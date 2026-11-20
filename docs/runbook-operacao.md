# Runbook de operação

Procedimentos de execução, implantação e remoção do Skill Finder na EC2 do AWS Academy — o que o
`docs/00-edital-projeto-2.md` §3.7 cobra como "procedimentos de execução, implantação e remoção" e o
desenho de `docs/01-analise-requisitos-e-arquitetura.md` §4.2 assume.

Vale para toda a página: WSL com AWS CLI v2 e Terraform ≥ 1.10 (`terraform version`), key pair em
`~/.ssh/projeto2`, `infra/terraform.tfvars` preenchido e credenciais de sessão exportadas:

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

### 1.5 Código no host e `/opt/app/.env`

O host não tem o repositório: o código chega como arquivo (`git archive`) e é extraído em
`/opt/app`, que é onde o `user_data` já criou o diretório.

```bash
git archive --format=tar.gz -o /tmp/skill-finder.tar.gz HEAD
scp -i ~/.ssh/projeto2 /tmp/skill-finder.tar.gz "ubuntu@$IP:/tmp/"
ssh -i ~/.ssh/projeto2 "ubuntu@$IP" 'sudo mkdir -p /opt/app && sudo tar -xzf /tmp/skill-finder.tar.gz -C /opt/app && sudo chown -R ubuntu:ubuntu /opt/app && ls /opt/app'
```

Esperado: `compose.yaml`, `backend`, `frontend` listados.

O `.env` é lido pelo compose (`env_file`) e é o que faz a API passar no schema de produção:

```bash
ssh -i ~/.ssh/projeto2 "ubuntu@$IP" 'umask 077 && cat > /opt/app/.env' <<EOF
POSTGRES_USER=skills
POSTGRES_PASSWORD=$(openssl rand -hex 24)
POSTGRES_DB=skills
IP_HASH_SALT=$(openssl rand -hex 16)
ADMIN_TOKEN=$(openssl rand -hex 32)
LLM_ENABLED=true
LLM_API_KEY=troque-pela-chave-do-provedor
SKILL_SOURCE_KIND=html
WEB_PORT=80
EOF
ssh -i ~/.ssh/projeto2 "ubuntu@$IP" 'chmod 600 /opt/app/.env && stat -c "%a %U" /opt/app/.env'
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

### 1.6 Subir o stack e migrar

```bash
ssh -i ~/.ssh/projeto2 "ubuntu@$IP" 'cd /opt/app && docker compose --profile prod up -d --build'
ssh -i ~/.ssh/projeto2 "ubuntu@$IP" 'cd /opt/app && docker compose --profile prod ps'
ssh -i ~/.ssh/projeto2 "ubuntu@$IP" 'cd /opt/app && docker compose --profile prod exec -T api npm run --silent prisma:deploy'
```

Esperado: `ps` com `api` e `web` em `running (healthy)` (o `postgres` também, `healthy`), e
`prisma:deploy` aplicando as migrations pendentes ou respondendo `No pending migrations to apply.`

O `--build` acontece no host e precisa de rede: são duas imagens construídas do zero
(`pnpm install --frozen-lockfile`). Em `t3.small` isso leva alguns minutos e é o passo mais pesado
do runbook.

### 1.7 Smoke

```bash
curl -fsS "http://$IP/healthz"; echo
curl -fsS "http://$IP/readyz"; echo
curl -fsS -o /dev/null -w '%{http_code}\n' "http://$IP/"
```

Esperado: `200` em `/healthz` e `/readyz` (os dois têm proxy explícito na borda —
`frontend/nginx.conf`) e `200` na raiz com a SPA. Um `502` aqui significa API fora do ar, quase
sempre `.env` inválido — o erro exato do schema aparece em
`ssh -i ~/.ssh/projeto2 "ubuntu@$IP" 'cd /opt/app && docker compose --profile prod logs api | tail -20'`.

### 1.8 Primeira ingestão

A imagem `runtime` **não** tem `scripts/` nem `ts-node` (`backend/Dockerfile`), então `make seed`,
`pnpm seed` e `pnpm ingest` não rodam no host de produção. Em produção a ingestão é a rota admin,
autenticada por `X-Admin-Token`:

```bash
TOKEN="$(ssh -i ~/.ssh/projeto2 "ubuntu@$IP" 'sed -n "s/^ADMIN_TOKEN=//p" /opt/app/.env')"
curl -fsS -X POST "http://$IP/api/v1/admin/ingest" \
  -H "X-Admin-Token: $TOKEN" -H 'Content-Type: application/json' \
  -d '{"source_keys":["vercel-labs/skills/find-skills","anthropics/skills/webapp-testing"]}' | head -c 400; echo
