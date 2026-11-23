# Runbook de operação

Procedimentos de execução, implantação e remoção do Skill Finder na EC2 do AWS Academy — o que o
`docs/00-edital-projeto-2.md` §3.7 cobra como "procedimentos de execução, implantação e remoção" e o
desenho de `docs/01-analise-requisitos-e-arquitetura.md` §4.2 assume.

Vale para toda a página: WSL com AWS CLI v2, Terraform ≥ 1.10 (`terraform version`), `gh` autenticado
(`gh auth status`), `infra/terraform.tfvars` preenchido e credenciais de sessão exportadas:

```bash
source ~/.local/bin/academy-env
aws sts get-caller-identity --query '[Account,Arn]' --output text
```

O caminho principal (§1 e §2) **não usa SSH**: a porta 22 não existe no security group
(`allowed_ssh_cidrs = []`, `infra/network.tf`) e o único canal até o host é o SSM RunCommand.
Nenhuma chave privada é necessária. O único passo que ainda sai por SSH — o backup que precede o
`destroy`, na §3 — está declarado no apêndice A, com o pré-requisito.

As credenciais do Learner Lab duram ~4 h e o `apply` não tem retomada automática: renove no começo
de cada sessão e siga o protocolo de `docs/02-aws-academy-limites-e-riscos.md` §2.6 se expirarem no
meio de um comando.

## 1. Subir

Do zero até a aplicação respondendo pela borda. São duas metades: a infraestrutura (§1.1–§1.4) e o
deploy que coloca a aplicação dentro dela (§1.5); a §1.6 fecha com a verificação pela borda. Para
uma versão nova de código com a stack no ar, vá direto à §2.

### 1.1 Bucket de state — uma vez por conta, fora do Terraform

O bucket **não pertence** ao state que guarda: o `init` falha se ele ainda não existir, e criá-lo
dentro do próprio state é impossível (`docs/02` §7.3). Ele nunca é destruído pela §3.

```bash
bash scripts/bootstrap-state.sh
```

Esperado: `bucket criado` (ou `bucket já existe — não recriado`), `versionamento: Enabled`,
`criptografia SSE-S3 aplicada`, `acesso público bloqueado` e, no fim, a linha com o nome do bucket
(o sufixo é o id da conta). Exporte-o na sessão atual, grave em `~/.local/bin/academy-env` e use o
mesmo valor em `state_bucket` no `terraform.tfvars` (§1.2):

```bash
export TF_STATE_BUCKET="bcc-cloud-tfstate-$(aws sts get-caller-identity --query Account --output text)"
echo "$TF_STATE_BUCKET"
```

### 1.2 Variáveis do Terraform

```bash
cp infra/terraform.tfvars.example infra/terraform.tfvars
"${EDITOR:-vi}" infra/terraform.tfvars
```

`project_name` e `state_bucket` (o nome impresso em §1.1) não têm default. `dockerhub_user` diz de
qual namespace o host puxa as imagens e é o mesmo valor da variable `DOCKERHUB_USERNAME` que o
`deploy.yml` usa para publicar; os dois lados têm de concordar, senão o `pull` no host procura uma
imagem que ninguém publicou.

`allowed_ssh_cidrs` vazio — o default — mantém a **porta 22 fechada**: sem CIDR na lista, a regra
nem existe no security group (`infra/network.tf`). É decisão de desenho, não esquecimento: o deploy
passa por SSM e não precisa de shell. Abrir a porta é trocar a lista por `<rede>/32` e rodar
`terraform apply`; sem isso, nenhum `ssh` responde e o acesso ao host é só o da §2.3.

`key_name` continua no arquivo (default `vockey`, o único par da conta do lab) porque a variável
existe no Terraform, mas nenhum passo do caminho principal depende dela. `terraform.tfvars` é
ignorado pelo Git.

### 1.3 init, plan e apply

O backend é **parcial**: o nome do bucket chega por `-backend-config` a cada `init` e nunca é
versionado (`infra/backend.tf`). O `-reconfigure` é o que faz um `init` repetido aceitar esse valor
em vez de reclamar que o backend já foi configurado.

