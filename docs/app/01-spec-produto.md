# Spec de Produto — Skill Finder

**Disciplina:** Computação em Nuvem · **UFRPE** — Projeto Integrador (Projeto 2)
**Versão:** 1.0 · **Data:** 2026-11-14
**Documento irmão:** [`02-arquitetura.md`](02-arquitetura.md) (componentes, contrato da API, modelo de dados, segurança, observabilidade)
**Fonte de verdade dos requisitos acadêmicos:** [`docs/00`](../00-edital-projeto-2.md) (edital) e [`docs/01`](../01-analise-requisitos-e-arquitetura.md) (R1–R8, C1–C8, Opção 1)
**Fora de escopo deste documento:** stack, endpoints, DDL, métricas, ADRs — estão no `02`. Sub-fases de construção estão em [`03-plano-app.md`](03-plano-app.md); infraestrutura e pipeline, em [`docs/04`](../04-plano-de-execucao.md).

> **Como ler.** Este documento responde **o que** o produto faz e **como se sabe que está certo**. Cada história tem critério de aceitação verificável (dá para provar com um teste, um `curl` ou um clique). Toda afirmação sobre o **skills.sh** e sobre o **provedor de LLM** que não pôde ser verificada offline está marcada `[a confirmar]`; nada foi inventado sobre eles. O ranking (§5) é a regra de negócio central: é determinística, tem fórmula fechada e é a única fonte da ordem exibida.

---

## 1. Problema, público e proposta de valor

1. Existe um catálogo grande de "skills" de agentes no **skills.sh**, alimentado por repositórios do GitHub, com estrelas, resumo, verificações de segurança e contagem de instalações.
2. Quem usa agentes de código sabe **o que precisa** ("revisar PRs de Python procurando falha de segurança"), mas não sabe **qual skill** faz isso, nem como comparar duas candidatas.
3. A busca do site é por nome/palavra-chave; ela não aceita "para que eu preciso" e não ordena por segurança + adoção + avaliação ao mesmo tempo.
4. Comparar manualmente custa caro: são dezenas de candidatas, cada uma com estrelas, instalações e um histórico de vulnerabilidades que ninguém lê.
5. **Público:** desenvolvedores e tech leads que já usam agentes de código e precisam escolher uma skill com critério — e a banca que avalia o projeto.
6. **Proposta de valor:** descrever a necessidade em linguagem natural e receber, em segundos, uma **lista curta, ordenada e explicada**, com a mais adequada destacada.
7. A ordem é **determinística e auditável** (estrelas, vulnerabilidades, instalações); a LLM interpreta o pedido e escreve o **porquê** — ela não escolhe a ordem.
8. O produto **não instala** a skill: ele decide *qual* instalar. O link para a origem acompanha cada resultado.
9. Interface em **português do Brasil (pt-BR)**; documentação do projeto em **português**.

---

## 2. Personas

| Persona | Perfil | Objetivo ao usar o app | O que a irrita hoje |
| --- | --- | --- | --- |
| **Ana — dev backend (persona primária)** | Usa agente de código todos os dias; conhece o domínio, não o catálogo | "Achar em 1 minuto uma skill de revisão de segurança para serviços Python, sem pegar uma abandonada" | Listas longas sem critério; não saber se a skill é segura |
| **Bruno — tech lead** | Decide o que o time adota; responde por risco | "Justificar a escolha: por que esta e não aquela" | Não ter número nem explicação para levar à revisão |
| **Carla — usuária não técnica de agentes** | Usa agente pronto, não lê repositório | "Descrever o que preciso e receber uma sugestão clara" | Termos técnicos, páginas de repositório, estrelas sem contexto |

**Persona secundária (contexto acadêmico):** o **avaliador/banca**, que precisa ver o fluxo completo em ≤ 3 minutos, com dado real e degradação visível quando algo falha.

---

## 3. Fluxos principais

### 3.1 Fluxo A — busca livre

1. A pessoa abre a página inicial: campo de texto ("Descreva o que a skill precisa fazer"), seletor de categoria em `Todas as categorias`, botão **Buscar**.
2. Digita a necessidade em linguagem natural (inglês ou português) e envia.
3. Vê o estado de carregamento; a resposta traz a **intenção interpretada** (categoria detectada + palavras-chave) e até 5 resultados ordenados.
4. O primeiro item vem destacado como **Recommended**, com a explicação e os números.
5. Abre o detalhe de um item (inclui `SKILL.md` quando existe) ou volta e refaz a busca.

### 3.2 Fluxo B — busca com categoria

1. Escolhe uma categoria no seletor (`Backend`, `Frontend`, `Data`, … — rótulos em inglês, vindos do catálogo `[a confirmar]`).
2. Descreve a necessidade.
3. Recebe resultados **somente** daquela categoria; se a categoria não tiver nada que case, vê o estado vazio com a sugestão de remover a categoria.

