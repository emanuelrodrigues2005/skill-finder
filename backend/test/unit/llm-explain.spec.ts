/**
 * Issue #41 (F2.10) — a porta `explain` e a escada de validação
 * (`docs/app/02-arquitetura.md` §6.5, `docs/app/03-plano-app.md` F2.10).
 *
 * O que este spec fixa, degrau por degrau — o payload é do contrato
 * (`ExplainPayload`, issue #39) e nada dele muda aqui:
 *
 *   1. corpo que não é JSON (ou chave fora do schema) -> `invalid_json`, nada do
 *      modelo chega à resposta e o #42 cai no template determinístico;
 *   2. `skill_id` fora dos candidatos -> item descartado; menos de um sobrevivente
 *      -> `invalid_ids`;
 *   3. `recommendation.skill_id` diferente do `rank 1` -> **um** reparo; persistindo,
 *      `invalid_ids` (nunca uma terceira tentativa);
 *   4. tetos 320/160/400 truncam, sem partir `{{` e sem invalidar o passo;
 *   5. nome de skill só por `{{skill:<id>}}` do conjunto — desconhecido é removido e
 *      o item sai marcado como reparado (é o `explanation_repaired` do §5.3);
 *   6. corpo fixo (`tools: []`, `temperature`, `max_tokens`) — provado em
 *      `llm-openai-compat.spec.ts`, onde o `nock` vê o corpo.
 *
 * Orçamento de latência: a intenção recebe `min(3000, restante)` e a explicação
 * `min(4000, restante)`; com menos de 800 ms restantes o `explain` **não é
 * tentado** e `explain_status` fica `null` (não é falha, é ausência de tentativa).
 */
import { Test } from '@nestjs/testing';
import nock from 'nock';

import type { Intent } from '@/contract/dto/search-response.dto';
import {
  EXPLAIN_MIN_BUDGET_MS,
  explainStepTimeoutMs,
  intentStepTimeoutMs,
  MAX_CAVEATS_CHARS,
  MAX_RECOMMENDATION_CHARS,
  MAX_WHY_CHARS,
  parseExplainPayload,
  type ExplainCandidate,
  type ExplainParser,
  type ExplainRequest,
} from '@/llm/explain-parser';
import { EXPLAIN_PROMPT_VERSION, buildExplainMessages } from '@/llm/explain-prompt';
import { FakeExplainParser } from '@/llm/fake';
import { EXPLAIN_PORT, LlmModule } from '@/llm/llm.module';
import { explainCacheKey, OpenAICompatParser } from '@/llm/openai-compat';

const ORIGIN = 'https://llm.test';
const CHAT_PATH = '/v1/chat/completions';
const MODEL = 'deepseek-v4.1-flash';
const QUERY = 'revisar pull request de Python procurando falha de seguranca';

/** Relógio fixo: o orçamento não depende de `Date.now` no teste. */
const NOW = 1_700_000_000_000;

const INTENT: Intent = {
  category: 'security',
  keywords: ['pull request', 'security', 'python'],
  filters: { exclude_with_vulnerabilities: false },
  language: 'pt',
  confidence: 0.9,
};

/** Dois candidatos ranqueados; `CANDIDATES[0]` é o `rank 1`. */
const CANDIDATES: readonly ExplainCandidate[] = [
  {
    skill_id: 'sk_rank1',
    name: 'Python security reviewer',
    category: 'security',
    stars: 1200,
    installs: 8000,
    vulnerability_count: 0,
    summary: 'Reviews pull requests for security problems in Python.',
  },
  {
    skill_id: 'sk_rank2',
    name: 'Lint helper',
    category: 'dev',
    stars: 250,
    installs: null,
    vulnerability_count: null,
    summary: null,
  },
];

const RANK1 = 'sk_rank1';
const RANK2 = 'sk_rank2';

interface PayloadItem {
  skill_id: string;
  why: string;
  caveats?: string | null;
}

/** Payload do §6.5, na forma que a LLM devolve. */
function payload(
  items: PayloadItem[],
  recommendation: { skill_id: string; why: string } = { skill_id: RANK1, why: 'Comece aqui.' },
): Record<string, unknown> {
  return { items, recommendation };
}

function completion(content: string): Record<string, unknown> {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    model: MODEL,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 300, completion_tokens: 90, total_tokens: 390 },
  };
}

/** Cliente com relógio fixo e orçamento inteiro disponível por padrão. */
function parser(): OpenAICompatParser {
  return new OpenAICompatParser({
    baseUrl: `${ORIGIN}/v1`,
    model: MODEL,
    timeoutS: 8,
    now: () => NOW,
  });
}

function request(overrides: Partial<ExplainRequest> = {}): ExplainRequest {
  return {
    query: QUERY,
    intent: INTENT,
    candidates: CANDIDATES,
    deadlineAtMs: NOW + 7_000,
    ...overrides,
  };
}

