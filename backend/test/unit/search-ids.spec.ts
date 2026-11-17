/**
 * Issue #10 (F2.6) — identificador público de skill (decisão D-B).
 *
 * Contrato exigido de `backend/src/search/ids.ts`:
 *
 *   export function encodeSkillId(id: bigint): string;
 *     // "sk_" + base32 Crockford MINÚSCULO, sempre 20 caracteres (zero-padded).
 *   export function decodeSkillId(value: string): bigint | null;
 *     // case-insensitive na entrada (inclusive o prefixo `sk_`);
 *     // lixo (vazio, tamanho errado, caractere fora do alfabeto Crockford) -> null.
 *
 * O `skill_id` é a única exposição do `skill.id bigint` no contrato (§5.3). Um
 * `decode` frouxo viraria 500 na rota `/skills/{skill_id}`; um `encode` que
 * passasse por `Number` perderia precisão acima de 2^53 — é o que os casos
 * abaixo fixam, com literais Crockford independentes da implementação.
 */
import { decodeSkillId, encodeSkillId } from '@/search/ids';

const PREFIX = 'sk_';
const BODY_LENGTH = 20;

describe('search ids (D-B: sk_ + Crockford base32 minúsculo, 20 chars)', () => {
  it('round-trips a bigint id', () => {
    expect(decodeSkillId(encodeSkillId(42n))).toBe(42n);
    expect(decodeSkillId(encodeSkillId(0n))).toBe(0n);
    expect(decodeSkillId(encodeSkillId(1n))).toBe(1n);
  });

  it('encodes exactly 20 lowercase Crockford characters', () => {
    expect(encodeSkillId(1n)).toMatch(/^sk_[a-z0-9]{20}$/);
    // Literais independentes da implementação: Crockford é posicional, base 32.
    expect(encodeSkillId(1n)).toBe(`${PREFIX}${'0'.repeat(BODY_LENGTH - 1)}1`);
    expect(encodeSkillId(32n)).toBe(`${PREFIX}${'0'.repeat(BODY_LENGTH - 2)}10`);
  });

  it('does not lose precision above 2^53', () => {
    const beyondSafeInteger = 9007199254740993n;

    const encoded = encodeSkillId(beyondSafeInteger);

    expect(encoded).toHaveLength(PREFIX.length + BODY_LENGTH);
    expect(decodeSkillId(encoded)).toBe(beyondSafeInteger);
  });

  it('decodes case-insensitively, including the prefix', () => {
    const lower = encodeSkillId(10n);
    const upper = `SK_${lower.slice(PREFIX.length).toUpperCase()}`;

    expect(decodeSkillId(lower)).toBe(10n);
    expect(decodeSkillId(upper)).toBe(10n);
  });

  it('returns null for anything that is not a 20-char Crockford body', () => {
    const garbage = [
      '',
      'nao-e-id',
      PREFIX,
      `${PREFIX}01JCV8Y6Q4`, // o id curto de exemplo do contrato v0 não é um id válido
      `${PREFIX}${'0'.repeat(BODY_LENGTH - 1)}`, // 19 caracteres
      `${PREFIX}${'0'.repeat(BODY_LENGTH + 1)}`, // 21 caracteres
      `${PREFIX}${'u'.repeat(BODY_LENGTH)}`, // `U` está fora do alfabeto Crockford
    ];

    for (const value of garbage) {
      expect({ value, decoded: decodeSkillId(value) }).toEqual({ value, decoded: null });
    }
  });
});
