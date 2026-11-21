terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  # A sessão do Learner Lab só é válida em us-east-1; parametrizar a região faria
  # todo apply falhar com UnauthorizedOperation (docs/02 §5).
  region = "us-east-1"
}
