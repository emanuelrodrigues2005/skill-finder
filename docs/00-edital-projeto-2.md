# Projeto 2 — Computação em Nuvem (transcrição do edital)

> Transcrição normalizada de `Projeto 2 - Computação em nuvem.pdf` (5 páginas).
> O PDF é renderizado com fontes CID mapeadas por `ToUnicode` e blocos de texto
> posicionados de forma não linear; o texto abaixo foi reconstruído a partir das
> posições reais dos glifos. Nenhuma frase foi acrescentada, resumida ou
> reescrita em conteúdo — apenas corrigida a fragmentação de palavras do PDF
> (ex.: `Desen v olv er` → `Desenvolver`) e restaurada a ordem de leitura.
> Em caso de dúvida, a fonte de verdade é o PDF.

Cabeçalho corrente em todas as páginas: **UNIVERSIDADE FEDERAL RURAL DE PERNAMBUCO** —
**PROJETO INTEGRADOR: DESENVOLVIMENTO E IMPLANTAÇÃO EM NUVEM**.

## 1. OBJETIVO

Desenvolver e implantar uma aplicação funcional em ambiente de nuvem, aplicando os
conceitos, ferramentas e práticas discutidos na disciplina de Computação em Nuvem. O
projeto deverá integrar o desenvolvimento de software, a infraestrutura em nuvem, a
automação de processos, a integração e entrega contínuas (CI/CD), a segurança e a
observabilidade. O objetivo é demonstrar como essas práticas podem ser combinadas para
automatizar o ciclo de vida de uma aplicação, desde o desenvolvimento até sua implantação
e operação.

## 2. PROPOSTA DO PROJETO

Cada grupo deverá propor e desenvolver uma aplicação de sua escolha, identificando um
problema real ou um cenário de uso que justifique sua implementação. A solução deverá
possuir funcionalidades reais e uma arquitetura compatível com o problema proposto,
contemplando os componentes necessários ao seu funcionamento. Espera-se,
preferencialmente, uma aplicação composta por interface de usuário (frontend), serviço de
backend e mecanismo de persistência de dados, como um banco de dados relacional ou não
relacional. A solução deverá apresentar funcionalidades efetivas, permitindo demonstrar a
interação entre seus componentes e o armazenamento e recuperação de informações.

Os grupos terão liberdade para definir a aplicação, a arquitetura, os serviços de nuvem e as
ferramentas utilizadas. Entretanto, todas as escolhas deverão ser tecnicamente justificadas,
considerando aspectos como funcionalidade, segurança, escalabilidade, manutenção e
disponibilidade. As aulas de acompanhamento de projeto servem para a proposta ser
submetida a discussão previamente, contendo uma descrição do problema, as
funcionalidades previstas, a arquitetura inicial e as tecnologias selecionadas. Essas
discussões devem ocorrer durante as aulas de acompanhamento de projeto.

## 3. REQUISITOS TÉCNICOS

### 3.1. APLICAÇÃO

A aplicação deverá:

- Implementar funcionalidades compatíveis com o problema proposto.
- Possuir uma arquitetura documentada, identificando seus principais componentes e
  suas interações.
- Utilizar um mecanismo adequado de persistência.
- Ser executada em ambiente de nuvem e disponibilizar uma forma de demonstrar seu
  funcionamento.

### 3.2. INFRAESTRUTURA COMO CÓDIGO

O grupo deverá utilizar Terraform para automatizar o provisionamento dos principais
recursos de infraestrutura utilizados pelo projeto, incluindo os recursos necessários para
execução da aplicação e sua comunicação. Os arquivos de configuração deverão estar
versionados no repositório Git.

### 3.3. INTEGRAÇÃO E ENTREGA CONTÍNUAS (CI/CD)

O projeto deverá possuir um pipeline automatizado que contemple, no mínimo:

- Verificação do código e execução de testes automatizados.
- Construção e disponibilização dos artefatos necessários à implantação.
- Implantação automatizada da aplicação no ambiente de nuvem.
- Verificação do resultado da implantação, incluindo a realização de uma verificação
  automatizada de disponibilidade ou funcionamento da aplicação após o deploy.

### 3.4. SEGURANÇA E GERENCIAMENTO DE SEGREDOS

O grupo deverá demonstrar práticas de segurança compatíveis com a solução, incluindo o
gerenciamento adequado de credenciais, tokens, senhas e demais informações sensíveis.
Ferramentas como Infisical poderão ser utilizadas para gerenciar e disponibilizar segredos.
As credenciais não devem ser armazenadas diretamente no código-fonte ou em arquivos
versionados sem proteção adequada.

O grupo deverá demonstrar que as credenciais utilizadas pela aplicação e pelo pipeline de
CI/CD são disponibilizadas de forma segura, evitando sua exposição em logs, no código-fonte
ou em artefatos públicos.

