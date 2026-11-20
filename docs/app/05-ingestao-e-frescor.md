# Ingestão e frescor do catálogo

Como o catálogo do skills.sh chega ao banco e como ele se mantém atualizado em
produção. Complementa `docs/app/02-arquitetura.md` §7.3 (o desenho) e §7.4
(degradação por idade).

## A ideia em uma frase

O catálogo é **local**: a ingestão copia uma fatia do skills.sh para a tabela
`skill`, e a busca lê um FTS no Postgres. Rápido e determinístico — o preço é que
cada skill tem uma idade, e é o rodízio que a mantém baixa.

Nada de raspar o site a cada busca. O `robots.txt` do skills.sh proíbe `/search` e
`/api/` para crawler; sitemap e página de detalhe são permitidos, e é só isso que
usamos.

## As duas fontes (e por que a escolha importa)

| `SKILL_SOURCE_KIND` | O que lê | Para que serve |
| --- | --- | --- |
| `fixture` | 25 skills de `backend/test/fixtures` | desenvolvimento e testes, sem rede |
| `html` | sitemap + página de detalhe do skills.sh, a 1 req/s | **produção** |

`make seed` **nunca** consulta a rede: ele chama a ingestão com a fixture fixa,
independente da configuração. Em produção, `make seed` injeta 25 skills de teste no
catálogo — não rode.

## O ciclo

`pnpm --dir backend ingest` executa **um** ciclo do rodízio (precisa de `scripts/` e `ts-node`,
então roda a partir do repositório, não da imagem de produção):

1. `selectRotationKeys` — até 360 chaves **hot** (as que apareceram em `search_request` nos últimos 7 dias) e o resto **cold** (as mais antigas primeiro);
2. `selectUnseenKeys` — chaves do sitemap que ainda não são linha ativa;
3. `planCycle` — hot → **inéditas** (cota reservada) → cold, cortando em 720;
4. `fetchSkills(keys)` — uma requisição por chave, a 1 req/s;
5. upsert, expurgo por idade (28 dias) e fechamento do `ingest_run`.

A prioridade existe por um motivo: se o cold consumisse o ciclo inteiro, o catálogo
nunca cresceria além das primeiras 720 chaves — foi o defeito que a #46 corrigiu,
com teste de regressão.

## Aritmética

```
20.000 skills ÷ 720 por ciclo = 28 ciclos
28 ciclos × 6 h              = 7 dias por passada completa
4 ciclos por dia             = 2.880 requisições/dia (≈3% do dia ocupado)
```

| Fase | Duração | O que acontece |
| --- | --- | --- |
| bootstrap | ~14 dias | as inéditas entram primeiro; o catálogo sai de 0 para 20.000 |
| regime | 7–14 dias por volta | cada skill é re-buscada dentro do TTL de 14 dias |
| desativação | 28 dias | quem sumiu do sitemap sai de `is_active` |

**Não é tempo real.** É "cada skill tem no máximo ~2 semanas de idade". O
`source_stale` de 12 h mede o **ciclo**, não a skill individual.

Para cobrir o intervalo entre ciclos existe o **enriquecimento ao vivo**
(`LIVE_ENRICH_ENABLED`): quando a busca local volta vazia, o sitemap é filtrado pelo
slug e até `LIVE_ENRICH_MAX_KEYS` chaves são ingeridas na hora. Ele é rede de
segurança, não a fonte principal.

## Rodar em produção

A imagem `runtime` não carrega `scripts/` nem `ts-node` (`backend/Dockerfile`), então o
host de produção **não** executa o ciclo: não há CLI ali. Em produção a ingestão é
**pela API**, com a stack no ar e o `ADMIN_TOKEN` do `.env` (`chmod 600`):

```bash
curl -fsS -X POST "http://$IP/api/v1/admin/ingest" \
  -H "X-Admin-Token: $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"source_keys":["vercel-labs/skills/find-skills"]}'
```