```bash
cd infra
terraform init -reconfigure -backend-config="bucket=$TF_STATE_BUCKET"
terraform fmt -check -recursive
terraform validate
terraform plan -out=plan.out
terraform apply plan.out
cd ..
```

Os comandos de Terraform entram e saem de `infra/`; o `cd ..` devolve ao repositório, de onde rodam
os comandos de `terraform output`, `gh` e `curl` das seções seguintes.

Esperado: `Terraform has been successfully initialized!`, nenhuma saída de `fmt`, `Success! The
configuration is valid.`, um plano com os cinco outputs (`dockerhub_user`, `host_public_ip`,
`image_repository`, `state_bucket`, `target_port`) e **nenhum** `aws_iam_*`, e por fim
`Apply complete! Resources: N added, 0 changed, 0 destroyed.`

Não use `-auto-approve`: o plano mostra o que será criado antes de o crédito ser gasto, e a sessão
pode expirar no meio (`docs/02` §2.6). O mesmo ciclo existe pronto no pipeline
(`gh workflow run deploy.yml --ref main -f provision=true`, §2.2), mas lá não há plano na tela —
rodar `terraform plan` na frente é o que permite ver o custo antes.

Mudou o `user_data`? Ele só roda em instância nova: o provider atualiza o atributo, mas o cloud-init
não reexecuta num host que já bootou. Force a troca e a sessão de bootstrap acontece de novo —

```bash
terraform apply -replace=aws_instance.app
```

— e o volume de dados é reanexado ao host novo (o `/var/lib/docker` vem junto: as imagens já
baixadas não são perdidas).

### 1.4 IP público

```bash
cd infra
IP="$(terraform output -raw host_public_ip)"
cd ..
echo "$IP"
```

Esperado: um IPv4 público. **O IP muda a cada `stop`/`start` da instância** (não há Elastic IP no
desenho): toda URL abaixo depende de `$IP` e fica inválida depois de religar a máquina. Releia o
output — §4.2 — antes de qualquer comando com `$IP`.

### 1.5 Deploy da aplicação

Depois do `apply` a instância está de pé e **vazia**: o `user_data` instala o Docker, monta o volume
de dados em `/var/lib/docker` e cria `/opt/app`, mas não sobe container nenhum. Quem coloca a
aplicação lá é o pipeline — o mesmo caminho de qualquer deploy, sem procedimento paralelo:

```bash
gh workflow run deploy.yml --ref main
```

Se a infraestrutura acabou de ser criada pelo próprio workflow, `-f provision=true` faz as duas
coisas num dispatch só. O `gate` exige os secrets da sessão AWS, o `DOCKERHUB_TOKEN`, os dois do
Infisical e a variable `DOCKERHUB_USERNAME`; a lista completa e como gravá-los está em
[`docs/app/06-pipeline-deploy.md`](app/06-pipeline-deploy.md) §3, e
`bash scripts/dev/set-deploy-secrets.sh` publica as três credenciais da sessão de uma vez.

A primeira ingestão não é um passo à parte: o deploy chama a rota admin de dentro do host, com o
`ADMIN_TOKEN` do Infisical, e o log do job mostra `ingestao: 202` (ou `409`, se outra ingestão
estiver em curso).

### 1.6 Verificação pela borda

O `smoke` do workflow roda estas checagens e reprova o run em qualquer desvio; rodar à mão serve para
conferir uma borda que ficou de pé fora do último deploy.

```bash
IP="$(cd infra && terraform output -raw host_public_ip)"
curl -fsS "http://$IP/healthz"; echo
curl -fsS "http://$IP/readyz"; echo
curl -sS -o /dev/null -w '%{http_code} %{content_type}\n' "http://$IP/"
curl -sS -o /dev/null -w '%{http_code}\n' "http://$IP/grafana/"
curl -sS -o /dev/null -w '%{http_code}\n' "http://$IP/metrics"
```

