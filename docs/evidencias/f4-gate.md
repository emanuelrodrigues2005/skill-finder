# F4 — Prova do pipeline em arquivo (issue #64)

**Data:** 2026-11-23
**Checkout onde a coleta rodou:** branch `dev` @ `13bf0c6` (o que está provado são runs de `main`)
**Commits observados:** `d8574a943270980ff44346885fdb332d77b5b0c7` (merge `d8574a9`) e
`2cdfb7e1ae50dcbcb94937f440a34eaed6b33fc8` (merge anterior, `2cdfb7e`)
**Gate de origem:** entregável §6.3 de `docs/04-plano-de-execucao.md`; critérios da F4 em
`docs/04-plano-de-execucao.md:311` e nome do artefato fixado em `docs/04-plano-de-execucao.md:478`

> **REGRA DESTE ARQUIVO: nenhum valor de segredo aparece aqui.** Só nome de variável,
> comprimento, contagem e resultado. Onde o GitHub mascarou, a transcrição traz `***`.
> Todos os comandos rodaram por `wsl.exe -e bash -lc`, no checkout
> `/mnt/c/Users/Lima02/Documents/bcc/cloud` (regra 8 do `AGENTS.md`).

Este arquivo é a prova **em texto**, não em link: o conteúdo abaixo é a saída de
`gh run view --json`, de `gh run view --log`, de `gh api` e de `docker manifest inspect`.
**Prints de tela** (`f4-pipeline-verde.png`, `f4-pipeline-vermelho.png`, citados no plano) podem
ser acrescentados depois pelo dono, na UI do Actions — a sessão que escreveu este arquivo não
tinha navegador. Nada aqui depende desses prints.

Repositório: `emanuelrodrigues2005/skill-finder`.

## 1. Run verde — `45273346584` (`Deploy`, `workflow_run`, `main`)

    $ gh run view 45273346584 --json displayTitle,headSha,headBranch,event,conclusion,createdAt

    displayTitle  Deploy
    event         workflow_run
    headBranch    main
    headSha       d8574a943270980ff44346885fdb332d77b5b0c7
    conclusion    success
    createdAt     2026-11-23T21:48:12Z

Cinco jobs, e o veredicto de cada um:

| job | conclusão | janela (UTC) | job id |
| --- | --- | --- | --- |
| `gate` | success | 21:48:14 → 21:48:26 | 138038610162 |
| `build` | success | 21:48:29 → 21:50:12 | 138038747042 |
| `provision` | skipped | — | 138038749859 |
| `deploy` | success | 21:50:14 → 21:51:47 | 138039762615 |
| `smoke` | success | 21:51:50 → 21:52:00 | 138040682494 |

`provision` aparece `skipped` **por desenho**, não por falha: o job só roda com
`inputs.provision` verdadeiro (`.github/workflows/deploy.yml:262-263`), e neste run a EC2 da F3
já existia. O `deploy` declara explicitamente que aceita `provision: skipped`
(`.github/workflows/deploy.yml:319-320`), então a cadeia segue.

Passos executados dentro de cada job, como o `--json` devolveu:

- `gate`: *Mask credentials*, *Verify the lab session*, *Resolve the deploy target*,
  *Fail fast when the host is missing* — e *Prove the CI gate for a manual dispatch* **skipped**,
  porque a origem não foi dispatch (item 5).
- `build`: *Checkout the deployed commit*, *Log in to Docker Hub*,
  *Build and push both images*, *Assert the SHA tag is in the registry* — todos `success`.
- `deploy`: *Resolve the host*, *Wait for the SSM agent*, *Prepare the SSM runner*,
  *Ship the compose files and the obs config*, *Deploy through SSM*, *Summary* — todos `success`.
- `smoke`: *smoke /healthz is JSON and ok*, *smoke /readyz is JSON and ok*,
  *smoke / serves the SPA as HTML*, *smoke admin ingest answers 401 without a token*,
  *smoke /grafana/ asks for a login*, *smoke /metrics is closed at the edge* — todos `success`.

