# AWS Academy — Limites, Riscos e Modelo de Credenciais

> **Escopo deste documento.** O que o ambiente AWS Academy permite e proíbe para o
> Projeto 2 de Computação em Nuvem (UFRPE), e como as credenciais funcionam no ciclo de
> vida de uma sessão de laboratório. Requisitos do projeto: `docs/00-edital-projeto-2.md`.
>
> **Não é** arquitetura, não é código Terraform, não é guia de instalação de CLI.
>
> **Como ler as marcas de confiança.** Todo número e todo estado de disponibilidade leva
> uma marca:
>
> | Marca | Significado |
> | --- | --- |
> | `[confiança: alta]` | Comportamento estável e amplamente documentado; pode ser tratado como fato. |
> | `[confiança: média — confirmar]` | Amplamente verdadeiro, mas **varia por instituição** ou por versão do Learner Lab. |
> | `[confiança: baixa — verificar no laboratório]` | Depende da configuração da conta; **não planeje em cima disso** sem o checklist da seção 11. |
>
> **Cenário confirmado pelo grupo:** AWS Academy Learner Lab entregue via Vocareum
> (Cenário A). O Cenário B aparece apenas como comparação curta na seção 2.3.

---

## 1. Como descobrir qual cenário é o meu (árvore de decisão)

Execute os quatro sinais na ordem. O primeiro que fechar decide.

```
[1] Você entra em vocareum.com (ou pelo link do professor) e vê um painel
    com botão "Start Lab" e, após iniciar, um bloco "AWS Details"?
    ├── SIM ──────────────────────────────────────────────► CENÁRIO A
    └── NÃO
         │
[2] `aws sts get-caller-identity` retorna um ARN contendo
    ":assumed-role/voclabs/" ou semelhante?
    └── SIM ──────────────────────────────────────────────► CENÁRIO A
         │
[3] O mesmo comando retorna ":user/<seu-nome>" (usuário IAM próprio)?
    └── SIM ──────────────────────────────────────────────► CENÁRIO B
         │
[4] `aws iam list-attached-user-policies --user-name <seu-usuário>`
    lista AdministratorAccess?
    └── SIM ──────────────────────────────────────────────► CENÁRIO B com admin
         │
         └── nenhum dos acima ───────────────────────────► PARAR e pedir
                                                           instruções ao professor
```

| Sinal | Cenário A (Learner Lab) | Cenário B (usuário IAM próprio) |
| --- | --- | --- |
| Origem do acesso | Vocareum, botão "Start Lab" | console AWS direto / credenciais do professor |
| Credenciais | temporárias, com token, expiram | access key de longa duração (ou role) |
| `AWS_SESSION_TOKEN` | **obrigatória** | normalmente ausente |
| ARN em `get-caller-identity` | `assumed-role/voclabs/...` | `user/...` |
| IAM | sem criar role/policy/user | pode criar role, user, OIDC provider |
| Região | restrita (tipicamente `us-east-1`) | livre |
| Persistência | mesma conta por todo o semestre, mas sessão curta | controlada por você |

**Confirmação do grupo:** é o **Cenário A**. Leia-o como caminho principal; o
Cenário B só interessa se outro integrante tiver um acesso diferente.

---

## 2. Modelo de credenciais

### 2.1 Os três valores

| Variável | O que é | Onde aparece |
| --- | --- | --- |
| `AWS_ACCESS_KEY_ID` | id da credencial (`ASIA…` para credencial temporária) | painel **AWS Details → AWS CLI** |
| `AWS_SECRET_ACCESS_KEY` | segredo associado à chave | idem |
| `AWS_SESSION_TOKEN` | token que amarra a credencial a uma **sessão STS** | idem |

`[confiança: alta]` Credenciais temporárias do AWS Academy **sempre** começam o access
key id com `ASIA` (as de longa duração começam com `AKIA`). O prefixo é um teste rápido
de sanidade: viu `ASIA`, tem que existir token.

### 2.2 Passo a passo (Cenário A)

1. Abra o Vocareum do curso e clique em **Start Lab** no card **AWS**. O círculo ao
   lado de "AWS" fica **verde** quando o laboratório está pronto. `[confiança: alta]`
2. Clique em **AWS Details** → bloco **AWS CLI: Show**. Aparecem as três linhas
   `[default]` com `aws_access_key_id`, `aws_secret_access_key` e `aws_session_token`.
   `[confiança: alta]`
3. Copie os três valores. **Nunca** cole em arquivo versionado, issue, print de tela ou
   mensagem de commit.
4. Grave num arquivo local fora do repositório:

   ```bash
   # WSL/Ubuntu
   mkdir -p ~/.aws && chmod 700 ~/.aws
   nano ~/.aws/credentials   # cole o bloco [default] copiado do painel
   chmod 600 ~/.aws/credentials
   ```

   ```text
   [default]
   aws_access_key_id     = <AWS_ACCESS_KEY_ID>
   aws_secret_access_key = <AWS_SECRET_ACCESS_KEY>
   aws_session_token     = <AWS_SESSION_TOKEN>
   ```

5. **Exporte como variáveis de ambiente** (é a forma que o Terraform e o CLI usam com
   menor atrito):

   ```bash
   # WSL/Ubuntu — repita a cada nova sessão de laboratório
   export AWS_ACCESS_KEY_ID='<AWS_ACCESS_KEY_ID>'
   export AWS_SECRET_ACCESS_KEY='<AWS_SECRET_ACCESS_KEY>'
   export AWS_SESSION_TOKEN='<AWS_SESSION_TOKEN>'
   export AWS_DEFAULT_REGION=us-east-1
   aws sts get-caller-identity   # deve retornar um ARN assumed-role/voclabs/...
   ```

   ```powershell
   # PowerShell (mesma sessão de shell)
   $env:AWS_ACCESS_KEY_ID     = '<AWS_ACCESS_KEY_ID>'
   $env:AWS_SECRET_ACCESS_KEY = '<AWS_SECRET_ACCESS_KEY>'
   $env:AWS_SESSION_TOKEN     = '<AWS_SESSION_TOKEN>'
   $env:AWS_DEFAULT_REGION    = 'us-east-1'
   aws sts get-caller-identity
   ```

6. Regra de ouro: **as credenciais valem para o terminal em que foram exportadas.** Uma
   janela nova não herda os `export` anteriores. `[confiança: alta]`

### 2.3 Cenário B, em resumo (só comparação)

Se outro integrante tiver usuário IAM próprio com poder administrativo: `aws configure`
basta (sem token), é possível criar `aws_iam_role`, `aws_iam_instance_profile` e um
**OIDC provider** para o GitHub Actions, e a região é livre. Isso desbloquearia o fluxo
de CI/CD com OIDC (seção 8.1). **Não presuma**: o restante deste documento é escrito
para o Cenário A, que é o confirmado.

### 2.4 Ciclo de vida da sessão