| checagem | esperado | o que um desvio significa |
| --- | --- | --- |
| `GET /healthz` | `200`, JSON com `status: ok` | API fora do ar ou nginx sem proxy; segredo ausente no Infisical é a causa mais comum |
| `GET /readyz` | `200`, JSON com `status: ok` | API viva e Postgres fora — o envelope `NOT_READY` diz qual dos dois |
| `GET /` | `200`, `text/html` com `<!doctype html>` | a SPA não subiu, ou o `web` está servindo outro conteúdo |
| `GET /grafana/` | `302` (login) ou `401` | `200` é o Grafana aberto na internet; `404`, proxy apontando para Grafana sem sub-path; `502`, stack obs fora |
| `GET /metrics` | `404` | a borda parou de fechar a rota e os contadores de latência por rota estão públicos |

Um `502` na raiz é quase sempre segredo inválido no Infisical — o motivo exato aparece no log do job
`deploy` (§2.3). `bash scripts/dev/smoke-edge.sh "$IP"` roda `/healthz`, `/readyz`, `/` e a recusa
`401` da rota admin sem token, com código de saída 1 quando alguma falha; `/grafana/` e `/metrics`
ficam de fora dele.

## 2. Implantar

Uma versão nova de código com a infraestrutura de pé. O caminho normal é **automático**: o
`deploy.yml` nasce de um `workflow_run` do `ci.yml` concluído com `success` num `push` para `main`.
O manual é o mesmo workflow, por `workflow_dispatch`. Nada de `terraform apply` aqui — infraestrutura
só muda na §1 — e nada de construir imagem no host.

O canal entre o runner e a EC2 é o **SSM RunCommand**, não SSH: a porta 22 não existe no security
group por decisão de desenho (§1.2), então o runner não guarda chave privada e o host não expõe
shell na internet. O desenho completo — jobs, secrets, limitações do lab — está em
[`docs/app/06-pipeline-deploy.md`](app/06-pipeline-deploy.md).

### 2.1 Caminho normal: merge em `main`

`ci.yml` verde → `deploy.yml` (`workflow_run`, `completed: success`, `push` em `main`) → cinco jobs:

| job | o que faz |
| --- | --- |
| `gate` | valida a sessão AWS (`sts get-caller-identity`), resolve o SHA, exige `DOCKERHUB_USERNAME` e os secrets do Infisical e confere que há host `running` (checagem pulada com `provision=true`) |
| `build` | `docker build --target runtime` de `api` e `web`, `push` no Docker Hub com tag = SHA e `docker manifest inspect` da tag |
| `provision` | `terraform init/validate/plan/apply` — só com `provision=true` |
| `deploy` | SSM: payload do compose e de `observability/`, Infisical no host, `pull`, `up -d --no-build`, `prisma:deploy`, ingestão e `--profile obs` |
| `smoke` | as checagens da §1.6 na borda pública; qualquer desvio reprova o run |

Nada a digitar. Run de CI vermelho não gera run de deploy: o gate é do grafo do GitHub, não uma
segunda suíte de teste (o porquê está em `docs/app/06-pipeline-deploy.md` §2). Run verde com
`smoke: skipped` seria smoke não executado — por isso a condição do job é explícita no `deploy.yml`,
dependente só do veredicto do `deploy`.

### 2.2 Caminho manual: `workflow_dispatch`

Para reimplantar sem merge, subir a infraestrutura junto ou voltar um deploy. O dispatch não escapa
do gate: o passo *Prove the CI gate for a manual dispatch* consulta a API de Actions e exige ao menos
um run verde do `ci.yml` para o SHA que vai ser implantado.

```bash
source ~/.local/bin/academy-env
bash scripts/dev/refresh-aws-secrets.sh     # as 3 credenciais da sessão nos secrets do repo
bash scripts/dev/deploy-preflight.sh        # AWS, host, SSM e secrets, antes de gastar um run
gh workflow run deploy.yml --ref main
gh run watch "$(gh run list --workflow deploy.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
```

`deploy-preflight.sh --offline` roda só as checagens de arquivo, quando a sessão do lab não está
aberta. Os três inputs do dispatch — `image_tag` vazio e os dois booleanos `false` por default:

| input | efeito |
| --- | --- |
| `image_tag` | SHA já publicado que será implantado (rollback, §2.4) |
| `skip_build` | pula build+push e implanta a imagem que já está no Docker Hub |
| `provision` | roda `terraform apply` antes do deploy, para infraestrutura derrubada |

