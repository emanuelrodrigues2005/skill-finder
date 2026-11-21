locals {
  data_volume_device = "/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${replace(aws_ebs_volume.data.id, "-", "")}"

  user_data = <<-EOT
    #!/usr/bin/env bash
    set -euxo pipefail
    export DEBIAN_FRONTEND=noninteractive

    apt-get update -y
    apt-get install -y --no-install-recommends \
      docker.io docker-compose-v2 e2fsprogs util-linux

    systemctl stop docker.socket docker || true

    data_disk="${local.data_volume_device}"
    for _ in $(seq 1 60); do
      [ -e "$data_disk" ] && break
      sleep 5
    done
    [ -e "$data_disk" ] || { echo "volume EBS de dados nao anexado" >&2; exit 1; }

    if [ -z "$(blkid -o value -s TYPE "$data_disk" || true)" ]; then
      mkfs.ext4 -L docker-data "$data_disk"
    fi

    mkdir -p /var/lib/docker
    grep -q "LABEL=docker-data" /etc/fstab \
      || echo "LABEL=docker-data /var/lib/docker ext4 defaults,nofail 0 2" >> /etc/fstab
    mountpoint -q /var/lib/docker || mount LABEL=docker-data /var/lib/docker

    systemctl enable --now docker
    usermod -aG docker ubuntu

    # O pull e anonimo: os repositorios do Docker Hub sao publicos, entao o host nao
    # precisa de `docker login`, de credential helper nem de credencial em disco.
    mkdir -p /opt/app
    chown ubuntu:ubuntu /opt/app
  EOT
}

resource "aws_instance" "app" {
  ami                         = data.aws_ami.ubuntu.id
  instance_type               = var.instance_type
  subnet_id                   = data.aws_subnet.default.id
  vpc_security_group_ids      = [aws_security_group.app.id]
  iam_instance_profile        = data.aws_iam_instance_profile.lab.name
  key_name                    = var.key_name
  associate_public_ip_address = true

  # IMDSv2 obrigatorio: sem isto a instancia aceita requisicao de metadado por GET,
  # que qualquer SSRF converte em credencial. Declarar torna a exigencia explicita.
  metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }
  user_data = local.user_data

  # O runbook (docs/runbook-operacao.md §3.2) varre órfãos por tag:project, então
  # todo recurso criado aqui precisa carregar essa tag com o mesmo valor.
  tags = {
    Name    = "${var.project_name}-app"
    project = var.project_name
  }
}
