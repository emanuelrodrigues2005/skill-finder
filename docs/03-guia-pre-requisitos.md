# Guia de pré-requisitos — ambiente pronto antes da primeira linha de código

> **Para quem é este documento.** Aluno(s) do Projeto 2 de Computação em Nuvem (UFRPE) que
> ainda **não** começaram a escrever Terraform nem código de aplicação. O objetivo é sair
> do zero até um ambiente em que `terraform init` funciona, o SSH entra numa instância e o
> pipeline tem credenciais — **sem** ter criado nenhum recurso de arquitetura ainda.
>
> **Fora de escopo:** escolher a arquitetura AWS, escrever código de aplicação, escrever
> arquivos `.tf` de recursos e planejar as fases do projeto. A arquitetura vive em
> `docs/01-analise-requisitos-e-arquitetura.md`; os requisitos do professor vivem em
> `docs/00-edital-projeto-2.md`; os limites do laboratório e o modelo de credenciais vivem
> em `docs/02-aws-academy-limites-e-riscos.md`.
>
> **Regra deste guia:** ele **não repete** `docs/02`. Onde o assunto já está resolvido lá,
> há um link e a decisão operacional de uma linha. Leia `docs/02` §2, §7, §8, §10 e §11
> antes de executar qualquer passo daqui.

---

## 0. Como usar este guia

**Convenções.**

| Marca | Significado |
| --- | --- |
| `<PLACEHOLDER>` | você troca por um valor real. Nunca grave valor real neste arquivo. |
| `saída esperada (formato)` | não é uma saída real capturada; é a **forma** que a saída tem. Os números e IDs vão variar. |
| `[confirmar versão no momento da instalação]` | a versão exata pode ter mudado; instale a estável mais recente e **anote a que usou**. |
| `WSL` | terminal Ubuntu dentro do Windows. É a **plataforma principal** deste guia. |
| `PowerShell` | só onde há alternativa útil. Nunca misture sintaxe dos dois no mesmo bloco. |

**Estado do ambiente no momento em que este guia foi escrito** (use como dado, não
re-verifique):

| Item | Estado |
| --- | --- |
| Windows 11, usuário `Lima02`, pasta de trabalho | `C:\Users\Lima02\Documents\bcc\cloud` |
| WSL2 com Ubuntu | **instalado e funcionando** — plataforma principal |
| Docker Desktop (CLI `docker` + `docker compose`) | instalado no Windows |
| Git 2.50, OpenSSH, Git Bash, Python 3.13, VS Code, `winget`, `scoop` | instalados no Windows |
| Chocolatey | **ausente** (não é necessário; use `apt` dentro do WSL) |
| AWS CLI, Terraform, Ansible | **não instalados** (é o Passo 2) |
| Identidade do Git | `Emanuel Rodrigues` / `emanuelrodrigues112358@gmail.com` (configurada no Windows) |
| Repositório Git na pasta | **não** existe ainda (`Test-Path .git` → False) |
| Internet da máquina do aluno | ok — este guia não baixa nem instala nada; **você** executa |

> **Sobre o Docker em sessões automatizadas.** Se um script rodar `docker ps` e receber
> `Cannot connect to the Docker daemon`, isso é isolamento da sessão, **não** defeito da
> instalação. No seu terminal, com o Docker Desktop aberto, `docker ps` funciona. Confirme
> sempre no seu terminal, não no de terceiros.

**A numeração dos passos é a ordem de leitura, não a ordem da primeira sessão.** O
laboratório AWS tem cronômetro (`docs/02` §2.4), e download de pacote não precisa de
credencial AWS. Na primeira sessão, execute nesta ordem:

```
Passo 2 (toolchain, ~30 min, sem lab)  →  Passo 1 (Start Lab)  →  Passo 3 (chave)
  →  Passo 4 (credenciais do dia a dia)  →  Passo 6 (bucket de state)  →  Passo 7 (secrets)
```

Os Passos 5 e 8 não dependem do lab: podem ser feitos em qualquer momento.

**Cada passo termina com um `Critério de verificação`.** Não avance com o critério
anterior falhando.

**Roteiro de uma tela:**

| # | Passo | Você termina quando… | tempo |
| --- | --- | --- | --- |
| 1 | Decisões (§1) | a tabela está preenchida e salva | 15 min |
| 2 | Toolchain (§3) | `terraform version` mostra ≥ 1.10 | 30 min |
| 3 | Lab AWS (§2) | `aws sts get-caller-identity` responde | 10 min |
| 4 | Chave SSH (§4) | `ssh proj2 'echo ok'` responde `ok` | 30 min |
| 5 | Credenciais (§5) | `source ~/.local/bin/academy-env` imprime `OK` | 20 min |
| 6 | Repositório (§6) | `git status` limpo, primeiro commit feito | 20 min |
| 7 | Backend (§7) | `terraform init` imprime `Successfully configured the backend "s3"` | 20 min |
| 8 | GitHub + secrets (§8) | `gh secret list` mostra os 3 nomes | 20 min |

---

## 1. Quadro de decisões antes de tocar em qualquer ferramenta

Estas decisões são **anteriores** a qualquer comando. Elas mudam nomes de bucket, nomes de
repositório e o que se pode desfazer. Preencha a coluna "decidido" e copie o resultado para
o `README.md` do repositório (criado no Passo 5) — é o documento que a banca lê.

| # | Decisão | Opção recomendada | Por quê | Onde registrar |
| --- | --- | --- | --- | --- |
| D1 | **Nome/slug do projeto** | `bcc-cloud` | vira prefixo de bucket, nome de repo, tags e security groups; trocar depois exige renomear bucket (não é possível) e repo | `README.md` §Identificação + nome do repositório no GitHub |
| D2 | **Região AWS** | `us-east-1` (salvo confirmação contrária no lab) | o Learner Lab normalmente trava a conta em `us-east-1`; região errada dá `AccessDenied`/`UnauthorizedOperation` em tudo (`docs/02` §5) | `README.md`, `~/.aws/config`, script de sessão (§5), bloco `backend` (§7) |
| D3 | **Quem opera o lab** | 1 operador principal + 1 suplente; os outros consomem o resultado | credencial de sessão não se compartilha e dois `apply` simultâneos disputam o lock; "quem clica em Start Lab" precisa ser uma pessoa por vez | `README.md` §Equipe e papéis + colaboradores no GitHub |
| D4 | **Conta GitHub e admin** | 1 conta pessoal como owner; demais como colaboradores (criar organização só se o professor exigir) | secrets e Actions ficam na conta owner; migrar depois para org é fácil, o inverso não | GitHub → Settings → Collaborators + `README.md` |
| D5 | **Visibilidade do repositório** | **privado** | um `.pem` ou state commitado por acidente em repo público é indexado em minutos; ver §6.6 | GitHub → Settings → General → Danger Zone |
| D6 | **Infisical: SaaS ou self-hosted** | **SaaS free**, e só quando existir segredo de aplicação | self-hosted = um servidor para manter, com TLS e backup, para guardar poucos valores; o SaaS free resolve o requisito 3.4 do edital sem operação | `README.md` §Segredos (preenchido no Passo 8) |
| D7 | **Backend do state** | S3 + `use_lockfile` (Terraform ≥ 1.10) — decisão copiada de `docs/02` §7.3 | é o que o `docs/02` recomenda; sem DynamoDB para criar e sem lock manual | bloco `backend` em `infra/` (§7) |
| D8 | **Arquitetura do projeto** | seguir a opção recomendada em `docs/01-analise-requisitos-e-arquitetura.md` (e aguardar o aval do professor) | a arquitetura e o custo de cada escolha estão lá; inventar outra aqui criaria recurso ocioso e retrabalho | `docs/01-analise-requisitos-e-arquitetura.md` + `README.md` |
| D9 | **Orçamento e rotina de destruição** | `terraform destroy` no fim de **toda** sessão de trabalho + conferir custo no painel do Vocareum; não existe alarme de budget para o aluno (`docs/02` §9 R9) | o inimigo do crédito é recurso ocioso (ALB, NAT, RDS, EBS), não o compute | `README.md` §Custo + calendário/checklist do grupo |
| D10 | **Rota da chave SSH** | Rota B (`ssh-keygen` + `ImportKeyPair`), com Rota A como plano B | privada nunca sai da máquina; detalhes e trade-off em §4.10 | `README.md` §Acesso |
| D11 | **Rota do Docker** | Rota A (Docker Desktop com integração WSL) | já está instalado e funcionando; Rota B só se a integração falhar (§3.7) | `README.md` §Ambiente |

> **Duas dessas decisões são irreversíveis na prática:** o nome do bucket de state (S3 não
> renomeia) e o nome/slug do projeto (aparece em URL, tags e nomes de recursos). Decida-as
> hoje e escreva-as antes de rodar o primeiro comando do Passo 6.

> **D8 é um bloqueio consciente.** Nenhum recurso da arquitetura de `docs/01` é criado antes
> do aval do professor. Tudo o que este guia faz — bucket de state, chave, repositório, secrets
> — é **infraestrutura de apoio**, não arquitetura, e não gera custo ocioso.

---

## 2. Passo 1 — primeira sessão no lab AWS

### 2.1 Antes de clicar em Start Lab

1. Tenha a **AWS CLI já instalada** (Passo 2). O teste de identidade deste passo é um
   comando de CLI — sem ele, você fica no escuro.
2. Feche o que consome crédito: nada deve estar ligado de uma sessão anterior
   (`docs/02` §2.4 — "End Lab" corta o acesso, **não** desliga recursos).
3. Anote o horário de início. A sessão dura ~4 h `[confiança: média — confirmar]`
   (`docs/02` §2.4).

### 2.2 Start Lab e o círculo verde

1. Entre no Vocareum do curso pelo link do professor.
2. No card **AWS**, clique em **Start Lab**.
3. O círculo ao lado de "AWS" fica **verde** quando o laboratório está pronto. Enquanto
   estiver amarelo/vermelho, as credenciais **não existem ainda**.
4. O console AWS abre em outra aba quando o círculo fica verde.

### 2.3 AWS Details: copiar as três credenciais

1. Clique em **AWS Details**.
2. No bloco **AWS CLI**, clique em **Show**.
3. Aparece um bloco `[default]` com três linhas. Copie as **três juntas, na mesma leitura**
   (`docs/02` §2.5: misturar valores de leituras diferentes gera
   "The security token included in the request is invalid"):

```text
[default]
aws_access_key_id=ASIA...
aws_secret_access_key=...
aws_session_token=...
```

4. Não cole em chat, issue, print, gravação de tela ou arquivo versionado. O destino é o
   script de sessão do Passo 4.
5. **Sanidade de 2 segundos:** o access key id começa com `ASIA`. Se começar com `AKIA`,
   você está em outro cenário (usuário IAM de longa duração) — pare e leia `docs/02` §1.

### 2.4 Primeira verificação

Com as três variáveis exportadas (§5.2) ou coladas no terminal da sessão:

