/**
 * Identificador público de skill (decisão D-B de `docs/app/02-arquitetura.md`
 * §5.3): `sk_` + 20 caracteres de Crockford base32 **minúsculo**.
 *
 * O `skill.id bigint` é detalhe de banco: ele nunca aparece no contrato. A
 * conversão mora aqui, num par de funções puras, porque um `encode` que passasse
 * por `Number` perderia precisão acima de 2^53 e um `decode` frouxo viraria 500
 * na rota `/skills/{skill_id}` — os dois erros mais fáceis de cometer.
 *
 * O corpo tem tamanho fixo (20 chars) para o id ter sempre a mesma forma: o
 * alfabeto cobre 100 bits, muito acima do `bigint` sequencial do Postgres.
 */

/** Prefixo do id público. */
export const SKILL_ID_PREFIX = 'sk_';

/** Caracteres do corpo: sempre 20, independentemente do valor. */
export const SKILL_ID_BODY_LENGTH = 20;

/**
 * Alfabeto Crockford base32 em minúsculas: sem `i`, `l`, `o` e `u`.
 *
 * A exclusão não é decoração — é o que torna `u` inválido (e o id ambíguo
 * impossível de digitar errado). `decode` normaliza a caixa, então `SK_` e
 * `SK_...` maiúsculo são aceitos.
 */
const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';

const CROCKFORD_VALUE = new Map<string, bigint>(
  [...CROCKFORD].map((char, index) => [char, BigInt(index)]),
);

/**
 * Codifica o id do banco no formato público.
 *
 * @throws RangeError para id negativo (não existe `skill.id < 1`).
 */
export function encodeSkillId(id: bigint): string {
  if (id < 0n) {
    throw new RangeError(`skill id must be non-negative, received ${String(id)}`);
  }

  let remaining = id;
  let body = '';
  for (let index = 0; index < SKILL_ID_BODY_LENGTH; index += 1) {
    body = `${CROCKFORD.charAt(Number(remaining & 31n))}${body}`;
    remaining >>= 5n;
  }

  if (remaining > 0n) {
    throw new RangeError(
      `skill id does not fit ${SKILL_ID_BODY_LENGTH} Crockford characters: ${String(id)}`,
    );
  }

  return `${SKILL_ID_PREFIX}${body}`;
}

/**
 * Decodifica o id público de volta para o `bigint` do banco.
 *
 * Devolve `null` — nunca lança — para qualquer coisa que não seja `sk_` + 20
 * caracteres do alfabeto: o chamador traduz isso em 404, não em 500.
 */
export function decodeSkillId(value: string): bigint | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized.startsWith(SKILL_ID_PREFIX)) {
    return null;
  }
  const body = normalized.slice(SKILL_ID_PREFIX.length);
  if (body.length !== SKILL_ID_BODY_LENGTH) {
    return null;
  }

  let decoded = 0n;
  for (const char of body) {
    const digit = CROCKFORD_VALUE.get(char);
    if (digit === undefined) {
      return null;
    }
    decoded = (decoded << 5n) | digit;
  }
  return decoded;
}
