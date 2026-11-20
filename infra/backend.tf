# O backend é parcial de propósito: o bucket carrega o id da conta AWS e é criado
# fora do Terraform (scripts/bootstrap-state.sh), então o nome chega por
# `-backend-config` e nunca é versionado (docs/02 §7.3).
#
# use_lockfile = true: o lock mora no próprio S3, sem tabela DynamoDB — exige
# Terraform 1.10+.
terraform {
  backend "s3" {
    key          = "projeto2/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}
