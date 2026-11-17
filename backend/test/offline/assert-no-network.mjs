#!/usr/bin/env node
/**
 * Canário de rede do `make offline-check` — issue #12, fase 2.
 *
 * Contrato: **exit 0 só quando as duas sondas falham**. Se qualquer uma alcançar
 * a rede, exit 1 com "a prova não vale, rede alcançável". É isso que impede o
 * gate de ser decorativo: rodar este arquivo fora do `unshare -rn` precisa dar
 * vermelho nesta máquina.
 *
 * As duas sondas cobrem os dois caminhos que a suíte tentaria usar se escapasse:
 * - TCP para 1.1.1.1:443 — o `net.Socket` cru, que é o que o `pg` usa e que o
 *   `nock.disableNetConnect()` **não** intercepta (ele patcheia `http(s)`);
 * - `dns.lookup('skills.sh')` — resolve o host do catálogo (evidência de que o
 *   caminho do `skills.sh` está fora).
 *
 * Timeout curto e sem retry: no netns a falha é imediata (ENETUNREACH); fora
 * dele, conectar é a resposta e espera é ruído.
 */

import dns from 'node:dns/promises';
import net from 'node:net';

const TIMEOUT_MS = 3000;
const TCP_HOST = '1.1.1.1';
const TCP_PORT = 443;
const DNS_HOST = 'skills.sh';

/** `true` = alcançou a rede. Nunca lança; sempre libera o socket. */
function probeTcp(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const settle = (reachable, detail) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve({ reachable, detail });
    };

    socket.setTimeout(TIMEOUT_MS);
    socket.once('connect', () => settle(true, 'conectou (handshake TCP completo)'));
    // Sem resposta não é "bloqueado", é ambíguo; na dúvida, o gate trata como
    // bloqueado e o operador vê o motivo na linha acima.
    socket.once('timeout', () => settle(false, 'timeout: nenhum pacote de volta'));
    socket.once('error', (error) => settle(false, `erro ${error.code ?? error.message}`));
  });
}

function timeoutAfter(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    // Não segurar o event loop: se o DNS responder, o processo pode sair.
    timer.unref?.();
  });
}

async function probeDns(host) {
  try {
    const address = await Promise.race([dns.lookup(host), timeoutAfter(TIMEOUT_MS)]);
    if (address === null) {
      return { reachable: false, detail: `timeout apos ${TIMEOUT_MS} ms` };
    }
    return { reachable: true, detail: `resolveu ${address.address}` };
  } catch (error) {
    return { reachable: false, detail: `falhou ${error.code ?? error.message}` };
  }
}

const probes = [
  { name: `tcp ${TCP_HOST}:${TCP_PORT}`, run: () => probeTcp(TCP_HOST, TCP_PORT) },
  { name: `dns ${DNS_HOST}`, run: () => probeDns(DNS_HOST) },
];

console.log('canario de rede (esperado: TODAS as sondas bloqueadas)');

const results = [];
for (const probe of probes) {
  const outcome = await probe.run();
  results.push({ name: probe.name, ...outcome });
  const label = outcome.reachable ? 'ALCANCOU' : 'bloqueado';
  console.log(`  ${label.padEnd(9)} ${probe.name}: ${outcome.detail}`);
}

const reached = results.filter((result) => result.reachable);
if (reached.length > 0) {
  console.error(
    `\nFALHA: a prova nao vale, rede alcancavel (${reached.map((r) => r.name).join(', ')}).\n` +
      'Sem a rede bloqueada de verdade, "a suite passou offline" nao prova nada.',
  );
  process.exit(1);
}

console.log('\nok: nenhuma sonda alcancou a rede. A suite roda sem internet.');
process.exit(0);
