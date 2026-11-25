# A VPC padrão já vem pronta em toda conta, e é a que o lab entrega sem trabalho
# extra (docs/02 §3.1). Criar aws_vpc/aws_subnet/aws_internet_gateway só
# acrescentaria recursos que o destroy pode deixar órfãos: por isso data, não resource.
data "aws_vpc" "default" {
  default = true
}

data "aws_availability_zones" "available" {
  state = "available"
}

# A primeira AZ em ordem alfabética fixa o subnet entre applies; a ordem devolvida
# pela API não é estável, e trocar de subnet recriaria a instância.
data "aws_subnet" "default" {
  vpc_id            = data.aws_vpc.default.id
  availability_zone = sort(data.aws_availability_zones.available.names)[0]
  default_for_az    = true
}

# Um SG por camada. O ingress de web/api/db nunca vem por CIDR: o endereço privado
# de cada instância muda quando ela é recriada, e um CIDR da VPC (10.0.0.0/16)
# abriria a porta para qualquer host da conta. Referenciar o SG que chama mantém a
# regra correta depois de qualquer stop/start.
#
# As regras ficam em recursos `aws_vpc_security_group_*_rule`, não em blocos
# inline: alb→web e web→alb se referenciam, e declarar os dois lados inline fecha
# um ciclo que o Terraform recusa (`Cycle: aws_security_group.alb,
# aws_security_group.web`). A alternativa seria fixar CIDR, justamente o que se
# quer evitar.
resource "aws_security_group" "alb" {
  name        = "${var.project_name}-sg-alb"
  description = "Unica entrada publica: 80 do balanceador. Saida so para as camadas web e api."
  vpc_id      = data.aws_vpc.default.id

  tags = {
    Name    = "${var.project_name}-sg-alb"
    project = var.project_name
  }
}

resource "aws_security_group" "web" {
  name        = "${var.project_name}-sg-web"
  description = "Borda nginx: aceita 80 apenas do balanceador."
  vpc_id      = data.aws_vpc.default.id

  tags = {
    Name    = "${var.project_name}-sg-web"
    project = var.project_name
  }
}

resource "aws_security_group" "api" {
  name        = "${var.project_name}-sg-api"
  description = "Backend: aceita 8000 e 3000 apenas do balanceador."
  vpc_id      = data.aws_vpc.default.id

  tags = {
    Name    = "${var.project_name}-sg-api"
    project = var.project_name
  }
}

# O db não recebe nada da internet nem do balanceador: só a api fala 5432 com ele.
resource "aws_security_group" "db" {
  name        = "${var.project_name}-sg-db"
  description = "Postgres: aceita 5432 apenas da camada api."
  vpc_id      = data.aws_vpc.default.id

  tags = {
    Name    = "${var.project_name}-sg-db"
    project = var.project_name
  }
}

# Mapa papel → SG da instância, para o compute não repetir a escolha.
locals {
  security_group_by_role = {
    web = aws_security_group.web.id
    api = aws_security_group.api.id
    db  = aws_security_group.db.id
  }
}

resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTP publico: unico ponto de entrada da conta."
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_security_group_egress_rule" "alb_to_web" {
  security_group_id            = aws_security_group.alb.id
  description                  = "Balanceador para o nginx da borda."
  referenced_security_group_id = aws_security_group.web.id
  ip_protocol                  = "tcp"
  from_port                    = 80
  to_port                      = 80
}

resource "aws_vpc_security_group_egress_rule" "alb_to_api_http" {
  security_group_id            = aws_security_group.alb.id
  description                  = "Balanceador para o backend (HTTP da API)."
  referenced_security_group_id = aws_security_group.api.id
  ip_protocol                  = "tcp"
  from_port                    = 8000
  to_port                      = 8000
}

resource "aws_vpc_security_group_egress_rule" "alb_to_api_metrics" {
  security_group_id            = aws_security_group.alb.id
  description                  = "Balanceador para o backend (metricas e painel)."
  referenced_security_group_id = aws_security_group.api.id
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3000
}

resource "aws_vpc_security_group_ingress_rule" "web_from_alb" {
  security_group_id            = aws_security_group.web.id
  description                  = "80 somente do balanceador."
  referenced_security_group_id = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = 80
  to_port                      = 80
}

resource "aws_vpc_security_group_egress_rule" "web_https" {
  security_group_id = aws_security_group.web.id
  description       = "Saida HTTPS para o Docker Hub no pull das imagens."
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_egress_rule" "web_apt_http" {
  security_group_id = aws_security_group.web.id
  description       = "Saida HTTP para os repositorios do apt no primeiro boot."
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_security_group_ingress_rule" "api_from_alb_http" {
  security_group_id            = aws_security_group.api.id
  description                  = "8000 somente do balanceador."
  referenced_security_group_id = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = 8000
  to_port                      = 8000
}

resource "aws_vpc_security_group_ingress_rule" "api_from_alb_metrics" {
  security_group_id            = aws_security_group.api.id
  description                  = "3000 somente do balanceador."
  referenced_security_group_id = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3000
}

# SSH fechado por padrão: sem CIDR em var.allowed_ssh_cidrs a regra 22 nem existe,
# então nenhuma varredura de porta encontra sshd exposto na internet. Fica no SG da
# api porque é a única camada com IP público, e o operador chega às outras por ela.
resource "aws_vpc_security_group_ingress_rule" "api_ssh" {
  for_each = toset(var.allowed_ssh_cidrs)

  security_group_id = aws_security_group.api.id
  description       = "SSH restrito as redes declaradas em allowed_ssh_cidrs."
  cidr_ipv4         = each.value
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
}

# O `apt` fala HTTP (porta 80) com `*.ec2.archive.ubuntu.com` e
# `security.ubuntu.com`. Sem esta regra o `apt-get update` falha inteiro, a lista
# de pacotes fica vazia e o `install docker.io` responde "no installation
# candidate" — o host sobe sem Docker e o sintoma no deploy vira "daemon sem
# resposta", que parece falha do compose.
resource "aws_vpc_security_group_egress_rule" "api_apt_http" {
  security_group_id = aws_security_group.api.id
  description       = "Saida HTTP para os repositorios do apt no primeiro boot."
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_security_group_egress_rule" "api_to_db" {
  security_group_id            = aws_security_group.api.id
  description                  = "5432 somente para o Postgres."
  referenced_security_group_id = aws_security_group.db.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

resource "aws_vpc_security_group_egress_rule" "api_https" {
  security_group_id = aws_security_group.api.id
  description       = "Saida HTTPS para o Docker Hub e para o provedor de LLM."
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_ingress_rule" "db_from_api" {
  security_group_id            = aws_security_group.db.id
  description                  = "5432 somente da camada api."
  referenced_security_group_id = aws_security_group.api.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

resource "aws_vpc_security_group_egress_rule" "db_apt_http" {
  security_group_id = aws_security_group.db.id
  description       = "Saida HTTP para os repositorios do apt no primeiro boot."
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_security_group_egress_rule" "db_https" {
  security_group_id = aws_security_group.db.id
  description       = "Saida HTTPS para o Docker Hub no pull da imagem do Postgres."
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}
