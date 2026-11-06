#!/usr/bin/env bash
# Local ClamAV for the real-scanner test (M12 B6). Throwaway config + signatures in a temp dir.
#   scripts/clamd-local.sh start   -> freshclam, start clamd on 127.0.0.1:${CLAMD_PORT:-3310}, wait for PONG
#   scripts/clamd-local.sh stop    -> stop that clamd and remove the temp dir
# Then: CLAMD_HOST=127.0.0.1 CLAMD_PORT=3310 pnpm exec vitest run src/lib/uploads/__tests__/clamd.int.test.ts
set -euo pipefail
PORT="${CLAMD_PORT:-3310}"
STATE="${TMPDIR:-/tmp}/nexaworks-clamd"
CLAMD="${CLAMD_BIN:-/opt/homebrew/sbin/clamd}"
FRESHCLAM="${FRESHCLAM_BIN:-/opt/homebrew/bin/freshclam}"

stop() {
  if [ -f "$STATE/clamd.pid" ]; then kill "$(cat "$STATE/clamd.pid")" 2>/dev/null || true; fi
  rm -rf "$STATE"
  echo "clamd stopped"
}

case "${1:-start}" in
  stop) stop; exit 0 ;;
  start) ;;
  *) echo "usage: $0 start|stop" >&2; exit 2 ;;
esac

[ -d "$STATE" ] && stop >/dev/null
mkdir -p "$STATE/db"
cat > "$STATE/freshclam.conf" <<CONF
DatabaseDirectory $STATE/db
DatabaseMirror database.clamav.net
CONF
cat > "$STATE/clamd.conf" <<CONF
DatabaseDirectory $STATE/db
TCPSocket $PORT
TCPAddr 127.0.0.1
Foreground yes
StreamMaxLength 1M
MaxFileSize 1M
LogFile $STATE/clamd.log
PidFile $STATE/clamd.pid
CONF
"$FRESHCLAM" --config-file="$STATE/freshclam.conf" 2>&1 | tee "$STATE/freshclam.log"
"$CLAMD" --config-file="$STATE/clamd.conf" > "$STATE/clamd.out" 2>&1 &
echo $! > "$STATE/clamd.pid"
for _ in $(seq 1 120); do
  if [ "$(printf 'zPING\0' | nc -w 2 127.0.0.1 "$PORT" 2>/dev/null | tr -d '\0')" = "PONG" ]; then
    echo "clamd ready on 127.0.0.1:$PORT (state in $STATE)"; exit 0
  fi
  sleep 1
done
echo "clamd did not answer PING; see $STATE/clamd.out" >&2; exit 1
