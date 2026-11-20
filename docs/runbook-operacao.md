# Runbook de operação

Procedimentos de execução, implantação e remoção do Skill Finder na EC2 do AWS Academy — o que o
`docs/00-edital-projeto-2.md` §3.7 cobra como "procedimentos de execução, implantação e remoção" e o
desenho de `docs/01-analise-requisitos-e-arquitetura.md` §4.2 assume.

Vale para toda a página: WSL com AWS CLI v2 e Terraform ≥ 1.10 (`terraform version`), a chave privada
do key pair **`vockey`** em `~/.ssh/labsuser.pem` (`chmod 400`), `infra/terraform.tfvars` preenchido
e credenciais de sessão exportadas:

```bash
source ~/.local/bin/academy-env
aws sts get-caller-identity --query '[Account,Arn]' --output text
```

As credenciais do Learner Lab duram ~4 h e o `apply` não tem retomada automática: renove no começo
de cada sessão e siga o protocolo de `docs/02-aws-academy-limites-e-riscos.md` §2.6 se expirarem no
meio de um comando.

## 1. Subir

Do zero até a aplicação respondendo. Caminho de primeira execução — para uma versão nova de código
já com a stack no ar, use a §2.

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

`project_name`, `key_name` (o key pair da F0) e `state_bucket` (o nome impresso em §1.1) não têm
default. `allowed_ssh_cidrs` vazio mantém a porta 22 fechada; para abrir, use o CIDR da sua rede com
máscara `/32`. `terraform.tfvars` é ignorado pelo Git.

O `key_name` tem default **`vockey`**, e é o único par que existe na conta do lab: nada de criar
`projeto2` nem baixar `.pem` novo — a privada correspondente é o `labsuser.pem` de *AWS Details*.

### 1.3 init, plan e apply

O backend é **parcial**: o nome do bucket chega por `-backend-config` a cada `init` e nunca é
versionado (`infra/backend.tf`).

```bash
cd infra
terraform init -backend-config="bucket=$TF_STATE_BUCKET"
terraform fmt -check -recursive
terraform validate
terraform plan -out=plan.out
terraform apply plan.out
cd ..
```

Os comandos de Terraform entram e saem de `infra/`; o `cd ..` devolve ao repositório, de onde
rodam os comandos de `docker`, `scp` e `git` das seções seguintes.

Esperado: `Terraform has been successfully initialized!`, nenhuma saída de `fmt`, `Success! The
configuration is valid.`, um plano com as 5 saídas (`host_public_ip`, `ecr_registry`,
`ecr_repository_urls`, `state_bucket`, `target_port`) e **nenhum** `aws_iam_*`, e por fim
`Apply complete! Resources: N added, 0 changed, 0 destroyed.`

Não use `-auto-approve`: o plano mostra o que será criado antes de o crédito ser gasto, e a sessão
pode expirar no meio (`docs/02` §2.6).

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

### 1.5 Compose e `/opt/app/.env`

O host não tem o repositório e **não precisa dele**: o código roda dentro da imagem publicada no
ECR (§1.6). Para `/opt/app` vão só os dois arquivos de composição e o `.env` — `/opt/app` já existe
porque o `user_data` o criou.

```bash
IP="$(cd infra && terraform output -raw host_public_ip)"
git archive --format=tar.gz -o /tmp/compose.tar.gz HEAD compose.yaml infra/deploy/compose.prod.yaml
scp -i ~/.ssh/labsuser.pem /tmp/compose.tar.gz "ubuntu@$IP:/tmp/"
ssh -i ~/.ssh/labsuser.pem "ubuntu@$IP" 'sudo mkdir -p /opt/app && sudo tar -xzf /tmp/compose.tar.gz -C /opt/app && sudo chown -R ubuntu:ubuntu /opt/app && ls -R /opt/app'
```

Esperado: `compose.yaml` e `infra/deploy/compose.prod.yaml`. Nenhum `backend/`, nenhum `frontend/`:
o que o host executa vem do registry, não do checkout.

O `.env` é lido pelo compose (`env_file`) e é o que faz a API passar no schema de produção. As
últimas quatro linhas não são segredo: são a interpolação de `infra/deploy/compose.prod.yaml`, e o
registry vem de `terraform output` para o id da conta não ser escrito no repositório.

