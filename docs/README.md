# Projeto 2 — Computação em Nuvem (UFRPE)

Repositório do Projeto Integrador: **Desenvolvimento e Implantação em Nuvem**.
Contém o edital transcrito, a análise e os planos do projeto acadêmico **e** a documentação de
produto da aplicação que será entregue: o **buscador de skills** (`Skill Finder`).

## Ordem de leitura

| # | Documento | Para quê | Leia quando |
| --- | --- | --- | --- |
| 00 | [Edital transcrito](00-edital-projeto-2.md) | requisitos, entregáveis e pesos — a fonte de verdade | sempre que tiver dúvida sobre "o que é exigido" |
| 01 | [Análise de requisitos e arquitetura](01-analise-requisitos-e-arquitetura.md) | rastreabilidade requisito→peso, 3 opções de arquitetura, recomendação, pilha de software, suposições | antes de decidir o que construir |
| 02 | [Limites e riscos do AWS Academy](02-aws-academy-limites-e-riscos.md) | credenciais temporárias, matriz de serviços, IAM bloqueado, key pairs, checklist K1–K22 | antes de tocar na conta |
| 03 | [Guia de pré-requisitos](03-guia-pre-requisitos.md) | passo a passo executável: decisões, lab, toolchain no WSL, chave SSH, credenciais, repositório, backend do state, secrets | **agora**, é o primeiro a executar |
| 04 | [Plano de execução](04-plano-de-execucao.md) | 7 fases com gates, cronograma de 8 semanas, marcos, riscos e checklist de entrega | depois do pré-voo |

## Documentação do produto

| Documento | Para quê |
| --- | --- |
| [01-spec-produto](app/01-spec-produto.md) | problema, personas, histórias de usuário, **regra de ranking**, requisitos não-funcionais |
| [02-arquitetura](app/02-arquitetura.md) | componentes, contrato da API, modelo de dados, segurança (prompt injection), ADRs |
| [03-plano-app](app/03-plano-app.md) | como a F2 é executada: descoberta da fonte de dados, sub-fases F2.0–F2.9, gates |
| [amostras](app/amostras/) | amostra real do skills.sh + decisão sobre a forma de acesso (F2.0) |

## Operação

| Documento | Para quê |
| --- | --- |
| [runbook-operacao](runbook-operacao.md) | subir, implantar, destruir e encerrar sessão na EC2 do lab — os "procedimentos de execução, implantação e remoção" do edital (§3.7) |
| [seguranca](seguranca.md) | inventário dos seis segredos, quem lê o quê, escopo da machine identity, rotação/revogação e riscos aceitos — a demonstração do §3.4 do edital |

Para agentes, a regra de sessão está em [`../AGENTS.md`](../AGENTS.md).

## As três coisas a fazer hoje

1. **Tomar as decisões irreversíveis** (`03` §1): slug do projeto (`bcc-cloud`), região
   (`us-east-1`) e visibilidade do repositório (**privado**). Bucket S3 não renomeia.
2. **Provar o sandbox** (`02` §11, itens K1–K3, K6, K7, K10, K11, K14): credenciais, key pair,
   `LabRole`/`LabInstanceProfile`, ECR e S3. Cada item responde uma suposição que, se falsa,
   muda a arquitetura.
3. **Instalar a toolchain no WSL** (`03` §3): AWS CLI v2, Terraform ≥ 1.10, Docker — e o script
   de sessão de credenciais (`03` §5), que é o que faz tudo funcionar depois.

## Respostas rápidas às duas dúvidas que motivaram este material

- **Chave `.pem`**: duas rotas em `03` §4 — gerar no WSL e importar a pública (recomendada) ou
  criar no console e baixar o `.pem`. O ponto que quebra todo mundo: `chmod 400` **não** vale em
  `/mnt/c`, só no filesystem Linux (`~/.ssh`) — `03` §4.5.
- **Credenciais da AWS CLI**: são **três** valores (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
  `AWS_SESSION_TOKEN`), não dois; `aws configure` sozinho gera `InvalidClientTokenId`. O fluxo
  completo está em `02` §2 e o script de sessão em `03` §5.

## Fatos do ambiente (verificados)

- Windows 11 + **WSL2 com Ubuntu funcionando**; Docker Desktop + Compose; git 2.50, ssh,
  Python 3.13, VS Code, `winget`, `scoop`, `gh` 2.103.
- **Instalados no WSL**: AWS CLI v2 e Terraform ≥ 1.10 (`scripts/install-toolchain-wsl.sh`).
- Acesso AWS: **AWS Academy Learner Lab via Vocareum** — credenciais temporárias com session
  token, IAM bloqueado (`LabRole`/`LabInstanceProfile`), sem OIDC para o GitHub Actions.
  Conta `794399909334`, região `us-east-1`, key pair `vockey` (`labsuser.pem` em `~/.ssh`).
- Sandbox validado: K1, K2, K3, K3b, K4, K6, K7, K10, K11 OK; K14 sem DB subnet group (RDS fora
  de cena); K5 e K9 não testados. Evidência em [`evidencias/sandbox.md`](evidencias/sandbox.md).

## Convenções

- **R1–R8** requisitos consolidados, **E1–E5** entregáveis do edital, **C1–C8** critérios de
  avaliação com pesos (definidos em `01` §1.4 e §2).
- **A1–A14** suposições a validar (`01` §9), **K1–K22** itens do checklist do sandbox (`02` §11),
  **F0–F6** fases do plano (`04` §3), **R01–R13** riscos do projeto (`04` §9).
- Marcas de confiança em `02`: `[confiança: alta]`, `[confiança: média — confirmar]`,
  `[confiança: baixa — verificar no laboratório]`. Nada marcado como "baixa" deve virar
  decisão de arquitetura sem antes rodar o item K correspondente.