```bash
aws sts get-caller-identity
```

**Saída esperada (formato):**

```text
{
    "UserId": "AROA<...>:<nome-da-sessao>",
    "Account": "<CONTA_DE_12_DIGITOS>",
    "Arn": "arn:aws:sts::<CONTA>:assumed-role/voclabs/<nome-da-sessao>"
}
```

O que importa: o ARN contém `assumed-role/voclabs/`. Se contiver `:user/`, você está no
Cenário B (`docs/02` §1) e o resto do guia precisa de ajuste — avise o professor antes de
seguir.

Forma curta, para usar em script:

```bash
aws sts get-caller-identity --query Arn --output text
```

**Saída esperada (formato):** `arn:aws:sts::<CONTA>:assumed-role/voclabs/<sessao>`

### 2.5 Se o círculo não ficar verde

Na ordem, sem pular:

| # | Ação | Comentário |
| --- | --- | --- |
| 1 | Espere 1–3 min e recarregue a página do Vocareum | provisionar a sessão não é instantâneo |
| 2 | Desative bloqueador de anúncios e extensões de privacidade para `vocareum.com` e `aws.amazon.com`; permita pop-ups e cookies de terceiros | é a causa mais comum de "nada acontece" |
| 3 | Tente uma janela anônima ou outro navegador (Edge/Chrome/Firefox) | descarta cache/extensão |
| 4 | Confira se o **seu** acesso ao curso está ativo (matrícula/link correto) | link antigo abre painel sem o card AWS |
| 5 | **Não** clique em Start Lab repetidamente | enfileira sessões e trava a UI |
| 6 | Se persistir por mais de ~10 min, **End Lab** (se o botão existir) e **Start Lab** de novo | reinicia a emissão de credenciais |
| 7 | Ainda assim: pare e contate o professor com print da tela e horário | é problema de conta, não do seu terminal |

### 2.6 Reemitir credenciais

- Enquanto o lab está ativo, **AWS Details → Show** de novo entrega as três credenciais
  (`docs/02` §2.4). Não é preciso reiniciar o lab.
- A reemissão pode devolver os mesmos valores ou valores novos. Copie sempre **os três da
  mesma leitura** e trate como se fossem novos: atualize o script de sessão (§5).
- Recursos criados **permanecem**; só o acesso muda.
- Se o painel passar a mostrar chave nova e você colar o token antigo, o sintoma é
  `InvalidClientTokenId` (`docs/02` §2.5).

> **Critério de verificação do Passo 1:** `aws sts get-caller-identity --query Arn --output
> text` imprime um ARN com `assumed-role/voclabs/` **e** o comando não retorna erro.

---

## 3. Passo 2 — instalar e verificar a toolchain dentro do WSL/Ubuntu

Tudo aqui roda no **WSL**, não no PowerShell. A exceção é o comando `wsl` do §3.0, que roda
no PowerShell.

> **Atalho: existe um script que faz §§3.1–3.5 com verificação no fim.**
> Dentro do Ubuntu, na raiz do repositório:
> ```bash
> bash scripts/install-toolchain-wsl.sh
> # ou, se quiser o Ansible junto (opcional, §3.5):
> bash scripts/install-toolchain-wsl.sh --with-ansible
> ```
> Ele instala AWS CLI v2 (zip oficial) e Terraform (apt da HashiCorp, com *fallback* para o
> zip oficial), e **falha com `exit 1`** se o Terraform ficar abaixo de 1.10. O texto abaixo
> continua sendo a referência de cada comando, do porquê e da saída esperada — útil se o
> script parar no meio e você precisar entender em qual passo.
>
> Se preferir trabalhar com PowerShell nativo em vez do WSL, o equivalente Windows é
> `pwsh -ExecutionPolicy Bypass -File .\scripts\install-toolchain-windows.ps1` (usa `winget`;
> **não** use `choco install terraform`, o Chocolatey não está instalado nesta máquina — §3.6).

### 3.0 Conferir o WSL

> **Onde o repositório aparece dentro do Ubuntu.** O projeto está em
> `C:\Users\Lima02\Documents\bcc\cloud` **no Windows**. O WSL não copia nada: ele monta o
> disco C: em `/mnt/c`. Então, dentro do Ubuntu, o mesmo diretório é
> **`/mnt/c/Users/Lima02/Documents/bcc/cloud`**. Um `bash scripts/install-toolchain-wsl.sh`
> rodado de `~` (ou de `/`) falha com `No such file or directory` — o script está lá, mas não
> naquele diretório. Sempre entre na pasta do projeto primeiro:
>
> ```bash
> cd /mnt/c/Users/Lima02/Documents/bcc/cloud   # ou: cd "$(wslpath 'C:\Users\Lima02\Documents\bcc\cloud')"
> pwd && ls        # precisa mostrar docs/ e scripts/
> bash scripts/install-toolchain-wsl.sh
> ```
>
> Para não digitar isso sempre, crie um atalho uma única vez:
>
> ```bash
> echo 'export PROJ=/mnt/c/Users/Lima02/Documents/bcc/cloud' >> ~/.bashrc
> source ~/.bashrc
> cd "$PROJ"
> ```

```powershell
wsl -l -v
```

**Saída esperada (formato):**

```text
  NAME      STATE           VERSION
* Ubuntu    Running         2
```

`VERSION` tem que ser `2`. Depois, entre no Ubuntu (`wsl` no PowerShell, ou pelo Windows
Terminal) e confira a distro:

```bash
lsb_release -a
uname -m
```

**Saída esperada (formato):**

```text
Distributor ID: Ubuntu
Description:    Ubuntu 24.04.x LTS
Release:        24.04
Codename:       noble
```

`uname -m` imprime `x86_64` (ou `aarch64` em máquina ARM — os downloads abaixo têm variante
para isso).

### 3.1 Base do sistema

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl wget unzip gnupg lsb-release ca-certificates \
                    jq make git python3 python3-venv python3-pip pipx netcat-openbsd
```

**Verificação:**

```bash
jq --version
make --version | head -n 1
git --version
node --version
pnpm --version
```

**Saída esperada (formato):**

```text
jq-1.7.1
GNU Make 4.3
git version 2.43.0
v22.11.0
9.15.0
```

Explicitando as versões mínimas:

| Ferramenta | Mínimo | Por quê |
| --- | --- | --- |
| `jq` | 1.6 | parsing de JSON nos scripts |
| `make` | 4.x | atalhos (`make plan`, `make destroy`) |
| `git` | 2.28 | `git init -b main` |
| `node` | 22 | runtime do backend (NestJS) e build do frontend |
| `pnpm` | versão do `packageManager` (12.21.0) | gerenciador de pacotes de `backend/` e `frontend/` — instalado pelo script abaixo, **não** pelo corepack |

> **Node 22 e pnpm são a toolchain da aplicação** (NestJS + TypeScript; ADR-007 em `docs/app/02-arquitetura.md`). O `scripts/install-toolchain-wsl.sh` **não** instala Node nem pnpm — ele cuida de AWS CLI, Terraform, tflint e Ansible. Para o Node use o script dedicado:
>
> ```bash
> bash scripts/setup-node-wsl.sh          # instala Node 22 (NodeSource) + pnpm da versão fixada
> bash scripts/setup-node-wsl.sh --check  # só diagnostica
> ```
>
> **Atalho que morde (duas vezes):**
>
> 1. Se você já usou Node/corepack no **Windows**, o WSL herda `/mnt/c/.../corepack-shims` no
>    PATH. O `pnpm` desse caminho é um shim que chama um `node` que não existe no Linux, e o
>    sintoma é `pnpm: 11: exec: node: not found`.
> 2. Se você tentar resolver com `sudo corepack enable && sudo corepack prepare pnpm@X
>    --activate`, o "default" fica no `COREPACK_HOME` do **root**; o shim do seu usuário não o
>    vê, baixa o pnpm **mais recente** e o install aborta com
>    `ERR_PNPM_BAD_PM_VERSION` (o projeto fixa a versão em `packageManager`).
>
> O `scripts/setup-node-wsl.sh` trata os dois: desabilita os shims do corepack e instala via
> `npm i -g pnpm@<versão do packageManager>`. Confira com `command -v node` (precisa começar
> com `/usr/`) e `pnpm -v` (precisa ser **12.21.0**, igual ao `packageManager`).
>
> O `python3`/`pipx` que continuam na lista do `apt` servem apenas à rota opcional do Ansible (§3.5).

> **Atenção — armadilha real:** o Git **do WSL** e o Git **do Windows** têm configurações
> separadas. Sua identidade já está configurada no Windows e **não** vale aqui. Configure no
> WSL também (é o Git que vai commitar o projeto):

```bash
git config --global user.name  'Emanuel Rodrigues'
git config --global user.email 'emanuelrodrigues112358@gmail.com'
git config --global init.defaultBranch main
git config --global core.autocrlf false
git config --list --show-origin | grep -E 'user\.|init\.|autocrlf'
```

**Saída esperada (formato):**

```text
file:/home/<usuario>/.gitconfig	user.name=Emanuel Rodrigues
file:/home/<usuario>/.gitconfig	user.email=emanuelrodrigues112358@gmail.com
file:/home/<usuario>/.gitconfig	init.defaultbranch=main
file:/home/<usuario>/.gitconfig	core.autocrlf=false
```

### 3.2 AWS CLI v2

Não use `apt install awscli` (instala a v1, em fim de vida). Instale a v2 oficial:

```bash
curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip   # [confirmar versão no momento da instalação]
unzip -q /tmp/awscliv2.zip -d /tmp
sudo /tmp/aws/install
```

Em máquina ARM (`uname -m` = `aarch64`), troque `x86_64` por `aarch64` na URL.

**Verificação:**

```bash
aws --version
```

**Saída esperada (formato):**

```text
aws-cli/2.x.y Python/3.x.y Linux/x.y.z-<...> exe/x86_64.ubuntu.24
```

O primeiro campo tem que começar com `aws-cli/2.` — se começar com `aws-cli/1.`, remova o
pacote do apt antes de seguir (`sudo apt remove -y awscli`).

**Atualizar depois:** repita o mesmo download e rode `sudo /tmp/aws/install --update`.

### 3.3 Terraform

Repositório oficial da HashiCorp (permite `apt upgrade` depois):

```bash
wget -O- https://apt.releases.hashicorp.com/gpg \
  | sudo gpg --dearmor -o /usr/share/keyrings/hashicorp-archive-keyring.gpg

echo "deb [signed-by=/usr/share/keyrings/hashicorp-archive-keyring.gpg] https://apt.releases.hashicorp.com $(lsb_release -cs) main" \
  | sudo tee /etc/apt/sources.list.d/hashicorp.list