`202` com o resultado do run; `409` se outra ingestão estiver em curso; **1 a 20**
`source_keys` por request (`owner/repo/slug`).

A rota **não** substitui o rodízio: ela atualiza as chaves pedidas, não escolhe as 720 do
ciclo. O ciclo de 720 em produção precisa de um agendador que consiga executar o CLI —
um checkout com o repositório e `ts-node`, ou uma imagem de ferramenta —, e é isso que a
F4/F5 resolve. Enquanto ele não existe, o catálogo de produção cresce pelo
enriquecimento ao vivo e pelas chamadas admin.

O agendador, quando existir, é **externo** ao processo: o comando roda o ciclo inteiro e
sai. Isso evita dependência nova no `package.json` (o CI instala com `--frozen-lockfile`)
e mantém o relógio no deploy. A forma que não depende do CLI na máquina é um job agendado
que faz SSH em um host **com o repositório** e roda `pnpm --dir backend ingest` lá; segredos
ficam nos *secrets* do repositório, nunca no workflow.

## Código de saída (o que acorda quem está de plantão)

| `status` | `exit` | Significado |
| --- | --- | --- |
| `ok` | 0 | o ciclo entregou o que pediu |
| `partial` | 0 | entregou menos (`LOW_CYCLE_COVERAGE`) ou teve chave faltando — registrado, não é alarme |
| `failed` | 1 | a fonte ou o banco falhou; nada foi desativado |

`partial` não vira `exit 1` de propósito: com 720 chaves por ciclo, uma chave
removida do sitemap é rotina. Quem precisa do detalhe lê `ingest_run.error_code`.

## O que monitorar

1. `catalog_snapshot_age_seconds > 43200` (12 h) — o agendador parou.
2. `search_degraded_total{reason="source_stale"}` crescendo — o mesmo, visto pelo usuário.
3. `ingest_run.error_code = LOW_CYCLE_COVERAGE` repetido — o scraper está entregando menos que o pedido (layout mudou, seletor quebrou).
4. `ingest_run.error_code = REPOSITORY_FAILED` — banco.
5. **Não** use `ingest_run.items_seen` como "tamanho do catálogo": ele vale ~720 por ciclo. Para o total, `countActiveSkills` ou `/api/v1/skills`.

## Variáveis

| Variável | Padrão | Papel |
| --- | --- | --- |
| `SKILL_SOURCE_KIND` | `fixture` | **em produção: `html`** |
| `SKILL_SOURCE_RPS` | `1` | requisições por segundo contra a fonte |
| `SKILL_SOURCE_BASE_URL` | `https://www.skills.sh` | base do adaptador |
| `LIVE_ENRICH_ENABLED` | `false` | enriquecimento sob demanda quando a busca volta vazia |
| `LIVE_ENRICH_MAX_KEYS` | `12` | teto de chaves por enriquecimento |
| `ADMIN_TOKEN` | — | **obrigatório em `prod`**; o boot recusa subir sem ele |

## Bootstrap depois do deploy

Um catálogo novo leva ~14 dias para encher pelo ciclo normal. Para a demo, force lotes em
série pela rota admin — 20 chaves por chamada, uma chamada por vez (a segunda recebe `409`
enquanto a primeira roda):

```bash
# chaves.txt: uma chave owner/repo/slug por linha
split -l 20 chaves.txt lote-
for lote in lote-*; do
  jq -Rsc 'split("\n")[:-1] | {source_keys: .}' "$lote" > corpo.json
  curl -fsS -X POST "http://$IP/api/v1/admin/ingest" \
    -H "X-Admin-Token: $ADMIN_TOKEN" -H 'Content-Type: application/json' \
    -d @corpo.json >/dev/null
done
```

Cada execução grava a sua linha em `ingest_run`, então o progresso é auditável — e o
total do catálogo continua sendo `countActiveSkills`, não `items_seen`.
