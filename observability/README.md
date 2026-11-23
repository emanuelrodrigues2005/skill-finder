# Observabilidade — profile `obs`

A stack vive no `compose.yaml` da raiz sob `profiles: ["obs"]` e não sobe por
acidente em `dev` nem em `prod`. A decisão de ficar neste arquivo (e não num
`compose.obs.yaml`) e a de não usar Telegraf nem cAdvisor estão na **ADR-009** de
[`docs/app/02-arquitetura.md`](../docs/app/02-arquitetura.md) §10.

```bash
docker compose --profile dev --profile obs up -d      # aplicação + observabilidade
docker compose --profile obs up -d                    # só observabilidade (alvos ficam `down` sem a api)
docker compose --profile obs down                     # derruba; os volumes continuam
docker compose --profile obs down -v                  # apaga também os dados coletados
```

Em `prod`, antes de ligar o profile: `GRAFANA_PASSWORD` é obrigatória. Sem a
variável o Grafana sobe com a senha padrão do fabricante — aceitável só em
máquina local.

## O que sobe

| Serviço | Imagem (pinada) | Porta (loopback) | `mem_limit` | Guarda |
| --- | --- | --- | --- | --- |
| `prometheus` | `prom/prometheus:v2.55.1` | `127.0.0.1:9090` | 320 M | série de `api:8000/metrics` e de `node-exporter:9100`, 15 s |
| `loki` | `grafana/loki:3.3.2` | `127.0.0.1:3100` | 384 M | log de todos os containers do projeto |
| `promtail` | `grafana/promtail:3.3.2` | — | 96 M | só a posição de leitura (`/var/lib/promtail`) |
| `node-exporter` | `prom/node-exporter:v1.8.2` | `127.0.0.1:9100` | 64 M | — |
| `grafana` | `grafana/grafana:11.4.0` | `127.0.0.1:3000` | 384 M | datasources, dashboard e usuários (`grafana-data`) |

Soma dos tetos: **1,22 GiB**. Não é o uso — é o que o kernel pode cobrar de um
`t3.small` de 2 GB se tudo disparar. O uso medido fica bem abaixo
(`docker stats --no-stream`).

Todas as portas são publicadas em `127.0.0.1`: Prometheus, Loki e Grafana não têm
autenticação própria para tráfego de leitura e a borda do projeto é o nginx.

## Retenção

| Onde | Janela | Teto de disco | Quem aplica |
| --- | --- | --- | --- |
| Prometheus (TSDB) | 7 dias | 512 MB | `--storage.tsdb.retention.time` **e** `--storage.tsdb.retention.size`, o que vier primeiro |
| Loki (chunks + índice TSDB) | 168 h | volume `loki-data` | `limits_config.retention_period` + `compactor` com `retention_enabled` |
| Log do Docker de cada container | — | 10 MB × 3 arquivos | `logging.options.max-size` / `max-file` no `compose.yaml` |

7 dias nos dois lados é o mesmo horizonte que a janela dos painéis (`now-6h`) e a
da demo: guardar mais custa disco sem responder pergunta nova. O `json-file` com
teto é o que impede os 20 GiB de EBS de encherem — antes dele, nada no repositório
limitava o log de container.

## Os 4 painéis (`grafana/dashboards/main.json`)

Provisionado por arquivo (`grafana/provisioning/dashboards/dashboards.yml`):
edição no navegador não sobrevive ao restart. Pasta **Skill Finder**, uid
`skill-finder-main`.

| # | Painel | Consulta | Quando olhar |
| --- | --- | --- | --- |
| 1 | RED da API | `sum by (route) (rate(http_requests_total[5m]))` · `sum by (status) (rate(http_requests_total{status=~"5.."}[5m]))` · `histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket[5m])))` | taxa cair a zero (API morta) ou 5xx aparecer |
| 2 | Pipeline de busca e LLM | `sum by (status) (rate(llm_calls_total[5m]))` · `sum by (reason) (rate(search_degraded_total[5m]))` | `llm` com `timeout`/`invalid_json` subindo, `degradado` com `source_stale` |
| 3 | Catálogo | `catalog_snapshot_age_seconds` (linha vermelha em 43200 s = 12 h) | a idade só cresce: ingestão parada |
| 4 | Logs de erro da API | `{service=~"api(-dev)?", level="error"}` (Loki, painel de log) | investigar o que o painel 1 ou 2 apontou |

O painel 4 consulta por **rótulo**, não por substring: `level` já é rótulo
extraído pelo Promtail do JSON da aplicação. Rótulos `query`, `query_hash` e
`client_hash` não existem de propósito — são entrada de usuário e explodiriam o
índice do Loki (§9.2).

O painel 4 de §9.3 também previa `llm_injection_suspected_total`, e os painéis 2 e
3 previam etapa, token, fallback e `skills_total`. **Nenhuma dessas métricas
existe no código ainda** (`backend/src/common/metrics/metrics.service.ts` publica
cinco). Os painéis consultam as que existem; quando a métrica nascer, o painel
ganha a série sem mudar de forma.

## Consultas de verificação

```bash
# 1. todos os alvos `up` (0 linhas = tudo certo)
curl -s localhost:9090/api/v1/targets | jq '[.data.activeTargets[] | select(.health != "up")] | length'

# 2. tráfego chegando depois de ~20 buscas
curl -s 'localhost:9090/api/v1/query?query=sum(rate(http_requests_total[5m]))' | jq '.data.result[0].value[1]'

# 3. Grafana vivo
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/api/health

# 4. log de erro no Loki (provocado, não inventado)
curl -s -G localhost:3100/loki/api/v1/query_range \
  --data-urlencode 'query={service=~"api(-dev)?", level="error"}' --data-urlencode 'limit=5' | jq '.data.result | length'

# 5. memória real contra os tetos
docker stats --no-stream --format '{{.Name}} {{.MemUsage}}'
```

## Rollback

A stack é aditiva: nada em `dev`/`prod` depende dela para funcionar.

1. `docker compose --profile obs down` — para os 5 containers e remove a rede do
   projeto; os volumes ficam.
2. Se o problema for o `logging:` (por exemplo, driver `json-file` removido do
   daemon), voltar o bloco é uma edição de `compose.yaml` e `up -d` de novo.
3. Se o problema for o `promtail` lendo `/var/lib/docker`, `docker compose
   --profile obs stop promtail` o isola: Prometheus e Grafana continuam de pé.

## Riscos aceitos

- **`promtail` monta `/var/run/docker.sock` (read-only).** É o preço de rotular o
  log com o nome do serviço: sem o socket, o arquivo se chama
  `<id>-json.log` e não há como saber a que serviço pertence. Quem tem o socket
  `:ro` consegue listar containers e ler o log deles — não consegue criar nem
  matar. Aceito porque o host já é a máquina da aplicação e o nginx é a borda.
- **`node-exporter` monta `/` do host em `/host` (`:ro`).** Sem isso o coletor de
  filesystem mede o overlay do container, que não é o disco que enche.
- **Sem `healthcheck` nos 5 serviços.** As imagens oficiais não trazem cliente
  HTTP confiável; `restart: unless-stopped` cobre o crash e a verificação real é
  a lista acima.
- **`level=error … empty ring` no log do Loki.** É ruído conhecido do modo
  single-binary: o *rate store* consulta o ring de ingesters antes de o primeiro
  write registrar o ingester. O `/ready` do Loki responde `200` e a gravação
  funciona (`curl` da lista acima); a linha volta a cada ~75 s e não indica falha.