afterEach(() => {
  nock.cleanAll();
});

describe('explain validation ladder (arquitetura 6.5)', () => {
  it('degrau 1: JSON nao parseavel -> invalid_json; chave extra e DESCARTADA', async () => {
    // A regra 2 do AGENTS.md diz que campo fora do schema é descartado, e a etapa
    // de intenção já faz isso. Com `.strict()` um `"reasoning"` inventado pelo
    // modelo derrubava o passo inteiro (achado MEDIUM do parecer da #41). O que
    // continua sendo `invalid_json` é o corpo que não dá para ler.
    expect(parseExplainPayload('Claro! Aqui esta o JSON:', { candidates: CANDIDATES })).toEqual({
      ok: false,
      reason: 'invalid_json',
    });

    // Chave extra no objeto raiz: descartada, o resto vale.
    const extraTop = parseExplainPayload({ ...payload([{ skill_id: RANK1, why: 'ok' }]), score: 0.93 }, {
      candidates: CANDIDATES,
    });
    expect(extraTop.ok).toBe(true);

    // Chave extra no item (`rank`/`score`, o que a LLM tentaria): idem.
    const extraItem = parseExplainPayload(
      payload([{ skill_id: RANK1, why: 'ok', rank: 1 } as PayloadItem]),
      { candidates: CANDIDATES },
    );
    expect(extraItem.ok).toBe(true);
    if (extraItem.ok) {
      expect(extraItem.items).toHaveLength(1);
      expect(extraItem.items[0].skill_id).toBe(RANK1);
      expect(JSON.stringify(extraItem)).not.toContain('score');
    }

    // Pela porta: prosa em vez de JSON vira `invalid_json`, sem valor novo no
    // enum do contrato (o rótulo é da métrica); a explicação cai no template.
    nock(ORIGIN).post(CHAT_PATH).reply(200, completion('Sure! Here is the JSON you asked for.'));

    const result = await parser().explain(request());

    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe('invalid_json');
    expect(result.items).toEqual([]);
    expect(result.recommendation).toBeNull();
  });

  it('degrau 2: skill_id fora dos candidatos e descartado; sem sobrevivente -> invalid_ids', () => {
    const verdict = parseExplainPayload(
      payload([
        { skill_id: RANK1, why: 'Casa com a consulta.' },
        { skill_id: 'sk_inventado', why: 'Skill que nao existe no catalogo.' },
      ]),
      { candidates: CANDIDATES },
    );

    expect(verdict.ok).toBe(true);
    if (!verdict.ok) {
      throw new Error('o payload com um id valido deveria sobreviver');
    }
    expect(verdict.items.map((item) => item.skill_id)).toEqual([RANK1]);
    // Item descartado é reparo: o texto entregue não é exatamente o do modelo.
    expect(verdict.status).toBe('repaired');

    // Nenhum sobrevivente: `invalid_ids` (o #42 tenta o único reparo e cai no template).
    expect(
      parseExplainPayload(
        payload([
          { skill_id: 'sk_inventado', why: 'x' },
          { skill_id: 'sk_outro_inventado', why: 'y' },
        ]),
        { candidates: CANDIDATES },
      ),
    ).toEqual({ ok: false, reason: 'invalid_ids' });
  });

  it('degrau 3: recommendation fora do rank 1 pede um reparo; persistindo -> invalid_ids', async () => {
    const first = nock(ORIGIN)
      .post(CHAT_PATH)
      .reply(
        200,
        completion(
          JSON.stringify(
            payload([{ skill_id: RANK1, why: 'ok' }], {
              skill_id: RANK2,
              why: 'A segunda e a melhor.',
            }),
          ),
        ),
      );

    let repairBody: string = '';
    const second = nock(ORIGIN)
      .post(CHAT_PATH, (body: Record<string, unknown>) => {
        repairBody = JSON.stringify(body);
        return true;
      })
      .reply(
        200,
        completion(
          JSON.stringify(
            payload([{ skill_id: RANK1, why: 'ok' }], {
              skill_id: RANK1,
              why: 'A primeira e a melhor.',
            }),
          ),
        ),
      );

    const repaired = await parser().explain(request());

    expect(first.isDone()).toBe(true);
    expect(second.isDone()).toBe(true);
    expect(repaired.status).toBe('ok');
    expect(repaired.recommendation?.skill_id).toBe(RANK1);
    // O re-prompt carrega os ids válidos e qual deles é o rank 1.
    expect(repairBody).toContain(RANK1);
    expect(repairBody).toContain(RANK2);
    expect(repairBody).toMatch(/rank 1/iu);

    // Persistindo, é `invalid_ids` + template — e **nenhuma** terceira tentativa.
    nock.cleanAll();
    const twice = nock(ORIGIN)
      .post(CHAT_PATH)
      .twice()
      .reply(
        200,
        completion(
          JSON.stringify(
            payload([{ skill_id: RANK1, why: 'ok' }], {
              skill_id: RANK2,
              why: 'Insisto na segunda.',
            }),
          ),
        ),
      );
    const third = nock(ORIGIN)
      .post(CHAT_PATH)
      .reply(200, completion(JSON.stringify(payload([{ skill_id: RANK1, why: 'ok' }]))));

    const persisted = await parser().explain(request({ query: `${QUERY} (segunda busca)` }));

    expect(twice.isDone()).toBe(true);
    expect(third.isDone()).toBe(false);
    expect(persisted.status).toBe('invalid_ids');
    expect(persisted.reason).toBe('invalid_ids');
    expect(persisted.items).toEqual([]);
    expect(persisted.recommendation).toBeNull();
  });

  it('degrau 4: truncates why/caveats/recommendation at 320/160/400 without splitting {{', () => {
    // O `{{` começa na posição 310: um corte seco em 320 deixaria `{{skill:sk_rank1`
    // pela metade, que nenhum resolvedor de placeholder consegue ler.
    const longWhy = `${'a'.repeat(310)}{{skill:${RANK1}}}${'b'.repeat(60)}`;

    const verdict = parseExplainPayload(
      payload([{ skill_id: RANK1, why: longWhy, caveats: 'c'.repeat(MAX_CAVEATS_CHARS + 200) }], {
        skill_id: RANK1,
        why: longWhy,
      }),
      { candidates: CANDIDATES },
    );

    expect(verdict.ok).toBe(true);
    if (!verdict.ok) {
      throw new Error('texto longo deve truncar, nao invalidar o passo');
    }
    const [item] = verdict.items;
    expect(item).toBeDefined();
    expect(item?.why.length).toBeLessThanOrEqual(MAX_WHY_CHARS);
    // No `why` o placeholder não caberia no corte: sai inteiro, não partido.
    expect(item?.why).not.toContain('{{');
    expect(item?.caveats?.length).toBeLessThanOrEqual(MAX_CAVEATS_CHARS);
    expect(verdict.recommendation.why.length).toBeLessThanOrEqual(MAX_RECOMMENDATION_CHARS);
    // No `recommendation` ele cabe inteiro dentro dos 400: fica, completo.
    expect(verdict.recommendation.why).toContain(`{{skill:${RANK1}}}`);
    expect(verdict.recommendation.why).not.toMatch(/\{\{(?!skill:sk_rank1\}\})/u);
    // Truncar é reparo, não falha: o passo continua entregando prosa.
    expect(verdict.status).toBe('repaired');

    // `caveats` ausente continua `null` (regra 3: dado ausente não vira texto).
    const absent = parseExplainPayload(payload([{ skill_id: RANK1, why: 'ok' }]), {
      candidates: CANDIDATES,
    });
    expect(absent.ok).toBe(true);
    if (absent.ok) {
      expect(absent.items[0]?.caveats).toBeNull();
    }
  });

  it('degrau 5: names only via {{skill:<id>}}; an unknown placeholder is removed and repaired', () => {
    const verdict = parseExplainPayload(
      payload(
        [
          {
            skill_id: RANK1,
            why: 'Use {{skill:sk_rank1}} para revisar; nao use {{skill:sk_999}} nem {{qualquer}}.',
            caveats: null,
          },
        ],
        { skill_id: RANK1, why: 'Comece por {{skill:sk_rank1}}.' },
      ),
      { candidates: CANDIDATES },
    );

    expect(verdict.ok).toBe(true);
    if (!verdict.ok) {
      throw new Error('placeholder fora do conjunto nao invalida o passo: ele e removido');
    }
    const [item] = verdict.items;
    // O id do conjunto fica: quem substitui pelo nome do banco é o #42 (§6.5, barreira 3).
    expect(item?.why).toContain(`{{skill:${RANK1}}}`);
    expect(item?.why).not.toContain('sk_999');
    expect(item?.why).not.toContain('{{qualquer}}');
    // Nenhum `{{` que não seja um placeholder resolvível sobra no texto.
    expect(item?.why).not.toMatch(/\{\{(?!skill:sk_rank1\}\})/u);
    expect(verdict.recommendation.why).not.toMatch(/\{\{(?!skill:sk_rank1\}\})/u);
    // O item é sinalizado: é dele que sai o `explanation_repaired` do §5.3.
    expect(item?.repaired).toBe(true);
    expect(verdict.status).toBe('repaired');
  });
});