| Etapa | O que acontece | Confiança |
| --- | --- | --- |
| **Start Lab** | inicia o cronômetro do laboratório, sobe o console e emite credenciais | `[confiança: alta]` |
| Enquanto o lab está ativo | as credenciais podem ser **reemitidas** clicando em AWS Details de novo (não precisa reiniciar o lab) | `[confiança: alta]` |
| Expiração do token | o token dura enquanto durar a sessão; ao expirar, **todo** comando AWS falha com `ExpiredToken` | `[confiança: alta]` |
| Duração típica da sessão | **~4 horas**, tipicamente entre 1 e 4 h conforme a configuração da instituição | `[confiança: média — confirmar]` |
| **End Lab** | encerra a sessão; as credenciais param de funcionar imediatamente; o console desloga | `[confiança: alta]` |
| Recursos criados | **permanecem** na conta (a conta é a mesma entre sessões) | `[confiança: alta]` |
| Créditos | o consumo continua enquanto houver recursos ligados, mesmo com o lab encerrado | `[confiança: média — confirmar]` |
| Nova sessão | novas credenciais, mesma conta, mesmos recursos | `[confiança: alta]` |

### 2.5 Por que `AWS_SESSION_TOKEN` é obrigatório

`[confiança: alta]` Um access key + secret emitidos pelo STS (via `AssumeRole`) são uma
**credencial de sessão**: o segredo é derivado da chave de sessão, não da chave de
usuário. A AWS precisa do token para saber qual sessão você é. Sintomas:

