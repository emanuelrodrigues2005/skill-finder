/**
 * Issue #12 — as bordas de identidade da busca: `ids.ts` (50% de branches),
 * `client-hash.ts` (77,8%) e `request-id.ts` (50%).
 *
 * Nenhum destes três é decorativo:
 *
 * - `encodeSkillId`/`decodeSkillId` são o par que traduz `bigint` do banco para
 *   `sk_...` do contrato (D-B). Um `encode` que aceitasse id negativo ou maior
 *   que os 100 bits do corpo devolveria um id que o próprio `decode` não lê, e a
 *   rota `/skills/{skill_id}` viraria 500 em vez de 404;
 * - `resolveClientIp` é o que faz o **bucket do rate limit** e o `client_hash` do
 *   histórico falarem do mesmo cliente. Depois da ADR-015 ele lê só `req.ip`
 *   (com `trust proxy = 1`, a última entrada do `X-Forwarded-For`): `X-Real-IP`
 *   é header que o cliente escolhe e o ALB não apaga, então ignorá-lo é o que
 *   impede o atacante de escolher o próprio bucket;
 * - `requestIdOf` devolve o id do middleware ou cunha um novo — nunca `undefined`
 *   no corpo da resposta.
 *
 * O caminho feliz de cada um já é coberto pela suíte `api`/`unit`; aqui ficam as
 * bordas que ninguém exercita por acidente.
 */
import type { RequestWithRequestId } from '@/common/request-id.middleware';
import { clientHash, resolveClientIp, sha256Hex } from '@/search/client-hash';
import { decodeSkillId, encodeSkillId, SKILL_ID_BODY_LENGTH, SKILL_ID_PREFIX } from '@/search/ids';
import { mintSearchRequestId, requestIdOf, stampSearchRequestId } from '@/search/request-id';

describe('ids — bordas do encode', () => {
  it('refuses a negative id: there is no `skill.id < 1`', () => {
    expect(() => encodeSkillId(-1n)).toThrow(RangeError);
    expect(() => encodeSkillId(-1n)).toThrow(/non-negative/);
  });

  it('refuses an id that does not fit the 100 bits of the body', () => {
    // O corpo tem 20 caracteres de Crockford = 100 bits.
    const max = 2n ** 100n - 1n;
    expect(encodeSkillId(max)).toMatch(/^sk_[a-z0-9]{20}$/);

    expect(() => encodeSkillId(2n ** 100n)).toThrow(RangeError);
    expect(() => encodeSkillId(2n ** 100n)).toThrow(/does not fit/);
  });

  it('round-trips zero and the largest id the format carries', () => {
    for (const id of [0n, 1n, 42n, 2n ** 100n - 1n]) {
      expect(decodeSkillId(encodeSkillId(id))).toBe(id);
    }
    expect(encodeSkillId(0n)).toBe(`${SKILL_ID_PREFIX}${'0'.repeat(SKILL_ID_BODY_LENGTH)}`);
  });
});

describe('ids — bordas do decode', () => {
  it('answers null, never throws, for anything that is not a string', () => {
    expect(decodeSkillId(42 as unknown as string)).toBeNull();
    expect(decodeSkillId(null as unknown as string)).toBeNull();
  });

  it('answers null for a body with a character outside the alphabet', () => {
    // `i`, `l`, `o` e `u` estão fora do alfabeto de propósito.
    expect(decodeSkillId(`${SKILL_ID_PREFIX}${'u'.repeat(SKILL_ID_BODY_LENGTH)}`)).toBeNull();
    expect(decodeSkillId(`${SKILL_ID_PREFIX}${'i'.repeat(SKILL_ID_BODY_LENGTH)}`)).toBeNull();
  });

  it('answers null for a wrong prefix or a wrong body length', () => {
    expect(decodeSkillId(`xx_${'0'.repeat(SKILL_ID_BODY_LENGTH)}`)).toBeNull();
    expect(decodeSkillId(`${SKILL_ID_PREFIX}0`)).toBeNull();
  });

  it('accepts upper case and surrounding spaces (the id is typed by a human)', () => {
    const id = encodeSkillId(1234n);

    expect(decodeSkillId(`  ${id.toUpperCase()}  `)).toBe(1234n);
  });
});

describe('client-hash — resolução do IP e do hash', () => {
  it('ignores a forged `X-Real-IP`: the identity is `req.ip` (ADR-015)', () => {
    // O ALB não escreve `X-Real-IP` nem apaga o que o cliente mandou. Com
    // `trust proxy = 1`, `req.ip` já é a última entrada do `X-Forwarded-For` —
    // a que o ALB anexou —, e é a única fonte que o cliente não escolhe.
    const request = { headers: { 'x-real-ip': '1.2.3.4' }, ip: '200.10.20.30' };

    expect(resolveClientIp(request)).toBe('200.10.20.30');
  });

  it('answers `req.ip` as-is and an empty string when the request has none', () => {
    expect(resolveClientIp({ ip: '203.0.113.9' })).toBe('203.0.113.9');
    expect(resolveClientIp({})).toBe('');
  });

  it('hashes the salt together with the IP, and the salt changes the hash', () => {
    const hash = clientHash('203.0.113.9', 'sal-de-teste');

    expect(hash).toBe(sha256Hex('sal-de-teste:203.0.113.9'));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    // Sem sal o hash continua determinístico, mas é outro valor: o sal é o que
    // impede reverter um IPv4 por força bruta (§8.5).
    expect(clientHash('203.0.113.9', undefined)).toBe(sha256Hex(':203.0.113.9'));
    expect(clientHash('203.0.113.9', undefined)).not.toBe(hash);
  });
});

describe('request-id — o id que a resposta devolve', () => {
  it('mints a `req_` + ULID id', () => {
    expect(mintSearchRequestId()).toMatch(/^req_[0-9A-Z]{26}$/);
    expect(mintSearchRequestId()).not.toBe(mintSearchRequestId());
  });

  it('echoes the middleware id, and mints one when there is none', () => {
    const withId = { requestId: 'req_01JCV8Y6Q4EXISTE00000000' } as unknown as RequestWithRequestId;
    expect(requestIdOf(withId)).toBe('req_01JCV8Y6Q4EXISTE00000000');

    const withoutId = {} as unknown as RequestWithRequestId;
    expect(requestIdOf(withoutId)).toMatch(/^req_[0-9A-Z]{26}$/);
  });

  it('stamps the response header with the id the body carries', () => {
    const headers = new Map<string, string>();
    const response = {
      setHeader: (name: string, value: string): void => {
        headers.set(name, value);
      },
    };

    stampSearchRequestId(response as unknown as Parameters<typeof stampSearchRequestId>[0], 'req_01JCV8Y6Q4STAMP00000000');

    expect(headers.get('X-Request-ID')).toBe('req_01JCV8Y6Q4STAMP00000000');
  });
});
