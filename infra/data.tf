# O sandbox nega escrita em IAM (access denied em iam:Create*): LabRole e o
# instance profile já existem na conta e só podem ser lidos. Criar aws_iam_*
# passa no plan e quebra no apply (docs/02 §4.3).
data "aws_iam_role" "lab" {
  name = "LabRole"
}

data "aws_iam_instance_profile" "lab" {
  name = var.instance_profile_name
}

data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"]

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}