### 3.3 Fluxo C — refinar/reformular

1. Depois de uma busca, a pessoa ajusta o texto (ou troca a categoria) e busca de novo, sem perder a busca anterior.
2. As últimas buscas ficam acessíveis na própria sessão (histórico por cliente, 30 dias — §6.5) e podem ser reabertas com o resultado original.
3. Refinar não consome cota extra além do limite normal: cada envio é uma busca (§6.3).

---

## 4. Histórias de usuário

Formato: `US-nn` · persona · história. Cada critério de aceitação (AC) é verificável isoladamente.

### US-01 — Busca livre por descrição de uso (Ana)
**Como** desenvolvedor, **quero** descrever em linguagem natural para que preciso da skill, **para** receber uma lista curta e ordenada sem saber o nome de nada.

- **AC1** `POST /api/v1/search` com `{"query":"review pull requests for security issues in Python"}` retorna `200` e `1 ≤ len(results) ≤ 5` quando o catálogo tem candidatos; cada `results[i].skill.skill_id` existe em `GET /api/v1/skills/{skill_id}`.
- **AC2** `results` vem em ordem decrescente de `score`, e `results[i].score` bate com a fórmula da §5.4 recalculada a partir de `stars`, `vulnerability_count` e `installs` do próprio item (tolerância 1e-4).
- **AC3** `intent.keywords` tem entre 1 e 8 itens e `intent.language ∈ {en, pt, other}`; a resposta inclui `llm.status`.
- **AC4** nenhum item de `results` tem `security_status = "fail"` nem `is_active = false`.

### US-02 — Busca restrita a uma categoria (Ana)
**Como** desenvolvedor, **quero** limitar a busca a uma categoria, **para** não receber sugestão de frontend quando o problema é de backend.

- **AC1** `POST /api/v1/search` com `{"query":"…","category":"backend"}` retorna apenas itens com `skill.category = "backend"`.
- **AC2** `category` inexistente retorna `422` com `error.code = "UNKNOWN_CATEGORY"` e `error.details.allowed_categories` com os `slugs` válidos.
- **AC3** `GET /api/v1/categories` retorna ao menos uma categoria com `skill_count > 0` e é a fonte do seletor da UI (nenhuma lista fixa no frontend).

### US-03 — Ver e corrigir a interpretação do pedido (Ana, Carla)
**Como** usuário, **quero** ver como meu pedido foi interpretado, **para** perceber quando a busca entendeu errado e reformular.

- **AC1** a resposta exibe `intent.category`, `intent.keywords` e `intent.confidence` na tela, acima dos resultados.
- **AC2** com `category` informada pelo usuário, `intent.category` é exatamente esse valor.
- **AC3** com `intent.confidence < 0.35`, a resposta traz `llm.status = "low_confidence"` (ou `"unavailable"`) e a UI mostra o aviso "We were not sure how to interpret your request — showing keyword matches", sem esconder os resultados.
- **AC4** nenhum texto do usuário é ecoado como HTML interpretado (renderização como texto puro).

### US-04 — Entender por que cada skill apareceu (Bruno)
**Como** tech lead, **quero** a justificativa de cada item com números, **para** defender a escolha sem abrir o repositório.

- **AC1** cada item traz `explanation` não vazia (≤ 320 caracteres) e `caveats` (≤ 160) ou `null`.
- **AC2** `explanation` e `recommendation.text` referenciam skills **apenas** por placeholder `{{skill:<skill_id>}}` já resolvido pelo backend, e todo `skill_id` citado pertence ao conjunto de `results`.
- **AC3** `score_breakdown` traz `stars`, `vulnerabilities`, `installs`, `missing_fields` e `penalty_factor`, e a UI mostra os números do catálogo (`stars`, `installs`, `vulnerability_count`) ao lado do texto.
- **AC4** um teste com provedor de LLM falso que devolva um `skill_id` inventado resulta em `llm.status = "invalid_ids"` **ou** `"repaired"`, e nenhum item inexistente aparece em `results`.

### US-05 — Receber uma recomendação única (Carla)
**Como** usuária não técnica, **quero** uma sugestão clara em destaque, **para** não ter que comparar cinco opções.

- **AC1** a resposta destaca exatamente um item como **Recommended**, e `recommendation.skill_id == results[0].skill.skill_id` — a recomendação é sempre o topo da lista, nunca um item de outra posição.
- **AC2** `recommendation.text` cita ao menos um número real do item (estrelas, instalações ou vulnerabilidades).
- **AC3** se `llm.status ∈ {unavailable, invalid_ids, disabled}`, a recomendação ainda existe, com texto de template determinístico (US-08).

### US-06 — Abrir o detalhe com `SKILL.md` (Ana)
**Como** desenvolvedor, **quero** ler a descrição completa da skill antes de adotar, **para** confirmar que ela faz o que o resumo promete.

