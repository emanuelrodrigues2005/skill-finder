import { DEV_CORS_OPTIONS } from '@/main';

/**
 * Gate do CORS de desenvolvimento.
 *
 * O CORS é o tipo de configuração que alguém "conserta" quando o navegador
 * reclama de um header, e a primeira tentativa costuma ser abrir a lista. Duas
 * propriedades não podem regredir:
 *
 * 1. `admin` nunca entra em `allowedHeaders`: `X-Admin-Token` vindo do navegador
 *    transformaria a superfície de ingestão em alcançável pela SPA.
 * 2. a origem nunca vira `*`: em dev a API aceita apenas as origens do Vite.
 *
 * O CORS só é habilitado fora de produção; em produção a SPA e a API
 * compartilham a origem pelo nginx e não há preflight.
 */
describe('development CORS policy', () => {
  it('never allows the admin token header', () => {
    const adminHeaders = DEV_CORS_OPTIONS.allowedHeaders.filter((header) => /admin/i.test(header));
    expect(adminHeaders).toEqual([]);
  });

  it('never uses a wildcard origin', () => {
    expect(DEV_CORS_OPTIONS.origin).not.toContain('*');
    expect(Array.isArray(DEV_CORS_OPTIONS.origin)).toBe(true);
  });

  it('only opens the methods the API actually serves', () => {
    expect([...DEV_CORS_OPTIONS.methods]).toEqual(['GET', 'POST']);
  });

  // A direção oposta também precisa de gate: se alguém esvaziar `allowedHeaders`,
  // a SPA quebra todo POST com `content-type` e os testes acima continuam verdes.
  it('keeps the headers the SPA actually sends', () => {
    expect([...DEV_CORS_OPTIONS.allowedHeaders]).toEqual(
      expect.arrayContaining(['content-type', 'x-request-id']),
    );
  });
});