### 1.1 Transcrição do `$GITHUB_STEP_SUMMARY` do job `deploy`

O sumário renderizado de um passo não é exposto pela API (`output.summary` volta `null` no
`check-runs`), então o conteúdo abaixo é o **template exato** de
`.github/workflows/deploy.yml:660-687` preenchido com os valores que o próprio job imprimiu no
log (`SHA`, `PUBLIC_IP`, `EVENT_NAME`) e com o veredicto de observabilidade lido do marcador
`::obs-ok::` na saída do SSM (linha 651 do log do job). Nenhum campo é estimado.

```markdown
## Deploy

| item | valor |
| --- | --- |
| commit | `d8574a943270980ff44346885fdb332d77b5b0c7` |
| IP publico | `54.89.140.66` |
| imagens | `emanuelr05/skill-finder-api:d8574a943270980ff44346885fdb332d77b5b0c7`, `emanuelr05/skill-finder-web:d8574a943270980ff44346885fdb332d77b5b0c7` |
| registry | `docker.io/emanuelr05` (publico, pull anonimo) |
| segredos | `Infisical prod` lido no host |
| observabilidade | `no ar` |
| gatilho | `workflow_run` |

Rollback: dispare com `image_tag=<SHA anterior>` e `skip_build=true`.
```

De onde saiu cada valor:

| campo | origem no log |
| --- | --- |
| `commit` | `env: SHA: d8574a943270980ff44346885fdb332d77b5b0c7` (passo *Summary*) |
| `IP publico` | `env: PUBLIC_IP: 54.89.140.66` (passo *Summary*, output de `steps.target`) |
| `imagens` | `DOCKERHUB_USER: emanuelr05` + `SHA` (a tag é o SHA; `latest` não é publicado) |
| `observabilidade` | `::obs-ok:: stack obs aplicada` (passo *Deploy through SSM*, 21:51:44Z) |
| `gatilho` | `EVENT_NAME: workflow_run` |

O caminho normal (`fora`) do sumário não valeu aqui: o marcador lido foi `::obs-ok::`, e o job
`smoke` confirmou o resultado por fora, no passo *smoke /grafana/ asks for a login*.

## 2. Run vermelho — `45273141415` (`Deploy`, `workflow_dispatch`, `main`)

    $ gh run view 45273141415 --json displayTitle,headSha,event,conclusion,createdAt

    displayTitle  Deploy
    event         workflow_dispatch
    headSha       d8574a943270980ff44346885fdb332d77b5b0c7
    conclusion    failure
    createdAt     2026-11-23T21:46:57Z

| job | conclusão |
| --- | --- |
| `gate` | **failure** |
| `build` | skipped |
| `provision` | skipped |
| `deploy` | skipped |
| `smoke` | skipped |

Motivo exato, transcrito do passo *Prove the CI gate for a manual dispatch*:

    ##[error]nenhum run verde do CI para d8574a943270980ff44346885fdb332d77b5b0c7;
      dispatch manual exige o mesmo gate do workflow_run
    ##[error]Process completed with exit code 1.

O passo compara o SHA pedido com os runs de `ci.yml` cujo `conclusion` é `success`
(`.github/workflows/deploy.yml:135-141`). **A causa é temporal, e o histórico mostra isso:**

| horário (UTC) | evento |
| --- | --- |
| 21:46:42 | `ci.yml` run `45273101280` nasce para `d8574a9` (evento `push`) |
| 21:46:57 | dispatch manual do `deploy.yml` para o **mesmo** SHA |
| 21:47:06 | `gate` consulta a API: **zero** runs verdes de CI para o SHA → reprova |
| 21:48:08 | o CI do SHA conclui `success` |

