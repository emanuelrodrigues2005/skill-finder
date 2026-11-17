import * as fs from 'node:fs';
import * as path from 'node:path';

import { rank } from '../../src/ranking';
import type { RankingCandidate, RankingWeights, RankedItem } from '../../src/ranking';

/**
 * Ranking determinístico — `01-spec-produto.md` §5.3–§5.9, `AGENTS.md` regra 1.
 *
 * Todo valor esperado aqui é **literal tirado da spec** ou de uma pré-condição
 * verificada dentro do próprio teste (por exemplo, "estes dois itens empatam em
 * `score`"), nunca o resultado de recalcular a fórmula do jeito que o código
 * recalcula — senão o teste passaria por construção.
 *
 * Âncoras de §5.3: `S = log10(1+stars)/log10(1+20000)`,
 * `P = 1 − min(1, vulns/5)`, `I = log10(1+installs)/log10(1+200000)`.
 */

const RATIFIED_WEIGHTS: RankingWeights = {
  stars: 0.5,
  vulnerabilities: 0.3,
  installs: 0.2,
};

/** Casos A/B/C de §5.7, na ordem canônica do documento. */
const GOLDEN: RankingCandidate[] = [
  { skill_id: 'skill-a', stars: 1200, installs: 8000, vulnerability_count: 0 },
  { skill_id: 'skill-b', stars: 3000, installs: 15000, vulnerability_count: 2 },
  { skill_id: 'skill-c', stars: 250, installs: null, vulnerability_count: null },
];

/** Cinco itens com empates forçados: pares que só o desempate separa. */
const TIED: RankingCandidate[] = [
  // score igual (P = 0 nos dois, porque `min(1, vulns/5)` satura em 1).
  { skill_id: 'tie-vulns-5', stars: 1000, installs: 3000, vulnerability_count: 5 },
  { skill_id: 'tie-vulns-9', stars: 1000, installs: 3000, vulnerability_count: 9 },
  // score igual (I = 1 nos dois: instalações acima da âncora 200.000).
  { skill_id: 'popular', stars: 20000, installs: 900000, vulnerability_count: 0 },
  { skill_id: 'saturated', stars: 20000, installs: 200000, vulnerability_count: 0 },
  // item incompleto, score distinto.
  { skill_id: 'missing', stars: 250, installs: null, vulnerability_count: null },
];

/** Seis itens para as propriedades de ordem total (§5.6). */
const TOTAL_ORDER: RankingCandidate[] = [
  { skill_id: 'alpha', stars: 1200, installs: 8000, vulnerability_count: 0 },
  { skill_id: 'bravo', stars: 3000, installs: 15000, vulnerability_count: 2 },
  { skill_id: 'charlie', stars: 1000, installs: 3000, vulnerability_count: 5 },
  { skill_id: 'delta', stars: 1000, installs: 3000, vulnerability_count: 9 },
  { skill_id: 'echo', stars: 20000, installs: 900000, vulnerability_count: 0 },
  { skill_id: 'foxtrot', stars: 250, installs: null, vulnerability_count: null },
];

function order(items: readonly RankedItem[]): string[] {
  return items.map((item) => item.skill_id);
}

function byId(items: readonly RankedItem[]): Record<string, RankedItem> {
  return Object.fromEntries(items.map((item) => [item.skill_id, item]));
}

/** Todas as permutações de `items` (gera 5! = 120 para cinco itens). */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) {
    return [[...items]];
  }
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += 1) {
    const rest = [...items.slice(0, index), ...items.slice(index + 1)];
    for (const tail of permutations(rest)) {
      result.push([items[index], ...tail]);
    }
  }
  return result;
}

/**
 * Ordem relativa de dois candidatos, medida pela interface pública: roda `rank`
 * só com o par. `-1` = `a` primeiro, `1` = `b` primeiro; empate (rank repetido)
 * é falha, não `0` — §5.6 promete ordem total.
 */