| Erro | Quando aparece | Causa |
| --- | --- | --- |
| `InvalidClientTokenId` | você exportou só `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, ou rodou `aws configure` e digitou as chaves sem o token | falta `AWS_SESSION_TOKEN` |
| `ExpiredToken: The security token included in the request is expired` | token vencido (fim da sessão, ou sessão reiniciada) | reemitir em AWS Details e reexportar |
| `The security token included in the request is invalid` | token de outra sessão/outro lab | copie os **três** valores juntos, na mesma leitura do painel |

Exemplo de mensagem completa (formato estável do AWS CLI v2) `[confiança: alta]`:

```text
An error occurred (ExpiredToken) when calling the GetCallerIdentity operation:
The security token included in the request is expired
```

### 2.6 A sessão expirou no meio de um `terraform apply`

`[confiança: alta]` O Terraform **não** tem retomada automática, mas é **idempotente**:
reexecutar depois de renovar as credenciais reconcilia o que já existe. Protocolo:

1. **Não** saia apagando recursos no console por pânico.
2. Reabra **AWS Details**, copie as três credenciais novas e reexporte no **mesmo
   terminal** que está rodando o Terraform.
3. `terraform plan` — leia a saída. O que foi criado antes da expiração pode aparecer
   como "to create" (criado na AWS mas fora do state) ou já constar no state.
4. Se aparecer "to create" para um recurso que **existe** na AWS, traga-o para o state
   antes de aplicar:
   ```bash
   terraform import aws_instance.app <instance-id>
   ```
   ou, se não houver import suportado, remova o registro fantasma:
   ```bash
   terraform state rm <recurso>
   ```
5. `terraform apply` de novo. Repita até o plan ficar limpo.
6. **Mitigação de base:** em desenvolvimento, nunca use `-auto-approve`; rode `plan` e
   `apply` em passos separados para ver onde parou.
7. Durante um `terraform destroy` interrompido, o mesmo protocolo se aplica: repita o
   `destroy` até tudo sumir; recursos órfãos continuam **consumindo crédito**.

### 2.7 Higiene de segredos

- `~/.aws/credentials`, `*.tfstate`, `*.tfstate.backup`, `*.pem` e `.env` **nunca** entram
  no Git. Coloque todos no `.gitignore` antes do primeiro commit.
- Não passe credenciais por `-var`, `-var-file` ou `TF_VAR_*` — elas aparecem em
  `terraform plan` e no log do CI.
- Em CI, prefira máscara/secrets nativos do provedor (seção 8), nunca `echo` da chave.
- Se uma chave vazar em log ou histórico, ela expira sozinha no fim da sessão; ainda
  assim, **considere vazada** e reemita.

---

## 3. Matriz de disponibilidade de serviços

Estados possíveis: `disponível` · `disponível com restrição` · `não disponível` ·
`desconhecido — verificar no laboratório`.
Todos os estados abaixo são para o **Cenário A** e refletem a configuração **típica** do
Learner Lab; a coluna de confiança diz o quanto confiar.

### 3.1 Computação e rede

| # | Serviço / recurso | Estado | Restrição observada | Confiança |
| --- | --- | --- | --- | --- |
| 1 | **EC2** (instâncias) | disponível com restrição | só tipos de instância permitidos pela política da conta; perfis de instância precisam usar `LabInstanceProfile`; sem criar role | alta |
| 2 | **EC2 Key Pairs** (criar/baixar `.pem`) | disponível com restrição | normalmente permitido; em algumas contas a política de IAM bloqueia `ec2:CreateKeyPair`/`ImportKeyPair`. **Testar antes de desenhar em cima** (seção 11, item K3) | média — confirmar |
| 3 | **Elastic IP** | disponível com restrição | cota de EIPs por conta costuma ser baixa (frequentemente **1–5**) | média — confirmar |
| 4 | **ALB / ELBv2** | disponível | custa por hora + LCU mesmo ocioso; sem crédito, não crie cedo | alta |
| 5 | **Security Groups** | disponível | regras liberadas; cuidado com `0.0.0.0/0` em portas sensíveis | alta |
| 6 | **Auto Scaling** (ASG, launch template) | disponível com restrição | launch template exige `iam_instance_profile` = `LabInstanceProfile`; limite de vCPUs da conta se aplica | média — confirmar |
| 7 | **Route 53** | disponível com restrição | **registro de domínio novo** não é viável (exige contato/cobrança real); **hosted zone** pública/privada normalmente funciona, mas sem domínio próprio a URL final é o DNS do ALB | média — confirmar |
| 8 | **CloudFront** | disponível com restrição | funciona, mas o benefício acadêmico é baixo e o troubleshooting de origem/HTTPS consome tempo; não é necessário para o edital | média — confirmar |
| 9 | **VPC / subnets / IGW / NAT** | disponível | NAT Gateway custa por hora — evite deixar ligado; a VPC padrão já basta para o projeto | alta |

### 3.2 Armazenamento

| # | Serviço / recurso | Estado | Restrição observada | Confiança |
| --- | --- | --- | --- | --- |
| 10 | **EBS** (volumes, anexar/desanexar) | disponível | cobrado por GB-mês provisionado, mesmo com instância parada; snapshots também custam | alta |
| 11 | **EBS Snapshots** | disponível | permitido; cobra por GB-mês armazenado | alta |
| 12 | **EFS** | disponível com restrição | monta por NFS na VPC; cobra por GB armazenado; exige security group NFS (2049) entre as instâncias e os mount targets | média — confirmar |
| 13 | **S3** (buckets, objetos) | disponível | nomes globais; versionamento/lifecycle disponíveis; **object lock/WORM** pode ser bloqueado | alta |

### 3.3 Contêineres e imagens

| # | Serviço / recurso | Estado | Restrição observada | Confiança |
| --- | --- | --- | --- | --- |
| 14 | **ECR** (repositórios e imagens) | disponível com restrição | `docker login` via `aws ecr get-login-password` (token de 12 h); scan básico ok; replicação entre regiões pode estar bloqueada | alta |
| 15 | **ECS** (Fargate e EC2) | disponível com restrição | precisa de **execution role**; use `LabRole`. Fargate é o caminho com menos atrito, mas tem custo por vCPU-hora e memória, além de cold start na demo | média — confirmar |

### 3.4 Bancos e serverless

| # | Serviço / recurso | Estado | Restrição observada | Confiança |
| --- | --- | --- | --- | --- |
| 16 | **RDS** | disponível com restrição | é o item de maior risco: só costuma funcionar se a conta oferecer **DB subnet group** e a role padrão do serviço; classes restritas (a faixa gratuita de `db.t3.micro`/`db.t2.micro` é o alvo), e engines limitadas (MySQL/PostgreSQL são as mais prováveis) | baixa — verificar no laboratório |
| 17 | **DynamoDB** | disponível | on-demand é o modo mais seguro para crédito; ideal como *lock table* do Terraform (seção 7.3) | alta |
| 18 | **Lambda** | disponível com restrição | a função precisa de uma **execution role**; use `LabRole` no `role` | alta |
| 19 | **API Gateway** | disponível | HTTP API é mais barata e simples que REST API para o caso do projeto | média — confirmar |

### 3.5 Observabilidade

| # | Serviço / recurso | Estado | Restrição observada | Confiança |
| --- | --- | --- | --- | --- |
| 20 | **CloudWatch** (métricas, logs, alarms) | disponível | logs custam por GB ingerido; alarmes por métrica custam por alarme-mês; `LogGroup` com retenção curta é obrigatório na prática | alta |

### 3.6 Segredos e acesso

| # | Serviço / recurso | Estado | Restrição observada | Confiança |
| --- | --- | --- | --- | --- |
| 21 | **AWS Secrets Manager** | disponível com restrição | cobra por segredo/mês + chamadas de API; pode estar limitado ou desencorajado por custo. Alternativa barata: SSM Parameter Store (`SecureString`) | média — confirmar |
| 22 | **SSM** (Session Manager, Parameter Store) | disponível com restrição | Session Manager exige **agente SSM na AMI** e permissões do `LabRole` para `ssm:*`; se o `LabRole` não tiver essas permissões, o shell remoto não abre. Parameter Store é o mais provável de funcionar | baixa — verificar no laboratório |

### 3.7 Identidade e orquestração

| # | Serviço / recurso | Estado | Restrição observada | Confiança |
| --- | --- | --- | --- | --- |
| 23 | **IAM** (criar user/role/policy/attachment) | **não disponível** | `iam:CreateRole`, `CreateInstanceProfile`, `AttachRolePolicy`, `CreateUser`, `CreatePolicy`, `CreateOpenIDConnectProvider` são negados; você **usa** o que já existe (`LabRole`, `LabInstanceProfile`) | alta |
| 24 | **STS** | disponível | `get-caller-identity` é o teste de vida das credenciais; `AssumeRole` para roles arbitrárias não | alta |
| 25 | **CloudFormation** | disponível com restrição | stacks funcionam, mas limites de conta e o fato de que o Terraform **não** deve gerenciar o que outra ferramenta criou desaconselham uso misto | média — confirmar |
| 26 | **Billing / Budgets** (orçamento, alarme de gasto) | desconhecido — verificar no laboratório | o aluno normalmente **não** tem acesso a `aws budgets`, nem visão de custo; o crédito é gerido pela instituição | baixa — verificar no laboratório |

> **Fora da lista, mas relevante:** Domain registration, Organizations, SSO/IAM Identity
> Center, Control Tower, Direct Connect, Marketplace e VM Import são típicos recursos
> bloqueados em contas de laboratório. `[confiança: média — confirmar]` Não são
> necessários para o edital.

---

## 4. Restrições de IAM e identidade

`[confiança: alta]` A conta do Learner Lab chega pronta com **três** objetos de IAM, e
confundir a role de sessão com a role de serviço é o erro que quebra o `terraform apply`
mais adiante:

| Objeto | Nome observado | Papel real | Para que serve |
| --- | --- | --- | --- |
| Role de **sessão** | `voclabs` | é a role que **você assume** ao usar o CLI/console; o nome aparece no ARN de `sts get-caller-identity` | autenticar as suas chamadas. **Não** pode ser anexada a uma instância |
| Role de **serviço** | `LabRole` | identidade usada por EC2 / Lambda / ECS como *execution role* | dar permissões a recursos que executam em seu nome |
| Instance profile | `LabInstanceProfile` | envelope que permite anexar `LabRole` a uma instância EC2 | é o valor de `iam_instance_profile` no Terraform |

> **Verificado em laboratório (UFRPE, 2026-11-14):** `sts get-caller-identity` retornou
> `arn:aws:sts::<CONTA>:assumed-role/voclabs/<usuario>=<email>`; `iam get-role LabRole` e
> `iam get-instance-profile LabInstanceProfile` responderam com sucesso. Ou seja: **são roles
> diferentes e as três coisas existem**. No Terraform você nunca referencia `voclabs` — usa
> `data.aws_iam_instance_profile.lab.name` = `LabInstanceProfile`.

O usuário do aluno **não** tem permissão de criar, alterar ou apagar IAM. As políticas de
IAM costumam negar explicitamente as chamadas de escrita em `iam:*` e permitir só
leitura (`iam:GetRole`, `iam:ListRoles`, `iam:PassRole` para o `LabRole`).

### 4.1 Por que todo recurso que exige instance profile precisa do `LabInstanceProfile`

EC2, Auto Scaling, ECS e Lambda não aceitam "uma role qualquer": eles precisam de um
**perfil/role que já exista** e que a chamada possa "passar" (`iam:PassRole`). Como você
não pode criar role nova, a única combinação que existe é:

```text
EC2 / ASG / ECS / Lambda  ──►  LabInstanceProfile  ──►  LabRole
```

Tentar usar qualquer outro nome resulta em erro de "role não encontrada" ou de
`PassRole` negado.

### 4.2 O que acontece se o Terraform tentar `aws_iam_role` ou `aws_iam_instance_profile`

`[confiança: alta]` Falha na criação, com `AccessDenied` (a mensagem exata varia):

```text
Error: creating IAM Role (meu-projeto-role): operation error IAM: CreateRole,
https response error StatusCode: 403, api error AccessDenied:
User: arn:aws:sts::<CONTA>:assumed-role/voclabs/<sessao> is not authorized to
perform: iam:CreateRole on resource: arn:aws:iam::<CONTA>:role/meu-projeto-role
```

O mesmo vale para `aws_iam_instance_profile`, `aws_iam_policy`,
`aws_iam_role_policy_attachment`, `aws_iam_openid_connect_provider` e `aws_iam_user`. O
`apply` para nesse ponto; o que já foi criado antes **fica**.

### 4.3 Como isso muda o desenho do Terraform

1. **Leia, não crie.** Use *data sources* para descobrir os objetos existentes:
   ```hcl
   data "aws_iam_instance_profile" "lab" { name = "LabInstanceProfile" }
   data "aws_iam_role"             "lab" { name = "LabRole" }
   ```
   e referencie `data.aws_iam_instance_profile.lab.name` / `data.aws_iam_role.lab.arn`.
2. **Nunca** coloque `aws_iam_role`, `aws_iam_instance_profile`, `aws_iam_policy`,
   `aws_iam_role_policy_attachment` no `main.tf`. Se colocar, o `plan` até passa e o
   `apply` quebra — o pior tipo de erro, porque só aparece na hora da demo.
3. **Parameterize o nome** (`variable "instance_profile_name" { default = "LabInstanceProfile" }`),
   para que o mesmo código rode no Cenário B sem edição.
4. **`aws_lambda_function.role`** e **`aws_ecs_task_definition.task_role_arn`** apontam
   para `data.aws_iam_role.lab.arn`.
5. **Least privilege vira "least privilege possível"**: você não pode criar uma policy
   restrita; a role é larga por definição. Documente isso como *risco aceito* no
   relatório do projeto (o edital pede justificativa de segurança, e essa é a
   justificativa honesta).
6. **Alternativa a instance profile**: se você precisa de credencial em um processo fora
   do EC2, use a própria credencial da sessão (`AWS_*` no ambiente) — é o mesmo caminho
   que o Terraform usa.

---

## 5. Restrições de compute

| Restrição | Comportamento | Confiança |
| --- | --- | --- |
| Tipos de instância | subconjunto permitido pela política da conta; famílias `t2`/`t3` são as mais prováveis de estar liberadas, GPU/bare-metal quase certamente não | `[confiança: baixa — verificar no laboratório]` |
| Limite de vCPU | cota de vCPUs *on-demand* por região, tipicamente dezenas (não centenas); estourar dá `VcpuLimitExceeded` | `[confiança: baixa — verificar no laboratório]` |
| Regiões | o Learner Lab normalmente trava em **`us-east-1`**; algumas instituições liberam `us-west-2`/outras. Se a região do provider estiver errada: `UnauthorizedOperation`/`AccessDenied` em tudo | `[confiança: média — confirmar]` |
| Crédito / orçamento | a instituição define o valor (faixa comum em dezenas de dólares por aluno); não há alarme automático para o aluno | `[confiança: baixa — verificar no laboratório]` |
| Ao estourar o crédito | recursos podem ser parados/terminados e o lab fica inutilizável até a instituição repor; você pode perder a conta no meio de uma entrega | `[confiança: baixa — verificar no laboratório]` |
| Duração da sessão | ~4 h por sessão; o cronômetro é do lab, não seu | `[confiança: média — confirmar]` |

**Consequências práticas.**

- A demo do projeto cabe em `t3.micro`/`t3.small`. **Não** use `m5.large` para "ter folga".
- Instância parada (`stopped`) **não** cobra compute, mas o EBS anexado continua
  cobrando. `[confiança: alta]`
- ALB, NAT Gateway, RDS e EFS cobram **por hora mesmo ociosos**. Tudo o que é "sempre
  ligado" deve ser criado o mais tarde possível e destruído com `terraform destroy` ao
  fim de cada sessão de trabalho. `[confiança: alta]`
- O maior risco de crédito não é o compute: é esquecer ALB/RDS/NAT ligados durante a
  semana.

---

## 6. Persistência entre sessões

A pergunta é: o que sobrevive a **clicar em "End Lab"** e a **iniciar uma nova sessão**?
A conta AWS é a mesma; o que muda são as credenciais.

### 6.1 Persiste

| Item | Por quê | Confiança |
| --- | --- | --- |
| Instâncias EC2 (o recurso, com IDs) | a conta é a mesma | alta |
| Volumes EBS e seus dados | armazenamento é independente do ciclo do lab | alta |
| Snapshots EBS e AMIs criadas | idem | alta |
| Buckets S3 e objetos | idem | alta |
| Repositórios ECR e imagens | idem | alta |
| Tabelas DynamoDB e dados | idem | alta |
| Recursos de rede (VPC, subnets, SGs, ALB, EIP) | idem | alta |
| CloudWatch Log Groups e alarms | idem | alta |
| Segredos em Secrets Manager / Parameter Store | idem | alta |
| O **state do Terraform**, se estiver em S3 | vive no bucket, não na sessão | alta |
| GitHub Secrets / configuração do runner | fora da AWS | alta |

### 6.2 Não persiste

| Item | Por quê | Confiança |
| --- | --- | --- |
| As três credenciais (`AWS_*`) | são de sessão STS | alta |
| A sessão do console AWS | encerrada no "End Lab" | alta |
| Variáveis exportadas em um terminal | morreram com o shell | alta |
| A otimização de "`aws sts` já autenticado" / cache de credenciais | fica no `~/.aws` da sua máquina, mas aponta para um token morto | alta |
| O processo do runner self-hosted **na sua máquina** | para junto com o WSL/máquina | alta |
| O *lock* de estado do Terraform (se a sessão cair no meio) | pode ficar preso no backend e precisa ser liberado | média — confirmar |

### 6.3 A confirmar no laboratório

| Dúvida | Por que importa | Como confirmar |
| --- | --- | --- |
| O estado (running/stopped) da instância é preservado entre sessões? | define se você precisa religar à mão toda vez | seção 11, K21 |
| Há **reset periódico** da conta (limpeza semanal/mensal)? | apagaria tudo no meio do semestre | perguntar ao professor **e** conferir se os recursos do dia anterior ainda existem |
| O lab é iniciado só pelo botão, ou há encerramento automático por tempo? | define se um `apply` longo pode ser cortado | observar a UI depois de ~4 h |
| EIP é mantido e reassociado? | IP muda = URL muda na demo | seção 11, K22 |
| O crédito reinicia por sessão ou é único para o semestre? | define a estratégia de "criar e destruir" | perguntar ao professor |

**Regra de ouro:** trate **todo** recurso como potencialmente descartável. O
`terraform apply` a partir do repositório é o seu mecanismo de recuperação; o
`terraform destroy` é o seu mecanismo de economia.

---

## 7. Implicações para Terraform

### 7.1 A cadeia de credenciais

`[confiança: alta]` Precedência que o provider AWS usa (do mais forte para o mais fraco,
nos pontos que importam aqui):

1. `provider "aws" { access_key = ..., secret_key = ..., token = ... }` — **nunca** faça
   isso, coloca segredo no código.
2. Variáveis de ambiente `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
   `AWS_SESSION_TOKEN` — **caminho recomendado**.
