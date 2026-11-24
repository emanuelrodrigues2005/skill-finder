# Segurança e gerenciamento de segredos

Modelo de segredos do projeto: onde cada credencial vive, quem consegue lê-la, o que acontece
quando ela vaza e como trocá-la sem tocar em código. É a resposta demonstrável ao §3.4 do edital
(`docs/00-edital-projeto-2.md:73-83`) — "credenciais da aplicação e do pipeline disponibilizadas
de forma segura, sem exposição em logs, no código-fonte ou em artefatos públicos".

O desenho em uma frase: **o cofre é a única fonte de verdade, o runner do CI nunca vê segredo de
aplicação, e o host busca os valores no momento do deploy** (`infisical secrets-manager run`).
As provas de cada afirmação estão em `docs/evidencias/f5-seguranca.txt`.

## 1. Inventário: os seis segredos

| Segredo | Onde vive | Quem consome | Comprimento | O que quebra sem ele |
| --- | --- | --- | --- | --- |
| `DATABASE_URL` | Infisical, projeto `2af53052…`, ambiente `prod` | container `api` → Prisma (`compose.yaml:45`) | 105 | boot em `prod` recusa subir (`backend/src/config/env.schema.ts:163`) |
| `POSTGRES_PASSWORD` | idem | container `postgres` (`compose.yaml:74,89`) | 64 | a senha fica presa no volume criado; divergir de `DATABASE_URL` faz a API falhar na conexão |
| `ADMIN_TOKEN` | idem | `api` (guard de `POST /api/v1/admin/ingest`) e o job `deploy` | 64 | boot em `prod` recusa; a rota falha fechada com 401 (`env.schema.ts:130,177`) |
| `IP_HASH_SALT` | idem | `api` (hash do IP no histórico de busca) | 64 | boot em `prod` recusa; sem sal o hash de IPv4 é reversível por tabela (`env.schema.ts:171`) |
| `LLM_API_KEY` | idem | `api` → provedor OpenAI-compatível | 51 | boot em `prod` recusa **se** `LLM_ENABLED=true` (`env.schema.ts:166`) |
| `GRAFANA_PASSWORD` | idem | container `grafana` → `GF_SECURITY_ADMIN_PASSWORD` (`compose.yaml:299`) | 48 | o Grafana sobe com a senha default do fabricante (achado da #18; criado na #19) |

**Não são segredo e por isso não estão no cofre:** `IMAGE_TAG`, `DOCKERHUB_USER`, `WEB_PORT`,
`SKILL_SOURCE_KIND`, `POSTGRES_USER` e `POSTGRES_DB` são exportados pelo próprio job `deploy`
(`.github/workflows/deploy.yml:528-531`); o `DOCKERHUB_TOKEN` é credencial de registry e vive
só no runner.

## 2. Quem lê o quê

| Quem | O que consegue ver | Por quê |
| --- | --- | --- |
| Runner do CI (GitHub Actions) | os **seis** Actions Secrets: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `DOCKERHUB_TOKEN`, `INFISICAL_CLIENT_ID`, `INFISICAL_CLIENT_SECRET` | são as credenciais de que o pipeline precisa para falar com a AWS, publicar imagem e autenticar no Infisical |
| Runner do CI — segredo de aplicação | **nada** | os seis nomes da §1 não existem como secret do GitHub; o workflow não os referencia em nenhum ponto (`.github/workflows/deploy.yml` só pede `secrets.*` para AWS, Docker Hub e Infisical) |
| Job `deploy` (runner) | as cinco credenciais que ele usa, mascaradas com `::add-mask::` antes do primeiro uso (`deploy.yml:340-349`) | o log do run 44850515112 mostra 37 linhas com `***` e **zero** ocorrências dos prefixos procuráveis dos valores de aplicação (`oc_sk_`, `postgresql://skills:`, `skillsdev`) |
| Host (SSM RunCommand, como `root`) | os seis valores, **na hora do deploy**, injetados no ambiente do processo | `infisical secrets-manager run --projectId … --env prod -- bash <script>` (`deploy.yml:578-579`); o compose interpola do ambiente e roda com `--env-file /dev/null`, então nenhum arquivo de segredo fica no disco |
| Containers (`api`, `postgres`, `grafana`) | cada um só as variáveis que o compose lhe passa | interpolação do ambiente; `docker inspect` mostra o env do container — quem tem root no host já tem tudo |
| Sessão da CLI no WSL do operador | os seis valores em claro (`secrets get`) | é a credencial de operação; ver §5, risco 5 |

Consequências do desenho:

- **Trazer o segredo para o runner pioraria.** O único canal até o host é o payload do SSM, que
  fica no histórico de invocações: mover os valores para o runner só os colocaria em dois lugares
  em vez de um (`docs/app/06-pipeline-deploy.md:150-159`).
- **O token da identidade morre no fim do comando.** O script remoto nasce de um login Universal
  Auth por deploy, grava a sessão com `umask 077` e um `trap` executa `infisical logout` em
  sucesso, erro ou sinal, apagando também o script intermediário de `/tmp`
  (`deploy.yml:466-477`).
- **A única exceção é o client secret da identidade**, que viaja no payload do SSM — risco
  declarado na §5 e detalhado em `docs/app/06-pipeline-deploy.md` §4.1.

## 3. Escopo da machine identity

A identidade de máquina é **Universal Auth** com papel **`Viewer`** (somente leitura) no projeto,
restrita ao ambiente `prod`. É a menor permissão que faz o deploy funcionar, e nada além disso:

- **Ler é tudo o que o deploy faz.** O host recebe os valores, exporta no ambiente do `compose` e
  não escreve nada de volta no cofre. Nenhum passo do pipeline cria, altera ou apaga segredo.
- **Não há escrita de aplicação no cofre.** Rotação é ato do operador (§4), não do pipeline: uma
  identidade que pudesse escrever permitiria a um run comprometido *plantar* valor em vez de só
  lê-lo.
- **`Viewer` já é mais do que o estritamente necessário** no sentido de alcance (lê o ambiente
  inteiro), e é o mínimo que o produto oferece sem criar política por caminho — declarado como
  risco aceito, não como virtude.

**O que `Admin` permitiria** (por isso não é o papel escolhido):

| Ação permitida por `Admin` | Dano concreto |
| --- | --- |
| Reescrever `DATABASE_URL`/`POSTGRES_PASSWORD` | o próximo deploy sobe a API apontando para **outro banco**: o catálogo é escrito onde o atacante lê, e a instância original fica com o banco velho |
| Trocar `ADMIN_TOKEN` por um valor conhecido | `POST /api/v1/admin/ingest` passa a aceitar a chamada do atacante — escrita autenticada no catálogo |
| Trocar `LLM_API_KEY` por uma chave própria | o tráfego de inferência (e o custo) muda de dono sem nenhuma linha de código alterada |
| Trocar `GRAFANA_PASSWORD` | acesso ao dashboard com o usuário `admin` |
| Apagar segredos | o deploy seguinte falha fechado (o boot em `prod` recusa) e a operação para |

O que a identidade **não** limita: o histórico do SSM. Revogar a identidade invalida o client
secret, inclusive a cópia que está no histórico — mas os seis valores de aplicação só chegam ao
host depois do login, e é isso que a §5 declara.

**Não verificado:** a CLI 0.45.13 não expõe a role de uma identidade. A conferência é no painel
`Access Control → Machine Identities` do projeto `2af53052…`; o comando que fecharia a lacuna não
existe nesta versão (`infisical machine-identity --help` não é um subcomando dela).

## 4. Rotação e revogação

**Rotação normal — trocar no cofre e reexecutar o deploy. Nada de código muda.**

```bash
# 1. novo valor no cofre (a saída vem mascarada em create/update)
infisical secrets-manager secrets update ADMIN_TOKEN="$(openssl rand -hex 32)" \
  --projectId 2af53052-6e7a-4e59-a321-4525fa7fadae --env prod

# 2. reimplantar: o host busca o valor novo na hora e o compose recria o container
gh workflow run deploy.yml --field image_tag="$(git rev-parse HEAD)" --field skip_build=true

# 3. provar que o processo subiu com o valor novo
curl -fsS http://<host>/readyz
```

Casos que exigem cuidado extra:

| Segredo | Cuidado na rotação |
| --- | --- |
| `DATABASE_URL` + `POSTGRES_PASSWORD` | são um par e têm de ser trocados juntos: a senha fica **fixada no volume** criado na primeira subida. Trocar sem `ALTER ROLE … PASSWORD` no banco faz a API subir e falhar na conexão (`docs/app/06-pipeline-deploy.md` §4.2) |
| `ADMIN_TOKEN` | depois do redeploy, a ingestão do próprio deploy já usa o valor novo; se o valor antigo tiver vazado, ele deixa de valer no mesmo instante |
| `LLM_API_KEY` | revogar a chave no provedor **antes** de gravar a nova no cofre: o intervalo entre as duas ações é de API degradada (`degraded: true`), não de erro |
| `GRAFANA_PASSWORD` | o Grafana cria o usuário `admin` na primeira subida; trocar a variável depois disso **não** reescreve a senha existente. O caminho é trocar pela UI ou recriar o volume `grafana-data` — **não verificado nesta sessão**; o comando que fecha: `docker compose --profile obs exec grafana grafana-cli admin reset-admin-password <nova>` |

**Revogação — o encerramento da entrega.** Depois da apresentação, a identidade e os dois secrets
que a representam saem de cena:

```bash
# no painel: Access Control -> Machine Identities -> Revoke (projeto 2af53052...)
gh secret delete INFISICAL_CLIENT_ID
gh secret delete INFISICAL_CLIENT_SECRET
```

O que passa a acontecer: o `deploy` falha **fechado** logo depois do login (`deploy.yml:521-524`
aborta se o Universal Auth não devolver token), os containers que já estão no ar seguem rodando com
o ambiente que têm, e nenhum deploy novo é possível. Para voltar atrás, cria-se identidade nova e
grava-se o par novo. A ordem importa: revogar **depois** de validar a entrega e **antes** de a
sessão do lab expirar, senão o histórico do SSM continua legível e sem dono.

Rotacionar os seis valores também é o procedimento de resposta a vazamento (R08 em
`docs/04-plano-de-execucao.md` §9): um segredo que apareceu em log é considerado vazado, não
"apagado do log".

## 5. Riscos aceitos, declarados

| # | Risco | Por que aceitamos | O que limita o dano | Como sair |
| --- | --- | --- | --- | --- |
| 1 | **`LabRole` larga e compartilhada** | o AWS Academy não permite criar role nem policy; a instância usa `LabInstanceProfile`/`LabRole` por definição (`docs/02-aws-academy-limites-e-riscos.md` §4.3, item 5) | a conta é efêmera, isolada por sessão e sem dado real; nada além do necessário é provisionado | sair do lab para uma conta com role própria e política por recurso |
| 2 | **HTTP sem TLS** | sem domínio próprio nem certificado no Academy; o ALB publica 80 e a 22 nem existe por padrão (`infra/network.tf`) | **A partir da F7 há credencial de usuário neste caminho:** o login do Grafana (`POST /grafana/login`) cruza a rede em claro, e a sessão resultante dá acesso aos logs de container da VM do back. A ingestão manual pela borda mandaria o `X-Admin-Token` em claro — por isso a demo **não** ingere pela borda (SSM ou `localhost`, como o deploy já faz). Um observador passivo na rede da faculdade captura o que passar; um ativo também reescreve a SPA | ALB + ACM (ou Caddy com Let's Encrypt) e redirect 80→443. Enquanto não houver: entrar no Grafana por túnel SSM, não pela URL do ALB, e **rotacionar** `GRAFANA_PASSWORD` e `ADMIN_TOKEN` se algum já cruzou rede compartilhada |
| 3 | **Client secret da identity no payload do SSM e no histórico de invocações** | não há outro canal: a porta 22 está fechada e a conta não cria IAM nem `ssm:GetParameter` com KMS (`docs/app/06-pipeline-deploy.md` §4.1) | o secret **só lê** o ambiente `prod`; o runner o mascara com `::add-mask::`; revogar a identidade invalida o valor no histórico | operador escreve `/opt/app/.infisical` (`0600`) uma vez por instância; um passo além, `SecureString` no Parameter Store |
| 4 | **Grafana publicado pela borda, atrás de login e sem TLS** | decisão do dono (ADR-013): a banca vê o painel pela URL do ALB, sem túnel | `GF_AUTH_ANONYMOUS_ENABLED=false`, `GF_USERS_ALLOW_SIGN_UP=false`, senha vinda do cofre. **O bind deixou de ser o controle:** o `GRAFANA_BIND=0.0.0.0` do deploy e a regra `/grafana/*` do ALB tornam o painel alcançável da internet — o `127.0.0.1:3000` desta linha valia antes da F7 e não vale mais. O que limita hoje é o login + o security group (`sg-api` aceita 3000 **só** de `sg-alb`) | TLS com proxy autenticado; ou túnel SSM (`aws ssm start-session --document-name AWS-StartPortForwardingSession`) para a demo |
| 5 | **A CLI imprime os valores em claro no `secrets get`** (achado desta issue) | é o comportamento da 0.45.13; `--show-values` só existe em `create`/`update`, onde a tabela vem mascarada | a sessão é do operador, no WSL dele; nada é copiado para arquivo, log ou evidência; `infisical logout` quando a sessão não estiver em uso | trocar para `secrets get <NOME> --plain` só quando o valor for realmente necessário e nunca com o output em log; ou usar a UI |

**Sobre "least privilege possível" — a justificativa honesta.** O edital (§3.4) cobra gestão de
credenciais, não uma política de IAM desenhada por recurso. Onde o lab permite (cofre, identidade
`Viewer`, imagem sem segredo, log mascarado), o privilégio é mínimo; onde não permite (`LabRole`),
ele é o mínimo que a plataforma oferece, e está declarado acima em vez de omitido.

**Quem lê o histórico do SSM:** qualquer credencial com `ssm:ListCommands` /
`ssm:GetCommandInvocation` na conta do lab — na prática, todo mundo que tem as credenciais da
sessão do Academy. É por isso que o risco 3 tem prazo: a identidade é revogada no fim da entrega
(§4).

## 6. Evidências

Todas as provas abaixo estão transcritas, com o comando e a saída, em
[`docs/evidencias/f5-seguranca.txt`](evidencias/f5-seguranca.txt).

| Afirmação | Prova | Resultado |
| --- | --- | --- |
| Os seis segredos existem no cofre | `infisical secrets-manager secrets get --projectId 2af53052… --env prod` | seis nomes listados; `GRAFANA_PASSWORD` criada na #19 (comprimento 48) |
| Nenhum segredo no histórico do Git | `gitleaks detect` (imagem oficial, v8.30.1) | 99 commits, 5,05 MB, `no leaks found` |
| Nenhum segredo na árvore do backend | `gitleaks detect --no-git --source backend` | 3,02 MB, `no leaks found` |
| Nenhum arquivo de segredo versionado | `git ls-files \| grep -E '(^\|/)\.env'` e `git log --all --full-history -- '*.env'` | só `.env.example`; histórico vazio |
| Segredo mascarado no log do pipeline | `gh api …/actions/jobs/136681134119/logs \| grep -cF '***'` | 37 linhas mascaradas; 0 ocorrências dos prefixos dos valores de aplicação |
| O host lê o cofre no deploy | log do run 44850515112 | `infisical version 0.45.13` no host, 3 containers com a tag do SHA, migrações aplicadas, `ingestao: 202` |
| A aplicação boota sem arquivo de segredo | migrações do Prisma aplicadas e `ingestao: 202` no mesmo run — `DATABASE_URL` e `ADMIN_TOKEN` vieram do ambiente do cofre | conexão com o banco e rota admin funcionando num host sem `.env`; o `/readyz` do job `smoke` **não** rodou nesse run (job `skipped`) |

**O que ainda não está provado** (mesma lista da §7 do arquivo de evidências): a role `Viewer` da
identidade (só o painel mostra), o `curl` em `/grafana/` pela borda (a rota está comentada), o
`/readyz` verde nesse run específico e o `gitleaks` **dentro da imagem** (`docker history` sem
`ENV`/`ARG` de segredo).