Ou seja: o dispatch chegou 66 s antes de o CI terminar. O CI daquele SHA fechou verde
(run `45273101280`, 8 jobs `success`: `secrets`, `lint`, `typecheck`, `contract`, `test-unit`,
`test-integration`, `test-e2e`, `test-web`), e 4 s depois o `workflow_run` abriu o run verde do
item 1. É exatamente o comportamento pretendido: **a execução do deploy é consequência do CI
verde, não da vontade de quem dispara.**

## 3. Run vermelho — `44849868942` (`Deploy`, `workflow_dispatch`, 2026-11-21)

    $ gh run view 44849868942 --json displayTitle,headSha,event,conclusion,createdAt

    displayTitle  Deploy
    event         workflow_dispatch
    headSha       2cdfb7e1ae50dcbcb94937f440a34eaed6b33fc8
    conclusion    failure
    createdAt     2026-11-21T01:23:10Z

| job | conclusão |
| --- | --- |
| `gate` | success |
| `build` | **failure** |
| `provision` | skipped |
| `deploy` | skipped |
| `smoke` | skipped |

Aqui o `gate` **passou** — o CI do SHA `2cdfb7e` estava verde quando o dispatch rodou — e quem
reprovou foi o login no registry, no passo *Log in to Docker Hub* do job `build`
(`docker/login-action@v3`), com o usuário `emanuelr05` e sem o token do Docker Hub:

    ##[group]Run docker/login-action@v3
    with:
      username: emanuelr05
      logout: true
    ##[error]Password required

Por causa disso, os dois passos seguintes do `build` ficaram sem rodar
(*Build and push both images*, *Assert the SHA tag is in the registry*) e `deploy`/`smoke`
nunca nasceram. Neste run o contrato de ordem do pipeline se repete: nada foi implantado sem
artefato publicado.

## 4. O dispatch manual não fura o gate

A prova é o par de runs do **mesmo** SHA `d8574a9`:

| run | gatilho | veredicto do `gate` | resultado |
| --- | --- | --- | --- |
| `45273141415` | `workflow_dispatch` | `failure` — "nenhum run verde do CI para `<sha>`" | `build`/`deploy`/`smoke` skipped |
| `45273346584` | `workflow_run` do CI verde | `success` | gate, build, deploy e smoke verdes |

No run verde, o passo *Prove the CI gate for a manual dispatch* aparece **`skipped`**: ele só
existe no caminho de dispatch (`.github/workflows/deploy.yml:124`), porque no `workflow_run` o
próprio evento já carrega a conclusão do CI, e o `if` do job `gate`
(`.github/workflows/deploy.yml:77-80`) exige `conclusion == 'success'` **e** `event == 'push'` —
o CI de um PR que aponte para `main` não abre deploy.

## 5. Artefatos publicados — o mesmo SHA nas duas imagens

    $ docker manifest inspect emanuelr05/skill-finder-api:d8574a943270980ff44346885fdb332d77b5b0c7 --verbose
    $ docker manifest inspect emanuelr05/skill-finder-web:d8574a943270980ff44346885fdb332d77b5b0c7 --verbose

| imagem | tag | digest do manifesto | mediaType |
| --- | --- | --- | --- |
| `emanuelr05/skill-finder-api` | `d8574a943270980ff44346885fdb332d77b5b0c7` | `sha256:47933c973de13688c2f922c1b88ff56763119d1abb4c0683284a6a8f14342ac6` | `application/vnd.docker.distribution.manifest.v2+json` |
| `emanuelr05/skill-finder-web` | `d8574a943270980ff44346885fdb332d77b5b0c7` | `sha256:83d37a234eab7c751ea5fd16addcce3e55a16da66fb033009aac4742bc2082c1` | `application/vnd.docker.distribution.manifest.v2+json` |

As duas consultas acima rodaram **sem login** no Docker Hub: o repositório é público e o pull no
host é anônimo, então a credencial do registry não existe na VM. O par `build` → `deploy` do run
verde é o que garante que a imagem com essa tag foi construída neste pipeline: os passos
*Build and push both images* e *Assert the SHA tag is in the registry* passaram antes de o
`deploy` começar (21:50:12 → 21:50:14).