```bash
gh workflow run deploy.yml --ref main -f skip_build=true   # reimplanta o SHA de `main`, sem build
gh workflow run deploy.yml --ref main -f provision=true    # §1 e §2 num dispatch
```

### 2.3 O que acontece no host, e onde ler o resultado

O job `deploy` faz, nesta ordem:

1. resolve o host por tag (`project=skill-finder`) e espera o agente SSM ficar `Online` — é o
   `LabInstanceProfile` que autoriza o agente;
2. manda `compose.yaml`, `infra/deploy/compose.prod.yaml` e `observability/` para `/opt/app` num
   comando SSM próprio: são arquivos do commit, sem segredo nenhum;
3. no host, autentica a machine identity no Infisical e roda, sob `secrets-manager run`,
   `compose pull`, `up -d --no-build`, `npm run --silent prisma:deploy` e a ingestão pela rota admin;
4. por último, `--profile obs up -d --no-build`: Grafana, Prometheus, Loki, Promtail e
   node-exporter.

Os segredos da aplicação (`DATABASE_URL`, `POSTGRES_PASSWORD`, `IP_HASH_SALT`, `ADMIN_TOKEN`,
`LLM_API_KEY`, `GRAFANA_PASSWORD`) existem só no projeto do Infisical, env `prod`: não passam pelo
runner, não ficam em arquivo no host e não aparecem em log. Não há arquivo de ambiente no host de
produção — o compose roda com `--env-file /dev/null` e o ambiente injetado é a única fonte; sobra de
execução antiga é ignorada, com aviso no log.

Onde olhar:

```bash
gh run view <run-id> --log | grep -E 'SSM (payload|deploy)|compose|ingestao|obs-'
gh run view <run-id>            # o Summary: commit, IP, imagens e o veredicto da observabilidade
```

E, para inspecionar o host sem SSH, o mesmo canal do deploy:

```bash
ID="$(aws ec2 describe-instances --filters "Name=tag:project,Values=skill-finder" \
  "Name=instance-state-name,Values=running" \
  --query 'Reservations[0].Instances[0].InstanceId' --output text)"
CMD="$(aws ssm send-command --document-name AWS-RunShellScript --instance-ids "$ID" \
  --comment "estado do compose" --timeout-seconds 120 \
  --parameters 'commands=["cd /opt/app && docker compose -f compose.yaml -f infra/deploy/compose.prod.yaml --profile prod --profile obs ps"]' \
  --query 'Command.CommandId' --output text)"
aws ssm wait command-executed --command-id "$CMD" --instance-id "$ID"
aws ssm get-command-invocation --command-id "$CMD" --instance-id "$ID" \
  --query '[Status,StandardOutputContent]' --output text
```

A saída do SSM volta truncada em 24 mil caracteres: serve para `ps` e para `logs --tail=50`, não para
arquivo grande — backup de banco é a §3, por outro canal.

### 2.4 Voltar um deploy (rollback)

A tag de cada imagem é o SHA do commit e o Docker Hub não expira tag: voltar é repetir o deploy
apontando para o SHA anterior, sem rebuild e sem `apply`.

```bash
gh workflow run deploy.yml --ref main -f image_tag=<sha-anterior> -f skip_build=true
```

É o mesmo caminho da §2.3 — Infisical, `pull`, `up -d --no-build`, `prisma:deploy`, obs —, e o
`smoke` da §1.6 só fecha verde se a versão antiga responder pela borda: o rollback é verificado como
um deploy. Migrations aplicadas **não** voltam: elas são para frente por desenho, e é por isso que a
migração de cada release entra antes do smoke. Reverter schema exige um release novo, não um
dispatch.

Se a tag anterior não existir mais no Docker Hub, dispare com `image_tag=<sha-anterior>` e **sem**
`skip_build`: o `build` faz checkout daquele commit, republica a tag e o `deploy` a consome — e o
gate manual continua exigindo um run verde do CI para o SHA.

## 3. Destruir

Remove tudo o que o Terraform criou e **pára de gastar crédito**. O bucket de state da §1.1 sobrevive
— ele não pertence a este state.

