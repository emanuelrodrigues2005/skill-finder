# O par foi criado na F0 e a privada vive só em ~/.ssh (docs/02 §10.1). O
# Terraform lê apenas o nome: nenhum material de chave entra no state nem no
# repositório, e recriar a instância não gera chave nova.
data "aws_key_pair" "projeto2" {
  key_name = var.key_name
}
