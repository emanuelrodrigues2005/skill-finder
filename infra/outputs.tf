output "host_public_ip" {
  description = "IPv4 publico da instancia; muda a cada stop/start."
  value       = aws_instance.app.public_ip
}

output "ecr_registry" {
  description = "Host do registry para docker login e para o compose de producao."
  value       = split("/", aws_ecr_repository.app["api"].repository_url)[0]
}

output "ecr_repository_urls" {
  description = "URL de cada repositorio, por servico."
  value       = { for name, repo in aws_ecr_repository.app : name => repo.repository_url }
}

output "state_bucket" {
  description = "Bucket do state remoto, repetido no output para o runbook nao reler o bootstrap."
  value       = var.state_bucket
}

output "target_port" {
  description = "Porta publicada pelo nginx da borda no host."
  value       = 80
}