- **AC1** `GET /api/v1/skills/{skill_id}` retorna `200` com `summary`, `repo_url`, `security_status`, `skill_md_present`.
- **AC2** quando `skill_md_present = true` e o documento foi obtido, a resposta traz `skill_md_excerpt` com 1–600 caracteres, texto puro (sem HTML).
- **AC3** quando o documento não existe ou falhou, `skill_md_present = false` **ou** `skill_md_excerpt = null`, e a UI mostra `n/a` com a frase "No full description available for this skill" — nunca um bloco vazio ou um erro.
- **AC4** `skill_id` malformado retorna `404`/`422`, nunca `500`.

> **Limites de texto na resposta** (fonte dos `maxLength` do contrato, `docs/app/02-arquitetura.md` §5.4):
> `summary` é truncado na ingestão em **280** caracteres; `skill_md_excerpt` em **600**. O corte acontece
> na ingestão, não na leitura — a resposta nunca promete mais do que o catálogo guarda.

### US-07 — Saber quando nada foi encontrado (Ana, Carla)
**Como** usuário, **quero** entender que a busca não achou nada e o que fazer, **para** não concluir que o app quebrou.

- **AC1** busca sem candidatos retorna `200` com `results: []`, `intent` preenchida e `warnings` contendo `"no_matches"` — **não** `404` nem `500`.
- **AC2** a UI mostra "No skills matched your request" e três ações: remover a categoria, simplificar a descrição, tentar um dos dois exemplos sugeridos.
- **AC3** o estado vazio aparece em ≤ 3 s quando a LLM está fora (fallback lexical sem prosa).

### US-08 — Saber quando a resposta é degradada (Bruno, banca)
**Como** usuário, **quero** saber quando a resposta veio pior do que o normal, **para** não confiar em dado velho ou em texto genérico.

- **AC1** com o provedor de LLM indisponível (timeout, erro HTTP, orçamento estourado), a resposta é `200` com `llm.status = "unavailable"`, `degraded = true`, `degraded_reason = "llm_unavailable"` e explicações de template determinístico.
- **AC2** com catálogo com mais de 12 h de idade (limiar da F2.10/D3), `degraded = true`, `degraded_reason = "source_stale"` e `data.age_seconds` correto; a UI mostra a faixa "Catalog may be outdated" com a idade em horas.
- **AC3** sem catálogo nenhum e com o skills.sh inacessível, a resposta é `503` com `error.code = "SOURCE_UNAVAILABLE"` e a UI mostra "Data source unavailable — try again later"; a lista **não** é preenchida com dado inventado.
- **AC4** em nenhum caso de degradação a tela mostra lista vazia sem explicação.

### US-09 — Refinar e reformular a busca (Ana)
**Como** desenvolvedor, **quero** ajustar o texto ou a categoria e buscar de novo, **para** convergir sem começar do zero.

- **AC1** enviar uma segunda busca com o mesmo texto e a mesma categoria devolve resultado idêntico em ordem e `score` (determinismo ponta a ponta, §5.9).
- **AC2** o campo de texto mantém o último valor e a categoria selecionada depois da busca; enviar de novo não exige redigitar.
- **AC3** duas buscas seguidas contam como duas unidades do limite de 10/min (§6.3); a UI informa o limite restante quando ele chega a ≤ 2.

### US-10 — Retomar uma busca anterior (Ana)
**Como** usuário, **quero** reabrir uma busca recente, **para** comparar com a nova sem refazer a pergunta.

- **AC1** a UI lista as últimas buscas do cliente (mínimo 5, quando existirem) com texto truncado, categoria e data.
- **AC2** reabrir uma busca usa `GET /api/v1/searches/{request_id}` e devolve o mesmo conjunto de `skill_id` da execução original (com `llm.cached = true` quando aplicável).
- **AC3** busca com mais de 30 dias retorna `410` com `error.code = "HISTORY_EXPIRED"`, e a UI remove o item da lista.
- **AC4** o histórico é por cliente pseudonimizado (`client_hash = sha256(ip + salt)`), sem conta e sem cookie de identificação persistente.

### US-11 — Ser avisado ao exceder o limite (Ana, Bruno)
**Como** usuário, **quero** uma mensagem clara quando exceder o limite de uso, **para** saber quanto esperar em vez de ver erro genérico.

- **AC1** a 11ª busca no mesmo minuto retorna `429` com `error.code = "RATE_LIMITED"`, `error.retry_after_seconds` e headers `Retry-After`, `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`.
- **AC2** a UI mostra "Too many searches — try again in {n} seconds" e mantém o resultado anterior visível.
- **AC3** o bloqueio não afeta `GET /healthz`, `GET /readyz`, `GET /categories` nem `GET /skills` (limite vale só para busca, que é o que custa token).