describe('explain latency budget (F2.10)', () => {
  it('orcamento: menos de 800 ms restantes e o explain nao e tentado', async () => {
    const scope = nock(ORIGIN)
      .post(CHAT_PATH)
      .reply(200, completion(JSON.stringify(payload([{ skill_id: RANK1, why: 'ok' }]))));

    const result = await parser().explain(
      request({ deadlineAtMs: NOW + EXPLAIN_MIN_BUDGET_MS - 1 }),
    );

    expect(result.status).toBeNull();
    expect(result.reason).toBe('budget');
    expect(result.items).toEqual([]);
    expect(result.recommendation).toBeNull();
    // A prova de que não houve chamada: o interceptor continua pendente.
    expect(scope.isDone()).toBe(false);
    expect(scope.pendingMocks()).toHaveLength(1);
  });

  it('orcamento: intent <= 3000 ms e explain <= 4000 ms do restante', () => {
    // Números ratificados na F2.10 (plano §F2.10): o teto da etapa é o menor
    // entre o orçamento próprio e o que sobrou da busca.
    expect(intentStepTimeoutMs(7_000)).toBe(3_000);
    expect(intentStepTimeoutMs(1_200)).toBe(1_200);
    expect(explainStepTimeoutMs(7_000)).toBe(4_000);
    expect(explainStepTimeoutMs(3_000)).toBe(3_000);
    expect(explainStepTimeoutMs(EXPLAIN_MIN_BUDGET_MS)).toBe(EXPLAIN_MIN_BUDGET_MS);
  });

  it('a segunda chamada identica vem do cache, e a versao do prompt entra na chave', async () => {
    const scope = nock(ORIGIN)
      .post(CHAT_PATH)
      .once()
      .reply(200, completion(JSON.stringify(payload([{ skill_id: RANK1, why: 'ok' }]))));

    const client = parser();
    const first = await client.explain(request());
    const second = await client.explain(request());

    expect(first.status).toBe('ok');
    expect(second.status).toBe('cached');
    expect(second.items.map((item) => item.skill_id)).toEqual([RANK1]);
    // Sem chamada ao provedor nesta requisição, modelo e tokens são `null`.
    expect(second.model).toBeNull();
    expect(second.tokens).toBeNull();
    expect(scope.isDone()).toBe(true);

    // Trocar a versão do prompt muda a chave: mudar uma vírgula no prompt
    // invalida o cache da explicação, como já acontece no passo de intenção.
    const key = explainCacheKey(request(), MODEL);
    expect(key).toBe(explainCacheKey(request(), MODEL, EXPLAIN_PROMPT_VERSION));
    expect(key).not.toBe(explainCacheKey(request(), MODEL, 'explain-v0'));
  });

  it('LLM_ENABLED=false: o explain nao e chamado e o status fica null', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        LlmModule.forRoot({
          enabled: false,
          baseUrl: `${ORIGIN}/v1`,
          model: MODEL,
          timeoutS: 8,
        }),
      ],
    }).compile();
    const port = moduleRef.get<ExplainParser>(EXPLAIN_PORT);
    const scope = nock(ORIGIN)
      .post(CHAT_PATH)
      .reply(200, completion(JSON.stringify(payload([{ skill_id: RANK1, why: 'ok' }]))));

    const result = await port.explain(request());

    expect(result.status).toBeNull();
    expect(result.reason).toBe('disabled');
    expect(result.items).toEqual([]);
    expect(scope.isDone()).toBe(false);
    await moduleRef.close();
  });
});

