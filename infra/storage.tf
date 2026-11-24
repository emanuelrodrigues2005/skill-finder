# O EBS de dados é montado em /var/lib/docker inteiro, e não em um subdiretório:
# assim imagens, camadas e o volume nomeado do Postgres ficam fora do disco raiz,
# que é descartado quando a instância é recriada. Parar e subir a máquina
# (§4.2 do runbook) preserva o banco.
resource "aws_ebs_volume" "data" {
  for_each = { for role, config in local.roles : role => config if config.data_volume }

  availability_zone = data.aws_subnet.default.availability_zone
  size              = var.data_volume_gb
  type              = "gp3"

  tags = {
    Name    = "${var.project_name}-${each.key}-data"
    project = var.project_name
  }
}

resource "aws_volume_attachment" "data" {
  for_each = aws_ebs_volume.data

  device_name = "/dev/sdf"
  volume_id   = each.value.id
  instance_id = aws_instance.role[each.key].id
}
