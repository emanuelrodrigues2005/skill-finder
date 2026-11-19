/**
 * Issue #49 — o serviço que roda a ingestão **com o serviço no ar**.
 *
 * Até aqui o único chamador de `ingest()` era `backend/scripts/seed.ts`: não
 * havia como disparar a ingestão com a API no ar. O `IngestService` é essa
 * fronteira, e estes casos fixam — sem HTTP, sem banco, sem rede — o que a rota
 * `POST /api/v1/admin/ingest` promete:
 *
 * 1. o refresh sob demanda pede **exatamente** as chaves recebidas e **não**
 *    enumera a fonte (`listKeys` não é chamado): a rota não gira o rodízio;
 * 2. duas execuções simultâneas não rodam juntas — a segunda devolve
 *    `{started:false}` **antes** de chegar à fonte, então o rate limit do
 *    skills.sh não dobra (§7.3, D3);
 * 3. a trava é liberada quando a execução termina, inclusive quando o run fecha
 *    como `failed`;
 * 4. `IngestRunInProgressError` do repositório (índice parcial
 *    `UNIQUE (status) WHERE status='running'`) também vira `{started:false}`:
 *    o lock do banco é o backstop entre processos (`make seed` em paralelo).
 */
import type {
  CatalogRepository,
  IngestRunFinish,
  IngestRunRow,
  RotationBands,
} from '@/catalog/catalog-repository';
import { IngestRunInProgressError } from '@/catalog/catalog-repository';
import type { SkillRecord, SkillSource } from '@/catalog/skill-source';
import { IngestService } from '@/admin/ingest.service';

/** Uma skill completa, como o adaptador a entrega (dado ausente é `null`). */
function record(sourceKey: string): SkillRecord {
  return {
    source_key: sourceKey,
    source_url: `https://skills.sh/${sourceKey}`,
    name: sourceKey.split('/')[2] ?? sourceKey,
    summary: 'summary',
    category_slug: 'backend',
    stars: 10,
    installs: 20,
    vulnerability_count: null,
    security_status: 'ok',
    repo_url: null,
    skill_md_present: false,
    first_seen_at: null,
    raw: null,
  };
}

/**
 * Fonte controlada: segura o `fetchSkills` até `release()` para que a segunda
 * execução concorra com a primeira de verdade, sem `sleep` nem relógio.
 */
class ControlledSource implements SkillSource {
  readonly capabilities = { supports_categories: false, supports_documents: false };
  readonly fetchCalls: string[][] = [];
  listKeysCalls = 0;
  private gate: Promise<void> | null = null;
  private openGate: (() => void) | null = null;
  private enteredResolve: (() => void) | null = null;
  /** Resolve quando `fetchSkills` foi chamado — o run está em andamento. */
  readonly entered = new Promise<void>((resolve) => {
    this.enteredResolve = resolve;
  });

  /** Segura a próxima chamada à fonte; devolve o `release`. */
  hold(): () => void {
    this.gate = new Promise<void>((resolve) => {
      this.openGate = resolve;
    });
    return () => {
      this.gate = null;
      this.openGate?.();
    };
  }

  async fetchSkills(keys: readonly string[]): Promise<SkillRecord[]> {
    this.fetchCalls.push([...keys]);
    this.enteredResolve?.();
    if (this.gate !== null) {
      await this.gate;
    }
    return keys.map(record);
  }

  listKeys(): Promise<string[]> {
    this.listKeysCalls += 1;
    return Promise.resolve(['example/repo/rotated']);
  }

  listCategories(): Promise<never[]> {
    return Promise.resolve([]);
  }

  fetchDocument(): Promise<null> {
    return Promise.resolve(null);
  }
}

/** Repositório em memória: guarda o run para provar `ok` e o `upserted`. */
class InMemoryCatalog implements CatalogRepository {
  readonly runs: IngestRunRow[] = [];
  stored: SkillRecord[] = [];
  rotationCalls = 0;
  /** Simula outro processo com o lock do banco tomado. */
  lockHeld = false;

  failStaleRuns(): Promise<number> {
    return Promise.resolve(0);
  }

  startRun(run: {
    adapter: string;
    started_at: Date;
    items_requested?: number | null;
  }): Promise<number> {
    if (this.lockHeld) {
      return Promise.reject(new IngestRunInProgressError());
    }
    const id = this.runs.length + 1;
    this.runs.push({
      id,
      adapter: run.adapter,
      started_at: run.started_at,
      finished_at: null,
      status: 'running',
      items_seen: null,
      items_upserted: null,
      items_deactivated: null,
      items_requested: run.items_requested ?? null,
      error_code: null,
      error_detail: null,
    });
    return Promise.resolve(id);
  }

