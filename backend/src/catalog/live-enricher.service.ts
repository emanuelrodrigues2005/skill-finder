/**
 * Enriquecimento ao vivo do catálogo (#46/#47, pedido do dono).
 *
 * O catálogo é local: a ingestão enche a tabela `skill` e a busca lê um FTS no
 * Postgres. Isso é rápido e determinístico, mas tem um intervalo — entre ciclos,
 * uma skill publicada agora ainda não está no banco.
 *
 * Esta peça cobre esse intervalo **sem virar busca remota por consulta**. Ela não
 * chama o site a cada busca: só entra quando a busca local **não devolveu nada**, e
 * mesmo então o trabalho é limitado — enumera o sitemap (2 requisições, cache de
 * 6 h no adaptador), filtra as chaves pelo `slug` e busca o detalhe de no máximo
 * `limit` delas, a 1 req/s. O resultado é **ingerido**, não devolvido direto: a
 * próxima busca (e a re-execução imediata) encontram as linhas no banco, com o
 * ranking e a explicação de sempre.
 *
 * Por que não "raspar a busca do site": `robots.txt` do skills.sh proíbe
 * `/search` e `/api/` para crawler. Sitemap e página de detalhe são permitidos —
 * é o que esta peça usa.
 */
import { Injectable, Logger } from "@nestjs/common";

import type { SkillSource } from "./skill-source";
import type { CatalogRepository } from "./catalog-repository";
import { ingest } from "./ingest";
import type { AppConfigService } from "../config/config.module";
import { DEFAULT_LIVE_ENRICH_BUDGET_MS } from "../config/env.schema";

/** Limite de chaves por enriquecimento. Cada chave é 1 requisição a 1 req/s. */
export const DEFAULT_LIVE_ENRICH_MAX_KEYS = 12;

/**
 * Sufixo que marca, em `ingest_run.adapter`, a rodada disparada pela **busca**.
 *
 * Sem ele, toda busca vazia gravava `adapter='html'` e `items_requested=12` — a
 * mesma linha que um `POST /admin/ingest` do operador ou um ciclo do agendador
 * produz. `GET /api/v1/admin/ingest/runs` e um
 * `SELECT adapter, count(*) FROM ingest_run GROUP BY 1` passam a dizer a origem.
 *
 * **Por que sufixo e não uma coluna `trigger`:** `ingest_run.adapter` é `TEXT` sem
 * enum nem `CHECK` (`backend/prisma/schema.prisma`), não entra no contrato (§5.1 —
 * `IngestRun` expõe `run_id`, datas, `status` e `skills_ingested`, não o
 * adaptador) e **ninguém ramifica em cima do valor gravado**: quem escolhe o
 * adaptador é o token `CATALOG_ADAPTER` (`SKILL_SOURCE_KIND`), não a coluna. Um
 * sufixo custa uma linha de código e zero migration; uma coluna custaria a
 * migration e três pontos de escrita para o mesmo diagnóstico.
 *
 * O nome da fonte fica como **prefixo** (`html+live`), para quem já agrupa por
 * `adapter LIKE 'html%'` continuar vendo as duas origens juntas.
 */
export function liveAdapterName(sourceKind: string): string {
  return `${sourceKind}+live`;
}

/** Tamanho mínimo de um termo para ele casar por `slug` (evita "de", "a", "of"). */
const MIN_TERM = 3;

/**
 * Normaliza o `slug` de uma chave (`owner/repo/slug`) e devolve os tokens.
 *
 * A chave é `owner/repo/slug`; o `slug` é a parte descritiva publicada
 * (`anthropics/skills/webapp-testing` → `webapp`, `testing`). `repo` também entra
 * porque às vezes é ele que diz o assunto (`vercel-labs/skills/find-skills`).
 */
export function slugTerms(sourceKey: string): string[] {
  const partes = sourceKey.toLowerCase().split("/");
  const descritivo = partes.length >= 3 ? `${partes[1]} ${partes[2]}` : partes.join(" ");
  return descritivo
    .split(/[^a-z0-9]+/u)
    .filter((termo) => termo.length >= MIN_TERM);
}

/**
 * Chaves cujo `slug` casa com algum termo. Função **pura**: a ordem de entrada é
 * preservada (o sitemap é estável) e o corte é do chamador.
 *
 * Casa por prefixo nos dois sentidos (`test`/`testing`, `develop`/`developer`),
 * porque a intenção vem em inglês mas o slug é escrito por quem publica.
 */
export function matchKeysBySlug(
  sourceKeys: readonly string[],
  keywords: readonly string[],
): string[] {
  const termos = [
    ...new Set(
      keywords
        .flatMap((keyword) => keyword.toLowerCase().split(/[^a-z0-9]+/u))
        .filter((termo) => termo.length >= MIN_TERM),
    ),
  ];
  if (termos.length === 0) {
    return [];
  }
  return sourceKeys.filter((sourceKey) => {
    const doSlug = slugTerms(sourceKey);
    return termos.some((termo) =>
      doSlug.some((token) => token.startsWith(termo) || termo.startsWith(token)),
    );
  });
}

/** O que a busca precisa do enriquecimento. */
export interface LiveEnrichRequest {
  /** Termos em inglês da intenção; vazio desliga o enriquecimento. */
  readonly keywords: readonly string[];
  /** Teto de chaves desta rodada. */
  readonly limit?: number;
}

/**
 * Chamado **pelo serviço de busca**, nunca pelo controller: é a busca que decide
 * se o catálogo local foi insuficiente.
 */
@Injectable()
export class CatalogLiveEnricher {
  private readonly logger = new Logger(CatalogLiveEnricher.name);