---

## 5. Regra de negócio: ranking determinístico

Esta seção é a **fonte de verdade** da ordem exibida. A implementação prevista é uma função pura em `backend/app/ranking` — sem I/O, sem relógio, sem aleatoriedade — e o `02` §6.4 a reproduz no pipeline.

### 5.1 Duas camadas, com fronteira explícita

| Camada | O que decide | Determinística? | Por quê |
| --- | --- | --- | --- |
| Ordem, `score`, filtros, recomendação | Backend | **Sim** | Precisa ser reproduzível, testável com asserção numérica e auditável na banca |
| Leitura da pergunta e redação do "porquê" | LLM | Não | Linguagem natural não tem regra fechada; o erro fica no texto, não no dado |

**A LLM nunca:** escolhe a ordem, escolhe qual skill existe, produz `score`, cita skill fora do conjunto recuperado, ou altera `stars`/`installs`/`vulnerability_count`.

### 5.2 Filtros de elegibilidade (antes de qualquer score)

1. `is_active = true` (a skill apareceu na última ingestão bem-sucedida).
2. `security_status ≠ 'fail'` — item com vulnerabilidade grave reportada não é recomendado em nenhuma hipótese `[a confirmar]` como o skills.sh classifica isso (texto livre ou categoria estruturada).
3. `category = <categoria informada>`, quando o usuário escolhe uma.
4. Um item por `source_key` (sem duplicata vinda de paginação).

Filtro é **corte**, não penalidade: item filtrado não aparece nem em posição pior.

### 5.3 Normalização (com âncoras fixas)

```
S = min(1, log10(1 + stars)             / log10(1 + 20_000))
P = 1 - min(1, vulnerability_count / 5)
I = min(1, log10(1 + installs)          / log10(1 + 200_000))
```

- **Escala logarítmica** porque estrelas e instalações têm cauda longa (dezenas a centenas de milhares); em escala linear, um item popular apagaria todos os outros.
- **Âncoras fixas** (20.000 estrelas, 200.000 instalações, 5 vulnerabilidades) e não mín-máx do conjunto recuperado: com mín-máx, o primeiro colocado teria `1,0` em toda busca, mesmo sendo medíocre, e o `score` deixaria de ser comparável entre buscas e de ser cacheável.
- `P` satura em 5: acima disso o sinal marginal é ruído e o item provavelmente já caiu no filtro 5.2.2.
- `stars` = estrelas do repositório no GitHub, `installs` = instalações no skills.sh `[a confirmar]` (nomes e semântica exatos a confirmar na descoberta).

### 5.4 Fórmula do score

```
m     = número de campos ausentes entre {stars, installs, vulnerability_count}   (0..3)
score = round( (0,5·S + 0,3·P + 0,2·I) × (1 − 0,10·m), 4 )
```

| Peso | Fator | Justificativa |
| --- | --- | --- |
| `0,5` | `S` (estrelas) | É o sinal de avaliação que o dono pediu como prioritário |
| `0,3` | `P` (menos vulnerabilidades) | Segurança pesa alto, mas não pode zerar a decisão: com peso dominante, uma skill desconhecida e sem histórico venceria uma skill popular e limpa |
| `0,2` | `I` (instalações) | Adoção real, porém ruidosa (depende de quando o contador começou) |

Pesos são configuração (`RANK_W_STARS`, `RANK_W_VULNS`, `RANK_W_INSTALLS`), com os valores acima como padrão; mudar peso não muda código nem prompt.

### 5.5 Dado ausente

- Campo ausente **nunca** vira `0` nem vira nota máxima: o fator recebe o valor **neutro `0,5`** e o item acumula `m += 1`.
- Penalidade de **10% por campo ausente**, teto de **30%** (`m = 3`).
- O item expõe `evidence_completeness = {missing_fields: m, penalty_factor: 1 − 0,10·m}`. No contrato do `02` §5.3 esse bloco aparece no item, e os mesmos dois números também dentro de `score_breakdown`.
- Na interface, campo ausente aparece como **`n/a`**, jamais como `0` ou vazio.
- Motivo: ausência de dado é ausência de evidência, não evidência de qualidade.

### 5.6 Desempate (ordem total, sempre resolve)

1. `score` decrescente (comparação no valor **arredondado** em 4 casas, para que o critério exibido seja o critério usado).
2. `relevance` decrescente — o `ts_rank` do casamento entre a consulta e o `search_doc` da skill, calculado pela recuperação (ausente = `0`: ausência de evidência textual, nunca vantagem).
3. `vulnerability_count` crescente, usando o valor tratado (`vulnerability_count ?? 2,5` — o neutro de `P = 0,5`).
4. `installs` decrescente (tratado: ausente = `0` apenas para desempate, nunca para o score).
5. `stars` decrescente (mesma regra de tratamento).
6. `skill_id` crescente (lexicográfico) — garante ordem estável mesmo com empate absoluto.

