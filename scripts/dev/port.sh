#!/usr/bin/env bash
# port.sh — inspeciona e libera as portas do backend e do frontend.
#
# Subcomandos:
#   list        mostra o estado das duas portas (padrão)
#   assert-free sai 0 se ambas estão livres, 1 se alguma está ocupada
#   free        libera o que pertence a este repositório; NUNCA mata processo alheio
#   wait        espera os containers de API e web ficarem healthy (timeout 120 s)
#   url         imprime as URLs de entrada
#
# Por que existe: a porta 8080 deste host vive presa por um proxy órfão do Docker
# Desktop, e `docker compose down` não a solta. Melhor detectar e dizer do que
# descobrir no meio de um `up` com "address already in use".
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Portas com default; o `.env` do repositório tem a palavra final. Ele é nosso e
# tem só `CHAVE=valor` e comentários, então source é seguro e é o mesmo que o
# `docker compose` faz.
API_PORT=8090
WEB_PORT=8081
if [ -f "$ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/.env"
  set +a
fi

# O nome do projeto vem do `compose.yaml` (`name:`), não do diretório: o compose
# chamaria o projeto de "cloud" (nome da pasta) se não fosse o `name:` explícito,
# e a heurística de dono erraria em todo container.
COMPOSE_PROJECT="$(sed -n 's/^name:[[:space:]]*\([A-Za-z0-9_.-]*\).*/\1/p' "$ROOT/compose.yaml" | head -1)"
[ -n "$COMPOSE_PROJECT" ] || COMPOSE_PROJECT="$(basename "$ROOT" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9')"

# Cor só quando a saída é um terminal: quando o `make` redireciona para arquivo ou
# pipe, os escapes ficariam no log e `grep` passaria a não casar.
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  cor_ok()   { printf '\033[32m%s\033[0m' "$1"; }
  cor_aviso(){ printf '\033[33m%s\033[0m' "$1"; }
  cor_erro() { printf '\033[31m%s\033[0m' "$1"; }
else
  cor_ok()   { printf '%s' "$1"; }
  cor_aviso(){ printf '%s' "$1"; }
  cor_erro() { printf '%s' "$1"; }
fi

# Quem escuta na porta: PID e comando, quando o `ss` permite ver (precisa de root
# para `-p` de processos de outro usuário; cai no nome do container se falhar).
quem_escuta() {
  local porta="$1" linha pid cmd
  if command -v ss >/dev/null 2>&1; then
    linha="$(ss -ltnpH "sport = :$porta" 2>/dev/null | head -1)"
    if [ -n "$linha" ]; then
      pid="$(printf '%s' "$linha" | sed -n 's/.*pid=\([0-9]*\).*/\1/p')"
      cmd="$(printf '%s' "$linha" | sed -n 's/.*users:(("\?\([^"]*\)"\?.*/\1/p')"
      printf 'pid=%s cmd=%s' "${pid:-?}" "${cmd:-?}"
      return 0
    fi
  fi
  if command -v lsof >/dev/null 2>&1; then
    pid="$(lsof -ti "tcp:$porta" 2>/dev/null | head -1)"
    if [ -n "$pid" ]; then
      printf 'pid=%s cmd=%s' "$pid" "$(ps -p "$pid" -o comm= 2>/dev/null || echo '?')"
      return 0
    fi
  fi
  return 1
}

# Container deste projeto que publica a porta (vazio se nenhum).
container_da_porta() {
  docker ps --filter "publish=$1" --format '{{.Names}}' 2>/dev/null | head -1
}

# `ours`: o container pertence ao projeto compose deste repositório.
eh_nosso() {
  local nome="$1"
  [ -n "$nome" ] && printf '%s' "$nome" | grep -q "^${COMPOSE_PROJECT}[-_]"
}

estado_da_porta() {
  local rotulo="$1" porta="$2" container holder
  container="$(container_da_porta "$porta")"
  if eh_nosso "$container"; then
    printf '  %-9s %-5s %s  container=%s\n' "$rotulo" "$porta" "$(cor_ok 'OCUPADA (nossa)')" "$container"
    return 2
  fi
  if [ -n "$container" ]; then
    printf '  %-9s %-5s %s  container=%s (de outro projeto)\n' "$rotulo" "$porta" "$(cor_aviso 'OCUPADA (alheia)')" "$container"
    return 3
  fi
  if holder="$(quem_escuta "$porta")"; then
    printf '  %-9s %-5s %s  %s\n' "$rotulo" "$porta" "$(cor_erro 'OCUPADA (processo)')" "$holder"
    return 3
  fi
  printf '  %-9s %-5s %s\n' "$rotulo" "$porta" "$(cor_ok 'livre')"
  return 0
}

cmd_list() {
  local r_api=0 r_web=0
  echo "portas deste projeto (API=${API_PORT} WEB=${WEB_PORT}, projeto compose=${COMPOSE_PROJECT})"
  estado_da_porta "API" "$API_PORT" || r_api=$?
  estado_da_porta "WEB" "$WEB_PORT" || r_web=$?
  echo
  if [ "$r_api" -eq 0 ] && [ "$r_web" -eq 0 ]; then
    echo "$(cor_ok 'ambas livres') — pode subir"
    return 0
  fi
  echo "$(cor_aviso 'alguma ocupada') — rode 'make port/free' para liberar o que é nosso"
  # 2 = nossa (dá para liberar); 3 = alheia (só o dono resolve)
  if [ "$r_api" -eq 3 ] || [ "$r_web" -eq 3 ]; then
    return 3
  fi
  return 2
}

cmd_assert_free() {
  local r_api=0 r_web=0
  estado_da_porta "API" "$API_PORT" >/dev/null 2>&1 || r_api=$?
  estado_da_porta "WEB" "$WEB_PORT" >/dev/null 2>&1 || r_web=$?
  [ "$r_api" -eq 0 ] && [ "$r_web" -eq 0 ]
}

cmd_free() {
  local antes_api antes_web depois_api=0 depois_web=0
  antes_api="$(container_da_porta "$API_PORT")"
  antes_web="$(container_da_porta "$WEB_PORT")"

  echo "liberando as portas do projeto..."
  # Só derruba o que é NOSSO: os dois profiles, sem tocar em volume (o banco
  # sobrevive) e sem `--volumes`.
  ( cd "$ROOT" && docker compose --profile dev --profile prod down --remove-orphans ) 2>&1 | sed 's/^/  /'
  # O banco descartável de teste ocupa 55432, não as portas da aplicação, mas
  # deixá-lo de pé entre sessões só gasta recurso.
  docker rm -f skills-db-test >/dev/null 2>&1 && echo "  skills-db-test removido"

  sleep 1
  estado_da_porta "API" "$API_PORT" >/dev/null 2>&1 || depois_api=$?
  estado_da_porta "WEB" "$WEB_PORT" >/dev/null 2>&1 || depois_web=$?

  if [ "$depois_api" -eq 0 ] && [ "$depois_web" -eq 0 ]; then
    echo "$(cor_ok 'portas livres')"
    return 0
  fi

  echo
  echo "$(cor_erro 'ainda ocupadas') — e NÃO é deste repositório:"
  estado_da_porta "API" "$API_PORT" || true
  estado_da_porta "WEB" "$WEB_PORT" || true
  echo
  echo "Não mato processo alheio automaticamente. Se for um proxy órfão do Docker"
  echo "Desktop, reinicie o Docker Desktop; se preferir, mude API_PORT/WEB_PORT no .env."
  return 1
}

cmd_wait() {
  local limite=120 inicio agora estado_api estado_web
  inicio="$(date +%s)"
  while :; do
    estado_api="$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose --project-directory "$ROOT" --profile dev ps -q api-dev 2>/dev/null | head -1)" 2>/dev/null || echo '?')"
    estado_web="$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose --project-directory "$ROOT" --profile dev ps -q web 2>/dev/null | head -1)" 2>/dev/null || echo '?')"
    if [ "$estado_api" = "healthy" ] && [ "$estado_web" = "healthy" ]; then
      echo "  api-dev healthy, web healthy"
      return 0
    fi
    agora="$(date +%s)"
    if [ $((agora - inicio)) -ge "$limite" ]; then
      echo "$(cor_erro 'timeout') esperando os containers (api=${estado_api:-?} web=${estado_web:-?})"
      ( cd "$ROOT" && docker compose --profile dev ps )
      return 1
    fi
    sleep 3
  done
}

cmd_url() {
  cat <<EOF

  SPA   http://localhost:${WEB_PORT}
  API   http://localhost:${API_PORT}   (healthz, readyz, metrics, /docs)
  direto no container: api:8000 (a SPA fala por aí; ${API_PORT} é só o acesso do host)

EOF
}

case "${1:-list}" in
  list)        cmd_list ;;
  assert-free) cmd_assert_free ;;
  free)        cmd_free ;;
  wait)        cmd_wait ;;
  url)         cmd_url ;;
  *)
    echo "uso: $0 [list|assert-free|free|wait|url]" >&2
    exit 64
    ;;
esac