3. Perfil compartilhado em `~/.aws/credentials` (`AWS_PROFILE`), com o campo
   `aws_session_token` no mesmo bloco.
4. `credential_process` no perfil (ver 7.2).

```bash
# depois do export da seção 2.2
terraform init   # baixa o provider na primeira vez
terraform plan
terraform apply
```

**Por que `aws configure` sem token gera `InvalidClientTokenId`:** `aws configure` grava
só `aws_access_key_id` e `aws_secret_access_key` (e a região). Sem `aws_session_token`, o
CLI e o Terraform enviam uma credencial de sessão **sem** o token; o STS não reconhece a
assinatura e devolve `InvalidClientTokenId`. Se você já rodou `aws configure` assim,
corrija:

```bash
aws configure set aws_session_token '<AWS_SESSION_TOKEN>'
# ou, mais seguro, defina o token só na sessão:
export AWS_SESSION_TOKEN='<AWS_SESSION_TOKEN>'
```

### 7.2 `AWS_PROFILE` + `credential_process`

Útil quando o grupo quer um único comando para "renovar e já valer". Crie `~/.aws/config`:

```ini
[profile academy]
region                 = us-east-1
output                 = json
credential_process     = /home/<usuario>/.local/bin/academy-creds
```

`[confiança: média — confirmar]` O `credential_process` deve imprimir **um JSON** com
`Version`, `AccessKeyId`, `SecretAccessKey`, `SessionToken` e só funciona se o script
tiver as credenciais de alguma fonte (ex.: arquivo que você cola manualmente). Ou seja:
**ele não substitui a cópia manual** no Learner Lab — só organiza o que já foi copiado.
Não invente um script que "consulta o Vocareum"; essa API não é pública.