**Por que `relevance` vem logo depois do `score`:** entre skills populares a fórmula satura (`S = 1`, `P = 1`, `I = 1` → `0,765`), então o empate de `score` é o caso **comum**, não a exceção — e sem relevância no desempate quem escolhia a ordem era a popularidade: numa busca por "design frontend", `find-skills` (4,5 M instalações) vinha antes de `frontend-design`. Casamento textual é a evidência de que a skill responde ao pedido; popularidade só decide quando o casamento também empata. É dado de entrada do comparador, como o `score`: `ts_rank` já era calculado para ordenar os candidatos no `SELECT` e passou a ser devolvido com eles. A fórmula do `score` (§5.4) **não** muda — `relevance` nunca entra nela, e o número mostrado na interface continua sendo o `score`.

### 5.7 Exemplos numéricos (casos de teste obrigatórios)

| Caso | stars | vulns | installs | S | P | I | m | score |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | 1.200 | 0 | 8.000 | 0,7160 | 1,0000 | 0,7364 | 0 | **0,8053** |
| B | 3.000 | 2 | 15.000 | 0,8085 | 0,6000 | 0,7878 | 0 | **0,7418** |
| C | 250 | ausente | ausente | 0,5579 | 0,5000 | 0,5000 | 2 | **0,4232** |

- **A vence B** mesmo com menos estrelas e menos instalações: `P = 1,0` contra `0,6` compensa a diferença. É a regra "menos vulnerabilidades" funcionando como o dono pediu.
- **C** ilustra dado ausente: os dois fatores neutros (`0,5`) e a penalidade de 20% derrubam o item para o fim, sem tratá-lo como "0 vulnerabilidades" (o que o promoted indevidamente).
- Contas: A = `0,5·0,71600 + 0,3·1 + 0,2·0,73641 = 0,80528 → 0,8053`; B = `0,40424 + 0,18 + 0,15756 = 0,74180 → 0,7418`; C = `(0,5·0,55791 + 0,15 + 0,10) × 0,8 = 0,52896 × 0,8 = 0,42317 → 0,4232`.

### 5.8 Como a LLM entra (e como não entra)

| Etapa | Dono | Saída | Validação |
| --- | --- | --- | --- |
| Interpretar o pedido | LLM | `{category, keywords[], filters, language, confidence}` | JSON Schema + `category` restrita ao catálogo + limite de 8 keywords |
| Recuperar candidatos | Backend | ≤ 5 itens elegíveis | `SELECT` auditável, filtros da §5.2 |
| Ordenar | Backend | `score` e ordem | Fórmula §5.4 + desempate §5.6 |
| Explicar e recomendar | LLM | `{items[{skill_id, why, caveats}], recommendation{skill_id, why}}` | `skill_id` restrito ao conjunto recuperado; `recommendation.skill_id = results[0]`; texto com placeholder |

A recomendação destacada é **sempre** o item de `rank 1`. A LLM escreve **por que** ele é o escolhido; ela não tem voto sobre qual é. Isso mantém a tela, o score e a explicação coerentes mesmo quando o texto é gerado.

### 5.9 Garantias testáveis do ranking

1. **Determinismo:** mesma entrada + mesmo snapshot de catálogo + mesmos pesos → mesma ordem e mesmos `score` (teste roda a função duas vezes e compara byte a byte).
2. **Pureza:** a função não faz I/O, não lê relógio, não usa `random`; o teste passa um fixture e confere os três casos da §5.7.
3. **Conjunto fechado:** todo `skill_id` em `results` veio do `SELECT`; teste com LLM falsa que inventa id garante que nada aparece (US-04 AC4).
4. **Rastreabilidade:** `score_breakdown` permite recalcular o `score` na mão; a diferença máxima aceita é `1e-4`.
5. **Monotonicidade:** com os outros fatores fixos, mais estrelas nunca piora a posição; menos vulnerabilidades nunca piora a posição; mais instalações nunca piora a posição (teste com casos gerados).

---

## 6. Requisitos não funcionais

Números explícitos; cada um tem um jeito de medir.

### 6.1 Desempenho

| Requisito | Alvo | Como medir |
| --- | --- | --- |
| Latência p95 da busca **com** LLM (sem cache) | **≤ 6 s** | `search_stage_duration_seconds{stage="total"}` (histograma) |
| Latência p50 da mesma busca | ≤ 3 s | idem |
| Latência p95 com cache quente (intenção + explicação) | **≤ 800 ms** | idem, filtrado por `llm.cached = true` |
| Timeout por chamada de LLM | **8 s** | configuração `LLM_TIMEOUT_S`; estouro → degradação (US-08) |
| Timeout de chamada ao skills.sh | 10 s, 2 retentativas com backoff | `skill_source_duration_seconds` |
| Concorrência suportada na instância única | 10 requisições simultâneas, ≥ 5 req/s com cache | teste de carga leve registrado em evidência |
| Tempo do estado vazio por queda de LLM | ≤ 3 s | US-07 AC3 |

