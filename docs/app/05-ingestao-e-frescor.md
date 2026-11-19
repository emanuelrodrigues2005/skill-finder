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

`make ingest` (ou `pnpm --dir backend ingest`) executa **um** ciclo do rodízio:

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

## Agendar em produção

O agendador é **externo** ao processo: o comando roda o ciclo inteiro e sai. Isso
evita dependência nova no `package.json` (o CI instala com `--frozen-lockfile`), e
o relógio fica onde pertence — no deploy (F3/F4).

### crontab (host ou EC2)

```cron
# a cada 6 h; o log guarda uma linha por ciclo ("ingest: status=... pedidas=720 ...")
0 */6 * * *  cd /srv/skill-finder && make ingest >> /var/log/skill-finder-ingest.log 2>&1
```

### systemd timer

`/etc/systemd/system/skill-finder-ingest.service`

```ini
[Unit]
Description=Skill Finder — um ciclo de ingestao do catalogo
After=docker.service

[Service]
Type=oneshot
WorkingDirectory=/srv/skill-finder
ExecStart=/usr/bin/make ingest
```

`/etc/systemd/system/skill-finder-ingest.timer`

```ini
[Unit]
Description=Skill Finder — ingestao a cada 6 h

[Timer]
OnBootSec=10min
OnUnitActiveSec=6h

[Install]
WantedBy=timers.target
```

```bash
systemctl enable --now skill-finder-ingest.timer
```

### GitHub Actions (agendado)

Útil quando o deploy ainda não existe:

```yaml
on:
  schedule:
    - cron: "0 */6 * * *"
  workflow_dispatch:
```

O job faz SSH na instância e roda `make ingest`. Segredos ficam nos *secrets* do
repositório — nunca no workflow.

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

Um catálogo novo leva ~14 dias para encher pelo ciclo normal. Para a demo, force
alguns ciclos em sequência:

```bash
for i in $(seq 1 5); do make ingest; done   # ~5 × 12 min
```

Cada execução grava a sua linha em `ingest_run`, então o progresso é auditável.
