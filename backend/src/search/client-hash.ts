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
 * `sha256(sal:ip)`, exatamente como a coluna `client_hash` de §4.1 documenta.
 *
 * `salt` é opcional só porque `IP_HASH_SALT` é opcional fora de produção
 * (`env.schema.ts` exige o sal quando `ENV=prod`); ausente, o hash continua
 * determinístico e estável, que é o que o bucket precisa.
 */
/**
 * Resolve o IP do cliente do jeito que a borda escreve: `X-Real-IP` (o nginx
 * sobrescreve com `$remote_addr`) e `req.ip` como fallback de quem fala direto
 * com a API em dev.
 *
 * Existe para o rate limit e a coluna `client_hash` falarem do MESMO cliente.
 * Antes, o guard lia `X-Real-IP` e o serviço lia `req.ip`: atrás do nginx os
 * dois coincidiam, mas fora dele (testes, acesso direto) o bucket e o histórico
 * descreviam clientes diferentes — a divergência silenciosa que este módulo
 * existe para evitar.
 */
export function resolveClientIp(request: {
  headers?: Record<string, unknown>;
  ip?: string | undefined;
}): string {
  const raw = request.headers?.['x-real-ip'];
  const header = Array.isArray(raw) ? (raw as unknown[])[0] : raw;
  if (typeof header === 'string' && header.trim() !== '') {
    return header.trim();
  }
  return request.ip ?? '';
}
export function clientHash(clientIp: string, salt: string | undefined): string {
  return sha256Hex(`${salt ?? ''}:${clientIp}`);
}
