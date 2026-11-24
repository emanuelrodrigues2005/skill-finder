/**
 * Identidade pseudonimizada do cliente (§8.5, D2 da issue #13).
 *
 * O IP nunca é gravado em claro: o histórico guarda `client_hash` e o rate limit
 * conta no mesmo bucket. Como o sal (`IP_HASH_SALT`) é segredo, o hash não é
 * reversível por força bruta de IPv4 — sem o sal, um espaço de 2³² endereços
 * cairia em segundos.
 *
 * A função é pura e mora aqui (e não no serviço) porque **dois** consumidores
 * precisam do mesmo valor: `SearchService` (coluna `client_hash` de
 * `search_request`) e `SearchThrottlerGuard` (chave do bucket). Duas
 * implementações do mesmo hash divergiriam em silêncio e o limite deixaria de
 * contar o histórico do mesmo cliente.
 */
import { createHash } from 'node:crypto';

/** sha256 hex — usado no `client_hash` e no `query_hash` (§4.1). */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Resolve o IP do cliente: `req.ip`, que com `trust proxy = 1` (`main.ts`) é a
 * **última** entrada do `X-Forwarded-For` — a que o ALB anexa (ADR-015).
 *
 * Nenhum header de IP escrito pelo cliente é lido: o ALB não sobrescreve o que
 * ele manda, então o valor seria escolhido por quem faz a requisição — um bucket
 * de rate limit novo a cada header e um `client_hash` forjável no histórico.
 *
 * Existe para o rate limit e a coluna `client_hash` falarem do MESMO cliente.
 */
export function resolveClientIp(request: { ip?: string | undefined }): string {
  return request.ip ?? '';
}

/**
 * `sha256(sal:ip)`, exatamente como a coluna `client_hash` de §4.1 documenta.
 *
 * `salt` é opcional só porque `IP_HASH_SALT` é opcional fora de produção
 * (`env.schema.ts` exige o sal quando `ENV=prod`); ausente, o hash continua
 * determinístico e estável, que é o que o bucket precisa.
 */
export function clientHash(clientIp: string, salt: string | undefined): string {
  return sha256Hex(`${salt ?? ''}:${clientIp}`);
}