function positionOf(a: RankingCandidate, b: RankingCandidate): -1 | 1 {
  const pair = rank([a, b]);
  expect(pair.map((item) => item.rank)).toEqual([1, 2]);
  expect([a.skill_id, b.skill_id]).toContain(pair[0].skill_id);
  return pair[0].skill_id === a.skill_id ? -1 : 1;
}

describe('ranking (§5.3–§5.7)', () => {
  describe('golden cases (§5.7)', () => {
    it('matches the ratified A/B/C scores exactly', () => {
      const ranked = rank(GOLDEN);

      expect(order(ranked)).toEqual(['skill-a', 'skill-b', 'skill-c']);
      expect(ranked.map((item) => item.score)).toEqual([0.8053, 0.7418, 0.4232]);
    });

    it('exposes the normalised factors', () => {
      // O documento imprime I(A) = 0,7364; o valor real é 0,7362989 → 0,7363
      // (§5.7). Diferença de arredondamento na 4ª casa, sem efeito no score.
      const a = byId(rank(GOLDEN))['skill-a'].score_breakdown;
      expect(a.stars).toBeCloseTo(0.715998, 3);
      expect(a.vulnerabilities).toBe(1);
      expect(a.installs).toBeCloseTo(0.736299, 3);
      expect(a.missing_fields).toBe(0);
      expect(a.penalty_factor).toBe(1);

      const b = byId(rank(GOLDEN))['skill-b'].score_breakdown;
      expect(b.stars).toBeCloseTo(0.808469, 3);
      expect(b.vulnerabilities).toBeCloseTo(0.6, 10);
      expect(b.installs).toBeCloseTo(0.787794, 3);

      const c = byId(rank(GOLDEN))['skill-c'].score_breakdown;
      expect(c.stars).toBeCloseTo(0.557927, 3);
      expect(c.vulnerabilities).toBe(0.5);
      expect(c.installs).toBe(0.5);
    });

    it('penalises the incomplete item without zeroing it', () => {
      const c = byId(rank(GOLDEN))['skill-c'];

      expect(c.score_breakdown.missing_fields).toBe(2);
      expect(c.score_breakdown.penalty_factor).toBe(0.8);
      expect(c.score).toBeGreaterThan(0);
      // §5.5: os mesmos dois números também em `evidence_completeness`.
      expect(c.evidence_completeness).toEqual({ missing_fields: 2, penalty_factor: 0.8 });
    });

    it('assigns 1-based contiguous rank', () => {
      expect(rank(GOLDEN).map((item) => item.rank)).toEqual([1, 2, 3]);
      expect(rank(TIED).map((item) => item.rank)).toEqual([1, 2, 3, 4, 5]);
    });

    it('returns an empty list for an empty candidate set', () => {
      expect(rank([])).toEqual([]);
      // Controle: a mesma chamada com entrada não vazia não pode devolver [].
      expect(rank(GOLDEN)).toHaveLength(GOLDEN.length);
    });
  });

  describe('determinism (§5.9)', () => {
    it('produces identical output for every permutation of the input', () => {
      const all = permutations(TIED);
      expect(all).toHaveLength(120);

      const baseline = JSON.stringify(rank(TIED));
      const differing = all.filter((input) => JSON.stringify(rank(input)) !== baseline);

      expect(differing).toEqual([]);
      // O fixture precisa ter empate de verdade, senão a permutação não prova nada.
      const scores = new Set(rank(TIED).map((item) => item.score));
      expect(scores.size).toBeLessThan(TIED.length);
      expect(baseline).toContain('"skill_id":"missing"');
    });

    it('is a strict total order', () => {
      // 15 pares × 2 direções: sinais opostos, nunca 0 (sem rank repetido) e
      // iguais ao que a ordenação completa dos seis itens diz. Um comparador
      // que devolvesse "empate" para itens distintos passaria no sinal do par
      // mas não sobreviveria à comparação com a lista inteira.
      const full = order(rank(TOTAL_ORDER));
      const violations: string[] = [];
      let pairs = 0;

      for (let i = 0; i < TOTAL_ORDER.length; i += 1) {
        for (let j = i + 1; j < TOTAL_ORDER.length; j += 1) {
          pairs += 1;
          const a = TOTAL_ORDER[i];
          const b = TOTAL_ORDER[j];
          const forward = positionOf(a, b);
          const backward = positionOf(b, a);
          const inFullRanking = full.indexOf(a.skill_id) < full.indexOf(b.skill_id) ? -1 : 1;

          if (forward !== -backward) {
            violations.push(`${a.skill_id}/${b.skill_id}: pair is not antisymmetric`);
          }
          if (forward !== inFullRanking) {
            violations.push(`${a.skill_id}/${b.skill_id}: pair disagrees with the full ranking`);
          }
        }
      }

      expect(pairs).toBe(15);
      expect(violations).toEqual([]);
    });

    it('is transitive', () => {
      const n = TOTAL_ORDER.length;
      const matrix: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
      for (let i = 0; i < n; i += 1) {
        for (let j = i + 1; j < n; j += 1) {
          matrix[i][j] = positionOf(TOTAL_ORDER[i], TOTAL_ORDER[j]);
          matrix[j][i] = -matrix[i][j];
        }
      }

      const violations: string[] = [];
      let triples = 0;
      for (let i = 0; i < n; i += 1) {
        for (let j = 0; j < n; j += 1) {
          for (let k = 0; k < n; k += 1) {
            triples += 1;
            if (matrix[i][j] < 0 && matrix[j][k] < 0 && matrix[i][k] >= 0) {
              violations.push(
                `${TOTAL_ORDER[i].skill_id} < ${TOTAL_ORDER[j].skill_id} < ${TOTAL_ORDER[k].skill_id} but not ${TOTAL_ORDER[i].skill_id} < ${TOTAL_ORDER[k].skill_id}`,
              );
            }
          }
        }
      }

      expect(triples).toBe(216);
      expect(violations).toEqual([]);
    });

    it('does not mutate its input', () => {
      const snapshot = GOLDEN.map((candidate) => ({ ...candidate }));
      const frozen = Object.freeze(GOLDEN.map((candidate) => Object.freeze({ ...candidate })));
      const reference = JSON.stringify(rank(GOLDEN));

      // `as RankingCandidate[]`: a interface promete consumir, não alterar; o
      // `freeze` transforma uma escrita indevida em exceção.
      const ranked = rank(frozen);

      expect(JSON.stringify(ranked)).toBe(reference);
      expect(order(ranked)).toEqual(order(rank(GOLDEN)));
      expect(ranked).toHaveLength(GOLDEN.length);
      expect([...frozen]).toEqual(snapshot);
    });

    it('uses code-unit order for skill_id', () => {
      const ids = ['a', 'B', 'á', 'A', 'b'];
      const ranked = rank(
        ids.map((skill_id) => ({
          skill_id,
          stars: 1000,
          installs: 3000,
          vulnerability_count: 0,
        })),
      );

      // Código de unidade UTF-16: 'A'(65) < 'B'(66) < 'a'(97) < 'b'(98) < 'á'(225).
      // `localeCompare` daria outra ordem — §5.6 pede ordem de code unit.
      expect(order(ranked)).toEqual(['A', 'B', 'a', 'b', 'á']);
      expect(new Set(ranked.map((item) => item.score)).size).toBe(1);
    });
  });

  describe('missing data (§5.5)', () => {
    it('treats a null factor as neutral 0.5 and counts it as missing', () => {
      const [item] = rank([
        { skill_id: 'only-stars', stars: 1000, installs: null, vulnerability_count: null },
      ]);

      expect(item.score_breakdown.installs).toBe(0.5);
      expect(item.score_breakdown.vulnerabilities).toBe(0.5);
      expect(item.score_breakdown.missing_fields).toBe(2);
      expect(item.score_breakdown.penalty_factor).toBe(0.8);
    });

    it('never treats a missing value as zero or a perfect score', () => {
      const missing = byId(
        rank([{ skill_id: 'gap', stars: 1000, installs: null, vulnerability_count: null }]),
      )['gap'];
      const withZeroVulns = byId(
        rank([{ skill_id: 'zero', stars: 1000, installs: 0, vulnerability_count: 0 }]),
      )['zero'];
      const withPerfect = byId(
        rank([{ skill_id: 'perfect', stars: 20000, installs: 200000, vulnerability_count: 0 }]),
      )['perfect'];

      expect(missing.score_breakdown.installs).toBeGreaterThan(0);
      expect(missing.score_breakdown.installs).toBeLessThan(1);
      expect(missing.score_breakdown.vulnerabilities).toBeGreaterThan(0);
      expect(missing.score_breakdown.vulnerabilities).toBeLessThan(1);
      // Não é "0 vulnerabilidades" (P = 1) nem nota máxima.
      expect(missing.score).not.toBe(withZeroVulns.score);
      expect(missing.score).toBeLessThan(withPerfect.score);
      expect(missing.score).toBeGreaterThan(0);
    });

    it('caps the missing penalty at 30%', () => {
      const [item] = rank([
        { skill_id: 'nothing', stars: null, installs: null, vulnerability_count: null },
      ]);

      expect(item.score_breakdown.missing_fields).toBe(3);
      // Tabela literal de §5.5 ([1, 0.9, 0.8, 0.7]). Medido: em IEEE-754,
      // `1 − 0,1·m` produz exatamente os mesmos valores para m ∈ {0,1,2,3},
      // então este caso pina o valor, não a forma de calcular.
      expect(item.score_breakdown.penalty_factor).toBe(0.7);
      expect(item.score).toBe(0.35);
    });

    it('treats negative and non-finite raw values as missing', () => {
      const ranked = rank([
        { skill_id: 'negative', stars: -5, installs: -100, vulnerability_count: -1 },
        { skill_id: 'nan', stars: NaN, installs: NaN, vulnerability_count: NaN },
        {
          skill_id: 'infinite',
          stars: Infinity,
          installs: Number.POSITIVE_INFINITY,
          vulnerability_count: Number.NEGATIVE_INFINITY,
        },
      ]);

      for (const item of ranked) {
        expect(Number.isFinite(item.score)).toBe(true);
        expect(item.score_breakdown.missing_fields).toBe(3);
        expect(item.score_breakdown.stars).toBe(0.5);
        expect(item.score_breakdown.installs).toBe(0.5);
        expect(item.score_breakdown.vulnerabilities).toBe(0.5);
        expect(item.score).toBe(0.35);
      }

      expect(ranked).toHaveLength(3);
    });
  });

  describe('tie-breaks (§5.6)', () => {
    it('breaks a score tie by vulnerability count ascending', () => {
      const five = { skill_id: 'five', stars: 1000, installs: 3000, vulnerability_count: 5 };
      const nine = { skill_id: 'nine', stars: 1000, installs: 3000, vulnerability_count: 9 };
      const [first, second] = rank([nine, five]);

      // Pré-condição do caso: os dois empatam em score (P = 0 nos dois).
      expect(first.score).toBe(second.score);
      expect(order([first, second])).toEqual(['five', 'nine']);
    });

    it('breaks a vulnerability tie by installs descending', () => {
      const low = { skill_id: 'low', stars: 1000, installs: 200000, vulnerability_count: 0 };
      const high = { skill_id: 'high', stars: 1000, installs: 900000, vulnerability_count: 0 };
      const [first, second] = rank([low, high]);

      // Pré-condição: score e vulnerabilidades empatam (I = 1 dos dois lados).
      expect(first.score).toBe(second.score);
      expect(first.score_breakdown.vulnerabilities).toBe(second.score_breakdown.vulnerabilities);
      expect(order([first, second])).toEqual(['high', 'low']);
    });

    it('breaks an installs tie by stars descending', () => {
      const small = { skill_id: 'small', stars: 20000, installs: 1000, vulnerability_count: 0 };
      const big = { skill_id: 'big', stars: 50000, installs: 1000, vulnerability_count: 0 };
      const [first, second] = rank([small, big]);

      // Pré-condição: score, vulnerabilidades e instalações empatam (S = 1).
      expect(first.score).toBe(second.score);
      expect(first.score_breakdown.installs).toBe(second.score_breakdown.installs);
      expect(order([first, second])).toEqual(['big', 'small']);
    });

    it('breaks a full tie by skill_id', () => {
      const same = { stars: 1200, installs: 8000, vulnerability_count: 0 };
      const ranked = rank([
        { skill_id: 'skill-z', ...same },
        { skill_id: 'skill-a', ...same },
      ]);

      expect(ranked[0].score).toBe(ranked[1].score);
      expect(order(ranked)).toEqual(['skill-a', 'skill-z']);
    });

    it('ranks a null vulnerability as 2.5 for ties only', () => {
      // Empate exato de score entre um item sem vulnerabilidade reportada e um
      // com 2 vulnerabilidades; o desempate usa 2,5 contra 2 (§5.6.2).
      const missing = {
        skill_id: 'missing',
        stars: 20000,
        installs: 200000,
        vulnerability_count: null,
      };
      const two = { skill_id: 'two', stars: 20000, installs: 178, vulnerability_count: 2 };
      const ranked = rank([missing, two]);
      const [first, second] = ranked;

      // Pré-condição: os scores empatam; só o critério 2 decide.
      expect(first.score).toBe(second.score);
      expect(order(ranked)).toEqual(['two', 'missing']);

      // O score **não** usa 2,5: o fator é o neutro 0,5 e o campo conta como
      // ausente (m += 1), o que aplica a penalidade de 10%.
      const nullVulns = byId(ranked)['missing'];
      expect(nullVulns.score_breakdown.vulnerabilities).toBe(0.5);
      expect(nullVulns.score_breakdown.missing_fields).toBe(1);
      expect(nullVulns.score_breakdown.penalty_factor).toBe(0.9);
      const explicitTwoAndAHalf = byId(
        rank([
          {
            skill_id: 'explicit',
            stars: 20000,
            installs: 200000,
            vulnerability_count: 2.5,
          },
        ]),
      )['explicit'];
      expect(nullVulns.score).not.toBe(explicitTwoAndAHalf.score);
      expect(nullVulns.score).toBe(0.765);
    });

    it('sorts a null installs last among score ties', () => {
      // Ambos empatam em score (0.6) e em vulnerabilidade tratada (2,5), então o
      // critério 3 decide: instalações ausentes contam como 0 só aqui.
      const noInstalls = {
        skill_id: 'no-installs',
        stars: 20000,
        installs: null,
        vulnerability_count: null,
      };
      const withInstalls = {
        skill_id: 'with-installs',
        stars: 529,
        installs: 200000,
        vulnerability_count: null,
      };
      const ranked = rank([noInstalls, withInstalls]);

      expect(ranked[0].score).toBe(ranked[1].score);
      expect(order(ranked)).toEqual(['with-installs', 'no-installs']);
    });
  });

  describe('weights and filtering (§5.2, §5.4)', () => {
    it('uses the ratified weights by default', () => {
      expect(rank(GOLDEN)).toEqual(rank(GOLDEN, undefined, RATIFIED_WEIGHTS));
      expect(rank(GOLDEN).map((item) => item.score)).toEqual([0.8053, 0.7418, 0.4232]);
    });

    it('honours custom weights', () => {
      // Só estrelas: B (0,8085) passa A (0,7160) — o inverso da ordem padrão.
      const starsOnly = rank(GOLDEN, undefined, {
        stars: 1,
        vulnerabilities: 0,
        installs: 0,
      });
      expect(order(starsOnly)).toEqual(['skill-b', 'skill-a', 'skill-c']);

      // Pesos válidos cuja soma em ponto flutuante não é exatamente 1.
      const noisy = rank(GOLDEN, undefined, {
        stars: 0.6,
        vulnerabilities: 0.25,
        installs: 0.15,
      });
      expect(order(noisy)).toEqual(['skill-a', 'skill-b', 'skill-c']);
      expect(noisy[0].score).toBeCloseTo(0.79, 3);
    });

    it('rejects weights that do not sum to 1', () => {
      expect(() =>
        rank(GOLDEN, undefined, { stars: 0.5, vulnerabilities: 0.3, installs: 0.3 }),
      ).toThrow();
      expect(() =>
        rank(GOLDEN, undefined, { stars: 0.4, vulnerabilities: 0.3, installs: 0.2 }),
      ).toThrow();
      // Controle: só os pesos inválidos são rejeitados.
      expect(rank(GOLDEN, undefined, RATIFIED_WEIGHTS)).toHaveLength(GOLDEN.length);
    });

    it('rejects a negative weight', () => {
      // Soma exatamente 1: a rejeição só pode vir do peso negativo.
      expect(() =>
        rank(GOLDEN, undefined, { stars: 1.2, vulnerabilities: -0.2, installs: 0 }),
      ).toThrow();
      expect(rank(GOLDEN, undefined, RATIFIED_WEIGHTS)).toHaveLength(GOLDEN.length);
    });

    it('keeps every score inside [0,1]', () => {
      const ranked = rank([
        { skill_id: 'huge', stars: 1e9, installs: 1e9, vulnerability_count: 0 },
        { skill_id: 'tiny', stars: 0, installs: 0, vulnerability_count: 1e6 },
        { skill_id: 'negative', stars: -5, installs: -100, vulnerability_count: -1 },
        { skill_id: 'nan', stars: NaN, installs: NaN, vulnerability_count: NaN },
        { skill_id: 'empty', stars: null, installs: null, vulnerability_count: null },
      ]);

      for (const item of ranked) {
        expect(Number.isFinite(item.score)).toBe(true);
        expect(item.score).toBeGreaterThanOrEqual(0);
        expect(item.score).toBeLessThanOrEqual(1);
        expect(item.score_breakdown.stars).toBeGreaterThanOrEqual(0);
        expect(item.score_breakdown.stars).toBeLessThanOrEqual(1);
        expect(item.score_breakdown.installs).toBeGreaterThanOrEqual(0);
        expect(item.score_breakdown.installs).toBeLessThanOrEqual(1);
        expect(item.score_breakdown.vulnerabilities).toBeGreaterThanOrEqual(0);
        expect(item.score_breakdown.vulnerabilities).toBeLessThanOrEqual(1);
        expect(item.score_breakdown.missing_fields).toBeGreaterThanOrEqual(0);
        expect(item.score_breakdown.missing_fields).toBeLessThanOrEqual(3);
      }

      expect(ranked).toHaveLength(5);
    });

    it('ignores the intent for weights', () => {
      // Pesos só entram pelo parâmetro dedicado: um `weights` escondido na
      // intenção não pode mudar a ordem (§5.4 — pesos são configuração).
      const smuggled = {
        excludeWithVulnerabilities: false,
        weights: { stars: 1, vulnerabilities: 0, installs: 0 },
      } as NonNullable<Parameters<typeof rank>[1]>;

      expect(rank(GOLDEN, smuggled)).toEqual(rank(GOLDEN));
      expect(order(rank(GOLDEN, smuggled))).toEqual(['skill-a', 'skill-b', 'skill-c']);
    });

    it('drops items with vulnerabilities when the intent asks', () => {
      const candidates: RankingCandidate[] = [
        { skill_id: 'clean', stars: 1200, installs: 8000, vulnerability_count: 0 },
        { skill_id: 'one-vuln', stars: 3000, installs: 15000, vulnerability_count: 1 },
        { skill_id: 'nine-vulns', stars: 5000, installs: 90000, vulnerability_count: 9 },
        { skill_id: 'unknown', stars: 250, installs: null, vulnerability_count: null },
      ];

      const filtered = rank(candidates, { excludeWithVulnerabilities: true });

      expect(order(filtered)).toEqual(['clean', 'unknown']);
      // Sem a intenção, os mesmos itens com vulnerabilidade continuam na lista.
      expect(order(rank(candidates))).toEqual(['clean', 'one-vuln', 'nine-vulns', 'unknown']);
      expect(filtered.map((item) => item.rank)).toEqual([1, 2]);
    });
  });

  describe('purity (§5.9, AGENTS.md regra 1)', () => {
    const rankingDir = path.join(__dirname, '..', '..', 'src', 'ranking');
    const forbidden = /axios|fetch\s*\(|Date\.now|Math\.random|process\.env|require\(/;

    it('is pure', () => {
      const files = fs.readdirSync(rankingDir).filter((file) => file.endsWith('.ts'));

      expect(files.length).toBeGreaterThan(0);
      const offending = files.filter((file) =>
        forbidden.test(fs.readFileSync(path.join(rankingDir, file), 'utf8')),
      );

      expect(offending).toEqual([]);
      // O módulo escaneado é o que ordena: um módulo vazio não pode passar aqui.
      expect(rank(GOLDEN)).toHaveLength(GOLDEN.length);
    });
  });

  describe('fixture sanity', () => {
    /**
     * Recorte de `docs/app/amostras/skills-sample-2026-11-15.json` (2026-11-15).
     * Números copiados de lá, e não lidos em tempo de teste, porque o espelho do
     * `verify.sh` só copia `backend/` e `openapi.yaml`. O arquivo estava com os
     * valores inflados ×10³–10⁶; com eles, todo fator saturaria em 1,0 e a ordem
     * viraria degenerada sem ninguém notar.
     */
    const SAMPLE: RankingCandidate[] = [
      {
        skill_id: 'vercel-labs/skills/find-skills',
        stars: 39400,
        installs: 4400000,
        vulnerability_count: null,
      },
      {
        skill_id: 'anthropics/skills/webapp-testing',
        stars: 194600,
        installs: 205900,
        vulnerability_count: null,
      },
      {
        skill_id: 'clerk/skills/clerk-webhooks',
        stars: 94,
        installs: 55600,
        vulnerability_count: null,
      },
      {
        skill_id: 'googleworkspace/cli/recipe-label-and-archive-emails',
        stars: 32300,
        installs: 31300,
        vulnerability_count: null,
      },
    ];

    it('keeps the sample fixture inside realistic magnitudes', () => {
      const maxStars = Math.max(...SAMPLE.map((candidate) => candidate.stars ?? 0));
      const maxInstalls = Math.max(...SAMPLE.map((candidate) => candidate.installs ?? 0));

      expect(maxStars).toBeLessThanOrEqual(1e6);
      expect(maxInstalls).toBeLessThanOrEqual(1e7);

      const ranked = rank(SAMPLE);
      const factors = ranked.flatMap((item) => [
        item.score_breakdown.stars,
        item.score_breakdown.installs,
      ]);

      // Um fixture inflado saturaria todos os fatores em 1,0 (clamp01).
      expect(Math.min(...factors)).toBeLessThan(0.99);
      expect(new Set(ranked.map((item) => item.score)).size).toBeGreaterThan(1);
      // Ordem com dados reais: os dois primeiros empatam em 0,765 (S = I = 1 nos
      // dois) e o critério 3 separa por instalações; depois 0,7376 e 0,5030.
      expect(order(ranked)).toEqual([
        'vercel-labs/skills/find-skills',
        'anthropics/skills/webapp-testing',
        'googleworkspace/cli/recipe-label-and-archive-emails',
        'clerk/skills/clerk-webhooks',
      ]);
      expect(ranked.map((item) => item.score)).toEqual([0.765, 0.765, 0.7376, 0.503]);
    });
  });
});
