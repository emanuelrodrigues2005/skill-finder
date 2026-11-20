import nock from 'nock';

// `TZ` antes de qualquer `Date`: o log e os timestamps são UTC.
process.env.TZ = 'UTC';

// Configuração mínima dos testes; nunca sobrescreve o que o ambiente já definiu.
const TEST_ENV: Record<string, string> = {
  ENV: 'dev',
  LOG_LEVEL: 'error',
  DATABASE_URL: 'postgresql://skills:skills@127.0.0.1:5432/skills_test',
  LLM_ENABLED: 'false',
  SKILL_SOURCE_KIND: 'fixture',
  // O default de dev (10/min) e o de 60/dia são para um cliente real, não para
  // uma suíte e2e que faz ~10 buscas do mesmo IP de loopback e testaria 429 sem
  // querer. Um teste de rate limit fixa o próprio teto; aqui o default é alto.
  RATE_LIMIT_SEARCH_PER_MIN: '1000',
  RATE_LIMIT_SEARCH_PER_DAY: '10000',
  // Token de operador das rotas de admin (#49). Em dev ele é opcional e a rota
  // falha fechada sem ele; a suíte precisa de um valor conhecido para provar o
  // caminho autorizado.
  ADMIN_TOKEN: 'test-admin-token-com-32-caracteres-ok',
};

for (const [key, value] of Object.entries(TEST_ENV)) {
  if (process.env[key] === undefined) {
    process.env[key] = value;
  }
}

// Nenhum teste fala com a rede. O loopback fica liberado porque o Supertest sobe a
// aplicação em uma porta local efêmera — não é tráfego externo.
//
// A comparação é de hostname exato, nunca `includes`: `localhost.exemplo.invalido`
// contém "localhost" e abriria socket real, mentindo sobre a regra 5.
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function hostOf(value: string): string | null {
  const candidate = value.includes('://') ? value : `http://${value}`;
  try {
    return new URL(candidate).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isLoopbackHost(host: string): boolean {
  const hostname = hostOf(host);
  return hostname !== null && LOOPBACK_HOSTNAMES.has(hostname);
}

// Um `DATABASE_URL` exportado no shell apontando para um banco remoto faria a
// suíte falar com produção. `nock.disableNetConnect()` não impede isso: o nock
// intercepta `http(s)`, não `net.Socket`, e o `pg` abre socket cru. A regra 5
// proíbe dependência externa, não loopback — loopback segue permitido porque o
// Supertest sobe a aplicação em uma porta local efêmera.
const DATABASE_URL = process.env.DATABASE_URL;
if (DATABASE_URL && !isLoopbackHost(DATABASE_URL)) {
  const host = hostOf(DATABASE_URL) ?? '<invalido>';
  throw new Error(
    `DATABASE_URL aponta para "${host}", que nao e loopback. ` +
      'Os testes nao abrem socket externo (AGENTS.md regra 5): use 127.0.0.1, localhost ou ::1.',
  );
}

nock.disableNetConnect();
nock.enableNetConnect(isLoopbackHost);

afterAll(() => {
  nock.cleanAll();
  nock.enableNetConnect();
});
