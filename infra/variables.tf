variable "project_name" {
  description = "Nome curto do projeto, usado em tags e no prefixo dos recursos."
  type        = string
}

variable "instance_type" {
  description = "Tipo da instância EC2, restrito às famílias liberadas pelo lab (t2/t3)."
  type        = string
  default     = "t3.small"
}

variable "key_name" {
  description = "Key pair já criado na F0, usado no acesso SSH à instância."
  type        = string
  default     = "vockey"
}

variable "instance_profile_name" {
  description = "Instance profile pré-existente na conta; o Terraform apenas o lê."
  type        = string
  default     = "LabInstanceProfile"
}

variable "allowed_ssh_cidrs" {
  description = "CIDRs autorizados na porta 22; lista vazia mantém o SSH fechado."
  type        = list(string)
  default     = []
}

variable "data_volume_gb" {
  description = "Tamanho do volume EBS de dados, em GiB."
  type        = number
  default     = 20
}

variable "state_bucket" {
  description = "Bucket do state remoto, repetido aqui porque o bloco backend não aceita variável."
  type        = string
}

variable "dockerhub_user" {
  description = "Usuário do Docker Hub que publica as imagens públicas consumidas pelo host."
  type        = string
  default     = "emanuelr05"
}