### 6.2 Frescor e cache

| Requisito | Alvo | Efeito |
| --- | --- | --- |
| Catálogo (estrelas, instalações, vulnerabilidades) | refresh a cada **6 h** | acima de 12 h → `degraded: true`, `source_stale` (US-08; limiar da F2.10/D3, alinhado ao ciclo do rodízio) |
| Prontidão do serviço | `/readyz` reprova com catálogo acima de **24 h** | `503 NOT_READY` |
| `SKILL.md` cacheado | **7 dias** | reduz chamadas ao GitHub/skills.sh |
| Explicação da LLM em cache | **24 h**, chaveada por intenção + conjunto de candidatos + snapshot | corta custo de token |
| Custo de aquisição | ≤ **4 ciclos de ingestão por dia** e ≤ 1 req/s ao skills.sh | `ingest_runs_total`, `skill_source_requests_total` |

### 6.3 Limites de uso e custo

| Requisito | Alvo |
| --- | --- |
| Limite por cliente | **10 buscas/minuto** e **60 buscas/dia** |
| Identidade do cliente | `client_hash = sha256(ip + salt)`; **sem login, sem cookie de identificação** |
| Orçamento de LLM | 500 chamadas/dia; estourou → degrada com template, **não** derruba a busca |
| Resposta ao limite | `429` com `error.code = "RATE_LIMITED"` e `retry_after_seconds` (US-11) |
| Ingestão manual | 1 disparo por 5 min, protegido por token de servidor |

### 6.4 Privacidade e segurança de dados

| Requisito | Regra |
| --- | --- |
| Texto da consulta em log | **proibido**; só `query_hash` e `query_len` |
| Texto da consulta no histórico | opcional, **desligado por padrão** (`SEARCH_LOG_STORE_TEXT=false`); quando ligado, retenção de 7 dias |
| IP | nunca em claro; só `client_hash` pseudonimizado no rate limit e no histórico |
| Chave do provedor de LLM | só no backend; nunca no bundle do frontend, nunca no prompt, nunca em log (detalhe no `02` §8) |
| Conteúdo de terceiro (`SKILL.md`, resumo, consulta) | tratado como **dado não confiável**; nunca como instrução; saída validada contra schema |
| Telemetria de terceiros | nenhuma (sem analytics, sem pixel, sem CDN de script) |

### 6.5 Retenção

| Dado | Retenção |
| --- | --- |
| Histórico de buscas (`search_request`) | **30 dias** |
| Texto da consulta (quando habilitado) | 7 dias |
| Snapshots de métricas das skills | 90 dias |
| Métricas e logs de infraestrutura | 7 dias (`docs/01` §7.2) |

### 6.6 Interface e idioma

| Requisito | Regra |
| --- | --- |
| Idioma da interface | **português do Brasil (pt-BR)** em todos os rótulos, mensagens de erro e estados vazios |
| Idioma da documentação | **português do Brasil** |
| Consulta aceita | inglês e português (a intenção é interpretada; a resposta é sempre em pt-BR) |
| Texto da fonte | `name`, `summary`, `SKILL.md` e o rótulo de categoria vêm do catálogo e são exibidos **como publicados** (em inglês); não há tradução |
| Estados obrigatórios por tela | carregando, erro, vazio, sucesso — nenhuma tela "em branco" |
| Acessibilidade mínima | navegação por teclado no formulário e nos resultados, foco visível, contraste legível |
| Voltar do detalhe | preserva a última busca e a posição de rolagem |

### 6.7 Disponibilidade (honesta, dentro da Opção 1)

| Requisito | Alvo |
| --- | --- |
| Disponibilidade | no ar durante a janela de demonstração; **sem alta disponibilidade** (instância única — trade-off aceito em `docs/01` §5.3) |
| RTO em redeploy | ≤ 15 min (ciclo `destroy`→`apply`→`deploy`→`smoke` de `docs/04` F6) |
| Falha do skills.sh | serviço continua servindo catálogo em cache (US-08) |

---

## 7. Escopo

### 7.1 Dentro da v1

1. Busca em linguagem natural com interpretação por LLM e **até 5 resultados** ordenados.
2. Filtro por categoria vinda do catálogo.
3. Explicação por item + recomendação única destacada.
4. Detalhe da skill com `SKILL.md` quando disponível (`n/a` quando não).
5. Degradação explícita e visível (LLM fora, catálogo velho, fonte fora).
6. Histórico das últimas buscas **por cliente pseudonimizado**, 30 dias, sem login.
7. Catálogo atualizado por ingestão a cada 6 h, com execução manual protegida por token.
8. Painel de operação (métricas, logs, dashboard) — requisito do edital, não feature de usuário.

