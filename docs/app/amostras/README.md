# Amostras da fonte de dados — skills.sh (F2.0)

**Data da coleta:** 2026-11-15 (UTC)
**Responsável:** orquestrador, com aprovação do dono
**Issue:** `chore(catalog): descobrir e congelar a fonte de dados do skills.sh`
**Método:** requisições HTTP públicas, 1 por segundo, apenas em páginas listadas no `sitemap.xml`.
Nenhum acesso a `/api/` ou `/search` — ambos **proibidos pelo `robots.txt`** do site.

## Decisão: **D3 — scraping de DOM**

| ID | Critério | Observação medida |
| --- | --- | --- |
| D1 | `application/json` público | **Não.** Não há endpoint JSON público; `/api/` é proibido pelo robots. |
| D2 | JSON embutido utilizável | **Parcial.** A página é Next.js App Router (`self.__next_f` × 21) e há JSON-LD, mas o JSON-LD traz só `name`, `description`, `url`, `publisher` — **sem as métricas**. |
| **D3** | **Dados só no DOM** | **Sim.** `Installs`, `GitHub Stars`, `Repository` e `First Seen` aparecem como texto renderizado (server-side) na página de detalhe. |
| D4 | Bloqueado / instável | Não. HTTP 200, HTML estável, `robots.txt` permite `Allow: /`. |
| D5 | Timebox estourado | Não. Decisão fechada na primeira sessão. |

**Consequência:** o adaptador `html` de `SkillSource` (`docs/app/02-arquitetura.md` §7 / ADR-003) é
o caminho. Nenhum código de rede no caminho da busca: a ingestão roda em job e grava no Postgres.

## Evidência bruta (arquivos nesta pasta)

| Arquivo | O que é | Números |
| --- | --- | --- |
| `home.html` / `home.headers` | página inicial | HTTP 200, `text/html; charset=utf-8`, 906 678 bytes, URL final `https://www.skills.sh/` (redirect 308 do apex) |
| `robots.txt` | política do site | `Allow: /` · `Disallow: /internal/`, `/debug-security/`, `/search`, `/api/` |
| `sitemap.xml` | índice de sitemaps | 4 sitemaps: `misc`, `owners`, `skills-1`, `skills-2` |
| `sitemap-skills-1.xml` | catálogo enumerável | **10 000 URLs** só neste arquivo |
| `skill-detalhe.html` / `.headers` | uma skill de exemplo | HTTP 200, `text/html`, 83 300 bytes — `https://www.skills.sh/vercel-labs/skills/find-skills` |
| `skills-sample-2026-11-15.json` | **amostra real, sanitizada** | **25 skills**, `SHA256SUMS` ao lado |
| `comando-descoberta.txt` | reprodução exata | o script versionado em `scripts/dev/collect-skills-sample.ps1` |

## Mapa campo → origem

| Campo do `SkillRecord` | Origem no site | Formato | Exemplo |
| --- | --- | --- | --- |
| `source_key` | path da URL, sem o domínio | `owner/repo/slug` | `vercel-labs/skills/find-skills` |
| `name` | `<title>` antes do `—` | texto | `find-skills` |
| `summary` | `<meta name="description">` | texto (HTML entities decodificadas) | "Helps users discover and install agent skills…" |
| `installs` | texto após o rótulo `Installs` | abreviado `4.4M`, `205.9K`, `121` | `4400000` |
| `stars` | texto após o rótulo `GitHub Stars` | abreviado | `39400` |
| `repository` | texto após `Repository` | `owner/repo` | `vercel-labs/skills` |
| `first_seen` | texto após `First Seen` | data | `Jan 26, 2026` |
| `vulnerabilities` | **não publicado pelo site** | — | **`null`** |
| `url` | a própria URL do sitemap | URL absoluta | `https://www.skills.sh/vercel-labs/skills/find-skills` |

## Achados que mudam o plano

1. **`vulnerabilities` não existe na fonte.** O site não publica contagem de vulnerabilidades. Pela
   regra 3 do `AGENTS.md` ("dado ausente é `null`, jamais zero"), o campo entra **`null`** e o
   `evidence_completeness` do item registra `missing_fields: ["vulnerabilities"]` com fator neutro
   0,5 e penalidade de 10%. O ranking continua determinístico, mas o fator `P` (peso 0,30) fica
   neutro para todo o catálogo — na prática, a ordem passa a ser decidida por estrelas (0,5) e
   instalações (0,2). **Decisão pendente do dono:** manter assim e documentar no capítulo de
   arquitetura, ou renormalizar os pesos quando o campo estiver ausente em todo o catálogo.
2. **`stars` é do repositório, não da skill.** Várias skills do mesmo repo compartilham o mesmo
   número (`aws/agent-toolkit-for-aws` → 3,5K em duas skills). Isso é aceitável como sinal de
   reputação da origem, e precisa estar escrito para a banca não ler como erro.
3. **O catálogo é grande.** ≥ 10 000 skills só no primeiro sitemap (há `skills-2`). A ingestão
   precisa paginar e limitar por `SKILL_SOURCE_RPS=1`, não tentar varrer tudo no boot.
4. **`robots.txt` fecha `/search` e `/api/`.** A busca semântica do site **não** pode ser usada como
   atalho: a recuperação é nossa (Postgres FTS + `pg_trgm`), como ADR-002 já definia.

## Sanitização

- Nenhum `cookie`, `authorization`, `token` ou header de sessão nos arquivos.
- Nenhuma requisição autenticada; todas as páginas são públicas.
- Amostra com 25 itens e < 200 KB; `sha256sum -c SHA256SUMS` valida a integridade.

## Reprodução

```powershell
# Windows (o script que gerou a amostra)
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dev/collect-skills-sample.ps1 -Count 25
```

```bash
# WSL/Ubuntu (descoberta bruta, sem amostra)
bash scripts/probe-skills-sh.sh
```
