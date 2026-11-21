output "host_public_ip" {
  description = "IPv4 publico da instancia; muda a cada stop/start."
  value       = aws_instance.app.public_ip
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