sudo apt update && sudo apt install -y terraform    # [confirmar versão no momento da instalação]
```

**Verificação:**

```bash
terraform version
```

**Saída esperada (formato):**

```text
Terraform v1.x.y
on linux_amd64
```

**Requisito duro: `v1.10` ou maior.** Abaixo disso, `use_lockfile` não existe e o backend do
Passo 6 não funciona (`docs/02` §7.3). Confira em uma linha:

```bash
terraform version -json | jq -r '.terraform_version' | cut -d. -f2
```

**Saída esperada (formato):** um número ≥ `10`.

**Fixar a versão (recomendado para reprodutibilidade).** Se preferir um binário exato em vez
do apt:

```bash
VERSAO='1.10.5'   # [confirmar versão no momento da instalação]
curl -fsSL -o /tmp/terraform.zip "https://releases.hashicorp.com/terraform/${VERSAO}/terraform_${VERSAO}_linux_amd64.zip"
mkdir -p ~/.local/bin && unzip -o /tmp/terraform.zip -d ~/.local/bin
terraform version
```

Anote a versão escolhida no `README.md` e use **a mesma** no CI — provider baixado em versão
diferente do CI é uma das armadilhas listadas em `docs/02` §7.4.

### 3.4 tflint (opcional, mas barato)

```bash
curl -fsSL -o /tmp/tflint.zip "https://github.com/terraform-linters/tflint/releases/latest/download/tflint_linux_amd64.zip"   # [confirmar versão no momento da instalação]
mkdir -p ~/.local/bin && unzip -o /tmp/tflint.zip -d ~/.local/bin
```

**Verificação:**

```bash
tflint --version
```

**Saída esperada (formato):** `TFLint version 0.x.y` seguido de `+ ruleset ...` quando houver
plugin.

Garanta `~/.local/bin` no `PATH` (§5.2). Sem isso, `tflint: command not found`.

### 3.5 Ansible — **opcional neste projeto**

> **Leia antes de instalar.** O Ansible é uma das ferramentas que o edital lista como
> *possibilidade*, não como exigência. A arquitetura recomendada em
> `docs/01-analise-requisitos-e-arquitetura.md` §6.4 o **descarta** com justificativa
> (`user_data` + Docker Compose versionado cobrem a configuração de um host único). Instale
> apenas se quiser ter a ferramenta disponível para experimentar ou se o professor pedir —
> nenhuma fase de `docs/04-plano-de-execucao.md` depende dele. O custo é só disco.

Rota simples (inclui as coleções da comunidade):

```bash
sudo apt install -y ansible      # [confirmar versão no momento da instalação]
```

Rota com versão pinada (só o core, sem coleções extra):

```bash
pipx install 'ansible-core==2.17.*'   # [confirmar versão no momento da instalação]
pipx ensurepath
```

**Verificação:**

```bash
ansible --version
ansible localhost -m ping -c local
```

**Saída esperada (formato):**

```text
ansible [core 2.x.y]
  config file = None
  python version = 3.12.x (main, ...) [GCC ...]
localhost | SUCCESS => {
    "changed": false,
    "ping": "pong"
}
```

O `ping` local é o único teste que não depende de rede, chave ou instância — é o que prova
que o Ansible está utilizável.

### 3.6 Resumo da toolchain

> **Por que não Chocolatey.** A página de instalação do Terraform sugere
> `choco install terraform`. Isso só funciona se o Chocolatey estiver instalado — e nesta
> máquina **não está** (`choco` não existe no `PATH`). Os gerenciadores disponíveis aqui são
> **winget** e **scoop**. Além disso, dentro do WSL o `choco` não existe por definição: lá o
> caminho é `apt` (é o que o script usa).
> Resumo: **WSL → `bash scripts/install-toolchain-wsl.sh`**; **Windows → `winget`**, via
> `scripts/install-toolchain-windows.ps1` (`Amazon.AWSCLI` + `Hashicorp.Terraform`).

| Ferramenta | Instalação (WSL) | Verificação | Mínimo |
| --- | --- | --- | --- |
| AWS CLI | download oficial v2 + `sudo ./aws/install` | `aws --version` | v2 |
| Terraform | repo apt da HashiCorp **ou** zip pinado | `terraform version` | **1.10** |
| tflint | zip do release para `~/.local/bin` | `tflint --version` | qualquer recente |
| Ansible | `apt install ansible` ou `pipx install ansible-core` | `ansible --version` | core 2.14 |
| jq | `apt install jq` | `jq --version` | 1.6 |
| make | `apt install make` (via base) | `make --version` | 4.x |
| git | `apt install git` | `git --version` | 2.28 |
| node / pnpm | Node 22 já no ambiente; `corepack enable` habilita o pnpm | `node --version`, `pnpm --version` | 22 / — |
| Docker | Rota A ou B (§3.7) | `docker run --rm hello-world` | 24+ / Compose v2 |

### 3.7 Docker — duas rotas

#### Rota A (recomendada): Docker Desktop com integração WSL

O daemon roda no Windows e o `docker` do Ubuntu fala com ele. **Passo a passo:**

1. Abra o Docker Desktop no Windows e espere o ícone ficar estável (não "starting").
2. **Settings → Resources → WSL Integration** → ative a chave geral **e** a chave da sua
   distro (`Ubuntu`) → **Apply & restart**.
3. No WSL, confirme que o contexto é o do Desktop e que o daemon responde.

```bash
docker context ls
docker version --format '{{.Client.Version}} / {{.Server.Version}}'
docker run --rm hello-world
docker compose version
```

**Saída esperada (formato):**

```text
NAME            DESCRIPTION                               DOCKER ENDPOINT
default         Current DOCKER_HOST based configuration   unix:///var/run/docker.sock
desktop-linux * Docker Desktop                            unix:///home/<usuario>/.docker/desktop/docker.sock
```

```text
27.x.y / 27.x.y
```

```text
Hello from Docker!
This message shows that your installation appears to be working correctly.
...
```

```text
Docker Compose version v2.x.y
```

Se `docker version` mostrar apenas a seção `Client` e um erro no `Server`, a integração não
está ativa — volte ao passo 2. **Nunca** use `docker-compose` (v1, descontinuado): use sempre
`docker compose` (plugin v2).

- **Trade-off:** um único daemon, imagens compartilhadas com o Windows, GUI para inspecionar
  containers, e é o que já está instalado. **Custo:** o Desktop precisa estar aberto; consome
  RAM do Windows; se o Desktop reiniciar, o `docker` do WSL cai junto.

#### Rota B (plano B): `docker-ce` nativo no Ubuntu

Só escolha esta rota se a integração da Rota A não funcionar. Duas coisas são obrigatórias:
`systemd` habilitado no WSL e **nenhuma** outra integração de Docker ativa para a distro.

```bash
# 1) systemd no WSL (uma vez)
sudo tee /etc/wsl.conf >/dev/null <<'EOF'
[boot]
systemd=true
EOF
```

No PowerShell, depois:

```powershell
wsl --shutdown
```

Reabra o Ubuntu e siga:

```bash
# 2) repositório oficial do Docker
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null

sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# 3) usar docker sem sudo
sudo usermod -aG docker "$USER"
```

Feche **todos** os terminais do WSL e abra de novo (o grupo novo só vale em sessão nova),
então:

```bash
systemctl is-active docker
docker run --rm hello-world
```

**Saída esperada (formato):** `active` e depois `Hello from Docker!`.

Se `systemctl` reclamar que o systemd não é o PID 1, o `/etc/wsl.conf` não foi lido: rode
`wsl --shutdown` no PowerShell e reabra. Alternativa sem systemd (menos confiável):
`sudo service docker start`.

- **Trade-off:** independente do Docker Desktop, mais leve, `systemctl` funciona. **Custo:**
  dois daemons na máquina se o Desktop também estiver com integração ligada (conflito de
  socket) e mais passos manuais para o grupo reproduzir.

> **Critério de verificação do Passo 2:** em **uma única** sessão de WSL, os cinco comandos
> abaixo rodam sem erro e cada um imprime a versão no formato esperado:
> `aws --version` (≥ 2), `terraform version` (≥ 1.10), `ansible --version`,
> `docker run --rm hello-world` (Hello from Docker!) e `git --version` (≥ 2.28).

---

## 4. Passo 3 — chave `.pem` / SSH

> **Antes de criar qualquer chave: você já tem uma.**
> O painel do Learner Lab (**AWS Details → SSH Key → Download**) entrega um arquivo
> **`labsuser.pem`**. Ele é a chave privada de um key pair que **já existe na conta** —
> normalmente chamado **`vockey`**. Se você baixou esse arquivo, **não precisa** das rotas A
> ou B abaixo: basta descobrir o nome do key pair e mover a chave para `~/.ssh`.
>
> ```bash
> # 1) qual key pair já existe na conta (esperado: vockey)
> aws ec2 describe-key-pairs --query 'KeyPairs[].KeyName' --output text
>
> # 2) mover a chave do Windows para o filesystem Linux, com permissão correta
> mkdir -p ~/.ssh && chmod 700 ~/.ssh
> mv /mnt/c/Users/Lima02/Downloads/labsuser.pem ~/.ssh/labsuser.pem
> chmod 400 ~/.ssh/labsuser.pem
> ls -l ~/.ssh/labsuser.pem          # esperado: -r-------- ... /home/<usuario>/.ssh/labsuser.pem
> ssh-keygen -y -f ~/.ssh/labsuser.pem > /dev/null && echo "chave valida"
> ```
>
> No Terraform, referencie o key pair **existente** pelo nome:
> `data "aws_key_pair" "lab" { key_name = "vockey" }`.
> Vantagem de usar a chave do lab: ela não é criada por você, então pode ser baixada de novo
> a qualquer momento pelo painel. **Nunca** commite o `.pem`.

### 4.1 O que a chave é (e o que o Terraform precisa)

Duas coisas distintas:

| O que | Onde vive | Quem usa |
| --- | --- | --- |
| o **par de chaves** na AWS (nome + chave pública) | na conta, por região | a instância EC2 |
| o arquivo **privado** (`.pem` ou `projeto2`) | `~/.ssh/` no **filesystem Linux** | você, no `ssh` |

O Terraform **não** guarda a chave: ele referencia o **nome** do key pair. Ou seja, a chave
tem que existir na conta **antes** do primeiro `apply`. As duas rotas e os trechos de
Terraform (`data "aws_key_pair"` vs `resource "aws_key_pair"`) estão em
`docs/02` §10.1 e §10.2 — não repita aqui, a decisão de qual usar está em §10.3.

### 4.2 Testar o que a conta permite (antes de escolher a rota)

Algumas contas do lab bloqueiam `ec2:CreateKeyPair`/`ImportKeyPair` (`docs/02` §3.1 item 2).
O teste é o item **K3** de `docs/02` §11 — rode-o na primeira sessão e **anote o resultado**
no `README.md`. Não desenhe nada em cima de uma rota que a conta recusa.

### 4.3 Rota B (recomendada) — gerar no WSL e importar a pública

```bash
# 1) gerar o par NO filesystem Linux (nunca em /mnt/c)
ssh-keygen -t ed25519 -f ~/.ssh/projeto2 -N '' -C 'projeto2@bcc-cloud'