```bash
ECR_REGISTRY="$(cd infra && terraform output -raw ecr_registry)"
IMAGE_TAG="$(git rev-parse --short HEAD)"
ssh -i ~/.ssh/labsuser.pem "ubuntu@$IP" 'umask 077 && cat > /opt/app/.env' <<EOF
POSTGRES_USER=skills
POSTGRES_PASSWORD=$(openssl rand -hex 24)
POSTGRES_DB=skills
IP_HASH_SALT=$(openssl rand -hex 16)
ADMIN_TOKEN=$(openssl rand -hex 32)
LLM_ENABLED=true
LLM_API_KEY=troque-pela-chave-do-provedor
SKILL_SOURCE_KIND=html
WEB_PORT=80
ECR_REGISTRY=$ECR_REGISTRY
ECR_API_REPOSITORY=skill-finder-api
ECR_WEB_REPOSITORY=skill-finder-web
IMAGE_TAG=$IMAGE_TAG
EOF
ssh -i ~/.ssh/labsuser.pem "ubuntu@$IP" 'chmod 600 /opt/app/.env && stat -c "%a %U" /opt/app/.env'
```

Esperado: `600 ubuntu`. O `chmod 600` é obrigatório — o arquivo tem a senha do banco, o
`ADMIN_TOKEN` e a chave da LLM, e é lido por um usuário só.

Troque `LLM_API_KEY` pelo valor real **antes** de rodar o bloco: o schema só exige string não vazia,
então o placeholder passa no boot e falha na primeira busca, com `degraded: true`.

Por que essas chaves: o compose deriva `DATABASE_URL` de `POSTGRES_*` e fixa `ENV=prod` por
serviço; com `ENV=prod` o boot **recusa** subir sem `DATABASE_URL`, `IP_HASH_SALT`, `ADMIN_TOKEN`
(≥ 32 caracteres) e `LLM_API_KEY` (quando `LLM_ENABLED=true`), e recusa a senha de dev `skillsdev`
(`backend/src/config/env.schema.ts`). `WEB_PORT=80` é o que publica o nginx na porta 80 — sem ele o
stack sobe na 8081 e `http://$IP/` não responde.

### 1.6 Puxar as imagens do ECR, subir e migrar

O `IMAGE_TAG` sai do `.env` (§1.5) e é o mesmo SHA nos dois repositórios: `pull` e `up` leem a
imagem do registry, nunca constroem no host.

```bash
ssh -i ~/.ssh/labsuser.pem "ubuntu@$IP" 'cd /opt/app && docker compose -f compose.yaml -f infra/deploy/compose.prod.yaml --profile prod pull'
ssh -i ~/.ssh/labsuser.pem "ubuntu@$IP" 'cd /opt/app && docker compose -f compose.yaml -f infra/deploy/compose.prod.yaml --profile prod up -d --no-build'
ssh -i ~/.ssh/labsuser.pem "ubuntu@$IP" 'cd /opt/app && docker compose -f compose.yaml -f infra/deploy/compose.prod.yaml --profile prod ps'
ssh -i ~/.ssh/labsuser.pem "ubuntu@$IP" 'cd /opt/app && docker compose -f compose.yaml -f infra/deploy/compose.prod.yaml --profile prod exec -T api npm run --silent prisma:deploy'
```

Esperado: `pull` baixando `skill-finder-api:<sha>`, `skill-finder-web:<sha>` e `postgres:16-alpine`;
`up -d --no-build` subindo os três; `ps` com `api` e `web` em `running (healthy)` (o `postgres`
também, `healthy`); `prisma:deploy` aplicando as migrations pendentes ou respondendo
`No pending migrations to apply.`

O `pull` não pede senha nem AWS CLI. O `user_data` instala o `amazon-ecr-credential-helper` e escreve
`/home/ubuntu/.docker/config.json` com `credHelpers` para o registry da conta; o helper pede o token
ao ECR com a credencial do `LabInstanceProfile` (o `LabRole` tem
`AmazonECRContainerRegistryReadOnly`) e a renova a cada `pull`. Consequência de projeto: nenhum
segredo de registry mora no host e nada vence em 12 h.

