#!/usr/bin/env bash
# hosts.sh — lista as instancias do projeto com o papel de cada uma.
#
# Existe porque o `--query` do aws com filtro JMESPath dentro de aspas aninhadas
# e o tipo de coisa que quebra em shell aninhado (getopt do aws interpreta `[0]}`
# como glob). Aqui a consulta e simples e o pareamento com o papel e feito em
# Python, que nao tem esse problema.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1
source ~/.local/bin/academy-env >/dev/null 2>&1

aws ec2 describe-instances --region us-east-1 \
  --filters "Name=instance-state-name,Values=running" \
  --query 'Reservations[].Instances[].{id:InstanceId,name:Tags}' \
  --output json 2>/dev/null \
| python3 -c '
import json, sys
d = json.load(sys.stdin)
if not d:
    print("nenhuma instancia rodando")
for i in d:
    tags = {t.get("Key"): t.get("Value") for t in (i.get("name") or [])}
    papel = tags.get("Name") or tags.get("name") or "?"
    print(f"  {i.get(\"id\")}  {papel}")
'