```

Esperado: `202` com o resultado do run. A rota aceita **1 a 20** `source_keys` (`owner/repo/slug`) e
responde `409` se outra ingestão estiver em curso; o ciclo de 720 chaves é do agendador, não desta
rota (`docs/app/02-arquitetura.md` §7.3). O catálogo cresce a cada chamada — o bootstrap completo
são várias.

## 2. Implantar

Uma versão nova de código com a infraestrutura de pé: código no host, `up -d --build`, migração,
smoke. Nada de `terraform apply` aqui — infraestrutura só muda na §1.

### 2.1 Código novo

```bash
IP="$(cd infra && terraform output -raw host_public_ip)"
git archive --format=tar.gz -o /tmp/skill-finder.tar.gz HEAD
scp -i ~/.ssh/projeto2 /tmp/skill-finder.tar.gz "ubuntu@$IP:/tmp/"
ssh -i ~/.ssh/projeto2 "ubuntu@$IP" 'sudo tar -xzf /tmp/skill-finder.tar.gz -C /opt/app && sudo chown -R ubuntu:ubuntu /opt/app'
```

Esperado: nenhuma saída de erro. O que vai para o host é o commit `HEAD` — alteração não commitada
fica de fora. O `tar` extrai por cima: alteração e remoção de arquivo no host só aparecem se você
apagar `/opt/app/backend` e `/opt/app/frontend` antes — para um deploy limpo:

```bash
ssh -i ~/.ssh/projeto2 "ubuntu@$IP" 'rm -rf /opt/app/backend /opt/app/frontend && tar -xzf /tmp/skill-finder.tar.gz -C /opt/app'
```

### 2.2 Reconstruir e migrar

```bash
ssh -i ~/.ssh/projeto2 "ubuntu@$IP" 'cd /opt/app && docker compose --profile prod up -d --build'
ssh -i ~/.ssh/projeto2 "ubuntu@$IP" 'cd /opt/app && docker compose --profile prod exec -T api npm run --silent prisma:deploy'
ssh -i ~/.ssh/projeto2 "ubuntu@$IP" 'cd /opt/app && docker compose --profile prod ps'
```

Esperado: os serviços cuja imagem mudou são recriados (`Recreated`), os demais seguem
`running`, e o `ps` volta com `api`/`web` `healthy`. `prisma:deploy` é idempotente — pode rodar em
todo deploy.

O `.env` **não** é tocado por esta seção. Mudou um segredo? Edite `/opt/app/.env`, confirme
`chmod 600` e recrie a API:
`docker compose --profile prod up -d --force-recreate api`.

### 2.3 Smoke e diagnóstico

```bash
curl -fsS "http://$IP/readyz"; echo
ssh -i ~/.ssh/projeto2 "ubuntu@$IP" 'cd /opt/app && docker compose --profile prod logs --tail=50 api'
```

Esperado: `200` e log sem `Invalid environment configuration`. Se a imagem subiu mas a API morre no
boot, o log traz o campo que falta (`DATABASE_URL`, `IP_HASH_SALT`, `ADMIN_TOKEN`, `LLM_API_KEY`).

As imagens também são publicadas no ECR com tag = SHA do commit (`terraform output -json
ecr_repository_urls`, rodando de dentro de `infra/`), mas o `compose.yaml` de hoje constrói a imagem
no host em vez de declarar `image:` — então `docker compose pull` não traz nada do ECR. O deploy por
`pull` é o caminho da F4, quando o workflow publica a imagem e o compose aponta para o repositório.

## 3. Destruir

Remove tudo o que o Terraform criou e **pára de gastar crédito**. O bucket de state da §1.1 sobrevive
— ele não pertence a este state.

Antes de destruir, salve o que o `destroy` leva junto: o volume EBS de dados (o banco) é apagado.

```bash
IP="$(cd infra && terraform output -raw host_public_ip)"
ssh -i ~/.ssh/projeto2 "ubuntu@$IP" 'cd /opt/app && docker compose --profile prod exec -T postgres pg_dump -U skills skills' > backup-$(date +%Y%m%d).sql
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
por tag — o valor é o `project_name` do `terraform.tfvars`:

```bash
aws ec2 describe-instances --filters "Name=tag:project,Values=skill-finder" \
  --query 'Reservations[].Instances[].[InstanceId,State.Name]' --output table
aws ec2 describe-volumes --filters "Name=tag:project,Values=skill-finder" \
  --query 'Volumes[].[VolumeId,State,Size]' --output table
```

Esperado: **duas tabelas vazias**. Qualquer linha é órfão e continua consumindo crédito. Confira o
id na tabela e remova com o comando abaixo — sem id, ele falha em vez de apagar outra coisa; repita a
varredura e o comando até as duas tabelas voltarem vazias (`delete-volume` apaga um volume por vez):

```bash
aws ec2 terminate-instances --instance-ids \
  "$(aws ec2 describe-instances --filters "Name=tag:project,Values=skill-finder" \
     --query 'Reservations[].Instances[].InstanceId' --output text)"
aws ec2 delete-volume --volume-id \
  "$(aws ec2 describe-volumes --filters "Name=tag:project,Values=skill-finder" \
     --query 'Volumes[0].VolumeId' --output text)"
```

### 3.3 Confirmar state vazio e bucket preservado

```bash
(cd infra && terraform state list)
aws s3 ls "s3://$TF_STATE_BUCKET/projeto2/"
```

Esperado: `state list` sem nenhuma linha e o `s3 ls` ainda listando `terraform.tfstate`. Bucket
apagado por engano é state perdido — o `bootstrap-state.sh` recria o bucket, não o histórico; o
versionamento do S3 é o que permite voltar a uma versão anterior do arquivo.

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
ssh -i ~/.ssh/projeto2 "ubuntu@$IP" 'cd /opt/app && docker compose --profile prod up -d'
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
