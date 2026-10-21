#!/usr/bin/env bash
# envincer dev lifecycle. Commands: start | stop | restart | status | logs | check
# Listens on 127.0.0.1 and the Tailscale address (see HOST in .env.example), port 4190.
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-4190}"
RUN=.run
PID="$RUN/server.pid"
LOG="$RUN/server.log"
mkdir -p "$RUN"

log() { echo "[dev.sh] $*"; }
running() { [[ -f "$PID" ]] && kill -0 "$(cat "$PID")" 2>/dev/null; }

start() {
  if running; then log "already running (pid $(cat "$PID")) on :$PORT"; return; fi
  if ss -ltn "sport = :$PORT" 2>/dev/null | grep -q LISTEN; then
    log "refusing to start: port $PORT is held by another process"; exit 1
  fi
  [[ -d node_modules ]] || npm install --no-fund --no-audit
  nohup node server/index.js >>"$LOG" 2>&1 &
  echo $! >"$PID"
  for _ in $(seq 1 30); do
    if curl -fs "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
      log "started (pid $(cat "$PID"))"; grep '\[envincer\] http' "$LOG" | tail -2; return
    fi
    sleep 0.2
  done
  log "did not answer on :$PORT — last log lines:"; tail -20 "$LOG"; exit 1
}

stop() {
  if running; then kill "$(cat "$PID")"; for _ in $(seq 1 25); do running || break; sleep 0.2; done; log "stopped"; else log "not running"; fi
  rm -f "$PID"
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status) if running; then log "running (pid $(cat "$PID")) on :$PORT"; else log "not running"; fi ;;
  logs) tail -n 200 -f "$LOG" ;;
  check) npm test ;;
  *) echo "usage: ./dev.sh start|stop|restart|status|logs|check"; exit 1 ;;
esac