```bash
ssh -i ~/.ssh/labsuser.pem "ubuntu@$IP" 'cat /home/ubuntu/.docker/config.json'
```

Esperado: `credHelpers` com `7943…amazonaws.com` → `ecr-login`.

`--no-build` não é opcional: o `compose.yaml` da raiz declara `build:` para `api` e `web`, e sem a
flag o host tentaria construir as duas imagens (`pnpm install --frozen-lockfile` do monorepo em
`t3.small`, 2 GB) em vez de usar o que veio do registry.

### 1.7 Smoke

```bash
curl -fsS "http://$IP/healthz"; echo
curl -fsS "http://$IP/readyz"; echo
curl -fsS -o /dev/null -w '%{http_code}\n' "http://$IP/"
```

Esperado: `200` em `/healthz` e `/readyz` (os dois têm proxy explícito na borda —
`frontend/nginx.conf`) e `200` na raiz com a SPA. Um `502` aqui significa API fora do ar, quase
sempre `.env` inválido — o erro exato do schema aparece em
`ssh -i ~/.ssh/labsuser.pem "ubuntu@$IP" 'cd /opt/app && docker compose -f compose.yaml -f infra/deploy/compose.prod.yaml --profile prod logs api | tail -20'`.

### 1.8 Primeira ingestão

A imagem `runtime` **não** tem `scripts/` nem `ts-node` (`backend/Dockerfile`), então `make seed`,
`pnpm seed` e `pnpm ingest` não rodam no host de produção. Em produção a ingestão é a rota admin,
autenticada por `X-Admin-Token`:

```bash
TOKEN="$(ssh -i ~/.ssh/labsuser.pem "ubuntu@$IP" 'sed -n "s/^ADMIN_TOKEN=//p" /opt/app/.env')"
curl -fsS -X POST "http://$IP/api/v1/admin/ingest" \
  -H "X-Admin-Token: $TOKEN" -H 'Content-Type: application/json' \
  -d '{"source_keys":["vercel-labs/skills/find-skills","anthropics/skills/webapp-testing"]}' | head -c 400; echo
```

Esperado: `202` com o resultado do run. A rota aceita **1 a 20** `source_keys` (`owner/repo/slug`) e
responde `409` se outra ingestão estiver em curso; o ciclo de 720 chaves é do agendador, não desta
rota (`docs/app/02-arquitetura.md` §7.3). O catálogo cresce a cada chamada — o bootstrap completo
são várias.

## 2. Implantar

Uma versão nova de código com a infraestrutura de pé: a imagem nova no ECR, `IMAGE_TAG` trocado,
`pull`, `up -d --no-build`, migração, smoke. Nada de `terraform apply` aqui — infraestrutura só
muda na §1 — e nada de construir imagem no host.

### 2.1 Publicar a imagem e apontar o `IMAGE_TAG`

A imagem sai do CI (F4) ou, sem CI, da máquina de quem desenvolve. O contrato é um só: **tag = SHA
do commit**, nos dois repositórios, e `latest` nunca entra.

```bash
SHA="$(git rev-parse --short HEAD)"
aws ecr get-login-password --region us-east-1 \
  | docker login --username AWS --password-stdin "$(cd infra && terraform output -raw ecr_registry)"
docker build -t "skill-finder-api:$SHA" --target runtime backend
docker build -t "skill-finder-web:$SHA" frontend
docker tag "skill-finder-api:$SHA" "$(cd infra && terraform output -raw ecr_registry)/skill-finder-api:$SHA"
docker tag "skill-finder-web:$SHA" "$(cd infra && terraform output -raw ecr_registry)/skill-finder-web:$SHA"
docker push "$(cd infra && terraform output -raw ecr_registry)/skill-finder-api:$SHA"
docker push "$(cd infra && terraform output -raw ecr_registry)/skill-finder-web:$SHA"
```

Esperado: dois `Pushed` e, em `aws ecr describe-images --repository-name skill-finder-api`, a tag com
o SHA. O `docker login` acima é da máquina de build — o host não faz login nenhum (§1.6).

O host só precisa saber qual SHA rodar, e isso mora no `IMAGE_TAG` do `.env`:

```bash
IP="$(cd infra && terraform output -raw host_public_ip)"
SHA="$(git rev-parse --short HEAD)"
ssh -i ~/.ssh/labsuser.pem "ubuntu@$IP" "sed -i 's/^IMAGE_TAG=.*/IMAGE_TAG=$SHA/' /opt/app/.env && grep -E '^(IMAGE_TAG|ECR_REGISTRY)=' /opt/app/.env"
```

Esperado: `IMAGE_TAG=<sha>` e `ECR_REGISTRY=<conta>.dkr.ecr.us-east-1.amazonaws.com`.

### 2.2 Puxar, subir e migrar

```bash
ssh -i ~/.ssh/labsuser.pem "ubuntu@$IP" 'cd /opt/app && docker compose -f compose.yaml -f infra/deploy/compose.prod.yaml --profile prod pull'
ssh -i ~/.ssh/labsuser.pem "ubuntu@$IP" 'cd /opt/app && docker compose -f compose.yaml -f infra/deploy/compose.prod.yaml --profile prod up -d --no-build'
ssh -i ~/.ssh/labsuser.pem "ubuntu@$IP" 'cd /opt/app && docker compose -f compose.yaml -f infra/deploy/compose.prod.yaml --profile prod exec -T api npm run --silent prisma:deploy'
ssh -i ~/.ssh/labsuser.pem "ubuntu@$IP" 'cd /opt/app && docker compose -f compose.yaml -f infra/deploy/compose.prod.yaml --profile prod ps'
```

Esperado: os serviços cuja imagem mudou são recriados (`Recreated`), os demais seguem `running`, e o
`ps` volta com `api`/`web` `healthy`. `prisma:deploy` é idempotente — pode rodar em todo deploy. O
`pull_policy: always` de `compose.prod.yaml` garante que `up` traga o digest do registry: tag igual e
imagem local velha não passam.

O `.env` **não** é tocado por esta seção além do `IMAGE_TAG`. Mudou um segredo? Edite
`/opt/app/.env`, confirme `chmod 600` e recrie a API:
`docker compose -f compose.yaml -f infra/deploy/compose.prod.yaml --profile prod up -d --force-recreate api`.

### 2.3 Smoke e diagnóstico

```bash
curl -fsS "http://$IP/readyz"; echo
ssh -i ~/.ssh/labsuser.pem "ubuntu@$IP" 'cd /opt/app && docker compose -f compose.yaml -f infra/deploy/compose.prod.yaml --profile prod logs --tail=50 api'
```

Esperado: `200` e log sem `Invalid environment configuration`. Se a imagem subiu mas a API morre no
boot, o log traz o campo que falta (`DATABASE_URL`, `IP_HASH_SALT`, `ADMIN_TOKEN`, `LLM_API_KEY`).

### 2.4 Voltar um deploy (rollback)

O ECR guarda as 5 imagens mais recentes de cada repositório (`infra/ecr.tf`), então voltar é apontar
o `IMAGE_TAG` para o SHA anterior e repetir §2.2 — sem rebuild, sem `apply`:

```bash
SHA_ANTERIOR="<sha que está rodando hoje>"
ssh -i ~/.ssh/labsuser.pem "ubuntu@$IP" "sed -i 's/^IMAGE_TAG=.*/IMAGE_TAG=$SHA_ANTERIOR/' /opt/app/.env"
```

Depois, `pull` + `up -d --no-build` + `prisma:deploy` (§2.2) e o smoke (§2.3). Se o SHA anterior já
saiu da janela de 5 imagens, o rollback é republicar o commit antigo
(`git switch --detach <sha>` e o bloco de build de §2.1) — migrations aplicadas **não** voltam: elas
são para frente por desenho, e é por isso que a migration de cada release entra antes do smoke.

## 3. Destruir

Remove tudo o que o Terraform criou e **pára de gastar crédito**. O bucket de state da §1.1 sobrevive
— ele não pertence a este state.

Antes de destruir, salve o que o `destroy` leva junto: o volume EBS de dados (o banco) é apagado.

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
`restart: unless-stopped` e o Docker sobe no boot; se `ps` não mostrar `healthy` em ~2 min:

```bash
ssh -i ~/.ssh/labsuser.pem "ubuntu@$IP" 'cd /opt/app && docker compose -f compose.yaml -f infra/deploy/compose.prod.yaml --profile prod up -d --no-build'
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
