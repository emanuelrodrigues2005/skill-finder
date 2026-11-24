#!/usr/bin/env bash
# check-tf.sh — validate + plan resumido do Terraform.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1
source ~/.local/bin/academy-env >/dev/null 2>&1

terraform -chdir=infra init -reconfigure \
  -backend-config="bucket=bcc-cloud-tfstate-794399909334" -input=false >/dev/null 2>&1
echo "init=$?"

terraform -chdir=infra validate > /tmp/tfv.txt 2>&1
echo "validate=$?"
grep -E "Success|Error" /tmp/tfv.txt | head -3

terraform -chdir=infra plan -no-color > /tmp/tfp.txt 2>&1
echo "plan=$?"
grep -E "^Plan:" /tmp/tfp.txt
grep -c "must be replaced" /tmp/tfp.txt | sed 's/^/recursos a recriar: /'
grep -E "Error" /tmp/tfp.txt | head -3