  /**
   * Rodada em andamento, para o **single-flight**.
   *
   * Duas buscas vazias simultâneas pediam duas rodadas e disputavam o índice
   * parcial `UNIQUE (status) WHERE status='running'` de `ingest_run`: uma abria o
   * run e a outra registrava `warn` de run concorrente. Com o campo preenchido, a
   * segunda chamada devolve `0` na hora — quem chegou depois espera a rodada que
   * já está no ar (e é ela que vai gravar as linhas das duas).
   *
   * Escrito de forma **síncrona** antes de qualquer `await` em `enrich`: é o que
   * garante que duas chamadas no mesmo tick vejam a rodada da outra.
   */
  private inFlight: Promise<number> | null = null;

  constructor(
    private readonly source: SkillSource,
    private readonly repository: CatalogRepository,
    private readonly config: AppConfigService,
  ) {}

  /** `true` quando a configuração permite enriquecer. */
  get enabled(): boolean {
    return this.config.env.liveEnrichEnabled;
  }

  /**
   * Ingere até `limit` chaves que casam com as palavras-chave.
   *
   * @returns quantas linhas foram gravadas; `0` quando nada casou, quando está
   *   desligado, quando a fonte falhou ou quando **já existe uma rodada no ar**
   *   (single-flight). **Nunca lança**: o pior caso permitido é a resposta vazia
   *   que a busca já ia devolver.
   */
  enrich(request: LiveEnrichRequest): Promise<number> {
    if (!this.enabled) {
      return Promise.resolve(0);
    }
    if (this.inFlight !== null) {
      // Diagnóstico sem dado do usuário: só o fato de a rodada anterior existir.
      this.logger.debug(
        'enriquecimento ao vivo: rodada ja em andamento, esta chamada nao abre outra',
      );
      return Promise.resolve(0);
    }

    const round = this.runRound(request).finally(() => {
      // Só limpa a própria rodada: outra nunca abre enquanto esta não termina,
      // mas a comparação deixa a invariante explícita.
      if (this.inFlight === round) {
        this.inFlight = null;
      }
    });
    this.inFlight = round;
    return round;
  }

  /**
   * Executa uma rodada, com o orçamento de tempo como freio.
   *
   * Sem `AbortSignal` (a porta da fonte não aceita um), o freio é **deixar de
   * pedir chaves**: cada chave custa ~`1/SKILL_SOURCE_RPS` na fonte, então o
   * orçamento que sobra depois do sitemap define quantas ainda cabem. Nada é
   * cancelado no meio — o que não couber simplesmente não é pedido.
   */
  private async runRound(request: LiveEnrichRequest): Promise<number> {
    const limit = Math.max(0, request.limit ?? DEFAULT_LIVE_ENRICH_MAX_KEYS);
    if (limit === 0 || request.keywords.length === 0) {
      return 0;
    }

    try {
      // Orçamento calculado **dentro** do `try`: leitura de configuração
      // degenerada (dublê sem `env`) vira rodada abandonada, nunca exceção.
      const budgetMs = this.budgetMs();
      const startedAtMs = Date.now();
      const deadlineAtMs = startedAtMs + budgetMs;

      const todas = await this.source.listKeys();
      // Quantas chaves ainda cabem no orçamento (o sitemap já consumiu parte).
      const cabem = Math.floor((deadlineAtMs - Date.now()) / this.perKeyMs());
      if (cabem <= 0) {
        this.logger.warn(
          `enriquecimento ao vivo abandonado: orcamento de ${String(budgetMs)} ms esgotado antes de pedir chaves`,
        );
        return 0;
      }
      const casadas = matchKeysBySlug(todas, request.keywords).slice(0, Math.min(limit, cabem));
      if (casadas.length === 0) {
        // Diagnóstico sem dado do usuário: só quantas chaves o sitemap tinha.
        this.logger.debug(
          `enriquecimento ao vivo: nenhuma chave casou (sitemap com ${String(todas.length)} chaves)`,
        );
        return 0;
      }
      // `keys` explícitas: a execução abre run próprio e pede exatamente estas
      // chaves — não gira o rodízio nem gasta a cota de descoberta.
      const outcome = await ingest({
        source: this.source,
        repository: this.repository,
        // Origem da rodada no `ingest_run` (Fase 5): `html+live` é busca,
        // `html` é operador/agendador. Ver `liveAdapterName`.
        adapter: liveAdapterName(this.config.env.skillSourceKind),
        startedAt: new Date(),
        keys: casadas,
      });
      // A rodada é background: quem paga o atraso não é a resposta, mas o teto
      // existe para ela não ficar pendurada. Se estourou, fica registrado (não
      // há como cancelar um `fetchSkills` já em curso).
      const elapsedMs = Date.now() - startedAtMs;
      if (elapsedMs > budgetMs) {
        this.logger.warn(
          `enriquecimento ao vivo excedeu o orcamento de ${String(budgetMs)} ms ` +
            `(${String(elapsedMs)} ms): a proxima rodada so abre quando esta terminar`,
        );
      }
      return outcome.items_upserted;
    } catch (error) {
      // Fonte fora do ar, sitemap mudado, run concorrente: a busca segue com o
      // catálogo local. O log é a única testemunha — por isso não é silencioso.
      this.logger.warn(
        `enriquecimento ao vivo falhou: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 0;
    }
  }

  /** Teto da rodada; `??` cobre contextos que montam `env` parcial (dublês). */
  private budgetMs(): number {
    return this.config.env.liveEnrichBudgetMs ?? DEFAULT_LIVE_ENRICH_BUDGET_MS;
  }

  /** Intervalo médio entre requisições à fonte (`SKILL_SOURCE_RPS`, 1 por padrão). */
  private perKeyMs(): number {
    const rps = this.config.env.skillSourceRps;
    return typeof rps === 'number' && rps > 0 ? 1_000 / rps : 1_000;
  }
}
