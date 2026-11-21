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

resource "aws_security_group" "app" {
  name        = "${var.project_name}-app"
  description = "Entrada HTTP publica e SSH opcional; saida livre."
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = "HTTP publico: o nginx da borda serve a SPA e faz proxy de /api."
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # SSH fechado por padrão: sem CIDR em var.allowed_ssh_cidrs a regra 22 nem
  # existe, então nenhuma varredura de porta encontra sshd exposto na internet.
  dynamic "ingress" {
    for_each = length(var.allowed_ssh_cidrs) > 0 ? [1] : []

    content {
      description = "SSH restrito as redes declaradas em allowed_ssh_cidrs."
      from_port   = 22
      to_port     = 22
      protocol    = "tcp"
      cidr_blocks = var.allowed_ssh_cidrs
    }
  }

  egress {
    description = "Saida livre: pull do Docker Hub, apt e chamada ao provedor de LLM."
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name    = "${var.project_name}-app"
    project = var.project_name
  }
}