Antes de destruir, salve o que o `destroy` leva junto: o volume EBS de dados (o banco) é apagado. O
`pg_dump` abaixo sai por SSH, o único passo do runbook que ainda depende da porta 22 — o
pré-requisito está no apêndice A.

```bash
IP="$(cd infra && terraform output -raw host_public_ip)"
ssh -i ~/.ssh/labsuser.pem "ubuntu@$IP" 'cd /opt/app && docker compose -f compose.yaml -f infra/deploy/compose.prod.yaml --profile prod exec -T postgres pg_dump -U skills skills' > backup-$(date +%Y%m%d).sql
```

### 3.1 destroy

```bash
cd infra
terraform plan -destroy
terraform destroy
cd ..
```

Esperado: o plano lista os recursos a destruir e `Destroy complete! Resources: N destroyed.` sem
erro. Sem `-auto-approve`: a lista é a última chance de ver que a instância certa vai sair.

### 3.2 Varredura de órfãos

`destroy` pode deixar recurso para trás (apply interrompido, criação fora do state). A varredura é
por tag — o valor é o `project_name` do `terraform.tfvars`, em minúsculo (`project`, nunca
`Project`): todo recurso do state carrega essa tag.

```bash
aws ec2 describe-instances --filters "Name=tag:project,Values=skill-finder" \
  --query 'Reservations[].Instances[].[InstanceId,State.Name]' --output table
aws ec2 describe-volumes --filters "Name=tag:project,Values=skill-finder" \
  --query 'Volumes[].[VolumeId,State,Size]' --output table
aws ec2 describe-security-groups --filters "Name=tag:project,Values=skill-finder" \
  --query 'SecurityGroups[].[GroupId,GroupName]' --output table
```

Esperado: **três tabelas vazias**. Qualquer linha é órfão e continua consumindo crédito. Confira o
id na tabela e remova com o comando abaixo — sem id, ele falha em vez de apagar outra coisa; repita a
varredura e o comando até as tabelas voltarem vazias (`delete-volume` apaga um volume por vez):

```bash
aws ec2 terminate-instances --instance-ids \
  "$(aws ec2 describe-instances --filters "Name=tag:project,Values=skill-finder" \
     --query 'Reservations[].Instances[].InstanceId' --output text)"
aws ec2 delete-volume --volume-id \
  "$(aws ec2 describe-volumes --filters "Name=tag:project,Values=skill-finder" \
     --query 'Volumes[0].VolumeId' --output text)"
aws ec2 delete-security-group --group-id \
  "$(aws ec2 describe-security-groups --filters "Name=tag:project,Values=skill-finder" \
     --query 'SecurityGroups[0].GroupId' --output text)"
```

Um security group só é removível depois que a última instância que o usa sumiu — se o
`delete-security-group` falhar com `DependencyViolation`, aguarde o `terminated` e repita.

### 3.3 Confirmar state vazio e bucket preservado

```bash
(cd infra && terraform state list)
aws s3 ls --recursive "s3://$TF_STATE_BUCKET"
```

Esperado: `state list` sem nenhuma linha e o `s3 ls` ainda listando o `terraform.tfstate` sob o
prefixo que `infra/backend.tf` declara em `key`. Bucket apagado por engano é state perdido — o
`bootstrap-state.sh` recria o bucket, não o histórico; o versionamento do S3 é o que permite voltar a
uma versão anterior do arquivo.

## 4. Encerrar sessão

Duas coisas diferentes: **parar a instância** (economiza crédito, preserva os dados) e **encerrar o
lab** (as credenciais morrem; os recursos ficam — `docs/02` §6.1–6.2).

### 4.1 Parar a instância

```bash
ID="$(aws ec2 describe-instances --filters "Name=tag:project,Values=skill-finder" \
  "Name=instance-state-name,Values=running" \
  --query 'Reservations[].Instances[].InstanceId' --output text)"
aws ec2 stop-instances --instance-ids "$ID"
aws ec2 wait instance-stopped --instance-ids "$ID"
```

Esperado: `StoppingInstances` com o id e, no fim do `wait`, o prompt de volta sem saída. Os dados do
volume EBS continuam lá; o que pára é a aplicação — o `start` da §4.2 devolve tudo.