# 2) permissões corretas
chmod 700 ~/.ssh
chmod 600 ~/.ssh/projeto2
chmod 644 ~/.ssh/projeto2.pub

# 3) conferir
ls -l ~/.ssh/projeto2*
```

**Saída esperada (formato):**

```text
-rw------- 1 <usuario> <usuario> 411 <data> /home/<usuario>/.ssh/projeto2
-rw-r--r-- 1 <usuario> <usuario> 100 <data> /home/<usuario>/.ssh/projeto2.pub
```

A privada com `-rw-------`. Se aparecer `-rwxrwxrwx`, você gerou em `/mnt/c` — refaça.

Importar a **pública** (console: **EC2 → Key pairs → Actions → Import key pair**, nome
`projeto2`, cole o conteúdo de `~/.ssh/projeto2.pub`). Ou pela CLI:

```bash
aws ec2 import-key-pair \
  --key-name projeto2 \
  --public-key-material fileb://$HOME/.ssh/projeto2.pub \
  --region us-east-1
```

**Verificação:**

```bash
aws ec2 describe-key-pairs --key-names projeto2 \
  --query 'KeyPairs[].[KeyName,KeyType,KeyFingerprint]' --output table
```

**Saída esperada (formato):**

```text
------------------------------------------------------------
|                     DescribeKeyPairs                     |
+----------+---------+-------------------------------------+
|  projeto2|  ed25519|  aa:bb:cc:...                       |
+----------+---------+-------------------------------------+
```

### 4.4 Rota A — criar no console e baixar o `.pem`

1. **EC2 → Key pairs → Create key pair**: nome `projeto2`, tipo **RSA**, formato **`.pem`**
   (Linux/WSL) → **Create**. O download acontece **uma única vez**; perdido o arquivo, não há
   como recuperá-lo (só criar outro key pair).
2. O arquivo cai em `C:\Users\Lima02\Downloads\projeto2.pem`. Traga para o Linux:

```bash
mkdir -p ~/.ssh
cp /mnt/c/Users/Lima02/Downloads/projeto2.pem ~/.ssh/projeto2.pem
chmod 400 ~/.ssh/projeto2.pem
ls -l ~/.ssh/projeto2.pem
```

**Saída esperada (formato):** `-r-------- 1 <usuario> <usuario> ... /home/<usuario>/.ssh/projeto2.pem`

3. Apague a cópia do Windows, para não ficar um `.pem` solto em `Downloads` (pasta que
   costuma estar sincronizada com OneDrive):

```bash
rm -f /mnt/c/Users/Lima02/Downloads/projeto2.pem
```

4. **Atalho pela CLI** (evita o `Downloads` por completo — a chave é escrita direto no
   filesystem Linux, mas a privada **não** pode ser recuperada depois):

```bash
aws ec2 create-key-pair --key-name projeto2 \
  --key-type rsa --key-format pem \
  --query 'KeyMaterial' --output text > ~/.ssh/projeto2.pem
chmod 400 ~/.ssh/projeto2.pem
```

Não misture as duas rotas no mesmo projeto: escolha **uma** e siga com ela. O nome `projeto2`
tem que ser único na conta — se já existir, `create-key-pair`
falha com `InvalidKeyPair.Duplicate` (a chave antiga continua válida).

### 4.5 Por que `chmod` em `/mnt/c` não funciona

O `/mnt/c` do WSL é um ponto de montagem **DrvFs**: quem manda nas permissões é o NTFS/Windows,
não o kernel Linux. Consequências:

- `chmod` em `/mnt/c/...` **não aplica** permissões Unix (retorna `Operation not permitted` ou
  simplesmente não muda nada), e o arquivo continua aparecendo como `-rwxrwxrwx` para o `ssh`.
- O `ssh` recusa usar uma chave privada legível por terceiros:

```text
@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
@         WARNING: UNPROTECTED PRIVATE KEY FILE!          @
@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
Permissions 0777 for '/mnt/c/Users/Lima02/Downloads/projeto2.pem' are too open.
```

- Existe a opção de montar `/mnt/c` com `metadata` (`/etc/wsl.conf`, `[automount] options =
  "metadata,umask=22"`), o que faz o `chmod` "pegar". **Não faça isso**: cria efeitos
  colaterais em todos os arquivos do Windows vistos pelo WSL. A solução correta e definitiva
  é **mover a chave para `~/.ssh`**, que é ext4 e respeita permissões.
- A mesma regra vale para scripts com bit de execução: em `/mnt/c` o bit `+x` é instável. Por
  isso scripts executáveis ficam em `~/.local/bin` (Passo 4) ou são chamados como
  `bash scripts/foo.sh`.

### 4.6 `~/.ssh/config`

Digitar `-i ~/.ssh/projeto2 ubuntu@<ip>` a cada vez é onde os erros nascem. Crie um atalho:

```bash
cat >> ~/.ssh/config <<'EOF'

Host proj2
    HostName <IP_PUBLICO_DA_INSTANCIA>
    User ubuntu
    IdentityFile ~/.ssh/projeto2
    IdentitiesOnly yes
    ServerAliveInterval 30
    ServerAliveCountMax 3
EOF

chmod 600 ~/.ssh/config
```

Regras:

- **`User` depende da AMI**, não do seu gosto: `ubuntu` (Ubuntu), `ec2-user` (Amazon Linux),
  `admin` (Debian), `centos` (CentOS). `Permission denied (publickey)` com a chave certa
  quase sempre é usuário errado.
- **`IdentitiesOnly yes`** impede o `ssh` de oferecer todas as chaves do agente e ser
  rejeitado por excesso de tentativas (`Too many authentication failures`).
- O `HostName` muda quando a instância é **recriada** (ou parada e iniciada **sem** Elastic
  IP). Para descobrir o IP atual:

```bash
aws ec2 describe-instances \
  --filters "Name=tag:Name,Values=proj2-teste" "Name=instance-state-name,Values=running" \
  --query 'Reservations[].Instances[].[InstanceId,PublicIpAddress]' --output table
```

**Saída esperada (formato):** tabela com `i-0123...` e o IP público em cada linha.

### 4.7 Teste de conexão real

```bash
ssh -i ~/.ssh/projeto2 ubuntu@<IP_PUBLICO>
```

**Saída esperada (formato):**

```text
The authenticity of host '<IP>' can't be established.
ED25519 key fingerprint is SHA256:....
Are you sure you want to continue connecting (yes/no/[fingerprint])? yes
Welcome to Ubuntu 24.04.x LTS (GNU/Linux ...)
...
ubuntu@ip-172-31-x-x:~$
```

Primeira conexão pede confirmação da fingerprint (`yes`) — normal em instância nova. Depois
do `~/.ssh/config`, o mesmo teste fica:

```bash
ssh proj2
ssh proj2 'echo ok'
```

**Saída esperada (formato):** `ok`

Para depurar, `ssh -vvv proj2` mostra qual arquivo de identidade foi oferecido e o motivo da
recusa.

> **Instância de teste.** O teste acima é a razão de existir uma instância mínima
> (`t3.micro`, Ubuntu) **apenas** para validar chave + security group. Ela não faz parte da
> arquitetura e deve ser **terminada** ao fim do teste (§10). Não confunda isso com "criar
> recursos de arquitetura antes da aprovação" — isso continua proibido.

### 4.8 `ssh-agent` / `ssh-add`

O agente guarda a chave descriptografada na memória da sessão: útil quando a chave tiver
passphrase e quando você abre várias conexões.

```bash
eval "$(ssh-agent -s)"
ssh-add ~/.ssh/projeto2
ssh-add -l
```

**Saída esperada (formato):** `Agent pid <n>` e depois uma linha com a fingerprint
`ED25519 SHA256:... /home/<usuario>/.ssh/projeto2 (ED25519)`.

Notas: o agente morre quando o terminal fecha (ou o WSL reinicia) — refaça o `eval` a cada
sessão. Se aparecer `Could not open a connection to your authentication agent`, você esqueceu
o `eval`. Com o agente carregado, `ssh proj2` funciona até sem `IdentityFile` no config, mas
**mantenha** o `IdentityFile` para não depender do agente no CI.

### 4.9 A porta 22 não responde

Na ordem de probabilidade:

| Sintoma | Causa provável | Como confirmar / corrigir |
| --- | --- | --- |
| `Connection timed out` | security group sem regra de entrada na 22, ou instância sem IP público | console → **Security Groups** → Inbound rules → `SSH / TCP / 22 / <seu-IP>/32`; confirmar que a instância tem **Public IPv4 address** e está na VPC/subnet com rota para o Internet Gateway |
| `Connection timed out` mesmo com regra | Network ACL da subnet bloqueando, ou firewall/VPN do campus | testar a mesma conexão do PowerShell do Windows e de outra rede (ex.: 4G) |
| `Connection refused` | instância ligada, mas o `sshd` ainda não subiu (ou está parado) | espere 60–90 s após o boot; verifique pelo console (EC2 → Connect → EC2 Instance Connect, se disponível) |
| `Permission denied (publickey)` | usuário errado (`ubuntu` vs `ec2-user`) ou chave que não é a do key pair | `ssh -v proj2` mostra o usuário e a identidade oferecida; `describe-key-pairs` mostra a fingerprint |
| `UNPROTECTED PRIVATE KEY FILE` | chave em `/mnt/c` ou permissão `644+` | §4.5: mover para `~/.ssh` e `chmod 400` |
| `Host key verification failed` | IP reciclado por outra instância | `ssh-keygen -R <IP>` e conecte de novo |
| `Network is unreachable` (só no WSL) | WSL sem rota de saída | testar do PowerShell; `wsl --shutdown` e reabrir |

Teste rápido de porta, sem `ssh` (diagnóstico puro de rede):

```bash
nc -vz <IP_PUBLICO> 22
```

**Saída esperada (formato):** `Connection to <IP> 22 port [tcp/ssh] succeeded!`

Se `nc` falhar mas o `ssh` do PowerShell funcionar, o problema é de rede do WSL, não do lab.

> **Regra de segurança (não relaxe na demo):** nunca deixe a 22 aberta para `0.0.0.0/0`. Use
> "My IP" no console. Se o seu IP muda muito, crie uma segunda regra temporária e **apague**
> depois da aula, em vez de abrir para o mundo. E `0.0.0.0/0` na 22 é item fácil de perder
> ponto em "segurança" (5% do edital) por um detalhe de configuração.

### 4.10 Qual rota eu recomendo, e por quê

**Rota B (`ssh-keygen` + `ImportKeyPair`).** Motivos, em ordem:

1. **A privada nunca transita por um caminho inseguro.** Na Rota A ela passa por
   `Downloads` (frequentemente sincronizado com OneDrive) e por um download que não pode ser
   repetido. Na Rota B ela nasce em `~/.ssh` com `600`, no filesystem certo, e não existe
   cópia em lugar nenhum.
2. **Some o passo que mais dá erro** — copiar de `/mnt/c` e `chmod` (o R10 de `docs/02` §9).
3. **É reimportável.** Se a conta for resetada, você regenera a `.pub` a partir da privada
   (`ssh-keygen -y -f ~/.ssh/projeto2 > ~/.ssh/projeto2.pub`) e importa de novo em 10 s. Na
   Rota A, chave perdida = key pair novo + instâncias recriadas.
4. **ed25519** é menor, mais rápido e suportado por todas as AMIs Ubuntu atuais.

**Quando usar a Rota A:** se `ec2:ImportKeyPair` vier `AccessDenied` no teste K3, ou se você
precisar de um `.pem` RSA para alguma ferramenta que não aceite ed25519. Nesse caso a Rota A
com o download direto pela CLI (§4.4 item 4) é a versão menos arriscada dela.

**O que não fazer:** reaproveitar essa mesma chave como chave SSH do GitHub (§8) ou
distribuir a privada para o grupo. Chave de lab é descartável e de uma pessoa.

> **Critério de verificação do Passo 3:** `ssh proj2 'echo ok'` imprime `ok`, sem pedir
> senha, **e** `aws ec2 describe-key-pairs --key-names projeto2` lista a chave com o tipo
> esperado.

---

## 5. Passo 4 — credenciais no dia a dia

### 5.1 Os arquivos `~/.aws`

```bash
mkdir -p ~/.aws
chmod 700 ~/.aws
```

`~/.aws/config` — configuração estável (não tem segredo; pode ficar assim):

```ini
[default]
region = us-east-1
output = json
```

`~/.aws/credentials` — **só** se você escolher a rota "arquivo" em vez da rota "variáveis de
ambiente":

```ini
[default]
aws_access_key_id     = <AWS_ACCESS_KEY_ID>
aws_secret_access_key = <AWS_SECRET_ACCESS_KEY>
aws_session_token     = <AWS_SESSION_TOKEN>
```

```bash
chmod 600 ~/.aws/config
chmod 600 ~/.aws/credentials
ls -l ~/.aws
```

**Saída esperada (formato):**

```text
-rw------- 1 <usuario> <usuario> ... credentials
-rw------- 1 <usuario> <usuario> ... config
```

**Rota recomendada: variáveis de ambiente** (§5.2). Motivos: é a precedência que o Terraform
e o CLI usam primeiro (`docs/02` §7.1), não deixa token velho em disco e não corre o risco de
"arquivo atualizado, terminal antigo". A precedência completa está em `docs/02` §7.1 — não
repita.

> **Não misture as duas rotas.** Se o arquivo tiver um token vencido e as variáveis tiverem o
> token novo, funciona; no dia em que você esquecer o `export`, o arquivo velho assume e você
> perde 20 min diagnosticando `ExpiredToken`. Escolha uma. Se usar variáveis, **apague** o
> bloco `[default]` do `credentials` (ou o arquivo inteiro).

### 5.2 O script de sessão (bash)

```bash
mkdir -p ~/.local/bin
```

Crie `~/.local/bin/academy-env`:

> **Atalho (recomendado):** o modelo já está versionado no repositório — copie em vez de
> digitar, e edite só as 3 linhas:
> ```bash
> mkdir -p ~/.local/bin
> cp scripts/academy-env.example ~/.local/bin/academy-env
> chmod 700 ~/.local/bin/academy-env
> nano ~/.local/bin/academy-env    # colar as 3 credenciais
> source ~/.local/bin/academy-env
> ```
> O conteúdo abaixo é o mesmo arquivo, mantido aqui como referência.

```bash
#!/usr/bin/env bash
# ~/.local/bin/academy-env
#
# Uso:
#   1. Start Lab -> AWS Details -> AWS CLI: Show -> copie os TRÊS valores
#   2. edite apenas as 3 linhas marcadas abaixo
#   3. source ~/.local/bin/academy-env
#
# Atenção: este arquivo é carregado com `source`. Não use `set -e`/`exit` aqui,
# senão a sua shell morre junto.

