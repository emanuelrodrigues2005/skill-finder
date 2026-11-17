// check-ci.mjs — valida o ci.yml sem depender de shell quoting.
// Lê o parse e checa as invariantes que o workflow promete.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../backend/', import.meta.url));
const YAML = require('yaml');

const doc = YAML.parse(readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8'));

const jobs = Object.keys(doc.jobs);
const problems = [];
const need = ['lint', 'typecheck', 'test-unit', 'test-e2e', 'test-integration', 'test-web', 'contract', 'secrets'];

for (const j of need) if (!jobs.includes(j)) problems.push(`job ausente: ${j}`);
for (const [name, job] of Object.entries(doc.jobs)) {
  if (!job['timeout-minutes']) problems.push(`${name}: sem timeout-minutes`);
  if (name.startsWith('-')) problems.push(`${name}: id invalido`);
}
if (doc.on?.pull_request !== null) problems.push('pull_request tem filtro (deveria ser null)');
if (JSON.stringify(doc.on?.push?.branches) !== '["main"]') problems.push('push.branches != [main]');
if (doc.permissions?.contents !== 'read') problems.push('permissions.contents != read');
if (doc.permissions?.['pull-requests'] !== 'read') problems.push('permissions.pull-requests != read');
if (!doc.concurrency?.['cancel-in-progress']) problems.push('sem cancel-in-progress');

const raw = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
for (const bad of ['pull_request_target', 'actions/cache', 'matrix:', 'dorny']) {
  if (raw.includes(bad)) problems.push(`armadilha presente: ${bad}`);
}

const services = Object.entries(doc.jobs).filter(([, j]) => j.services?.postgres);
const ports = services.map(([, j]) => JSON.stringify(j.services.postgres.ports));

console.log('jobs      :', jobs.join(', '));
console.log('gatilho   :', JSON.stringify(doc.on));
console.log('permissoes:', JSON.stringify(doc.permissions));
console.log('runs-on   :', [...new Set(Object.values(doc.jobs).map((j) => j['runs-on']))].join(', '));
console.log('services  :', services.map(([n]) => n).join(', '), '->', ports.join(' '));
console.log(problems.length === 0 ? '\nOK: nenhum problema' : `\nPROBLEMAS:\n- ${problems.join('\n- ')}`);
process.exit(problems.length === 0 ? 0 : 1);