### 7.2 Fora da v1 (com justificativa)

| Fora de escopo | Por quê |
| --- | --- |
| **Login / contas de usuário** | O produto é consulta pública e não guarda dado pessoal além de `client_hash`; conta adicionaria senha, sessão, JWT e recuperação de senha — esforço alto, valor zero para o problema descrito. Histórico funciona sem identidade (US-10) |
| **Upload de `SKILL.md` ou de skill própria** | O app é de **descoberta**, não de publicação; upload exige moderação, antivírus e storage de objeto — nada disso está no problema |
| **Busca por embeddings / vetorial** | Sem evidência de que a busca lexical (`tsvector` + `pg_trgm`) com palavras-chave geradas pela LLM deixe a desejar; embeddings trazem custo por token, dependência de modelo e reindexação. Vira ADR novo se a avaliação com ≥ 20 consultas reais mostrar item relevante fora do top-5 (`02` ADR-002) |
| **i18n da interface (PT/EN)** | A interface é **só em pt-BR**; "i18n" aqui significa um **toggle de idioma ou uma segunda locale** — dois conjuntos de strings, dois testes de tela e revisão dupla, sem ganho de nota. Uma locale só, decidida (pt-BR), atende o público da banca e a documentação em português |
| **Instalar/executar a skill** | O produto termina na decisão de *qual* adotar; execução é responsabilidade do agente do usuário. Escopo diferente, risco de segurança muito maior |
| **Reviews e notas próprias de usuário** | A avaliação é a do GitHub (estrelas), fonte já disponível; reviews exigiriam moderação e identidade, incompatíveis com "sem login" |
| **Comparação lado a lado de 2+ skills** | O ranking já entrega a ordem e a explicação; a comparação dedicada é polimento de UI, candidata a pós-v1 |
| **Notificações/alertas de novas skills** | Exige e-mail (SES indisponível no sandbox) e conta de usuário |
| **Analytics de produto (cliques, funil)** | Exigiria endpoint de evento e consentimento; as metas da §9 usam só dados do servidor |
| **Admin UI** | A ingestão manual usa `POST /admin/ingest` com token de servidor; uma tela só para o dono é custo sem nota |

### 7.3 Decisão de tema (registro, sem inventar aprovação)

- Este app é o **Tema D — descoberta de skills de agentes** e **substitui os Temas A/B/C** propostos em `docs/01` §8 na execução do projeto (a escolha de tema é do aluno, conforme aquele documento registra).
- **Não há aprovação registrada do professor** para o Tema D. A validação da proposta (entregável E1, `docs/04` F1) segue **pendente** e deve acontecer na aula de acompanhamento antes de a F2 começar `[a confirmar]`.
- Consequência aceita: se a banca exigir um dos temas A/B/C, o esforço de F2 é reaproveitado (NestJS + Postgres + SPA + testes continuam válidos), mas o domínio muda — risco registrado na §10.

### 7.4 Identidade e sessão (explícito)

**A v1 não tem login.** Não existe tabela de usuário, senha, JWT, cookie de sessão ou recuperação de senha. A identidade é o `client_hash` (§6.3), usado apenas para (i) rate limit e (ii) histórico de buscas daquele cliente por 30 dias (`02` §4.1 `search_request`). Consequência: histórico não é portável entre dispositivos e não há preferências salvas — aceito na v1.

---

## 8. Riscos do produto e mitigação

