# Ensaio cronometrado da entrega — F6 (#21)

Data: **2026-11-23**, sessão do AWS Academy aberta às 20:20 (-03:00).
Conta `794399909334`, região `us-east-1`. Branch `main` em `35f42d5`.

> Nenhum valor de segredo aparece neste arquivo. Onde o log mascarou, está `***`; onde havia
> credencial, está o nome e o comprimento.

## 1. Tempo por etapa

Run **`45291245979`** (disparado pelo `workflow_run` quando o CI de `35f42d5` fechou verde):

| Job | Duração | Conclusão |
| --- | --- | --- |
| `gate` | 0,1 min | success |
| `build` | 0,9 min | success |
| `provision` | — | skipped (infra já de pé) |
| `deploy` | 0,8 min | success |
| `smoke` | 0,1 min | success |
| **total** | **2,0 min** | **success** |

Run **`45289944441`** — o ensaio com `-f provision=true` (Terraform aplicado **dentro** do
pipeline, caminho nunca exercitado antes):

| Etapa | Duração |
| --- | --- |
| dispatch → conclusão | **3,8 min** |
| `gate` | 0,1 min |
| `provision` (Terraform apply: 8 recursos) | 0,9 min |
| `build` (imagens em cache) | 0,7 min |
| `deploy` (SSM: pull, up, migrate, ingestão, obs) | 1,0 min |
| `smoke` | 0,1 min |

**Conclusão sobre o teto de 15 min:** o ciclo completo com provisionamento cabe em **menos de 4
minutos** quando as imagens estão em cache, e em ~12 min com build completo do zero. O teto de 15
min é interno (`docs/04` §3/F6), não do edital, e **foi cumprido com folga**.

## 2. O defeito que o ensaio encontrou

O run `45289944441` reprovou o `smoke`:

```
smoke /grafana/ asks for a login
  status: 502
  ::error::/grafana/ respondeu 502, esperado 302 (login) ou 401
```

**A aplicação estava correta.** Um minuto depois:

```
bash scripts/dev/verify-f5.sh 54.175.235.110
  OK /healthz 200 · OK JSON · OK /readyz 200 · OK / HTML · OK admin 401
  OK /grafana/ -> 200 · OK /metrics 404          FALHAS=0
```

A causa é de **tempo, não de código**: o Grafana leva dezenas de segundos para escutar depois do
`up`, e o nginx responde `502` nesse intervalo. O passo do `smoke` checava **uma vez, imediatamente**.

Corrigido em `77b49be`: o passo espera até 90 s (18 × 5 s), como o passo da borda já fazia. Prova
no run `45291245979` — `smoke: success`.

**É exatamente para isto que o ensaio existe:** um defeito que só aparece com a stack no ar, achado
antes da banca em vez de na frente dela.

## 3. Verificação pela borda (a mesma do job `smoke`)

IP público da sessão: **`54.175.235.110`**.

```
== borda: http://54.175.235.110 ==
  OK    /healthz 200
  OK    /healthz JSON
  OK    /readyz 200
  OK    / HTML (SPA)
  OK    admin sem token 401
  OK    /grafana/ -> 200 (painel alcancavel)
  OK    /metrics 404 (fechado na borda)

FALHAS=0 — F5 demonstravel pela borda publica
```

| Requisito do edital | Como esta verificação cobre |
| --- | --- |
| §3.3 verificação de disponibilidade após o deploy | `/healthz` e `/readyz` em JSON, pelo pipeline |
| §3.6 disponibilidade | `/readyz` só responde 200 com o Postgres de pé |
| §3.6 visualização | `/grafana/` alcançável pela porta 80 |
| §3.4 superfície de segredo | `POST /admin/ingest` recusa 401 sem token; `/metrics` fechado |

## 4. Roteiro dos 3 minutos

Apresentador fala; **operador** digita. Nada é digitado ao vivo que não tenha rodado 20 minutos antes.

| Tempo | Na tela | O que se diz | O que prova |
| --- | --- | --- | --- |
| 0:00–0:25 | `http://54.175.235.110/healthz` e `/readyz` | "borda única na EC2; `/readyz` só responde 200 se o Postgres responder" | §3.3 e §3.6 |
| 0:25–1:05 | SPA: busca em linguagem natural (query ensaiada) | "a LLM interpreta a intenção; **a ordem é de uma função pura** — score, selo de confiança, explicação" | §3.1; ADR-001; 25% |
| 1:05–1:35 | Detalhe da skill: `SKILL.md` e campo ausente como **`n/a`** | "dado ausente é `null`, nunca zero — a interface diz `n/a` em vez de inventar" | regra 3 do `AGENTS.md` |
| 1:35–2:10 | Erro provocado + Loki filtrado pelo `request_id` + painel no Grafana | "todo erro tem `request_id`; o log sai estruturado e cai no Loki sem rótulo de alta cardinalidade" | §3.6 logs + visualização |
| 2:10–2:40 | Actions: run verde, `smoke` verde, e o run vermelho com `build`/`deploy` skipped | "teste reprovado não gera artefato nem deploy — o `smoke` reprova o workflow quando a app está fora" | §3.3 e §3.5 — 15% |
| 2:40–3:00 | `terraform state list` (8 recursos) | "a infraestrutura é destruída depois da apresentação — não fica recurso cobrando" | §3.2 e remoção (§3.7) |

## 5. O que o ensaio **não** produziu, e quem produz

| Artefato | Estado | Por quê |
| --- | --- | --- |
| `f5-dashboard.png`, `f5-targets.png`, `f5-log-erro.png` | **pendente** | não tenho navegador nem captura de tela nesta sessão. O painel está no ar em `/grafana/` — são três prints de 30 s para quem tiver a URL aberta |
| Vídeo de fallback (3 min) | **pendente** | idem: gravação de tela exige a máquina do apresentador. Deve morar **fora do repositório** (teto de 50 MB) e o caminho anota-se aqui |
| `/api/v1/categories` com dados | verificado antes | o catálogo é populado pela ingestão do próprio deploy (2 skills no último run); se vier `data: []`, o roteiro não usa filtro de categoria |

## 6. Custo e destruição

| Item | Valor |
| --- | --- |
| Recursos provisionados | 8 (EC2 `t3.small`, EBS 20 GiB gp3, SG, 2 repositórios ECR removidos, 4 volumes de obs) |
| Janela | ~25 min de instância ligada |
| Destruição | `terraform -chdir=infra destroy -var-file=terraform.tfvars`, ao fim da sessão |

O `destroy` é o último passo de toda janela — nenhum recurso fica ligado entre sessões.

## 7. O que o ensaio provou sobre o procedimento

1. **O `provision` do pipeline funciona** — nunca havia sido exercitado: o Terraform aplicou 8
   recursos de dentro do workflow, com credencial de sessão vinda dos secrets do GitHub.
2. **O deploy terminou com a stack de observabilidade no ar** — o log traz `::obs-ok::` e os cinco
   containers `Up`.
3. **O `smoke` é capaz de reprovar** — reprovou de verdade, por um motivo real, e a correção foi
   feita e provada.
4. **O ciclo `apply → deploy → smoke` cabe em menos de 4 minutos** com imagens em cache.
