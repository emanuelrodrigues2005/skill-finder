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

function isLoopbackHost(host: string): boolean {
  const candidate = host.includes('://') ? host : `http://${host}`;
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(candidate).hostname.toLowerCase());
  } catch {
    return false;
  }
}

nock.disableNetConnect();
nock.enableNetConnect(isLoopbackHost);

afterAll(() => {
  nock.cleanAll();
  nock.enableNetConnect();
});
