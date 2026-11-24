output "instance_ids" {
  description = "Id da instancia de cada papel (web, api, db)."
  value       = { for role, instance in aws_instance.role : role => instance.id }
}

output "web_private_ip" {
  description = "IPv4 privado da web; alvo do balanceador (#70)."
  value       = aws_instance.role["web"].private_ip
}

output "api_private_ip" {
  description = "IPv4 privado da api; alvo do balanceador (#70)."
  value       = aws_instance.role["api"].private_ip
}

output "db_private_ip" {
  description = "IPv4 privado do db; alvo 5432 alcancado pela api."
  value       = aws_instance.role["db"].private_ip
}

# A api e a unica camada com IP publico e com a regra 22 opcional: o smoke atual
# a alcanca por IP ate a #74 passar a usar o DNS do balanceador.
output "host_public_ip" {
  description = "IPv4 publico da api; muda a cada stop/start."
  value       = aws_instance.role["api"].public_ip
}

locals {
  image_repository = {
    api = "${var.dockerhub_user}/${var.project_name}-api"
    web = "${var.dockerhub_user}/${var.project_name}-web"
  }
}

output "dockerhub_user" {
  description = "Usuario do Docker Hub que publica as imagens consumidas pelo host."
  value       = var.dockerhub_user
}

output "image_repository" {
  description = "Repositorio de cada servico, por nome, sem a tag."
  value       = local.image_repository
}

output "state_bucket" {
  description = "Bucket do state remoto, repetido no output para o runbook nao reler o bootstrap."
  value       = var.state_bucket
}

output "target_port" {
  description = "Porta publicada pelo nginx da borda no host."
  value       = 80
}

output "alb_dns_name" {
  description = "DNS do balanceador; e o BASE_URL do smoke e da demo."
  value       = aws_lb.this.dns_name
}

output "alb_arn" {
  description = "ARN do balanceador; a varredura de orfaos da F7.9 consulta por ele."
  value       = aws_lb.this.arn
}