### 3.5. TESTES E QUALIDADE

O projeto deverá contemplar testes automatizados adequados à aplicação, como testes
unitários, de integração ou de API. Os testes deverão estar integrados ao pipeline de CI/CD.
O grupo deverá explicar como os resultados dos testes influenciam a continuidade do
processo de implantação.

### 3.6. OBSERVABILIDADE

O grupo deverá implementar mecanismos de observabilidade que permitam acompanhar o
funcionamento da aplicação implantada em nuvem.

A solução deverá contemplar, no mínimo:

- **Métricas**: coleta de informações relacionadas ao funcionamento da aplicação, como
  quantidade de requisições, disponibilidade ou tempo de resposta.
- **Logs**: registro de operações relevantes e de ocorrências de erro durante a execução
  da aplicação.
- **Visualização**: disponibilização de uma forma de consultar as métricas e os logs
  coletados, por meio de dashboards ou ferramentas equivalentes.

Poderão ser utilizadas ferramentas como Prometheus, Grafana e Telegraf, entre outras
alternativas tecnicamente justificadas.

### 3.7. DOCUMENTAÇÃO

O repositório deverá conter documentação suficiente para compreender a aplicação, sua
arquitetura, as tecnologias empregadas e os procedimentos necessários para execução,
implantação e remoção dos recursos.

## 4. ESCOLHA DAS TECNOLOGIAS

A implantação da aplicação deverá utilizar a plataforma Amazon Web Services (AWS). Os
grupos poderão selecionar os serviços que considerarem mais adequados à arquitetura
proposta, justificando suas escolhas. Ferramentas complementares poderão ser utilizadas
em conjunto com os serviços AWS.

Entre as possibilidades de tecnologias e serviços estão:

| Categoria | Tecnologias / Serviços |
| --- | --- |
| Computação e rede | Amazon EC2, Application Load Balancer (ALB) e serviços relacionados |
| Armazenamento | Amazon EBS, Amazon EFS e Amazon S3 |
| Contêineres | Docker e Amazon ECR |
| Infraestrutura como código | Terraform |
| Automação e CI/CD | GitHub Actions |
| Gerenciamento de segredos | Infisical |
| Gerenciamento de configuração | Ansible |
| Observabilidade | Prometheus, Grafana, Telegraf e Loki |

A utilização de cada tecnologia deverá ser justificada de acordo com as necessidades da
aplicação. Não é necessário utilizar todos os serviços listados, nem adotar a mesma
arquitetura para todos os grupos. Entretanto, a escolha das tecnologias não elimina a
necessidade de atender aos requisitos técnicos obrigatórios do projeto. Tecnologias
alternativas poderão ser utilizadas mediante justificativa e aprovação durante o
acompanhamento do projeto.

## 5. ORGANIZAÇÃO DO TRABALHO

O trabalho deverá ser desenvolvido em grupos de até quatro integrantes. Todos os
integrantes deverão participar do desenvolvimento, conhecer a arquitetura completa e
compreender as principais decisões técnicas do grupo. A divisão de tarefas deverá ser
documentada, sem impedir que os integrantes conheçam o funcionamento geral da solução.

O desenvolvimento deverá utilizar um repositório Git, com histórico de alterações que
permita acompanhar a evolução do projeto.

## 6. ENTREGÁVEIS

Cada grupo deverá entregar:

1. **Proposta inicial**: descrição do problema, funcionalidades previstas, arquitetura
   preliminar e tecnologias selecionadas para aprovação.
2. **Repositório do projeto**: código-fonte da aplicação, testes, arquivos de infraestrutura
   como código, configurações de automação e documentação.
3. **Pipeline CI/CD funcional**: evidências da execução dos testes, da construção dos
   artefatos e da implantação automatizada.
4. **Aplicação implantada**: ambiente funcional na nuvem.
5. **Documentação técnica**: arquitetura, decisões tecnológicas, instruções de execução e
   implantação, medidas de segurança e configuração das ferramentas de observabilidade.

## 7. CRITÉRIOS DE AVALIAÇÃO

A avaliação considerará os seguintes critérios:

| Critério de Avaliação | Peso |
| --- | --- |
| Desenvolvimento da aplicação | 25% |
| Utilização e integração dos serviços AWS | 20% |
| Terraform | 15% |
| Pipeline CI/CD | 15% |
| Testes automatizados e qualidade da implementação | 10% |
| Segurança e gerenciamento de segredos | 5% |
| Observabilidade | 5% |
| Documentação técnica | 5% |
| **Total** | **100%** |

A avaliação não será baseada apenas na quantidade de serviços ou ferramentas utilizados.
Serão valorizadas a integração entre os componentes, a qualidade da implementação, a
justificativa das decisões técnicas, a automação efetiva e a capacidade de demonstrar o
funcionamento da solução.
