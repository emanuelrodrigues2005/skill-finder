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
};

for (const [key, value] of Object.entries(TEST_ENV)) {
  if (process.env[key] === undefined) {
    process.env[key] = value;
  }
}

// Nenhum teste fala com a rede. O loopback fica liberado porque o Supertest sobe a
// aplicação em uma porta local efêmera — não é tráfego externo.
nock.disableNetConnect();
nock.enableNetConnect(
  (host: string) => host.includes('127.0.0.1') || host.includes('localhost'),
);

afterAll(() => {
  nock.cleanAll();
  nock.enableNetConnect();
});
