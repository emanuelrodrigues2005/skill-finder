/**
 * Issue #10 (F2.6) — explicação e recomendação determinísticas (D-C).
 *
 * Contrato exigido de `backend/src/search/explanation.ts`:
 *
 *   export interface ExplanationItem {
 *     readonly skill: SkillSummary;
 *     readonly score_breakdown: ScoreBreakdown;
 *     readonly evidence_completeness: EvidenceCompleteness;
 *     // Texto bruto com placeholders; ausente = template determinístico.
 *     readonly template?: string;
 *   }
 *   export interface Explanation {
 *     readonly explanation: string;
 *     readonly flags: string[];
 *     readonly caveats: string | null;
 *   }
 *   export function explainItem(
 *     item: ExplanationItem,
 *     known: ReadonlyMap<string, string>,   // skill_id -> name do conjunto ranqueado
 *   ): Explanation;
 *   export function recommend(items: readonly ExplanationItem[]): Recommendation | null;
 *
 * A porta `IntentParser` não tem `explain` (D-C): o texto sai de um template
 * determinístico e o backend resolve `{{skill:<skill_id>}}` com o `name` do
 * banco. Placeholder de id fora do conjunto é **removido** e o item ganha
 * `flags: ["explanation_repaired"]` (§5.3). `caveats` é `null` quando
 * `missing_fields === 0` e ≤ 160 caracteres quando há lacuna (§5.3); dado
 * ausente é `null`, nunca zero (regra 3 do AGENTS.md). `explanation` ≤ 1200.
 */
import type { SkillSummary } from '@/contract/dto/catalog.dto';
import type { Recommendation } from '@/contract/dto/search-response.dto';
import type { EvidenceCompleteness, ScoreBreakdown } from '@/contract/dto/result-item.dto';
import { explainItem, recommend, EXPLANATION_REPAIRED_FLAG } from '@/search/explanation';
import { encodeSkillId } from '@/search/ids';

const SKILL: SkillSummary = {
  skill_id: encodeSkillId(42n),
  name: 'python-security-review',
  source_url: 'https://skills.sh/example/python-security-review',
  category: 'backend',
  stars: 1200,
  installs: 8000,
  vulnerability_count: 0,
  security_status: 'ok',
  skill_md_present: true,
};

const OTHER_SKILL: SkillSummary = {
  ...SKILL,
  skill_id: encodeSkillId(43n),
  name: 'pr-hygiene',
  category: 'testing',
};

const CLEAN_BREAKDOWN: ScoreBreakdown = {
  stars: 0.71,
  vulnerabilities: 1,
  installs: 0.73,
  missing_fields: 0,
  penalty_factor: 1,
};

const GAPPY_BREAKDOWN: ScoreBreakdown = {
  stars: 0.5,
  vulnerabilities: 0.5,
  installs: 0.5,
  missing_fields: 2,
  penalty_factor: 0.8,
};

const CLEAN_EVIDENCE: EvidenceCompleteness = { missing_fields: 0, penalty_factor: 1 };
const GAPPY_EVIDENCE: EvidenceCompleteness = { missing_fields: 2, penalty_factor: 0.8 };

const KNOWN = new Map<string, string>([
  [SKILL.skill_id, SKILL.name],
  [OTHER_SKILL.skill_id, OTHER_SKILL.name],
]);