### 4.2 Religar e recuperar a URL

O IP público **muda** no `stop`/`start`: a URL antiga responde erro de conexão até você reler o
output.

```bash
aws ec2 start-instances --instance-ids "$ID"
aws ec2 wait instance-running --instance-ids "$ID"
IP="$(cd infra && terraform refresh >/dev/null && terraform output -raw host_public_ip)"
echo "$IP"
curl -fsS "http://$IP/healthz"; echo
```

Esperado: um IP novo (ou o mesmo, por sorte) e `200` em `/healthz`. Os containers têm
`restart: unless-stopped` e o Docker sobe no boot. Se `/healthz` continuar fora do ar depois de
~2 min, não há shell no host para mexer em container um a um: o conserto é reimplantar pelo mesmo
canal, que refaz `pull`, `up -d --no-build` e a migração e só fecha verde se a borda responder
(§2.2):

```bash
gh workflow run deploy.yml --ref main -f skip_build=true
```

### 4.3 Fim do lab: credenciais, lock preso

- **Credenciais expiradas** (`ExpiredToken`, `InvalidClientTokenId`): copie as três credenciais de
  *AWS Details* e rode `source ~/.local/bin/academy-env` de novo no **mesmo** terminal.
- **`apply`/`destroy` interrompido pela expiração**: não apague nada no console; renove, rode
  `terraform plan` de dentro de `infra/`, e se um recurso existir na AWS mas não no state traga-o com
  `terraform import <recurso> <id>` (ou `state rm` do registro fantasma). Repita até o plano ficar
  limpo — protocolo completo em `docs/02` §2.6.
- **`Error acquiring the state lock`**: outra execução morreu segurando o lock. Use
  `terraform force-unlock <lock-id>` **apenas** com certeza de que ninguém está aplicando
  (`docs/02` §7.4).
- **End Lab**: o EC2, o EBS, o S3 e o ECR continuam existindo; o que não sobrevive são as
  credenciais e a sessão do console. Vai usar amanhã? Pare a instância (§4.1). Não vai mais usar?
  Destrua (§3) — instância parada ainda cobra o volume EBS.

### 4.4 Fechar o dia

```bash
(cd infra && terraform plan -detailed-exitcode >/dev/null); echo "plan exit: $?"
```

Esperado: `plan exit: 0` (sem mudanças). `2` significa deriva entre o código e a AWS — investigue
antes de sair; `1` é erro de leitura, normalmente credencial vencida. Registre o que mudou em
`docs/evidencias/` se a sessão produziu evidência para o relatório.

## Apêndice A — Legado: procedimento manual (não usado)

As versões anteriores deste runbook ensinavam a subir a aplicação à mão: copiar os arquivos de
composição para o host, escrever o arquivo de ambiente à mão, preencher o registry do ECR e rodar
cada comando por `ssh -i ~/.ssh/labsuser.pem`. **Não é mais o procedimento**: a imagem vem do Docker
Hub público (o pull é anônimo, sem credencial de registry no host), o arquivo de ambiente foi
eliminado (o Infisical injeta no processo) e a porta 22 não existe no security group. O caminho
válido é a §2 — um dispatch, o mesmo do dia a dia.

O que sobrou de SSH no documento é um passo anterior ao canal SSM — o `pg_dump` que precede o
`destroy` (§3) —, e ele não funciona sem o pré-requisito explícito: **`allowed_ssh_cidrs` preenchido**
em `infra/terraform.tfvars` com o CIDR de quem opera (`<rede>/32`) e um **`terraform apply`**. Sem os
dois, não há regra na 22 e o `ssh` não responde. Como conferir o estado da porta:

```bash
aws ec2 describe-security-groups --filters "Name=tag:project,Values=skill-finder" \
  --query 'SecurityGroups[].IpPermissions[].[FromPort,ToPort]' --output text
```

Esperado com o default: só `80 80`. Qualquer `22` na saída é a porta aberta — o que a §1.2 fechou.

Para inspecionar o host sem abrir nada, use o SSM da §2.3; para o backup antes do `destroy` (§3), o
SSH é o canal que resta enquanto não houver upload da base para o S3.
