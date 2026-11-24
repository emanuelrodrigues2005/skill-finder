# O balanceador exige ao menos duas AZs. Os ids vêm de data porque a VPC padrão é
# da conta, não do Terraform (network.tf); a primeira subnet é a das instâncias,
# para um alvo não depender de tráfego entre zonas.
#
# `default-for-az` não é decoração: sem ele, uma subnet criada à mão na VPC padrão
# pode entrar na lista, empatar na AZ com a da instância e o mapa `az => id`
# colapsar — o ALB nasce com as duas subnets na mesma zona e o `create` falha.
data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }

  filter {
    name   = "default-for-az"
    values = ["true"]
  }
}

data "aws_subnet" "alb_candidate" {
  for_each = toset(data.aws_subnets.default.ids)

  id = each.value
}

locals {
  alb_candidate_by_az = {
    for id in data.aws_subnets.default.ids :
    data.aws_subnet.alb_candidate[id].availability_zone => id
  }

  alb_subnet_ids = [
    data.aws_subnet.default.id,
    [
      for az in sort(keys(local.alb_candidate_by_az)) :
      local.alb_candidate_by_az[az]
      if az != data.aws_subnet.default.availability_zone
    ][0],
  ]
}

resource "aws_lb" "this" {
  name                       = "${var.project_name}-alb"
  internal                   = false
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.alb.id]
  subnets                    = local.alb_subnet_ids
  idle_timeout               = 240
  enable_deletion_protection = false

  # Header malformado nao chega ao backend: uma linha, sem efeito em cliente
  # legitimo, e o unico controle de borda de L7 que o lab permite (sem WAF).
  drop_invalid_header_fields = true

  # `append` explícito: no modo `preserve` o cliente escolhe a última entrada do
  # X-Forwarded-For, que é exatamente a que a api lê como `req.ip` (ADR-015). Com
  # a porta do cliente ligada a entrada vira IP:porta e o bucket passa a ser por
  # conexão TCP, então ela fica desligada.
  xff_header_processing_mode = "append"
  enable_xff_client_port     = false

  tags = {
    Name    = "${var.project_name}-alb"
    project = var.project_name
  }
}

locals {
  target_groups = {
    web = { port = 80, health_path = "/" }
    api = { port = 8000, health_path = "/healthz" }
    obs = { port = 3000, health_path = "/grafana/api/health" }
  }
}

resource "aws_lb_target_group" "role" {
  for_each = local.target_groups

  name        = "${var.project_name}-tg-${each.key}"
  port        = each.value.port
  protocol    = "HTTP"
  vpc_id      = data.aws_vpc.default.id
  target_type = "instance"

  # `/healthz`, nunca `/readyz`: o readyz responde 503 com catálogo velho e o ALB
  # tiraria do ar uma api sadia. Degradação é visível ao usuário, não motivo de
  # drenagem (ADR-014).
  health_check {
    enabled             = true
    path                = each.value.health_path
    port                = "traffic-port"
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = {
    Name    = "${var.project_name}-tg-${each.key}"
    project = var.project_name
  }
}

# Uma instância por papel: web → tg-web, api → tg-api e a observabilidade que roda
# na própria api → tg-obs.
locals {
  target_attachments = {
    web = { role = "web", target_group = "web", port = 80 }
    api = { role = "api", target_group = "api", port = 8000 }
    obs = { role = "api", target_group = "obs", port = 3000 }
  }
}

resource "aws_lb_target_group_attachment" "role" {
  for_each = local.target_attachments

  target_group_arn = aws_lb_target_group.role[each.value.target_group].arn
  target_id        = aws_instance.role[each.value.role].id
  port             = each.value.port
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.role["web"].arn
  }
}

# Prioridade explícita e caminho da api separado do web: `/api/*` nunca vai para o
# tg-web, porque o `$remote_addr` que o nginx escreveria seria o IP do ALB e todos
# os clientes cairiam no mesmo bucket do rate limit (ADR-015). As duas sondas da
# api têm regra própria, e a observabilidade tem prefixo próprio (`/grafana/`)
# para um único salto ALB → Grafana.
locals {
  listener_rules = {
    api     = { priority = 10, patterns = ["/api/*"], target = "api" }
    healthz = { priority = 20, patterns = ["/healthz"], target = "api" }
    readyz  = { priority = 30, patterns = ["/readyz"], target = "api" }
    grafana = { priority = 40, patterns = ["/grafana/*"], target = "obs" }
  }
}

resource "aws_lb_listener_rule" "path" {
  for_each = local.listener_rules

  listener_arn = aws_lb_listener.http.arn
  priority     = each.value.priority

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.role[each.value.target].arn
  }

  condition {
    path_pattern {
      values = each.value.patterns
    }
  }
}