## 6. Resposta ao §3.5 do edital — como o teste decide a implantação

O §3.5 pede que se explique como os resultados dos testes influenciam a continuidade da
implantação, e a resposta está no grafo, não na boa vontade: o `deploy.yml` **não tem gatilho por
push nem por tag** — ele nasce de `workflow_run` do `ci.yml` concluído em `main`
(`.github/workflows/deploy.yml:32-46`), e o job `gate` só prossegue com
`github.event.workflow_run.conclusion == 'success' && event == 'push'`
(`.github/workflows/deploy.yml:77-80`). Um teste reprovado no CI, portanto, não "gera aviso": ele
fecha o caminho inteiro. Sem CI verde não há `gate` verde → sem `gate` verde não há job `build`
(`needs: gate`) → sem `build` não há imagem com a tag do SHA → sem imagem não há `deploy`
(`needs: [gate, build, provision]`, `.github/workflows/deploy.yml:313`) → sem `deploy` não há
`smoke` (`needs: deploy`, `.github/workflows/deploy.yml:693`). O `workflow_dispatch` é a única
porta lateral, e ele passa pela **mesma** verificação, consultando a API pelo CI verde daquele
SHA antes de gastar um passo caro — foi isso que o run `45273141415` reprovou em 9 s. É essa
corrente que transforma "testes integrados ao CI/CD" em bloqueio de entrega, e não em relatório.

## 7. Ligação com o §3.3 do edital — as quatro etapas, cada uma com o seu run

| # | etapa do §3.3 | onde está a prova |
| --- | --- | --- |
| 1 | Verificação do código e testes automatizados | `ci.yml` run `45273101280` (push em `main`, SHA `d8574a9`), 8 jobs `success`: `secrets`, `lint`, `typecheck`, `contract`, `test-unit`, `test-integration`, `test-e2e`, `test-web` |
| 2 | Construção e disponibilização dos artefatos | job `build` de `45273346584` (`success`), passos *Build and push both images* e *Assert the SHA tag is in the registry*; artefatos conferidos em `docker manifest inspect` (item 5 deste arquivo) |
| 3 | Implantação automatizada na nuvem | job `deploy` de `45273346584` (`success`) pelo SSM RunCommand, sem SSH e sem clique; saída *Deploy through SSM*: `3 migrations found in prisma/migrations`, `All migrations have been successfully applied.`; sumário em 1.1 |
| 4 | Verificação pós-deploy (disponibilidade/funcionamento) | job `smoke` de `45273346584` (`success`), com seis asserções: `/healthz` JSON e ok, `/readyz` JSON e ok, `/` serve a SPA em HTML, ingestão admin responde 401 sem token, `/grafana/` pede login, `/metrics` fechado na borda |

## 8. Limites desta coleta

- **Sumário renderizado não é recuperável pela API.** `check-runs` devolve `output.summary`
  `null` para todos os jobs, e `gh run view --log` mostra o script que escreve em
  `$GITHUB_STEP_SUMMARY`, não o arquivo final. O item 1.1 foi reconstruído do template do
  workflow mais os valores impressos no log; o campo `observabilidade` vem do marcador
  `::obs-ok::` gravado no log do passo.
- **Prints de tela** da UI do Actions não foram capturados: não havia navegador nesta sessão.
  Ficam para o dono, se quiser juntar `f4-pipeline-verde.png` e `f4-pipeline-vermelho.png` ao
  lado deste arquivo.
- **Logs do job `build` de `44849868942`** vieram por
  `gh api repos/.../actions/jobs/136678469749/logs` (17.312 bytes); `gh run view --log --job`
  voltou vazio nesse run. As linhas de credencial aparecem como `***` na transcrição.
- **A EC2 e o IP `54.89.140.66`** são do laboratório do AWS Academy vigente em 2026-11-23. Não há
  afirmação aqui sobre a disponibilidade do host depois do fim da sessão do lab.
