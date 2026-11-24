locals {
  # Três camadas, uma instância cada. A web não tem volume nem banco, então cabe no
  # tipo menor; api e db rodam Postgres e o Docker com as duas imagens.
  roles = {
    web = { instance_type = "t3.micro", data_volume = false }
    api = { instance_type = "t3.small", data_volume = true }
    db  = { instance_type = "t3.small", data_volume = true }
  }

  user_data_head = <<-EOT
    #!/usr/bin/env bash
    set -euxo pipefail
    export DEBIAN_FRONTEND=noninteractive

    apt-get update -y
    apt-get install -y --no-install-recommends \
      docker.io docker-compose-v2 e2fsprogs util-linux

    systemctl stop docker.socket docker || true
  EOT

  user_data_tail = <<-EOT
    systemctl enable --now docker
    usermod -aG docker ubuntu

    # O pull e anonimo: os repositorios do Docker Hub sao publicos, entao o host nao
    # precisa de `docker login`, de credential helper nem de credencial em disco.
    mkdir -p /opt/app
    chown ubuntu:ubuntu /opt/app
  EOT

  # Só api e db montam EBS: o disco raiz é descartado quando a instância é
  # recriada, e o volume nomeado do Postgres precisa sobreviver a isso. Na web o
  # nginx só serve estático, então não há estado a preservar. O caminho by-id
  # evita casar com outro disco anexado antes do volume de dados aparecer.
  user_data_mount_template = <<-EOT
    data_disk="/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_%s"
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
  EOT

  user_data_mount = {
    for role, volume in aws_ebs_volume.data : role => format(
      local.user_data_mount_template,
      replace(volume.id, "-", ""),
    )
  }

  # Papéis com volume: o trecho de mount depende do id do volume, então só existe
  # para api e db. A web usa local.user_data_base e fica conhecida já no plan.
  user_data_by_role = {
    for role, mount in local.user_data_mount : role => join("\n", [
      local.user_data_head, mount, local.user_data_tail,
    ])
  }

  user_data_base = join("\n", [local.user_data_head, local.user_data_tail])
}

resource "aws_instance" "role" {
  for_each = local.roles

  ami                         = data.aws_ami.ubuntu.id
  instance_type               = each.value.instance_type
  subnet_id                   = data.aws_subnet.default.id
  vpc_security_group_ids      = [local.security_group_by_role[each.key]]
  iam_instance_profile        = data.aws_iam_instance_profile.lab.name
  key_name                    = var.key_name
  associate_public_ip_address = true

  # Só papéis com volume passam pelo mount; o ramo não escolhido não é avaliado,
  # então a web não aponta para um volume que ela não tem.
  user_data = each.value.data_volume ? local.user_data_by_role[each.key] : local.user_data_base

  # IMDSv2 obrigatorio: sem isto a instancia aceita requisicao de metadado por GET,
  # que qualquer SSRF converte em credencial. Declarar torna a exigencia explicita.
  metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  # O runbook (docs/runbook-operacao.md §3.2) varre órfãos por tag:project, então
  # todo recurso criado aqui precisa carregar essa tag com o mesmo valor.
  tags = {
    Name    = "${var.project_name}-${each.key}"
    role    = each.key
    project = var.project_name
  }
}
