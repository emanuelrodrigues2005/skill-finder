/**
 * Issue #47 — o enum de fonte do catálogo passa a ser `html | fixture`.
 *
 * O valor `json` era ficção: o skills.sh não publica endpoint JSON público
 * (`/api/` é proibido pelo `robots.txt`), como a descoberta da F2.0 registrou em
 * `docs/app/amostras/README.md` (decisão D3). Manter `json` no enum permitiria
 * subir a aplicação com `SKILL_SOURCE_KIND=json` — um valor que não existe em
 * adaptador nenhum. O teste vive em arquivo próprio para não mexer no spec de
 * configuração existente.
 */
import { loadEnv } from '@/config/env.schema';

describe('env schema — fonte do catálogo', () => {
  it('aceita html e fixture', () => {
    expect(loadEnv({ ENV: 'dev', SKILL_SOURCE_KIND: 'html' }).skillSourceKind).toBe('html');
    expect(loadEnv({ ENV: 'dev', SKILL_SOURCE_KIND: 'fixture' }).skillSourceKind).toBe('fixture');
  });

  it('mantém fixture como default de dev/CI', () => {
    expect(loadEnv({ ENV: 'dev' }).skillSourceKind).toBe('fixture');
  });

  it.each([['json'], ['xml'], ['HTML']])('recusa SKILL_SOURCE_KIND=%s', (kind) => {
    expect(() => loadEnv({ ENV: 'dev', SKILL_SOURCE_KIND: kind })).toThrow(/SKILL_SOURCE_KIND/);
  });
});