Depois: `export AWS_PROFILE=academy` (bash) / `$env:AWS_PROFILE='academy'` (PowerShell).

### 7.3 Backends de state

O state precisa estar fora da máquina local se o pipeline for usar. Opções:

| Opção | Como | Prós | Contras | Confiança |
| --- | --- | --- | --- | --- |
| **S3 nativo + `use_lockfile`** *(recomendado)* | bucket S3 versionado e criptografado, `backend "s3"` com `use_lockfile = true` | sem DynamoDB para criar; lock nativo (Terraform ≥ 1.10); funciona bem com as permissões do `LabRole` | exige Terraform ≥ 1.10 e um bucket **criado antes** (bootstrap manual ou `terraform init` com backend local) | alta |
| S3 + DynamoDB lock | tabela DynamoDB `LockID` (String, chave de partição) | compatível com versões antigas do Terraform; clássico | um recurso a mais para criar, custar e gerenciar; DynamoDB só entra por isso | alta |
| S3 sem lock | só `bucket` + `key` | simples | risco de dois `apply` simultâneos corromperem o state | alta |
| State local | padrão do `terraform init` | zero setup | cada máquina/runner tem seu próprio state; some com o WSL; inútil para CI | alta |

**Recomendação:** bucket S3 dedicado (`meu-projeto-tfstate-<sufixo>`), versionamento
ligado, criptografia SSE-S3, bloqueio de acesso público, e `use_lockfile = true` no
Terraform 1.10+. Se a versão do Terraform for menor, use DynamoDB.

```hcl
terraform {
  backend "s3" {
    bucket       = "bcc-cloud-tfstate-<sufixo>"
    key          = "projeto2/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}
```

> `[confiança: média — confirmar]` O bootstrap do bucket é um passo manual (ou um segundo
> `apply` com state local). Não tente criar o bucket no **mesmo** state que o usa —
> `terraform init` falha antes disso existir.

### 7.4 Armadilhas específicas de Terraform no Learner Lab

| Sintoma | Causa | Mitigação |
| --- | --- | --- |
| `InvalidClientTokenId` no `init`/`plan` | falta `AWS_SESSION_TOKEN` | reexportar os três valores |
| `ExpiredToken` no meio do `apply` | sessão acabou | protocolo da seção 2.6 |
| `Error: creating IAM Role ... AccessDenied` | código cria IAM | `data "aws_iam_role"` (seção 4.3) |
| `InvalidParameterValue: The parameter iamInstanceProfile is not valid` | perfil com nome errado | usar `LabInstanceProfile` (`[confiança: média — confirmar]` o nome exato) |
| `Error acquiring the state lock` | outra sessão/runner morreu com o lock | `terraform force-unlock <id>` — **só** se tiver certeza de que ninguém está aplicando |
| provider baixado em uma versão e CI em outra | `required_providers` sem `version` | fixar `version = "~> 5.0"` (ajuste à versão local) `[confiança: média — confirmar]` |
| plan mostra `~ update` em tudo a cada run | atributos computados/refresh | não force `ignore_changes` sem entender; verifique `provider` e região |

---

## 8. Implicações para GitHub Actions

### 8.1 Por que OIDC / `AssumeRoleWithWebIdentity` normalmente é inviável

`[confiança: alta]` O fluxo OIDC exige **três** coisas que o Learner Lab bloqueia:

1. `iam:CreateOpenIDConnectProvider` (criar o provedor do `token.actions.githubusercontent.com`);
2. `iam:CreateRole` + `iam:UpdateAssumeRolePolicy` (a role com a trust policy que aceita
   o repositório);
3. `iam:PassRole`/`iam:AttachRolePolicy` para amarrar as permissões.

Como você não tem escrita em IAM (seção 3.7, item 23), o passo 1 já falha. Não existe
"workaround" de OIDC com o `LabRole` porque a trust policy dele não confia no GitHub.

**Teste barato para descartar de vez** `[confiança: alta]` (como ele falha por
`AccessDenied`, o teste é inofensivo):

```bash
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com
```

### 8.2 Alternativa (a): credenciais temporárias em GitHub Secrets

Guardar `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` como
*repository secrets* e atualizá-los a cada nova sessão de lab.

| Prós | Contras | Custo |
| --- | --- | --- |
| funciona hoje, sem criar IAM; usa `aws-actions/configure-aws-credentials` com `aws-access-key-id`/`aws-secret-access-key`/`aws-session-token`; pipeline roda no GitHub (sem máquina ligada) | **exige atualização manual a cada sessão** (~4 h); o pipeline falha silenciosamente quando o token vencer; segredo de longa duração em repositório, contra o espírito do requisito 3.4 do edital; se vazar, é reemitido pelo lab mas mancha o histórico | zero em créditos AWS; o custo é tempo de secretaria/automação imperfeita |

### 8.3 Alternativa (b): runner self-hosted em EC2 com `LabInstanceProfile`

Uma instância EC2 com `LabInstanceProfile` roda o runner do GitHub; o runner herda as
credenciais do perfil **sem** access key estática.

| Prós | Contras | Custo |
| --- | --- | --- |
| sem segredo estático (melhor aderência ao requisito 3.4); credencial sempre fresca enquanto a instância viver; é a solução mais "correta" tecnicamente | a instância precisa estar **ligada e registrada** para o runner existir; exige provisionar, instalar o runner e mantê-lo atualizado; runner ocioso cobra EC2 + EBS; a sessão do lab limita a janela de execução; a demo pode depender de "ligar a instância antes" | EC2 `t3.micro` ligada algumas horas por semana + EBS 24/7; em créditos, o item mais caro das duas alternativas |