describe('explanation (D-C: template determinístico, placeholders resolvidos)', () => {
  it('produces a non-empty explanation within the 1200-char ceiling', () => {
    const { explanation, flags } = explainItem(
      { skill: SKILL, score_breakdown: CLEAN_BREAKDOWN, evidence_completeness: CLEAN_EVIDENCE },
      KNOWN,
    );

    expect(explanation.trim().length).toBeGreaterThan(0);
    expect(explanation.length).toBeLessThanOrEqual(1200);
    expect(explanation).not.toContain('{{');
    expect(flags).toEqual([]);
  });

  it('resolves a known placeholder with the catalog name', () => {
    const { explanation, flags } = explainItem(
      {
        skill: SKILL,
        score_breakdown: CLEAN_BREAKDOWN,
        evidence_completeness: CLEAN_EVIDENCE,
        template: `Pairs well with {{skill:${OTHER_SKILL.skill_id}}}.`,
      },
      KNOWN,
    );

    expect(explanation).toContain(OTHER_SKILL.name);
    expect(explanation).not.toContain('{{');
    expect(flags).toEqual([]);
  });

  it('drops a placeholder for an id outside the set and flags the repair', () => {
    const unknownId = encodeSkillId(999n);

    const { explanation, flags } = explainItem(
      {
        skill: SKILL,
        score_breakdown: CLEAN_BREAKDOWN,
        evidence_completeness: CLEAN_EVIDENCE,
        template: `Useful for Python services; compare with {{skill:${unknownId}}}.`,
      },
      KNOWN,
    );

    expect(explanation).not.toContain('{{');
    expect(explanation).not.toContain(unknownId);
    expect(explanation.length).toBeGreaterThan(0);
    expect(flags).toContain('explanation_repaired');
  });

  it('truncates a pathological skill name to the 1200-char ceiling', () => {
    const longName = 'x'.repeat(2000);
    const { explanation } = explainItem(
      {
        skill: { ...SKILL, name: longName },
        score_breakdown: CLEAN_BREAKDOWN,
        evidence_completeness: CLEAN_EVIDENCE,
      },
      KNOWN,
    );

    expect(explanation.length).toBeLessThanOrEqual(1200);
    expect(explanation).not.toContain('{{');
  });

  it('keeps caveats null when no catalog field is missing', () => {
    const { caveats } = explainItem(
      { skill: SKILL, score_breakdown: CLEAN_BREAKDOWN, evidence_completeness: CLEAN_EVIDENCE },
      KNOWN,
    );

    expect(caveats).toBeNull();
  });

  it('explains missing evidence in at most 160 characters, never as zero', () => {
    const { caveats } = explainItem(
      { skill: SKILL, score_breakdown: GAPPY_BREAKDOWN, evidence_completeness: GAPPY_EVIDENCE },
      KNOWN,
    );

    expect(typeof caveats).toBe('string');
    expect(caveats?.trim().length ?? 0).toBeGreaterThan(0);
    expect(caveats?.length ?? 0).toBeLessThanOrEqual(160);
    expect(caveats).not.toContain('{{');
  });

  /**
   * Issue #10 (revisão): o `name` de uma skill é **dado de scraping**, não
   * template. Um nome como `evil {{skill:<id de outra skill>}}` não pode citar a
   * outra skill, não pode vazar `{{` e não pode ganhar `explanation_repaired`
   * por causa do dado de terceiro — nem em `recommendation.text`.
   */
  describe('scraped skill name is data, never template syntax (issue #10)', () => {
    const KNOWN_TARGET = encodeSkillId(43n); // id de OTHER_SKILL
    const OUTSIDE_ID = encodeSkillId(999n);
    const SCRAPED_KNOWN = `evil {{skill:${KNOWN_TARGET}}}`;
    const SCRAPED_OUTSIDE = `evil {{skill:${OUTSIDE_ID}}}`;

    it('does not resolve a placeholder embedded in the name', () => {
      const { explanation, flags } = explainItem(
        {
          skill: { ...SKILL, name: SCRAPED_KNOWN },
          score_breakdown: CLEAN_BREAKDOWN,
          evidence_completeness: CLEAN_EVIDENCE,
        },
        KNOWN,
      );

      // Sem escape, o placeholder do nome seria resolvido com o nome de outra skill.
      expect(explanation).not.toContain(OTHER_SKILL.name);
      expect(explanation).not.toContain('{{');
      // O nome não é descartado: continua no texto, só que escapado.
      expect(explanation).toContain('evil');
      expect(flags).toEqual([]);
    });

    it('does not flag explanation_repaired for an out-of-set id inside the name', () => {
      const { explanation, flags } = explainItem(
        {
          skill: { ...SKILL, name: SCRAPED_OUTSIDE },
          score_breakdown: CLEAN_BREAKDOWN,
          evidence_completeness: CLEAN_EVIDENCE,
        },
        KNOWN,
      );

      // Placeholder de id fora do conjunto remove o trecho e marca a flag; no
      // nome, o id é dado de scraping e a flag não pode aparecer.
      expect(flags).not.toContain(EXPLANATION_REPAIRED_FLAG);
      expect(explanation).not.toContain('{{');
      expect(explanation).toContain('evil');
      expect(explanation.length).toBeGreaterThan(0);
    });

    it('keeps recommendation.text free of placeholder syntax from the top-1 name', () => {
      const items = [
        {
          skill: { ...SKILL, name: SCRAPED_KNOWN },
          score_breakdown: CLEAN_BREAKDOWN,
          evidence_completeness: CLEAN_EVIDENCE,
        },
        {
          skill: OTHER_SKILL,
          score_breakdown: GAPPY_BREAKDOWN,
          evidence_completeness: GAPPY_EVIDENCE,
        },
      ] as const;

      const recommendation = recommend(items);

      expect(recommendation?.skill_id).toBe(SKILL.skill_id);
      // Sem o mesmo escape da explicação, o top-1 citaria OTHER_SKILL aqui.
      expect(recommendation?.text).not.toContain(OTHER_SKILL.name);
      expect(recommendation?.text).not.toContain('{{');
      expect(recommendation?.text).toContain('evil');
    });

    it('still resolves a placeholder that comes from the template, not from a name', () => {
      const { explanation, flags } = explainItem(
        {
          skill: SKILL,
          score_breakdown: CLEAN_BREAKDOWN,
          evidence_completeness: CLEAN_EVIDENCE,
          template: `Pairs well with {{skill:${OTHER_SKILL.skill_id}}}.`,
        },
        KNOWN,
      );

      // Contrapositivo do escape: o caminho do template continua resolvendo.
      expect(explanation).toContain(OTHER_SKILL.name);
      expect(flags).toEqual([]);
    });
  });

  it('recommends the first ranked item and nothing when the list is empty', () => {
    const items = [
      { skill: SKILL, score_breakdown: CLEAN_BREAKDOWN, evidence_completeness: CLEAN_EVIDENCE },
      {
        skill: OTHER_SKILL,
        score_breakdown: GAPPY_BREAKDOWN,
        evidence_completeness: GAPPY_EVIDENCE,
      },
    ] as const;

    const recommendation: Recommendation | null = recommend(items);

    expect(recommendation).not.toBeNull();
    expect(recommendation?.skill_id).toBe(SKILL.skill_id);
    expect(recommendation?.text.trim().length ?? 0).toBeGreaterThan(0);
    expect(recommendation?.text.length ?? 0).toBeLessThanOrEqual(1200);
    expect(recommendation?.text).not.toContain('{{');
    expect(recommend([])).toBeNull();
  });
});
