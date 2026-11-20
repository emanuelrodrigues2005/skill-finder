# O EBS de dados é montado em /var/lib/docker inteiro, e não em um subdiretório:
# assim imagens, camadas e o volume nomeado do Postgres ficam fora do disco raiz,
# que é descartado quando a instância é recriada. Parar e subir a máquina
# (§4.2 do runbook) preserva o banco.
resource "aws_ebs_volume" "data" {
  availability_zone = data.aws_subnet.default.availability_zone
  size              = var.data_volume_gb
  type              = "gp3"

  tags = {
    Name    = "${var.project_name}-data"
    project = var.project_name
  }
}

resource "aws_volume_attachment" "data" {
  device_name = "/dev/sdf"
  volume_id   = aws_ebs_volume.data.id
  instance_id = aws_instance.app.id
}