  finishRun(id: number, patch: IngestRunFinish): Promise<void> {
    const row = this.runs.find((candidate) => candidate.id === id);
    if (row === undefined) {
      return Promise.reject(new Error(`run ${id} não existe`));
    }
    Object.assign(row, {
      status: patch.status,
      finished_at: patch.finished_at,
      items_seen: patch.items_seen,
      items_upserted: patch.items_upserted,
      items_deactivated: patch.items_deactivated,
      error_code: patch.error_code ?? null,
      error_detail: patch.error_detail ?? null,
    });
    return Promise.resolve();
  }

  countActiveSkills(): Promise<number> {
    return Promise.resolve(0);
  }

  selectRotationKeys(): Promise<RotationBands> {
    this.rotationCalls += 1;
    return Promise.resolve({ hot: [], cold: [] });
  }

  selectUnseenKeys(): Promise<string[]> {
    return Promise.resolve([]);
  }

  upsertSkills(skills: SkillRecord[]): Promise<number> {
    this.stored = [...skills];
    return Promise.resolve(new Set(skills.map((skill) => skill.source_key)).size);
  }

  deactivateSkillsStaleBefore(): Promise<number> {
    return Promise.resolve(0);
  }
}

function service(source: SkillSource, repository: CatalogRepository): IngestService {
  return new IngestService(source, repository, 'fixture');
}

/** Espera o run entrar na fonte: o laço do event loop já passou pelos awaits. */
async function entered(source: ControlledSource): Promise<void> {
  await source.entered;
}

describe('IngestService — execução da ingestão no runtime (#49)', () => {
  it('pede exatamente as chaves do refresh sob demanda e não enumera a fonte', async () => {
    const source = new ControlledSource();
    const repository = new InMemoryCatalog();

    const attempt = await service(source, repository).refresh(['a/b/one', 'a/b/two']);

    expect(attempt.started).toBe(true);
    if (!attempt.started) {
      throw new Error('o refresh deveria ter começado');
    }
    expect(attempt.outcome).toMatchObject({
      status: 'ok',
      items_requested: 2,
      items_seen: 2,
      items_upserted: 2,
      items_deactivated: 0,
      error_code: null,
      error_detail: null,
    });
    // A fonte recebeu o par pedido, uma única vez.
    expect(source.fetchCalls).toEqual([['a/b/one', 'a/b/two']]);
    // Descoberta/rodízio não entram: a rota é refresh, não ciclo de 6 h.
    expect(source.listKeysCalls).toBe(0);
    expect(repository.rotationCalls).toBe(0);
    expect(repository.stored.map((skill) => skill.source_key)).toEqual(['a/b/one', 'a/b/two']);
  });

  it('recusa a segunda execução enquanto a primeira está na fonte (409)', async () => {
    const source = new ControlledSource();
    const repository = new InMemoryCatalog();
    const ingestService = service(source, repository);
    const release = source.hold();

    const first = ingestService.refresh(['a/b/one', 'a/b/two']);
    await entered(source);

    const second = ingestService.refresh(['a/b/three']);
    // Um macrotask deixa a segunda tentativa atravessar todas as promessas já
    // resolvidas da ingestão — se a trava falhar, ela chega à fonte antes daqui.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    // O rate limit da fonte não dobrou: uma chamada, não duas.
    expect(source.fetchCalls).toEqual([['a/b/one', 'a/b/two']]);
    expect(ingestService.isRunning()).toBe(true);

    release();
    const attempt = await first;
    expect(attempt.started).toBe(true);
    expect(await second).toEqual({ started: false });
    expect(ingestService.isRunning()).toBe(false);
  });

  it('libera a trava quando o run fecha como failed', async () => {
    const source = new ControlledSource();
    const repository = new InMemoryCatalog();
    jest.spyOn(source, 'fetchSkills').mockRejectedValueOnce(new Error('sitemap fora do ar'));
    const ingestService = service(source, repository);

    const failed = await ingestService.refresh(['a/b/one']);

    expect(failed.started).toBe(true);
    if (!failed.started) {
      throw new Error('o refresh deveria ter começado');
    }
    expect(failed.outcome.status).toBe('failed');
    expect(failed.outcome.error_code).toBe('SOURCE_FETCH_FAILED');
    // Run com falha não deixa a ingestão travada para sempre.
    expect(ingestService.isRunning()).toBe(false);
    await expect(ingestService.refresh(['a/b/one'])).resolves.toMatchObject({ started: true });
  });

  it('devolve {started:false} quando outro processo segura o lock do banco', async () => {
    const source = new ControlledSource();
    const repository = new InMemoryCatalog();
    repository.lockHeld = true;

    const attempt = await service(source, repository).refresh(['a/b/one']);

    // O índice parcial `UNIQUE (status) WHERE status='running'` é o backstop
    // entre processos: o POST responde 409, não 500.
    expect(attempt).toEqual({ started: false });
    expect(source.fetchCalls).toEqual([]);
  });
});
