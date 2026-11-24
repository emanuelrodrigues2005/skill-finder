# Runbook de operação

Procedimentos de execução, implantação e remoção do Skill Finder na AWS Academy — o que o
`docs/00-edital-projeto-2.md` §3.7 cobra como "procedimentos de execução, implantação e remoção" e o
desenho de `docs/01-analise-requisitos-e-arquitetura.md` §4.2 assume.

Desde a F7 a arquitetura não é mais uma EC2: são **três VMs**, uma por papel (`web`, `api`, `db`,
ADR-011), atrás de um **ALB** (ADR-010). A URL pública é o `alb_dns_name` — o DNS do balanceador,
nunca o IP de uma instância — e o roteamento por caminho é do listener (ADR-014). Três consequências
para este documento: todo `curl` usa o DNS (§1.4), o deploy virou quatro `ssm_run` em série (§2.3) e
a varredura de órfãos passou a incluir `elbv2` (§3.3).

Nenhum passo daqui usa SSH. A porta 22 não existe em security group nenhum enquanto
`allowed_ssh_cidrs = []` (`infra/network.tf`), e os dois canais são o **SSM RunCommand** (§2.3) e a
**API da AWS** — o backup que precede o `destroy` é um snapshot do EBS (§3.1), não um dump por
shell.

Vale para toda a página: WSL com AWS CLI v2, Terraform ≥ 1.10 (`terraform version`), `gh` autenticado
(`gh auth status`), `infra/terraform.tfvars` preenchido e credenciais de sessão exportadas:

```bash
source ~/.local/bin/academy-env
aws sts get-caller-identity --query '[Account,Arn]' --output text
```

As credenciais do Learner Lab duram ~4 h e o `apply` não tem retomada automática: renove no começo
de cada sessão e siga o protocolo de `docs/02-aws-academy-limites-e-riscos.md` §2.6 se expirarem no
meio de um comando.

Com o ALB na frente, a stack ligada custa **0,1147 US$/h** e o crédito de $50 compra **18,2 dias**.
A janela é `apply` antes da demo e `destroy` no fim, com snapshot do banco antes — a tabela aberta e a
regra estão na §5 (ADR-017).

## 1. Subir

Do zero até a aplicação respondendo pela borda. São duas metades: a infraestrutura (§1.1–§1.4) e o
deploy que coloca a aplicação dentro dela (§1.5); a §1.6 fecha com a verificação pela borda. Para
uma versão nova de código com a stack no ar, vá direto à §2.

O ciclo inteiro num dispatch só também existe — `gh workflow run deploy.yml --ref main -f
provision=true` (§2.2) —, mas lá não há plano na tela: é o `terraform plan` da §1.3 que mostra o que
vai ser criado antes de o crédito começar a correr.

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
qual namespace os três hosts puxam as imagens e é o mesmo valor da variable `DOCKERHUB_USERNAME` que
o `deploy.yml` usa para publicar; os dois lados têm de concordar, senão o `pull` na VM procura uma
imagem que ninguém publicou.