### 8.4 Comparação e recomendação

| Critério | (a) Secrets temporários | (b) Runner em EC2 |
| --- | --- | --- |
| Automação real (push → deploy) | baixa/média (precisa de alguém reexportar) | alta, **enquanto a instância estiver ligada** |
| Segredo estático armazenado | sim | não |
| Esforço inicial | baixo | alto |
| Custo em crédito | ~0 | EC2 + EBS contínuos |
| Funciona com OIDC | não | não (mas não precisa) |
| Risco na demo | falha por token vencido | falha se a instância estiver desligada |

**Recomendação.** Desenhe o pipeline em **duas camadas**:

1. **Camada sempre-verde (CI, sem AWS):** lint, testes unitários, build da imagem Docker,
   `terraform fmt -check` e `terraform validate`. Isso satisfaz partes do requisito 3.3 do
   edital e **nunca** falha por credencial, porque não toca na AWS.
2. **Camada de implantação (CD, com AWS):** job com `workflow_dispatch` que usa a
   alternativa **(a)** na maior parte do tempo — é a que cabe em 4 horas de sessão e custa
   ~0. Mantenha **(b)** como evolução documentada se o grupo quiser demonstrar
   "push → deploy" real; nesse caso a instância do runner é criada/ligada no início da
   sessão e destruída no fim.

Justificativa em uma frase: o edital pesa **pipeline CI/CD (15%)** e **segurança de
credenciais (5%)**; (b) é melhor em segurança mas custa crédito e uma instância sempre
ligada que o aluno não tem como manter — (a) entrega o critério com transparência total
sobre a limitação, que é justamente o que a documentação técnica (5%) deve explicar.

### 8.5 O que **não** fazer

- Não tente `aws-actions/configure-aws-credentials` com `role-to-assume` — é OIDC.
- Não coloque as credenciais em `terraform.tfvars`, em `env:` inline no YAML, nem em
  `--var` do CLI: tudo isso fica no log do workflow.
- Não use `pull_request_target` com secrets: expõe a chave a forks.
- Não commite o `.terraform/` nem o `terraform.tfstate`.

---

## 9. Riscos e armadilhas (sintoma → causa → mitigação)

| # | Sintoma | Causa | Mitigação |
| --- | --- | --- | --- |
| R1 | `ExpiredToken: The security token included in the request is expired` | sessão do lab acabou ou foi reiniciada | reemitir em AWS Details, reexportar os três valores, `terraform plan` antes de `apply` |
| R2 | `InvalidClientTokenId` | `aws configure` sem `aws_session_token`, ou só duas variáveis exportadas | copiar/exportar sempre os **três**; conferir com `aws sts get-caller-identity` |
| R3 | Chave/segredo aparecem em log de `terraform plan` ou no log do Actions | credencial passada por `-var`, `TF_VAR_*` ou `env` do YAML | só variáveis de ambiente mascaradas; `sensitive = true`; rodar `plan` local |
| R4 | `apply` morre no meio e recursos ficam "órfãos" | sessão expirou durante o apply | protocolo 2.6; `terraform import`/`state rm`; evitar `-auto-approve` |
| R5 | `AccessDenied`/`UnauthorizedOperation` em um recurso específico (ex.: `iam:CreateRole`, `rds:CreateDBInstance` com subnet group inexistente) | recurso bloqueado pela política da conta | identificar o serviço na matriz (seção 3), trocar por alternativa; nunca insistir criando IAM |
| R6 | ALB ligado sem tráfego consumindo crédito | ALB cobra por hora + LCU mesmo ocioso | criar tarde, `terraform destroy` ao fim da sessão; checar custos no painel do Vocareum |
| R7 | Instância ligada esquecida de um dia para o outro | "End Lab" encerrado **não** para a instância | parar via `aws ec2 stop-instances`; rotina de fim de sessão; tag `owner`/`stop-schedule` |
| R8 | Recursos criados em região errada, ou tudo `AccessDenied` | provider sem `region` e `AWS_DEFAULT_REGION` apontando para fora da região do lab | fixar `region = "us-east-1"` no provider `[confiança: média — confirmar]` e conferir `aws configure get region` |
| R9 | Não há alarme de orçamento e o crédito some | `aws budgets` normalmente não é acessível ao aluno | monitorar por rotina: `terraform destroy` no fim de cada sessão + parar instâncias + conferir custos no painel Vocareum |
| R10 | `chmod: changing permissions of '/mnt/c/...': Operation not permitted` / `UNPROTECTED PRIVATE KEY FILE` no `ssh` | chave `.pem` em `/mnt/c` (DrvFs) que ignora permissões Unix | mover a chave para o filesystem Linux (`~/.ssh/`) e `chmod 400` lá |
| R11 | `Error acquiring the state lock` | runner/máquina morreu segurando o lock | `terraform force-unlock <id>` após confirmar que ninguém aplica; preferir `use_lockfile` |
| R12 | Key pair bloqueado (`UnauthorizedOperation` em `CreateKeyPair`/`ImportKeyPair`) | política de IAM da conta | usar Session Manager, ou gerar o par e tentar `ImportKeyPair`; se ambos falharem, acesso só HTTP (seção 10.3) |
| R13 | Docker push no ECR falha com `no basic auth credentials`/`denied` | token de login do ECR expirou (12 h) ou região errada no login | `aws ecr get-login-password --region us-east-1 \| docker login --username AWS --password-stdin <conta>.dkr.ecr.us-east-1.amazonaws.com` |
| R14 | RDS não cria (`DBSubnetGroupNotFound`, classe não suportada) | conta sem subnet group padrão/classe bloqueada | verificar no laboratório antes de comprometer a arquitetura; alternativa: banco auto-hospedado em EC2/Docker com EBS |
| R15 | Conta "resetada"/recursos somem no meio do semestre | limpeza periódica da instituição | manter tudo reproduzível por Terraform; nunca depender de configuração manual no console |
| R16 | `docker build`/`apply` não termina antes do fim da sessão | sessão de ~4 h e imagem grande | build enxuto (multi-stage), cache no Actions, operações longas no início da sessão |

---

## 10. Key pairs: como obter a chave `.pem` e usá-la no Terraform

Você precisa da chave para `ssh` e o Terraform precisa do **nome** do key pair já
existente. Há duas rotas — teste qual funciona na sua conta **antes** de desenhar a
arquitetura em cima. `[confiança: alta]` Se nenhuma funcionar, os acessos remotos mudam
completamente (seção 10.3).

### 10.1 Rota A — criar no console EC2 e baixar o `.pem`

1. Console → **EC2 → Key pairs → Create key pair**: nome `projeto2`, tipo **RSA**,
   formato **`.pem`** (Linux/WSL) → download. `[confiança: alta]`
