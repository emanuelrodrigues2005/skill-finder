#!/usr/bin/env bash
# session-on.sh — carrega a sessao e PROVA que ela funciona de verdade.
#
# O `academy_whoami` testa so `sts:GetCallerIdentity`, que responde mesmo com a
# credencial cancelada (`voc-cancel-cred`). Este script testa uma leitura real.
set -uo pipefail
cd /mnt/c/Users/Lima02/Documents/bcc/cloud || exit 1
source ~/.local/bin/academy-env >/dev/null 2>&1

echo "== identidade =="
aws sts get-caller-identity --query Account --output text 2>&1 | head -1

echo "== acao real (prova que nao esta cancelada) =="
if out="$(aws ec2 describe-instances --max-items 1 --query 'Reservations[].Instances[].InstanceId' --output text 2>&1)"; then
  echo "  OK: credencial viva (instancias: ${out:-nenhuma})"
else
  echo "  FALHA: $out" | head -3
  exit 1
fi