describe('explain prompt (F2.10)', () => {
  it('o prompt e em portugues, versionado e mantem o texto do usuario fora do system', () => {
    const [system, user] = buildExplainMessages(request());

    expect(system?.role).toBe('system');
    expect(system?.content).toContain(EXPLAIN_PROMPT_VERSION);
    expect(system?.content).toMatch(/voc[êe] /iu);
    expect(system?.content).not.toContain(QUERY);
    expect(user?.role).toBe('user');
    expect(user?.content).toContain('<candidates>');
    expect(user?.content).toContain(RANK1);
    expect(user?.content).toContain(`{{skill:${RANK1}}}`);
  });

  it('o provedor falso devolve payload valido, so com ids e placeholders do conjunto', () => {
    const result = new FakeExplainParser().explain(request());

    return result.then((explained) => {
      expect(explained.status).toBe('ok');
      expect(explained.items.map((item) => item.skill_id)).toEqual([RANK1, RANK2]);
      const verdict = parseExplainPayload(
        {
          items: explained.items.map((item) => ({
            skill_id: item.skill_id,
            why: item.why,
            caveats: item.caveats,
          })),
          // O payload do contrato é `{skill_id, why}`: o `repaired` é sinal local
          // da porta (#42), não campo do schema do modelo.
          recommendation: {
            skill_id: explained.recommendation?.skill_id ?? '',
            why: explained.recommendation?.why ?? '',
          },
        },
        { candidates: CANDIDATES },
      );
      expect(verdict.ok).toBe(true);
    });
  });
});