2. O arquivo cai em `C:\Users\<usuario>\Downloads\projeto2.pem`. **Mova para o
   filesystem Linux do WSL** (não deixe em `/mnt/c`):

   ```bash
   mkdir -p ~/.ssh
   cp /mnt/c/Users/<usuario>/Downloads/projeto2.pem ~/.ssh/projeto2.pem
   chmod 400 ~/.ssh/projeto2.pem
   ssh -i ~/.ssh/projeto2.pem ubuntu@<ip-publico>
   ```
3. Ponto crítico: `chmod` em `/mnt/c` (DrvFs) **não** aplica permissões Unix — o `ssh`
   reclama de "UNPROTECTED PRIVATE KEY FILE" e se recusa a usar a chave. Por isso a
   cópia para `~/.ssh`. `[confiança: alta]`
4. No Terraform, referencie **pelo nome**:

   ```hcl
   data "aws_key_pair" "projeto2" { key_name = "projeto2" }
   resource "aws_instance" "app" {
     key_name = data.aws_key_pair.projeto2.key_name
     # ...
   }
   ```

   (ou, sem data source: `key_name = "projeto2"` direto no recurso)
5. **Vantagem:** o `.pem` nunca transita pelo repositório. **Desvantagem:** passo manual;
   se a instância for recriada com a mesma chave, ok — a chave é da conta, não da
   instância.

### 10.2 Rota B — gerar no WSL e importar a chave pública

1. Gere o par **no** WSL (filesystem Linux):

   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/projeto2 -N '' -C 'projeto2@bcc-cloud'
   chmod 600 ~/.ssh/projeto2
   chmod 644 ~/.ssh/projeto2.pub
   cat ~/.ssh/projeto2.pub
   ```
2. Importe a **pública** no EC2 (console: **Key pairs → Actions → Import key pair**, cole
   o conteúdo de `~/.ssh/projeto2.pub`; ou CLI):

   ```bash
   aws ec2 import-key-pair \
     --key-name projeto2 \
     --public-key-material fileb://$HOME/.ssh/projeto2.pub \
     --region us-east-1
   ```
3. No Terraform, escolha **uma** das duas formas:

   | Forma | Quando usar | Como |
   | --- | --- | --- |
   | `aws_key_pair` com `public_key` | o Terraform **cria/gerencia** o key pair | `resource "aws_key_pair" "projeto2" { key_name = "projeto2"; public_key = file("~/.ssh/projeto2.pub") }` |
   | `data "aws_key_pair"` | o key pair **já existe** (criado no console/CLI) | `data "aws_key_pair" "projeto2" { key_name = "projeto2" }` + `key_name = data.aws_key_pair.projeto2.key_name` |

   > `[confiança: alta]` Regra prática que evita erro nas duas versões do provider: use
   > `data "aws_key_pair"` para chave **que já existe** e `resource "aws_key_pair"` **com**
   > `public_key` para chave que o Terraform deve criar. Não use `resource` apontando para
   > um nome que já existe — dá conflito de adoção.
4. **Vantagem:** a privada nunca sai da sua máquina e não existe arquivo baixado para
   perder. **Desvantagem:** um passo extra (import).

**Qual funciona no Learner Lab?** `[confiança: média — confirmar]` As duas **costumam**
ser permitidas, mas `ec2:ImportKeyPair` e `ec2:CreateKeyPair` podem estar negados pela
política da conta. Teste os dois na primeira sessão:

```bash
# teste de criação (não baixa nada se você não pedir)
aws ec2 create-key-pair --key-name teste-academy --query 'KeyName' --output text
# teste de importação (usa uma pública que você já tem)
aws ec2 import-key-pair --key-name teste-academy-imp \
  --public-key-material fileb://$HOME/.ssh/<alguma>.pub
# limpeza
aws ec2 delete-key-pair --key-name teste-academy
aws ec2 delete-key-pair --key-name teste-academy-imp
```

Se ambos falharem com `UnauthorizedOperation`, trate como **descoberta crítica**.

### 10.3 Se key pair for bloqueado (alternativas de acesso)

1. **AWS Systems Manager Session Manager** — acesso a shell sem porta 22 e sem chave;
   exige que a AMI tenha o agente SSM e que o `LabRole` permita `ssm:*`.
   `[confiança: baixa — verificar no laboratório]` Teste:
   `aws ssm start-session --target <instance-id>`.
2. **Acesso via HTTP apenas** — a aplicação fica atrás do ALB e a "operação" se faz por
   deploy e logs, não por SSH. É suficiente para o edital (que pede app funcional,
   pipeline e observabilidade, não shell).
3. **Runbook/user-data** — toda configuração da instância entra no `user_data` do
   Terraform; nada de ajuste manual. Essa é a melhor prática de qualquer forma.

---

## 11. Checklist de verificação no laboratório

Rode na **primeira sessão** (WSL/Ubuntu, credenciais exportadas) e anote o resultado.
Cada item converte um `desconhecido`/`baixa` da matriz em fato. Todos os comandos são
`bash`; o ambiente principal é o WSL. `[confiança: alta]` A maioria é **somente leitura**.

| # | Dúvida a fechar | Comando (WSL/bash) | O que observar |
| --- | --- | --- | --- |
| K1 | Credenciais e identidade (sempre primeiro) | `aws sts get-caller-identity` | ARN contém `assumed-role/voclabs`? |
| K2 | Região efetiva | `aws configure get region` | tem que bater com a região dos recursos |
| K3 | **Key pair** é permitido? | `aws ec2 create-key-pair --key-name kp-teste --query KeyName --output text` e `aws ec2 import-key-pair --key-name kp-teste-imp --public-key-material fileb://$HOME/.ssh/id_ed25519.pub` | `AccessDenied` → bloqueado; depois `aws ec2 delete-key-pair --key-name kp-teste` |
| K4 | Tipos de instância permitidos | `aws ec2 describe-instance-types --filters Name=current-generation,Values=true --query 'InstanceTypes[].InstanceType' --output table` | liste as famílias disponíveis |
| K5 | Cotas de vCPU / EIP / etc. | `aws service-quotas list-service-quotas --service-code ec2 --query 'Quotas[?contains(QuotaName,`On-Demand`)].{Q:QuotaName,V:Value}' --output table` | valor da cota de vCPU on-demand |
| K6 | `LabRole` existe e é usável? | `aws iam get-role --role-name LabRole --query 'Role.Arn' --output text` | nome exato e ARN |
| K7 | `LabInstanceProfile` existe? | `aws iam get-instance-profile --instance-profile-name LabInstanceProfile --query 'InstanceProfile.InstanceProfileName' --output text` | nome exato (usar no Terraform) |
| K8 | IAM é realmente bloqueado? | `aws iam create-role --role-name teste --assume-role-policy-document file://trust.json` (espere falhar) | `AccessDenied` confirma Cenário A |
| K9 | OIDC provider é bloqueado? | `aws iam create-open-id-connect-provider --url https://token.actions.githubusercontent.com --client-id-list sts.amazonaws.com` (espere falhar) | `AccessDenied` → OIDC inviável |
| K10 | ECR existe / está liberado? | `aws ecr describe-repositories` (vazio = sem repos, ok) e `aws ecr get-login-password --region us-east-1` | token sai → ECR liberado |
| K11 | S3 funciona? | `aws s3 ls` e `aws s3 mb s3://bcc-cloud-teste-$RANDOM` | cria e lista; apague depois |
| K12 | Snapshots/AMIs permitidos? | `aws ec2 describe-snapshots --owner-ids self` | lista vazia é normal |
| K13 | EFS liberado? | `aws efs describe-file-systems` | erro de acesso indica bloqueio |
| K14 | RDS: subnet group e classes | `aws rds describe-db-subnet-groups` e `aws rds describe-orderable-db-instance-options --engine mysql --query 'OrderableDBInstanceOptions[].DBInstanceClass'` | sem subnet group → RDS inviável |
| K15 | DynamoDB liberado? | `aws dynamodb list-tables` | vazio = ok |
| K16 | Lambda/Secrets/SSM | `aws lambda list-functions`; `aws secretsmanager list-secrets`; `aws ssm describe-parameters` | qualquer `AccessDenied` fecha o item |
| K17 | SSM Session Manager usável? | `aws ssm describe-instance-information --query 'InstanceInformationList[].InstanceId'` | vazio sem instância SSM é esperado |
| K18 | Ofertas de instance type na região | `aws ec2 describe-instance-type-offerings --location-type region --query 'InstanceTypeOfferings[].InstanceType' --output table` | ofertas na região |
| K19 | CloudWatch Logs | `aws logs describe-log-groups --query 'logGroups[].logGroupName' --output table` | lista (vazia ok) = liberado |
| K20 | Budgets/custos | `aws budgets describe-budgets --account-id $(aws sts get-caller-identity --query Account --output text)` | `AccessDenied` → sem alarme de orçamento (R9) |
| K21 | Instância sobrevive ao "End Lab"? | criar `t3.micro`, encerrar o lab, iniciar de novo e rodar `aws ec2 describe-instance-status --instance-ids <id>` | `running`/`stopped`/recriada |
| K22 | EIP é mantido? | `aws ec2 describe-addresses --query 'Addresses[].[PublicIp,InstanceId]' --output table` em duas sessões | mesmo IP e associação |