`allowed_ssh_cidrs` vazio — o default — mantém a **porta 22 fechada**: sem CIDR na lista, a regra
nem existe (`infra/network.tf`, e ela vive no `sg-api`, a única camada com IP público). É decisão de
desenho, não esquecimento: o deploy passa por SSM e não precisa de shell. Abrir a porta agora só
serve a diagnóstico: é trocar a lista por `<rede>/32` e rodar `terraform apply`.

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
configuration is valid.`, e um plano com três `aws_instance` (uma por papel), os quatro security
groups (`sg-alb`, `sg-web`, `sg-api`, `sg-db`) com suas regras separadas, o ALB com os três target
groups (`tg-web`, `tg-api`, `tg-obs`), o listener da 80 com as quatro regras de caminho e os dois
volumes de dados — e **nenhum** `aws_iam_*`. No fim, `Apply complete! Resources: N added, 0 changed,
0 destroyed.` Os onze outputs saem aqui e são lidos na §1.4 e na §2: `instance_ids`,
`web_private_ip`, `api_private_ip`, `db_private_ip`, `host_public_ip`, `dockerhub_user`,
`image_repository`, `state_bucket`, `target_port`, `alb_dns_name` e `alb_arn`.

O `apply` ficou ~2 min mais longo por causa do ALB (121 s medidos em
`docs/evidencias/f7-alb-probe.txt`) e o `destroy` ~2,5 min (153 s medidos). Não use
`-auto-approve`: o plano é o que mostra o custo antes de o relógio da §5 começar, e a sessão pode
expirar no meio (`docs/02` §2.6).

Mudou o `user_data`? Ele só roda em instância nova: o provider atualiza o atributo, mas o cloud-init
não reexecuta num host que já bootou. Force a troca de um papel — trocá-la também registra o alvo novo
no target group — e a sessão de bootstrap acontece de novo:

```bash
terraform apply -replace='aws_instance.role["web"]'
```

O volume de dados é reanexado ao host novo (o `/var/lib/docker` vem junto: as imagens já baixadas não
são perdidas). A `web` não tem volume; substituí-la perde só o nginx, que o deploy da §1.5 reescreve.

### 1.4 URL pública: o DNS do ALB

```bash
EDGE="$(terraform -chdir=infra output -raw alb_dns_name)"
echo "$EDGE"
```

Esperado: `skill-finder-alb-<sufixo>.us-east-1.elb.amazonaws.com`. Este nome **não muda** com
`stop`/`start` nem com um `apply` de rotina — é o que faz dele a URL da demo e o `BASE_URL` do `smoke`
(ADR-010). Todo `curl` deste documento usa `$EDGE`.

Os IPs públicos das instâncias continuam existindo, mas mudam a cada `stop`/`start` e não são
endereço de nada: `host_public_ip` é o da `api` e serve a diagnóstico. Depois de um `apply`
recém-criado, o DNS responde antes de o alvo ficar saudável: até o primeiro health check passar
(`/healthz` no `tg-api`, intervalo de 30 s, 2 sucessos), a borda devolve `503` do próprio
balanceador, sem chegar a instância nenhuma.

### 1.5 Deploy da aplicação

Depois do `apply` as três VMs estão de pé e **vazias**: o `user_data` instala o Docker, monta o
volume de dados em `/var/lib/docker` (na `api` e na `db`) e cria `/opt/app`, mas não sobe container
nenhum. Quem coloca a aplicação lá é o pipeline — o mesmo caminho de qualquer deploy, sem
procedimento paralelo:

```bash
gh workflow run deploy.yml --ref main
```

Se a infraestrutura acabou de ser criada pelo próprio workflow, `-f provision=true` faz as duas
coisas num dispatch só. O `gate` exige os secrets da sessão AWS, o `DOCKERHUB_TOKEN`, os dois do
Infisical e a variable `DOCKERHUB_USERNAME`; a lista completa e como gravá-los está em
[`docs/app/06-pipeline-deploy.md`](app/06-pipeline-deploy.md) §3, e
`bash scripts/dev/set-deploy-secrets.sh` publica as três credenciais da sessão de uma vez.

A primeira ingestão não é um passo à parte: o deploy chama a rota admin de dentro da VM `api`, com o
`ADMIN_TOKEN` do Infisical, e o log do job mostra `ingestao: 202` (ou `409`, se outra ingestão
estiver em curso).

### 1.6 Verificação pela borda

O `smoke` do workflow roda estas checagens pelo DNS do ALB e reprova o run em qualquer desvio; rodar
à mão serve para conferir uma borda que ficou de pé fora do último deploy.

```bash
EDGE="$(terraform -chdir=infra output -raw alb_dns_name)"
curl -fsS "http://$EDGE/healthz"; echo
curl -fsS "http://$EDGE/readyz"; echo
curl -sS -o /dev/null -w '%{http_code} %{content_type}\n' "http://$EDGE/"
curl -sS -o /dev/null -w '%{http_code}\n' "http://$EDGE/grafana/"
curl -sS -o /dev/null -w '%{http_code}\n' "http://$EDGE/metrics"
```

| checagem | esperado | o que um desvio significa |
| --- | --- | --- |
| `GET /healthz` | `200`, JSON com `status: ok` | API fora do ar, ou a regra `/healthz` do listener apontando para o `tg-web`; segredo ausente no Infisical é a causa mais comum |
| `GET /readyz` | `200`, JSON com `status: ok` | API viva e Postgres fora — o envelope `NOT_READY` diz qual dos dois |
| `GET /` | `200`, `text/html` com `<!doctype html>` | a SPA não subiu, o `tg-web` está sem alvo saudável, ou a `web` está servindo outro conteúdo |
| `GET /grafana/` | `302` (login) ou `401` | `200` é o Grafana aberto na internet; `404`, Grafana sem sub-path ou regra `/grafana/*` ausente; `502`, stack obs fora |
| `GET /metrics` | `404` | a borda parou de fechar a rota e os contadores de latência por rota estão públicos |

Um `502` na raiz é quase sempre segredo inválido no Infisical — o motivo exato aparece no log do job
`deploy` (§2.3). `bash scripts/dev/smoke-edge.sh "$EDGE"` roda `/healthz`, `/readyz`, `/` e a recusa
`401` da rota admin sem token, com código de saída 1 quando alguma falha; o argumento é o DNS do ALB,
não um IP. `/grafana/` e `/metrics` ficam de fora dele.

## 2. Implantar

Uma versão nova de código com a infraestrutura de pé. O caminho normal é **automático**: o
`deploy.yml` nasce de um `workflow_run` do `ci.yml` concluído com `success` num `push` para `main`.
O manual é o mesmo workflow, por `workflow_dispatch`. Nada de `terraform apply` aqui — infraestrutura
só muda na §1 — e nada de construir imagem no host.

O canal entre o runner e as VMs é o **SSM RunCommand**, não SSH: a porta 22 não existe em security
group nenhum por decisão de desenho (§1.2), então o runner não guarda chave privada e nenhuma VM
expõe shell na internet. O desenho completo — jobs, secrets, limitações do lab — está em
[`docs/app/06-pipeline-deploy.md`](app/06-pipeline-deploy.md).

### 2.1 Caminho normal: merge em `main`

`ci.yml` verde → `deploy.yml` (`workflow_run`, `completed: success`, `push` em `main`) → cinco jobs:

| job | o que faz |
| --- | --- |
| `gate` | valida a sessão AWS (`sts get-caller-identity`), resolve o SHA, exige `DOCKERHUB_USERNAME` e os secrets do Infisical, e confere que há host `running` por papel (checagem pulada com `provision=true`) |
| `build` | `docker build --target runtime` de `api` e `web`, `push` no Docker Hub com tag = SHA e `docker manifest inspect` da tag |
| `provision` | `terraform init/validate/plan/apply` — só com `provision=true` |
| `deploy` | resolve **um id por papel** (`tag:role`) e o DNS do ALB, espera o agente SSM nos três, envia o payload dos composes a cada VM e roda **quatro `ssm_run` em série**: `db` (Postgres + healthcheck), `api` (`prisma:deploy`, `up`, ingestão), `web` (nginx) e `obs` (a stack de volta na `api`) |
| `smoke` | as checagens da §1.6 pelo DNS do ALB; qualquer desvio reprova o run |

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
bash scripts/dev/deploy-preflight.sh        # AWS, hosts, SSM e secrets, antes de gastar um run
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

### 2.3 O que acontece nas VMs, e onde ler o resultado

O job `deploy` faz, nesta ordem:

1. resolve **um id por papel** (`Name=tag:role`, valores `web`, `api` e `db`; faltando qualquer um,
   o job reprova em vez de implantar dois terços) e espera o `PingStatus` do agente SSM ficar
   `Online` nos três — é o `LabInstanceProfile` que autoriza o agente;
2. manda `compose.yaml`, `infra/deploy/compose.prod.yaml`, `frontend/nginx.conf` e `observability/`
   para `/opt/app` de **cada** VM, num comando SSM próprio por host: são arquivos do commit, sem
   segredo nenhum;
3. roda os quatro `ssm_run` **em série**, na ordem `db → api → web` e depois `obs`:

   | # | papel | o que sobe |
   | --- | --- | --- |
   | 1 | `db` | Postgres com `--profile db`, esperando o healthcheck ficar `healthy`; é a única VM que publica a 5432 (`POSTGRES_BIND=0.0.0.0`), e o `sg-db` só aceita a `api` |
   | 2 | `api` | monta a `DATABASE_URL` com o IP privado do banco + `POSTGRES_PASSWORD`, roda `npm run --silent prisma:deploy`, sobe a API (`--profile api`) e ingere o catálogo em `127.0.0.1:8000` |
   | 3 | `web` | o nginx da borda (`--profile web`) — o único host sem Infisical, porque a imagem dele não tem segredo |
   | 4 | `obs` | Grafana, Prometheus, Loki, Promtail e node-exporter (`--profile obs`), de volta na VM `api` |

**A ordem é o contrato, não preferência (ADR-016).** Em série porque o `SendCommand` não garante
ordem entre invocações, e um comando único com os três ids perderia a ordem de vez. `db` antes de
`api` porque a migração precisa de um Postgres que já aceite conexão; `api` antes de `web` porque a
borda no ar antes do schema migrado devolve 500 em toda busca com filtro; `obs` por último porque é o
único passo cuja falha é degradação — com a borda no ar, um Grafana fora deixa app e site
funcionando e o job vermelho, em vez de derrubar a demonstração.

Os segredos da aplicação (`DATABASE_URL`, `POSTGRES_PASSWORD`, `IP_HASH_SALT`, `ADMIN_TOKEN`,
`LLM_API_KEY`, `GRAFANA_PASSWORD`) existem só no projeto do Infisical, env `prod`: não passam pelo
runner, não ficam em arquivo no host e não aparecem em log. Não há arquivo de ambiente na produção —
o compose roda com `--env-file /dev/null` e o ambiente injetado é a única fonte; sobra de execução
antiga é ignorada, com aviso no log.

Onde olhar:

```bash
gh run view <run-id> --log | grep -E 'SSM (payload|deploy)-(db|api|web|obs)|compose|ingestao|obs-'
gh run view <run-id>            # o Summary: commit, DNS do ALB, os três ids, imagens e o veredicto da observabilidade
```

E, para inspecionar um host sem SSH, o mesmo canal do deploy — troque `api` pelo papel que interessa:

```bash
ID="$(aws ec2 describe-instances --filters "Name=tag:role,Values=api" \
  "Name=instance-state-name,Values=running" \
  --query 'Reservations[0].Instances[0].InstanceId' --output text)"
CMD="$(aws ssm send-command --document-name AWS-RunShellScript --instance-ids "$ID" \
  --comment "estado do compose" --timeout-seconds 120 \
  --parameters 'commands=["cd /opt/app && docker compose -f compose.yaml -f infra/deploy/compose.prod.yaml --profile api --profile obs ps"]' \
  --query 'Command.CommandId' --output text)"
aws ssm wait command-executed --command-id "$CMD" --instance-id "$ID"
aws ssm get-command-invocation --command-id "$CMD" --instance-id "$ID" \
  --query '[Status,StandardOutputContent]' --output text
```

A saída do SSM volta truncada em 24 mil caracteres: serve para `ps` e para `logs --tail=50`, não para
arquivo grande — o backup do banco é o snapshot da §3.1, por outro canal.

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

Remove tudo o que o Terraform criou e **pára de gastar crédito** (§5). O bucket de state da §1.1
sobrevive — ele não pertence a este state. Com o ALB no state, o `destroy` leva ~2,5 min a mais
(153 s medidos): o balanceador sai devagar e o Terraform espera.

Duas coisas antes, nesta ordem: o banco é **SPOF em EC2 e não há RDS** (ADR-012), então o snapshot do
EBS da §3.1 é o único backup que existe — e é ele que sobrevive ao `destroy`. Os volumes, não.

### 3.1 Snapshot do EBS do banco — antes do `destroy`

O volume que importa é o da VM `db` (`/var/lib/docker`, com o volume nomeado do Postgres). O da
`api` guarda cache de imagem e se reconstrói com um `pull`.

```bash
VOL="$(aws ec2 describe-volumes \
  --filters "Name=tag:project,Values=skill-finder" "Name=tag:Name,Values=skill-finder-db-data" \
  --query 'Volumes[0].VolumeId' --output text)"
SNAP="$(aws ec2 create-snapshot --volume-id "$VOL" \
  --description "skill-finder db $(date +%Y%m%d-%H%M)" \
  --tag-specifications 'ResourceType=snapshot,Tags=[{Key=project,Value=skill-finder},{Key=role,Value=db}]' \
  --query 'SnapshotId' --output text)"
echo "$SNAP"
aws ec2 wait snapshot-completed --snapshot-ids "$SNAP"
```

Esperado: um `snap-…` e, no fim do `wait`, o prompt de volta. O snapshot é tirado com o Postgres no
ar — é backup de bloco, consistente o bastante para uma janela de demo, porque o catálogo é
reconstruível pela ingestão e o que importa é o histórico de busca (ADR-012). **Não houve restore
cronometrado**: a janela de perda é a do último snapshot manual.

O snapshot **não pertence ao state** e sobrevive ao `destroy`; ele continua cobrando armazenamento
até ser apagado (fora da tabela da §5, que conta disco, não snapshot):

```bash
aws ec2 describe-snapshots --owner-ids self \
  --filters "Name=tag:project,Values=skill-finder" \
  --query 'Snapshots[].[SnapshotId,StartTime,VolumeSize]' --output table
aws ec2 delete-snapshot --snapshot-id <snap-id>
```

Restaurar é `aws ec2 create-volume --snapshot-id <snap-id> --availability-zone <az-da-vm-db>` (a AZ
sai de `aws ec2 describe-volumes --volume-ids "$VOL" --query 'Volumes[0].AvailabilityZone'`) e
reanexar à VM `db` criada pelo `apply` seguinte.

### 3.2 destroy

```bash
cd infra
terraform plan -destroy
terraform destroy
cd ..
```

Esperado: o plano lista os recursos a destruir e `Destroy complete! Resources: N destroyed.` sem
erro. Sem `-auto-approve`: a lista é a última chance de ver que as três instâncias certas vão sair.
Se o `destroy` morrer com `ResourceInUse` ou "resource in use", é o ALB ainda saindo: espere
`aws elbv2 describe-load-balancers` voltar vazio e repita o comando.

### 3.3 Varredura de órfãos

`destroy` pode deixar recurso para trás (apply interrompido, criação fora do state) — e o ALB, o
listener, as regras e os target groups são os candidatos novos: eles se referenciam entre si, e, se
sobrar um deles, o `elbv2` recusa apagar os demais com `ResourceInUse`. A varredura é por tag — o
valor é o `project_name` do `terraform.tfvars`, em minúsculo (`project`, nunca `Project`): todo
recurso do state carrega essa tag.

```bash
aws ec2 describe-instances --filters "Name=tag:project,Values=skill-finder" \
  --query 'Reservations[].Instances[].[InstanceId,State.Name]' --output table
aws ec2 describe-volumes --filters "Name=tag:project,Values=skill-finder" \
  --query 'Volumes[].[VolumeId,State,Size]' --output table
aws ec2 describe-security-groups --filters "Name=tag:project,Values=skill-finder" \
  --query 'SecurityGroups[].[GroupId,GroupName]' --output table
aws elbv2 describe-load-balancers --query 'LoadBalancers[].[LoadBalancerName,State.Code]' --output table
aws elbv2 describe-target-groups --query 'TargetGroups[].[TargetGroupName,TargetType]' --output table
```

Esperado: **cinco tabelas vazias**. As duas de `elbv2` não filtram por tag (a API não aceita o filtro
em `describe-load-balancers`), então valem só porque a conta do lab não tem outro balanceador.
Qualquer linha é órfão e continua consumindo crédito. Confira o id na tabela e remova com os comandos
abaixo — sem id, eles falham em vez de apagar outra coisa; repita a varredura e a remoção até as
tabelas voltarem vazias (`delete-volume` apaga um volume por vez):

```bash
aws ec2 terminate-instances --instance-ids \
  "$(aws ec2 describe-instances --filters "Name=tag:project,Values=skill-finder" \
     --query 'Reservations[].Instances[].InstanceId' --output text)"
aws elbv2 delete-load-balancer --load-balancer-arn \
  "$(aws elbv2 describe-load-balancers --names "skill-finder-alb" \
     --query 'LoadBalancers[0].LoadBalancerArn' --output text)"
for tg in web api obs; do
  aws elbv2 delete-target-group --target-group-arn \
    "$(aws elbv2 describe-target-groups --names "skill-finder-tg-$tg" \
       --query 'TargetGroups[0].TargetGroupArn' --output text)"
done
aws ec2 delete-volume --volume-id \
  "$(aws ec2 describe-volumes --filters "Name=tag:project,Values=skill-finder" \
     --query 'Volumes[0].VolumeId' --output text)"
aws ec2 delete-security-group --group-id \
  "$(aws ec2 describe-security-groups --filters "Name=tag:project,Values=skill-finder" \
     --query 'SecurityGroups[0].GroupId' --output text)"
```

Um security group só é removível depois que a última instância que o usa sumiu — e, aqui, também
depois que o SG que o referencia sai: comece pelo `sg-alb`, cujas regras de saída apontam para
`sg-web` e `sg-api`. Se um `delete-security-group` falhar com `DependencyViolation`, aguarde e repita
na ordem inversa.

### 3.4 Confirmar state vazio e bucket preservado

```bash
(cd infra && terraform state list)
aws s3 ls --recursive "s3://$TF_STATE_BUCKET"
```

Esperado: `state list` sem nenhuma linha e o `s3 ls` ainda listando o `terraform.tfstate` sob o
prefixo que `infra/backend.tf` declara em `key`. Bucket apagado por engano é state perdido — o
`bootstrap-state.sh` recria o bucket, não o histórico; o versionamento do S3 é o que permite voltar a
uma versão anterior do arquivo.

## 4. Encerrar sessão

Duas coisas diferentes: **parar as instâncias** (economiza o compute, preserva os dados) e **encerrar
o lab** (as credenciais morrem; os recursos ficam — `docs/02` §6.1–6.2).

### 4.1 Parar as instâncias

```bash
IDS="$(aws ec2 describe-instances --filters "Name=tag:project,Values=skill-finder" \
  "Name=instance-state-name,Values=running" \
  --query 'Reservations[].Instances[].InstanceId' --output text)"
aws ec2 stop-instances --instance-ids $IDS
aws ec2 wait instance-stopped --instance-ids $IDS
```

Esperado: `StoppingInstances` com os três ids e, no fim do `wait`, o prompt de volta sem saída. O
`$IDS` vai **sem aspas** de propósito: são três ids separados por espaço. Os volumes EBS continuam
lá; o que pára é a aplicação — o `start` da §4.2 devolve tudo.

Parar **não** zera o relógio da §5: pela tabela da ADR-017, o compute (`0,0520/h`) e o IPv4 das VMs
saem da conta, mas o ALB (`0,0305/h`, que cobra hora ociosa) e o EBS (`0,0070/h`) continuam. Quem pára
de gastar de verdade é o `destroy` da §3.

### 4.2 Religar e recuperar a URL

O IP público de cada instância muda no `stop`/`start`, mas a URL da demo **não**: o `alb_dns_name` é
do balanceador.

```bash
aws ec2 start-instances --instance-ids $IDS
aws ec2 wait instance-running --instance-ids $IDS
EDGE="$(cd infra && terraform refresh >/dev/null && terraform output -raw alb_dns_name)"
echo "$EDGE"
curl -fsS "http://$EDGE/healthz"; echo
```

Esperado: o mesmo DNS de sempre e `200` em `/healthz`. Os containers têm `restart: unless-stopped` e
o Docker sobe no boot; o target group leva até ~1 min para marcar os alvos como saudáveis. Se o
`/healthz` continuar fora do ar depois de ~2 min, não há shell no host para mexer em container um a
um: o conserto é reimplantar pelo mesmo canal, que refaz `pull`, `up -d --no-build` e a migração e só
fecha verde se a borda responder (§2.2):

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
- **End Lab**: o EC2, o EBS, o ALB e o S3 continuam existindo; o que não sobrevive são as
  credenciais e a sessão do console. Vai usar amanhã? Pare as instâncias (§4.1) sabendo que só o
  compute deixa de cobrar. Não vai usar mais nesta janela? `destroy` (§3), com o snapshot da §3.1
  **antes** — instância parada ainda cobra o volume EBS e o ALB.

### 4.4 Fechar o dia

```bash
(cd infra && terraform plan -detailed-exitcode >/dev/null); echo "plan exit: $?"
```

Esperado: `plan exit: 0` (sem mudanças). `2` significa deriva entre o código e a AWS — investigue
antes de sair; `1` é erro de leitura, normalmente credencial vencida. Registre o que mudou em
`docs/evidencias/` se a sessão produziu evidência para o relatório. Sessão encerrada com a stack de
pé? Confira a conta da §5 antes de fechar o terminal.

## 5. Custo por hora e a janela

Números de **tabela de preço da `us-east-1`**, e **referência, não fatura**: o lab não expõe custo e
nenhuma linha abaixo foi lida de uma conta do Academy (ADR-017). Servem para decidir quantas horas a
stack pode ficar no ar — não para conferir cobrança.

| Recurso | Conta | US$/h |
| --- | --- | --- |
| Compute — `t3.micro` + 2 × `t3.small` | 0,0104 + 0,0208 + 0,0208 | **0,0520** |
| ALB + LCU | 0,0225 + 0,0080 | **0,0305** |
| IPv4 — 3 VMs + 2 nós do ALB | 5 × 0,0050 | **0,0250** |
| EBS — 64 GiB gp3 | 64 × 0,0001096 | **0,0070** |
| **Total** | | **0,1147** |

O crédito do semestre é de **$50**:

| cenário | horas | custo |
| --- | --- | --- |
| crédito inteiro com a stack no ar | `$50 ÷ 0,1147 = 436 h` | **18,2 dias** |
| demo | 4 h | **$0,46** |
| uma semana esquecida | 168 h | **$19,30** (39% do crédito) |

A leitura é direta: **18,2 dias** é menos que o semestre, então "deixar ligado" não é uma opção — e
uma semana esquecida come **39%** do crédito. O ALB, que a Opção 1 de uma EC2 não tinha, responde por
**0,0305/h** (≈27% do total) e cobra **hora ociosa**.

**A regra é a da ADR-017: `apply` antes da demo, `destroy` no fim.** A sequência de uma janela:

1. `apply` e deploy (§1) — o relógio começa a correr no primeiro recurso criado;
2. snapshot do EBS do banco (§3.1) **antes** de qualquer remoção — é o único backup que existe;
3. demo e evidências;
4. `destroy` (§3.2) e varredura (§3.3) — inclusive `elbv2`, que é o órfão que mais cobra;
5. `state list` vazio e bucket intacto (§3.4).

Parar as instâncias (§4.1) no meio da janela economiza só o compute: o relógio do ALB e do EBS
continua. O plano B registrado na ADR-017 — `var.enable_alb=false`, com a URL de volta ao IP público
e Elastic IP — cortaria os 0,0305/h do ALB, mas **não está implementado em `infra/`** e não é usado
enquanto o balanceador estiver de pé.

## Apêndice A — Legado: procedimento manual (não usado)

As versões anteriores deste runbook ensinavam a subir a aplicação à mão: copiar os arquivos de
composição para o host, escrever um arquivo de ambiente à mão, preencher o registry do ECR e rodar
cada comando por um shell remoto com a chave do lab. **Não é mais o procedimento**, por três motivos
independentes: a imagem vem do Docker Hub público (o pull é anônimo, sem credencial de registry na
VM), o arquivo de ambiente foi eliminado (o Infisical injeta no processo) e a porta 22 não existe no
security group. O caminho válido é a §1.5 e a §2 — um dispatch, o mesmo do dia a dia.

Do outro mundo sobrou uma conferência, ainda útil depois de um `apply` em que alguém preencheu
`allowed_ssh_cidrs`:

```bash
aws ec2 describe-security-groups --filters "Name=tag:project,Values=skill-finder" \
  --query 'SecurityGroups[].[GroupName,IPPermissions[].FromPort]' --output text
```

Esperado com o default: só `80` no `sg-alb`, `8000` e `3000` no `sg-api`, `5432` no `sg-db` e
`sg-web` só com `80` vindo do balanceador — **nenhum `22`**. Qualquer `22` na saída é a porta aberta
pela §1.2; confira `allowed_ssh_cidrs` antes de seguir.

Para inspecionar host sem abrir nada, use o SSM da §2.3; e o backup antes do `destroy` é o snapshot
da §3.1, que não depende de porta nenhuma.