| # | Risco | Prob. | Impacto | Mitigação (no produto) | Sinal de que aconteceu |
| --- | --- | --- | --- | --- | --- |
| R1 | **skills.sh muda layout/API** e a aquisição quebra | Alta `[a confirmar]` | Alto — catálogo para de atualizar | Adaptador `SkillSource` (json/html/fixture) trocável por configuração; `fixture` como rede de segurança; ingestão só promove catálogo novo se viu ≥ 80% do total; alerta de catálogo velho | `skills_total` caindo > 20%; `ingest_run` `partial`/`failed`; `source_stale` aparecendo |
| R2 | **Dados ausentes** (sem estrelas, sem instalações, sem verificação de segurança) | Alta | Médio — ranqueia errado | Fator neutro `0,5`, penalidade de 10% por campo (§5.5), `n/a` na UI, `evidence_completeness` no contrato | `missing_fields > 0` em > 20% dos itens |
| R3 | **Custo de token** estoura o orçamento do dono | Média | Alto — demo sem LLM | Cache de intenção e explicação (24 h), ≤ 5 candidatos por explicação, `max_tokens` fixo, orçamento de 500 chamadas/dia, rate limit por cliente | `llm_tokens_total` crescendo sem `search_requests_total`; `llm_fallback_total{reason="budget"}` |
| R4 | **Alucinação**: LLM recomenda skill que não existe | Média | **Crítico** — mata a confiança | `enum` de IDs no schema, validação de conjunto, nomes só por placeholder resolvido no banco, 1 reparo e fallback de template; cards sempre do banco | `llm_calls_total{status="invalid_ids"}` > 0 |
| R5 | **Prompt injection** no campo de descrição | Média | Alto — resposta manipulada | Texto como dado delimitado, nenhuma ferramenta exposta, saída validada por schema, detecção + métrica `llm_injection_suspected_total`, renderização como texto puro (`02` §8.3) | métrica de injeção suspeita > 0; `warnings: ["untrusted_input_detected"]` |
| R6 | **skills.sh fora do ar** na hora da demo | Média | Alto | Servir catálogo em cache com aviso de idade (US-08); `503` honesto se não houver cache | `/readyz` reprovando; `skill_source_requests_total{status="error"}` |
| R7 | **Termos de uso/`robots.txt`** proíbem acesso automatizado `[a confirmar]` | Média | Alto — inviabiliza ingestão | Verificar antes de codificar o adaptador de produção; preferir endpoint público documentado; registrar a decisão em `docs/app/amostras/README.md` | nenhum — é decisão prévia, não sintoma |
| R8 | **Latência da LLM** estoura o alvo de 6 s | Média | Médio | Timeout 8 s, 1 retentativa, circuit breaker, cache, fallback de template (busca continua < 3 s) | `llm_call_duration_seconds` p95 |
| R9 | **Categoria do site não cobre** o que o usuário quer | Média | Baixo | `category` é opcional; sem categoria a busca é livre; `UNKNOWN_CATEGORY` devolve a lista válida | buscas com `intent.category = null` |
| R10 | **Provedor de LLM muda** contrato ou descontinua o modelo | Baixa | Médio | Cliente OpenAI-compatible com `base_url`/`model`/`key` por ambiente; `LLMProvider` trocável; `fake` para testes | erro 4xx sistemático do provedor |

---

## 9. Métricas de sucesso do produto (só com dados do servidor)

| Métrica | Meta v1 | Fonte | Observação |
| --- | --- | --- | --- |
| Buscas com ≥ 1 resultado | ≥ 95% | `search_requests_total{result="ok"}` / total | Mede se o catálogo e a interpretação dão conta |
| Buscas degradadas | ≤ 5% | `search_requests_total{result="degraded"}` | Se subir, o problema é LLM ou fonte, não o usuário |
| Latência p95 da busca | ≤ 6 s | `search_stage_duration_seconds` | §6.1 |
| Frescor do catálogo | ≤ 6 h em 95% do tempo | `ingest_last_success_timestamp_seconds` | §6.2 |
| Custo de token por busca | ≤ 2.500 tokens (prompt+completion) | `llm_tokens_total` / buscas | Controle do R3 |
| Itens com dado incompleto | ≤ 20% | `missing_fields > 0` | Controle do R2 |

**Não medimos na v1:** cliques, CTR, tempo de permanência e funil — exigiriam endpoint de evento e consentimento (fora de escopo, §7.2).

---

## 10. Glossário curto

| Termo | Significado |
| --- | --- |
| **Skill** | Pacote de instruções/capacidade de agente catalogado no skills.sh, instalável a partir de um repositório do GitHub |
| **Score** | Número de 0 a 1 calculado pela fórmula da §5.4; é o que ordena a lista |
| **`evidence_completeness`** | Marca de quanto dado real existe para o item (`missing_fields`, `penalty_factor`); na UI vira `n/a` |
| **Degradado** | Resposta válida, porém pior: sem prosa da LLM ou com catálogo velho; sempre sinalizada ao usuário |
| **`client_hash`** | Pseudônimo do cliente (`sha256(ip + salt)`); identifica o limite de uso e o histórico, sem conta |
| **Snapshot do catálogo** | Identificador da última ingestão bem-sucedida; garante que a resposta e o cache se refiram ao mesmo dado |
| **Fallback de template** | Explicação determinística montada a partir dos números do banco, usada quando a LLM falha |

---

## 11. O que este documento não decide

- **Como** o catálogo é obtido (adaptador, seletores, paginação) → `02` §7 e o resultado da descoberta com o dono.
- **Endpoints, DDL, nomes de métrica e de log** → `02` §4, §5 e §9.
- **Stack, imagens, compose, Terraform, pipeline** → `02` §3 e `docs/04` F3/F4.
- **Ordem de construção e gates** → `03-plano-app.md`.

Se qualquer número deste documento divergir de `docs/00`–`docs/04`, vale o documento do edital para requisito acadêmico; para regra de produto (ranking, limites, degradação), vale **este** documento, e o `02` deve ser ajustado para refleti-lo.