**Versão PowerShell (Windows nativo)** — só para os quatro primeiros, caso queira rodar
fora do WSL:

```powershell
aws sts get-caller-identity
aws configure get region
aws ec2 describe-instance-types --filters Name=current-generation,Values=true --query "InstanceTypes[].InstanceType" --output table
aws service-quotas list-service-quotas --service-code ec2 --query "Quotas[].{Q:QuotaName,V:Value}" --output table
```

Após rodar a checklist, **atualize a seção 3**: substitua `desconhecido — verificar no
laboratório` por `disponível`/`não disponível` com a data e o comando usado como
evidência.

---

## 12. Onde o edital e o AWS Academy colidem

| Requisito do edital (`docs/00-edital-projeto-2.md`) | Limite do Academy | Impacto | Saída honesta |
| --- | --- | --- | --- |
| 3.3 — "implantação automatizada da aplicação no ambiente de nuvem" + "verificação automatizada após o deploy" | sem OIDC; credenciais de ~4 h; conta sem IAM | o CD "push → deploy" só existe dentro da janela da sessão | pipeline em duas camadas (8.4), com job de deploy `workflow_dispatch` documentado e evidência de execução |
| 3.4 — credenciais "disponibilizadas de forma segura" | credenciais temporárias rotativas; `LabRole` larga e imutável | não dá para aplicar least privilege real | registrar como **risco aceito e justificado**; secrets mascarados, sem segredo estático quando se usa (b) |
| 4 — "implantação … deverá utilizar a plataforma AWS" | serviços sugeridos todos viáveis no Cenário A exceto **Route 53 (domínio)**, e **RDS/EFS/SSM** dependem de confirmação | nada do edital é impossível por definição; o risco está na **disponibilidade de RDS** e na **falta de domínio próprio** | usar DNS do ALB; se RDS falhar, banco em EC2/Docker sobre EBS ou DynamoDB, com justificativa técnica |
| 3.6 — observabilidade (métricas, logs, dashboards) | Prometheus/Grafana/Telegraf/Loki são software **dentro** de EC2 — não são serviços AWS, então não esbarram em IAM; CloudWatch é o serviço AWS subjacente | ok, mas lembre que Grafana/Prometheus ligados 24/7 queimam crédito | rodar o stack na mesma instância da aplicação ou em uma instância pequena, destruída ao fim da sessão |
| 3.2 — Terraform gerencia "os principais recursos" | IAM não é gerenciável | a infraestrutura fica reproduzível **exceto** os objetos de IAM (pré-existentes) | documentar `data "aws_iam_role"`/`data "aws_iam_instance_profile"` como decisão de projeto |
| 6.4 — "ambiente funcional na nuvem" para a banca | sessões de ~4 h e crédito finito | a URL só existe durante a sessão/aula | garantir `terraform apply` reprodutível em < 10 min antes da demo; deixar recursos mínimos ligados só na véspera |

---

## 13. Resumo em uma página

- **Cenário A** (Learner Lab/Vocareum) tem **3 credenciais temporárias**; sem
  `AWS_SESSION_TOKEN` nada funciona (`InvalidClientTokenId`); a sessão dura **~4 h**
  `[confiança: média — confirmar]` e "End Lab" corta o acesso na hora, mas os recursos
  ficam.
- **IAM é o muro**: nada de criar role/policy/user/OIDC provider. Todo compute usa
  `LabInstanceProfile` → `LabRole`. O Terraform **lê** com `data`, não cria.
- **Terraform**: exportar as 3 variáveis, provider com região fixa, state em **S3 com
  `use_lockfile`** (Terraform ≥ 1.10) ou S3+DynamoDB.
- **CI/CD**: OIDC inviável; (a) secrets temporários é o caminho barato, (b) runner em EC2
  com instance profile é o caminho correto e caro. Recomendado: CI sem AWS sempre verde +
  CD `workflow_dispatch` com (a).
- **Key pair**: criar+baixar (console) **ou** `ssh-keygen` + Import; `chmod 400` só vale
  em filesystem Linux (`~/.ssh`), nunca em `/mnt/c`. Bloqueio é possível — teste na
  primeira sessão.
- **Persistência**: EBS/S3/ECR/snapshots/ALB/DynamoDB/CloudWatch **persistem**;
  credenciais, sessão e processos locais **não**. O que é destruído por reset da
  instituição é `a confirmar`.
- **Custo**: o inimigo são recursos ociosos (ALB, NAT, RDS, EFS, EBS). Rotina:
  `terraform destroy` ao fim de cada sessão de trabalho.
- **Antes de arquitetar**, rode a seção 11 e atualize a seção 3.