# ---- EDITAR A CADA SESSÃO DE LAB (3 linhas) ----
export AWS_ACCESS_KEY_ID='<AWS_ACCESS_KEY_ID>'
export AWS_SECRET_ACCESS_KEY='<AWS_SECRET_ACCESS_KEY>'
export AWS_SESSION_TOKEN='<AWS_SESSION_TOKEN>'
# ---- daqui para baixo não muda ----

export AWS_DEFAULT_REGION='us-east-1'
export AWS_REGION='us-east-1'
export TF_STATE_BUCKET='bcc-cloud-tfstate-<SUFIXO>'

# Verifica a identidade e explica a falha em português.
academy_whoami() {
    local arn
    if ! arn=$(aws sts get-caller-identity --query Arn --output text 2>/tmp/academy_whoami.err); then
        echo "FALHA: credenciais inválidas ou expiradas."
        sed -n '1,3p' /tmp/academy_whoami.err
        echo "Ação: Start Lab -> AWS Details -> copie os 3 valores ->"
        echo "      edite ~/.local/bin/academy-env -> source de novo."
        return 1
    fi
    case "$arn" in
        *:assumed-role/*) echo "OK: sessão de laboratório ativa." ;;
        *)                echo "ATENÇÃO: ARN não é de sessão de lab (Cenário B?)." ;;
    esac
    echo "  ARN:     $arn"
    echo "  região:  ${AWS_DEFAULT_REGION:-<não definida>}"
    echo "  bucket:  ${TF_STATE_BUCKET:-<não definido>}"
}

# conferência automática ao carregar (apague esta linha se não quiser o custo de 1 chamada STS)
academy_whoami
```

Permissão e uso:

```bash
chmod 700 ~/.local/bin/academy-env
ls -l ~/.local/bin/academy-env
source ~/.local/bin/academy-env
```

**Saída esperada (formato):**

```text
-rwx------ 1 <usuario> <usuario> ... /home/<usuario>/.local/bin/academy-env
OK: sessão de laboratório ativa.
  ARN:     arn:aws:sts::<CONTA>:assumed-role/voclabs/<sessao>
  região:  us-east-1
  bucket:  bcc-cloud-tfstate-<sufixo>
```

Por que `chmod 700` e não `chmod +x`: o arquivo contém credenciais vivas. `+x` respeita o
umask e pode deixar o arquivo legível por outros usuários da máquina; `700` garante
dono-leitura-execução e mais nada. `chmod +x` isolado **funciona**, mas `700` é o certo.

Garanta `~/.local/bin` no `PATH` (uma vez):

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
command -v academy-env
```

**Saída esperada (formato):** `/home/<usuario>/.local/bin/academy-env`

Depois disso, a rotina de início de sessão é: **Start Lab → AWS Details → editar 3 linhas →
`source academy-env`**. Se `academy_whoami` imprimir `OK`, está pronto.

### 5.3 Versão PowerShell (Windows nativo)

Para quem preferir rodar a AWS CLI no Windows (o Terraform do guia continua no WSL).

```powershell
# 1) criar o perfil do PowerShell, se ainda não existir
if (-not (Test-Path $PROFILE)) { New-Item -ItemType File -Path $PROFILE -Force | Out-Null }
notepad $PROFILE
```

Cole no arquivo que abriu:

```powershell
function Test-AcademyWhoami {
    $arn = aws sts get-caller-identity --query Arn --output text 2>$null
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($arn)) {
        Write-Host 'FALHA: credenciais inválidas ou expiradas. Reemita em AWS Details.' -ForegroundColor Red
        return
    }
    Write-Host "OK: sessão ativa - $arn" -ForegroundColor Green
    Write-Host "  região: $env:AWS_DEFAULT_REGION"
}

function Set-AcademyEnv {
    # EDITE AS 3 LINHAS ABAIXO A CADA SESSÃO
    $env:AWS_ACCESS_KEY_ID     = '<AWS_ACCESS_KEY_ID>'
    $env:AWS_SECRET_ACCESS_KEY = '<AWS_SECRET_ACCESS_KEY>'
    $env:AWS_SESSION_TOKEN     = '<AWS_SESSION_TOKEN>'

    $env:AWS_DEFAULT_REGION    = 'us-east-1'
    $env:AWS_REGION            = 'us-east-1'
    $env:TF_STATE_BUCKET       = 'bcc-cloud-tfstate-<SUFIXO>'
    Test-AcademyWhoami
}
```

Uso: abra um PowerShell **novo**, edite o perfil (`notepad $PROFILE`) e carregue:

```powershell
. $PROFILE
Set-AcademyEnv
```

**Saída esperada (formato):** `OK: sessão ativa - arn:aws:sts::<CONTA>:assumed-role/voclabs/<sessao>`

`$env:` vale só para a janela atual: cada janela nova precisa de `Set-AcademyEnv` de novo. E
`$env:` **não** atravessa para o WSL (o Ubuntu é outro processo) — quem roda Terraform no WSL
usa o script bash.

### 5.4 Regras de segurança (valem para o resto do projeto)

1. **Nunca commitar.** O `.gitignore` do Passo 6 cobre `*.pem`, `.env` e `.aws/`, mas o
   `academy-env` mora em `~/.local/bin` **de propósito**, fora do repositório.
2. **Nunca colar** em chat, issue, PR, print de tela, vídeo de demo ou log. Em demo, pare a
   gravação antes de abrir o AWS Details.
3. **Nunca passar por `-var`, `TF_VAR_*` ou `env:` inline no YAML** — aparece no
   `terraform plan` e no log do Actions (`docs/02` §2.7 e §8.5).
4. **Prefira editar o arquivo a digitar `export ...` na linha de comando**: o que você digita
   vai para `~/.bash_history`.
5. **Vazou? Considere vazada.** Reemita em AWS Details e atualize o script
   (`docs/02` §2.7). O token morre no fim da sessão, mas a lição fica.
6. **Fim de sessão:** feche o terminal (as variáveis morrem junto) e clique em **End Lab**.
   Não é preciso "apagar" nada do `academy-env`; ele será sobrescrito na próxima sessão.

> **Critério de verificação do Passo 4:** em um terminal **novo**, `source ~/.local/bin/academy-env`
> imprime `OK: sessão de laboratório ativa.` com o ARN `assumed-role/voclabs/...`; em um
> segundo terminal novo, sem `source`, `aws sts get-caller-identity` falha — o que prova que
> a credencial é de sessão e que a rotina funciona.

---

## 6. Passo 5 — bootstrap do repositório Git

### 6.1 Onde o repositório vive

Duas opções, com consequências diferentes:

| Opção | Caminho | Prós | Contras |
| --- | --- | --- | --- |
| **A (recomendada)** | `/mnt/c/Users/Lima02/Documents/bcc/cloud` | uma cópia só; a pasta já é a pasta de trabalho e já tem `docs/` | `chmod`/bit de execução não valem (DrvFs); `git` e `terraform init` mais lentos |
| B | `~/cloud` (ext4) | permissões e bit de execução nativos; rápido | duas cópias: a pasta do Windows fica desatualizada, ou você abandona a original |

Fique na **opção A** e neutralize os contras:

- arquivos que **precisam** de `chmod` (chave `.pem`, `academy-env`) moram em `~/.ssh` e
  `~/.local/bin` — já é o desenho dos Passos 3 e 4;
- o bit de execução de scripts do repo: rode scripts como `bash scripts/foo.sh` ou, se o CI
  precisar do bit, `git update-index --chmod=+x scripts/foo.sh`;
- `terraform init` lento: aponte o cache de providers para o ext4 (§7.4).

Se o Git reclamar de "dubious ownership" por causa do DrvFs:

```bash
git config --global --add safe.directory /mnt/c/Users/Lima02/Documents/bcc/cloud
```

### 6.2 `git init`

```bash
cd /mnt/c/Users/Lima02/Documents/bcc/cloud
git init -b main
git status
```

**Saída esperada (formato):**

```text
Initialized empty Git repository in /mnt/c/Users/Lima02/Documents/bcc/cloud/.git/
On branch main

No commits yet

Untracked files:
  (use "git add <file>..." to include in what will be committed)
	docs/
	...
```

Confirme que a identidade é a certa **neste** repositório (a do Windows não vale no WSL —
§3.1):

```bash
git config user.name
git config user.email
```

**Saída esperada (formato):** `Emanuel Rodrigues` e `emanuelrodrigues112358@gmail.com`.

### 6.3 `.gitignore`

**Antes do primeiro commit.** Crie `.gitignore` na raiz:

```gitignore
# ---------- Terraform ----------
.terraform/
.terraform.*/
*.tfstate
*.tfstate.*
*.tfstate.backup
*.tfplan
crash.log
crash.*.log
override.tf
override.tf.json
*_override.tf
*_override.tf.json
.terraformrc
terraform.rc
# NÃO ignore .terraform.lock.hcl: é ele que pina as versões dos providers.

# ---------- Segredos, chaves e credenciais ----------
.aws/
*.pem
*.key
*.ppk
*.p12
.env
.env.*
!.env.example
*.tfvars
*.tfvars.json
!terraform.tfvars.example

# ---------- Testes e cobertura (Nest/Jest) ----------
coverage/
*.lcov
junit.xml

# ---------- Node ----------
node_modules/
dist/
build/
.next/
*.tsbuildinfo
npm-debug.log*

# ---------- Logs, artefatos e SO ----------
*.log
logs/
*.zip
*.tar
*.tar.gz
.DS_Store
Thumbs.db
desktop.ini

# ---------- Editores ----------
.vscode/*
!.vscode/extensions.json
.idea/
```

Por que cada bloco importa:

| Padrão | Evita |
| --- | --- |
| `.terraform/` | ~200 MB de provider binário no histórico |
| `*.tfstate*` | o pior vazamento possível: state guarda IPs, senhas e ARNs em texto claro |
| `crash.log` | log de pânico do Terraform, que pode conter valores sensíveis |
| `*.pem`, `*.key` | chave privada versionada (catástrofe se o repo virar público) |
| `.env`, `.env.*` | segredo de aplicação; `!.env.example` mantém o template versionado |
| `.aws/` | credencial da sessão de lab se você copiar `~/.aws` para dentro do repo |
| `*.tfvars` | valores locais; mantenha só `terraform.tfvars.example` |
| `node_modules/`, `dist/`, `build/`, `coverage/` | artefatos de build, dependências e cobertura de teste |
| `.vscode/*` | configuração pessoal de editor |

> **Não ignore `terraform.lock.hcl`.** Ele é o arquivo que garante "a mesma versão do provider
> no meu WSL e no CI". Ignorá-lo é como não ter lockfile nenhum.

Arquivo complementar recomendado, dado que você edita no Windows e roda no Linux —
`.gitattributes` (evita `bad interpreter: /bin/bash^M` em CI):

```gitattributes
* text=auto eol=lf
*.sh    text eol=lf
*.py    text eol=lf
*.tf    text eol=lf
*.yml   text eol=lf
*.yaml  text eol=lf
*.md    text eol=lf
*.ps1   text eol=crlf
*.pem   -text
*.key   -text
```

**Verificação:**

```bash
git check-ignore -v docs/02-aws-academy-limites-e-riscos.md   # não deve imprimir nada
git check-ignore -v terraform.tfstate exemplo.pem .env        # deve imprimir 3 linhas
```

**Saída esperada (formato):** o primeiro comando **sem saída**; o segundo com três linhas
`... .gitignore:<linha>:<padrão>	<arquivo>`.

### 6.4 Estrutura de pastas inicial

```bash
mkdir -p app infra scripts docs .github/workflows
touch app/.gitkeep infra/.gitkeep scripts/.gitkeep .github/workflows/.gitkeep
```

```text
cloud/
├── .github/
│   └── workflows/          # vazio por enquanto: o pipeline é trabalho posterior
├── app/                    # código da aplicação (ainda não existe)
├── infra/                  # Terraform: backend aqui; recursos depois da arquitetura aprovada
├── scripts/                # automação local (smoke test, atalhos)
├── docs/                   # 00, 01, 02, 03
├── .gitattributes
├── .gitignore
└── README.md
```

**Nada de `main.tf` de recurso agora.** Em `infra/` entra apenas o bloco `backend` (§7).
`app/`, `infra/` e `scripts/` ficam com `.gitkeep` para o Git versionar as pastas vazias.

`README.md` mínimo (o conteúdo cresce com o projeto):

```markdown
# bcc-cloud — Projeto 2 de Computação em Nuvem (UFRPE)

## Identificação
- Projeto: <nome escolhido>
- Região AWS: us-east-1
- Repositório: privado

## Equipe e papéis
- Operador do lab: <nome>
- Suplente: <nome>

## Decisões
- Backend do state: S3 + `use_lockfile` (Terraform >= 1.10)
- Arquitetura: ver `docs/01-analise-requisitos-e-arquitetura.md`

## Rotina de fim de sessão
1. `terraform destroy` (quando houver recursos)
2. Parar/terminar a instância de teste
3. End Lab
```

### 6.5 Primeiro commit

```bash
git add -A
git status --short
git diff --staged --name-only
```

Confira a lista: **não** pode aparecer `*.pem`, `.env`, `*.tfstate` nem `.aws/`. Se aparecer,
pare e corrija o `.gitignore` antes de commitar.

```bash
git commit -m "chore: bootstrap do repositório (estrutura, .gitignore, .gitattributes)"
git log --oneline
```

**Saída esperada (formato):** uma linha `<hash> chore: bootstrap do repositório (estrutura, .gitignore, .gitattributes)`

### 6.6 Público ou privado?

**Privado.** A comparação honesta:

| Critério | Privado (recomendado) | Público |
| --- | --- | --- |
| Segredo commitado por acidente | fica restrito a quem tem acesso | **indexado e varrido por bots em minutos**; o `docs/02` §2.7 já trata chave vazada como perdida |
| Minutos de Actions | cota mensal do plano `[confirmar no momento da criação]` | ilimitados |
| Colaboradores | convite explícito | qualquer pessoa lê e clona |
| Evidência para a banca | print do repo + histórico | idem |

O único argumento real a favor do público é minutos de CI ilimitados. Isso **não** compensa o
risco: o trabalho tem credenciais AWS rotativas, state e possivelmente `.env` passando pela
máquina de quatro pessoas — um `git add -A` errado em repo público é irreversível na prática
(o objeto fica no histórico e em forks).

Se em algum momento o professor exigir repositório público, o mínimo é: nunca commitar
segredo, rodar `git log -p | grep -i -E 'aws_secret|session_token|BEGIN .*PRIVATE'` antes de
cada push, e aceitar que o histórico é público para sempre.

> **Critério de verificação do Passo 5:** `git status --porcelain` não imprime nada (árvore
> limpa), `git log --oneline` mostra ≥ 1 commit e `git check-ignore -v exemplo.pem .env
> terraform.tfstate` imprime 3 linhas.

---

## 7. Passo 6 — backend do Terraform (bucket de state)

### 7.1 Por que isso vem **antes** do primeiro `terraform init`

O `init` precisa **ler** o state no destino configurado no bloco `backend`. Se o bucket não
existir, ele falha (`no such bucket`) — o Terraform **não cria** o bucket do backend por você.
E se você tentar criar o bucket no **mesmo** state que usa esse bucket, cai no paradoxo do
bootstrap: para gravar o state do bucket, o bucket teria que existir antes de existir
(`docs/02` §7.3). Por isso o bucket é criado **à mão, uma vez**, com a CLI — ou com um
segundo `apply` de state local.

Ordem obrigatória: **credenciais (§5) → bucket (§7.2) → bloco `backend` (§7.3) → `terraform init` (§7.4).**

### 7.2 Criar o bucket

> **Atalho:** `bash scripts/bootstrap-state.sh` faz os passos desta seção (cria o bucket,
> liga versionamento, SSE-S3 e bloqueio de acesso público), é idempotente e imprime o bloco
> `backend "s3"` já preenchido com o nome real do bucket. Use `--suffix <texto>` para escolher
> o sufixo e `--dry-run` para só olhar. O texto abaixo explica cada comando.

Escolha o sufixo **uma vez** e use para sempre. Nome de bucket S3 é **global** (todo mundo na
AWS compartilha o namespace) e **não pode ser renomeado**.

```bash
export TF_STATE_BUCKET='bcc-cloud-tfstate-<SUFIXO>'   # minúsculo, 3-20 chars, só seu
echo "$TF_STATE_BUCKET"
```

```bash
aws s3api create-bucket --bucket "$TF_STATE_BUCKET" --region us-east-1
```

**Saída esperada (formato):** `{ "Location": "/bcc-cloud-tfstate-<sufixo>" }`

Em região diferente de `us-east-1` é obrigatório passar a localização (motivo extra para ficar
em `us-east-1`, D2):

```bash
aws s3api create-bucket --bucket "$TF_STATE_BUCKET" --region us-east-1 \
  --create-bucket-configuration LocationConstraint=us-east-1
```

Versionamento (permite recuperar um state sobrescrito):

```bash
aws s3api put-bucket-versioning --bucket "$TF_STATE_BUCKET" \
  --versioning-configuration Status=Enabled
aws s3api get-bucket-versioning --bucket "$TF_STATE_BUCKET"
```

**Saída esperada (formato):** `{ "Status": "Enabled" }`

Criptografia em repouso (SSE-S3):

```bash
aws s3api put-bucket-encryption --bucket "$TF_STATE_BUCKET" \
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
aws s3api get-bucket-encryption --bucket "$TF_STATE_BUCKET" --output json
```

**Saída esperada (formato):** JSON com `"SSEAlgorithm": "AES256"` em
`Rules[0].ApplyServerSideEncryptionByDefault`.

Bloqueio de acesso público (o state **nunca** pode ser público):

```bash
aws s3api put-public-access-block --bucket "$TF_STATE_BUCKET" \
  --public-access-block-configuration "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"
aws s3api get-public-access-block --bucket "$TF_STATE_BUCKET" --output json
```

**Saída esperada (formato):** os quatro campos `true`.

Opcional, barato e recomendado — recusar qualquer acesso sem TLS:

```bash
cat > /tmp/tfstate-policy.json <<'JSON'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DenyInsecureTransport",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:*",
      "Resource": ["arn:aws:s3:::BUCKET", "arn:aws:s3:::BUCKET/*"],
      "Condition": { "Bool": { "aws:SecureTransport": "false" } }
    }
  ]
}
JSON
sed -i "s/BUCKET/$TF_STATE_BUCKET/g" /tmp/tfstate-policy.json
aws s3api put-bucket-policy --bucket "$TF_STATE_BUCKET" --policy file:///tmp/tfstate-policy.json
```

> **Não** habilite object lock/WORM (pode estar bloqueado na conta, `docs/02` §3.2 item 13) e
> **não** coloque lifecycle que expire o state. Objeto de state é pequeno: o custo é
> irrelevante — o risco é perder o state.

### 7.3 O bloco `backend "s3"`

Em `infra/backend.tf` (decisão copiada de `docs/02` §7.3; os valores são os mesmos):

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

- `use_lockfile = true` exige **Terraform 1.10+** — é o teste do §3.3. Se sua versão for
  menor, use a alternativa com DynamoDB descrita em `docs/02` §7.3 (não invente outra).
- `encrypt = true` faz o Terraform pedir SSE no próprio objeto, além do default do bucket.
- `key` fixa o caminho dentro do bucket. Um state por ambiente, um `key` por ambiente.
- O **nome do bucket não é segredo** (mas identifica a conta): pode ser versionado.

### 7.4 Primeiro `init`

```bash
mkdir -p ~/.terraform.d/plugin-cache
export TF_PLUGIN_CACHE_DIR="$HOME/.terraform.d/plugin-cache"   # adicione ao ~/.bashrc
cd /mnt/c/Users/Lima02/Documents/bcc/cloud/infra
terraform init
```

**Saída esperada (formato):**

```text
Initializing the backend...

Successfully configured the backend "s3"! Terraform will automatically
use this backend unless the backend configuration changes.

Initializing provider plugins...

Terraform has been successfully initialized!
```

O cache de providers em `~/.terraform.d/plugin-cache` fica no ext4 e evita rebaixar/descompactar
o provider a cada `init` em `/mnt/c`.

Se você já tinha rodado `init` com state local antes de configurar o backend, migre com
`terraform init -migrate-state` (ele pergunta se pode copiar o state — responda `yes`).

Se aparecer `Error: Failed to get existing workspaces: S3 bucket does not exist`, o bucket não
foi criado ou o nome/sufixo está diferente: volte ao §7.2.

> **Critério de verificação do Passo 6:** `terraform init` em `infra/` imprime
> `Successfully configured the backend "s3"!` **e** `aws s3 ls "s3://$TF_STATE_BUCKET"` responde
> sem `NoSuchBucket`.

---

## 8. Passo 7 — GitHub e CI/CD

### 8.1 Criar o repositório

Pelo navegador: `github.com/new` → nome `bcc-cloud` → **Private** → **não** marque README,
`.gitignore` nem license (você já tem os seus) → **Create repository**.

Conecte o repositório local:

```bash
cd /mnt/c/Users/Lima02/Documents/bcc/cloud
git remote add origin https://github.com/<USUARIO>/bcc-cloud.git
git remote -v
git push -u origin main
```

**Saída esperada (formato):** `origin  https://github.com/<usuario>/bcc-cloud.git (fetch)` e
`(push)`, e no `push` as linhas `* [new branch] main -> main` + `branch 'main' set up to track 'origin/main'.`

Na primeira vez, o Git pede credencial: use um **Personal Access Token** como senha (GitHub →
Settings → Developer settings → Personal access tokens → Fine-grained), nunca a senha da conta.
Alternativa mais confortável: `gh auth login` (§8.2), que configura o credential helper.

### 8.2 `gh` CLI (opcional, mas poupa tempo)

```bash
sudo apt install -y gh    # [confirmar versão no momento da instalação]
gh --version
```

Se o `apt` não encontrar o pacote na sua versão do Ubuntu, instale pelo repositório oficial da
GitHub CLI (`cli.github.com/manual/installation`) em vez de baixar um `.deb` solto.

**Saída esperada (formato):** `gh version 2.x.y (...)`

```bash
gh auth login
gh auth status
```

**Saída esperada (formato):** escolha `GitHub.com` → `HTTPS` → `Login with a web browser`; ele
mostra um código de 8 caracteres e um link; abra o link no navegador do Windows, cole o código
e autorize. Depois, `gh auth status` imprime `Logged in to github.com as <usuario>`.

Com `gh` autenticado, o push e a criação de secrets ficam em um comando:

```bash
gh repo view --web        # abre o repo no navegador
git push -u origin main
```

### 8.3 Cadastrar os secrets

A comparação entre as estratégias de CI/CD e a recomendação em duas camadas estão em
`docs/02` §8.2–§8.4 — **leia antes de escolher**; aqui ficam só os três secrets que a
estratégia (a) usa e a rotina de mantê-los frescos.

Pela interface (mais seguro para quem está começando): **Settings → Secrets and variables →
Actions → New repository secret**, um por vez, com o valor colado direto do AWS Details:

| Nome | Valor |
| --- | --- |
| `AWS_ACCESS_KEY_ID` | o access key id da sessão (`ASIA...`) |
| `AWS_SECRET_ACCESS_KEY` | o secret correspondente |
| `AWS_SESSION_TOKEN` | o token da **mesma** leitura do painel |

Pela CLI, com as variáveis já carregadas (`source academy-env`), **por stdin** — assim o valor
não aparece em `ps` nem no histórico:

```bash
printf '%s' "$AWS_ACCESS_KEY_ID"     | gh secret set AWS_ACCESS_KEY_ID
printf '%s' "$AWS_SECRET_ACCESS_KEY" | gh secret set AWS_SECRET_ACCESS_KEY
printf '%s' "$AWS_SESSION_TOKEN"     | gh secret set AWS_SESSION_TOKEN

gh secret list
```

**Saída esperada (formato):**

```text
NAME                  UPDATED
AWS_ACCESS_KEY_ID     about 1 minute ago
AWS_SECRET_ACCESS_KEY about 1 minute ago
AWS_SESSION_TOKEN     about 1 minute ago
```

`gh secret list` mostra **nomes e datas**, nunca valores — é a verificação correta.

> Nunca crie secret com `--body "$AWS_SECRET_ACCESS_KEY"`: o valor vai para o histórico do
> shell e para a lista de processos.

### 8.4 Rotação a cada sessão de lab

O token morre em ~4 h e o pipeline passa a falhar (`docs/02` §8.2). A rotina é curta e cabe no
início de toda sessão:

| # | Quando | Ação | Verificação |
| --- | --- | --- | --- |
| 1 | ao clicar **Start Lab** | copiar as 3 credenciais em AWS Details | círculo verde |
| 2 | imediatamente | editar as 3 linhas de `~/.local/bin/academy-env` e `source` | `academy_whoami` → `OK` |
| 3 | antes de qualquer push que dispare deploy | atualizar os 3 secrets no GitHub (§8.3) | `gh secret list` com data de agora |
| 4 | ao terminar | `End Lab` + encerrar instâncias de teste | nada `running` no console |

Regra prática: se o relógio passou de ~3 h desde o Start Lab, **renove antes de rodar o
pipeline**, não depois de ele falhar.

### 8.5 O que fica para depois

- **Não** crie arquivos em `.github/workflows/` agora. O pipeline só faz sentido depois que
  existir aplicação, testes e `infra/` com recursos — e a camada que nunca toca a AWS
  (`fmt`/`validate`/lint/testes) é a primeira a ser escrita, conforme `docs/02` §8.4.
- **Não** tente OIDC (`role-to-assume`): é inviável no Learner Lab (`docs/02` §8.1).
- **Não** adicione `AWS_REGION` como secret: região é configuração, não segredo — fica no
  `README.md` e no código.

> **Critério de verificação do Passo 7:** `git remote -v` aponta para o repo privado,
> `git push` conclui e `gh secret list` (ou a página de secrets) mostra os **três** nomes com
> data de atualização da sessão atual.

---

## 9. Passo 8 — contas e ferramentas externas

| Ferramenta | Criar agora? | Por quê | Custo |
| --- | --- | --- | --- |
| **GitHub** (conta + repo privado) | **sim** — é o Passo 7 | hospeda código, histórico e secrets do pipeline | free |
| **Infisical SaaS (free)** | **só quando existir o primeiro segredo de aplicação** | é o que o edital cita (3.4); criar antes de ter segredo só gera um projeto vazio e mais uma credencial para cuidar | free tier `[confirmar limites no momento da criação]` |
| **Infisical self-hosted** | **não** neste semestre | exige servidor, TLS, backup e atualização — operação que consome crédito do lab e tempo de prova, para guardar poucos valores (`docs/02` §8.2 tem o mesmo raciocínio de custo/benefício) | EC2 + EBS contínuos |
| **Docker Hub** | não | o registry do projeto é o **ECR** (`docs/02` §3.3 item 14); Docker Hub só serviria para imagens públicas | free, mas desnecessário |
| **Terraform Cloud** | não | o state já vive em S3 (§7) | free tier, mas duplica a fonte de verdade |
| **Conta AWS própria / cartão** | **nunca** | o lab já é a conta AWS do projeto; criar conta paga abre frente de cobrança real | cobrança real |
| **Domínio / Route 53 registro** | **não** | registro de domínio não é viável no lab (`docs/02` §3.1 item 7); a URL da demo é o DNS do ALB | ~US$ 12/ano |
| **Grafana Cloud / observabilidade SaaS** | não agora | a stack de observabilidade será decidida com a arquitetura (`docs/01`); o edital aceita Prometheus/Grafana self-hosted | free tier com limites |

**Regra:** nada pago. Se uma ferramenta exigir cartão, ela está fora até o professor dizer o
contrário por escrito.

**Se você for usar Infisical**, o mínimo para o requisito 3.4 do edital é: um projeto, dois
ambientes (`dev`/`prod`), e o **token de serviço** consumido pelo pipeline via secret do
GitHub — nunca no código. E o token do Infisical **também** entra na rotina de rotação, com
validade maior que 4 h (ele não expira com o lab).

---

## 10. Checklist "pronto para começar"

Marque só o que você **verificou com o comando**, não o que você acha que está feito.

> **Atalho para o bloco "Lab AWS":** `bash scripts/sandbox-check.sh` roda os itens K de
> `docs/02` §11 que não dependem de infraestrutura (identidade, região, key pair, `LabRole`,
> `LabInstanceProfile`, ECR, S3, RDS, tipos de instância, cota de vCPU), limpa o que cria e
> anexa um registro datado em `docs/evidencias/sandbox.md`. Use `--com-iam` para incluir o
> teste de OIDC (write em IAM, esperado falhar).

### Lab AWS

- [ ] `aws sts get-caller-identity --query Arn --output text` imprime um ARN com `assumed-role/voclabs/`
- [ ] `aws configure get region` imprime `us-east-1`
- [ ] As três credenciais foram copiadas na **mesma** leitura do AWS Details
- [ ] O teste K3 de `docs/02` §11 foi rodado e a rota de chave escolhida (A ou B) foi anotada
- [ ] Nenhum recurso de uma sessão anterior está `running` no console

### Toolchain (WSL)

- [ ] `aws --version` → `aws-cli/2.`
- [ ] `terraform version` → `Terraform v1.` com minor **≥ 10**
- [ ] `ansible --version` → `ansible [core 2.`
- [ ] `jq --version` → `jq-1.`
- [ ] `make --version` → `GNU Make 4.`
- [ ] `git --version` → `git version 2.` com minor ≥ 28
- [ ] `node --version` → `v22.` e `pnpm --version` responde
- [ ] `docker run --rm hello-world` imprime `Hello from Docker!`
- [ ] `docker compose version` → `v2.` (nunca `docker-compose` v1)
- [ ] `git config user.email` no WSL imprime o e-mail do grupo

### Chave e acesso

- [ ] `aws ec2 describe-key-pairs --key-names projeto2` lista a chave
- [ ] `ls -l ~/.ssh/projeto2*` mostra a privada como `-rw-------` (ou `-r--------` na Rota A)
- [ ] `~/.ssh/config` tem o bloco `Host proj2` com `User` correto para a AMI e `chmod 600`
- [ ] `ssh proj2 'echo ok'` imprime `ok`
- [ ] A regra de entrada da porta 22 está limitada ao seu IP, não a `0.0.0.0/0`
- [ ] A instância de teste foi **terminada** depois do teste

### Repositório

- [ ] `git status --porcelain` não imprime nada
- [ ] `git log --oneline` mostra o commit de bootstrap
- [ ] `git check-ignore -v exemplo.pem .env terraform.tfstate` imprime 3 linhas
- [ ] `.terraform.lock.hcl` **não** está no `.gitignore`
- [ ] O repositório no GitHub é **privado** e `git remote -v` aponta para ele

### Backend

- [ ] `aws s3api get-bucket-versioning --bucket "$TF_STATE_BUCKET"` → `"Enabled"`
- [ ] `aws s3api get-public-access-block --bucket "$TF_STATE_BUCKET"` → quatro `true`
- [ ] `aws s3api get-bucket-encryption --bucket "$TF_STATE_BUCKET"` → `AES256`
- [ ] `infra/` contém o bloco `backend "s3"` com `use_lockfile = true`
- [ ] `terraform init` em `infra/` → `Successfully configured the backend "s3"!`

### CI

- [ ] `git push` conclui sem pedir senha (token ou `gh auth login` funcionando)
- [ ] `gh secret list` mostra `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`
- [ ] Os três secrets foram atualizados **na sessão atual**
- [ ] `.github/workflows/` está vazio (ou só com `.gitkeep`) — pipeline é trabalho posterior

### Teste de fumaça (o exame final do pré-voo)

Rode os seis comandos **em sequência, no WSL**, com a instância de teste ligada e o
`academy-env` carregado:

```bash
# 1. identidade AWS
aws sts get-caller-identity --query Arn --output text

# 2. Terraform instalado e compatível com use_lockfile
terraform version -json | jq -r '.terraform_version'

# 3. Docker com daemon acessível
docker run --rm hello-world | head -n 1

# 4. SSH na instância de teste
ssh -o ConnectTimeout=5 -o BatchMode=yes proj2 'echo ok'

# 5. bucket de state acessível
aws s3 ls "s3://$TF_STATE_BUCKET"

# 6. repositório limpo
test -z "$(git -C /mnt/c/Users/Lima02/Documents/bcc/cloud status --porcelain)" && echo CLEAN
```

**Saída esperada (formato), uma linha por comando:**

```text
arn:aws:sts::<CONTA>:assumed-role/voclabs/<sessao>
1.10.x
Hello from Docker!
ok
CLEAN
```

O comando 5 (`aws s3 ls` de bucket vazio) **não imprime nada** — sucesso é "nenhuma saída e
nenhum erro". Se algum dos seis falhar, o problema está no passo correspondente: 1→§2/§5,
2→§3.3, 3→§3.7, 4→§4, 5→§7, 6→§6.

Depois do teste: **termine a instância de teste** e clique em **End Lab**.

---

## 11. Ordem de execução e o que NÃO fazer ainda

| Quando | O quê | Por quê |
| --- | --- | --- |
| **Agora** | decisões D1–D11 (§1) | nome de bucket e slug não se renomeiam depois |
| **Agora** | toolchain no WSL (§3) | sem `terraform` e `aws` nada mais acontece |
| **Agora** | chave + teste de SSH (§4) | descobre se `CreateKeyPair`/`ImportKeyPair` estão liberados antes de desenhar em cima |
| **Agora** | credenciais + script de sessão (§5) | é o que faz todo o resto funcionar por 4 h |
| **Agora** | repo + `.gitignore` + primeiro commit (§6) | evita que o primeiro segredo entre no histórico |
| **Agora** | bucket de state + `backend` + `init` (§7) | o `init` falha sem o bucket |
| **Agora** | repo no GitHub + 3 secrets + rotina de rotação (§8) | o CI depende disso e a rotação tem que virar hábito |
| **Depois** | recursos da arquitetura em `.tf` | dependem da opção de `docs/01-...` aprovada pelo professor |
| **Depois** | pipeline em `.github/workflows/` | depende da aplicação e dos testes existirem |
| **Depois** | Infisical, Ansible, observabilidade | dependem de existir algo para configurar/observar |
| **Depois** | ALB, RDS, EFS, NAT | alto custo por hora, só com arquitetura aprovada e demo marcada |
| **Nunca** | criar ALB/RDS/NAT "para testar" | custo ocioso por hora, mesmo sem tráfego (`docs/02` §5) |
| **Nunca** | `aws configure` digitando só access key e secret | gera `InvalidClientTokenId` sem o token (`docs/02` §7.1) |
| **Nunca** | commitar `terraform.tfstate`, `*.pem`, `.env` | vazamento permanente no histórico |
| **Nunca** | deixar instância/ALB ligado ao clicar End Lab | End Lab não desliga recurso (`docs/02` §2.4) |
| **Nunca** | criar role/policy/user/OIDC no IAM | bloqueado na conta e quebra o `apply` (`docs/02` §4) |
| **Nunca** | `terraform apply -auto-approve` em desenvolvimento | esconde onde o apply parou (`docs/02` §2.6) |
| **Nunca** | credencial em `-var`, `TF_VAR_*` ou `env:` do YAML | aparece no log (`docs/02` §8.5) |
| **Nunca** | `0.0.0.0/0` na porta 22 | perde ponto de segurança e expõe a instância |

---

## 12. Reversão (rollback) do que este guia cria

Nada aqui é irreversível, **exceto** o bucket de state, que você **não deve** apagar enquanto
o projeto existir. Ordem e comandos:

| Item criado | Reverter | Observação |
| --- | --- | --- |
| Segredos no GitHub (§8.3) | `gh secret delete AWS_SESSION_TOKEN` (repita para os outros) | inofensivo: no próximo deploy o pipeline falha por falta de credencial |
| Remote do Git (§8.1) | `git remote remove origin` | o repo local e o remoto no GitHub continuam existindo |
| Bloco `backend` (§7.3) | remova o bloco e rode `terraform init -migrate-state` | volta o state para local — **não** faça isso com recursos já criados |
| Bucket de state (§7.2) | **só no fim do semestre**: `aws s3 rm "s3://$TF_STATE_BUCKET" --recursive` e depois `aws s3api delete-bucket --bucket "$TF_STATE_BUCKET"` | bucket versionado: apague versões e delete markers antes (o `delete-bucket` falha com `BucketNotEmpty`) |
| Key pair (§4) | `aws ec2 delete-key-pair --key-name projeto2` | não afeta instâncias em execução, mas você perde o acesso a elas |
| Script de sessão (§5) | `rm ~/.local/bin/academy-env` | feche os terminais abertos; as variáveis morrem com eles |
| Toolchain (§3) | `sudo apt remove --purge terraform ansible`; `sudo rm -rf /usr/local/aws-cli /usr/local/bin/aws ~/.aws` | raramente necessário |
| Recursos de arquitetura | `terraform destroy` | **só** existe depois de `docs/01`; nunca apague à mão no console |

**Ponto de não retorno:** o momento em que o primeiro recurso de arquitetura é criado. Antes
disso, tudo é descartável e reversível em minutos. Depois, a única forma segura de desfazer é
`terraform destroy` — mais um motivo para não criar ALB/RDS/NAT antes da aprovação.

---

## 13. Erros comuns → onde olhar

| Mensagem / sintoma | Onde está a resposta |
| --- | --- |
| `InvalidClientTokenId` | `docs/02` §2.5 — faltou `AWS_SESSION_TOKEN` ou você usou `aws configure` |
| `ExpiredToken` | `docs/02` §2.5 e §2.6 — reemitir e reexportar; protocolo de retomada |
| `Error acquiring the state lock` | `docs/02` §7.4 e §9 R11 |
| `AccessDenied` em `iam:*` | `docs/02` §4 — não crie IAM, leia com `data` |
| `Terraform v1.9.x` (ou menor) | §3.3 deste guia — reinstale com versão ≥ 1.10 |
| `S3 bucket does not exist` no `init` | §7.2 — nome/sufixo do bucket errado |
| `UNPROTECTED PRIVATE KEY FILE` | §4.5 — chave em `/mnt/c` |
| `Permission denied (publickey)` | §4.6/§4.9 — usuário da AMI errado |
| `Cannot connect to the Docker daemon` | §3.7 — Docker Desktop fechado ou integração WSL desligada |
| `/bin/bash^M: bad interpreter` | §6.3 — `.gitattributes` com `eol=lf` |
| `docker-compose: command not found` | §3.7 — use `docker compose` |
| Pipeline falha sem mensagem clara depois de ~4 h | §8.4 — token expirado, rotacione os secrets |

---

## 14. Referências

| Documento | Para quê |
| --- | --- |
| `docs/00-edital-projeto-2.md` | requisitos e pesos do projeto |
| `docs/02-aws-academy-limites-e-riscos.md` | limites do lab, credenciais, backend, CI/CD, key pairs, checklist de verificação (K1–K22) |
| `docs/01-analise-requisitos-e-arquitetura.md` | arquitetura recomendada e custo das escolhas; criar recursos depende dela e do aval do professor (§1, D8) |
| `docs/03-guia-pre-requisitos.md` | este documento |

> **Próximo passo depois deste guia:** com `docs/01` aprovado, escrever o primeiro `.tf` de
> recurso em `infra/` — começando por `required_providers` com versão fixada e
> `data "aws_iam_role"`/`data "aws_iam_instance_profile"` (`docs/02` §4.3 e §7.4).
