#!/bin/bash
# Навчальне відновлення бекапу фінпорталу: доводить, що копія у сховищі ВІДНОВЛЮЄТЬСЯ з повними даними,
# а не лише розшифровується.
#
# Береться найсвіжіша перевірена копія зі сховища (тека на Mac), розшифровується тут приватним ключем і
# потоком (через drill.mjs → SQL) іде в тимчасову базу на сервері — окремий контейнер postgres без мережі,
# після прогону видаляється. Потім з відновленої бази все вивантажується назад і звіряється з тим, що зняв
# бекап: кількість рядків і sha256 канонічного JSON кожної таблиці (тобто вміст рядок у рядок), а sha256
# кожного файлу інвойсу перевіряється ще до заливки. Відкритий текст на диск Mac не пишеться.
#
#   restore-drill.sh [файл.dump.age]   — прогнати зараз (за замовчуванням найсвіжіша перевірена копія)
#   restore-drill.sh --if-due          — лише якщо минув місяць від останнього вдалого (так його кличе pull-скрипт)
#
# Схема — з навчального відновлення BizDev / платформи (Павло). Провал — сповіщення macOS і код 1.

set -uo pipefail
umask 077

DEST="${DEST:-$HOME/db-backups-finportal}"
KEY="${KEY:-$HOME/.config/advantage-db-backup-bizdev/age-key.txt}"
HOST="${HOST:?HOST не задано (marko@<сервер>) — див. ~/.config/advantage-db-backup-finportal/host}"
DRILL_DAYS="${DRILL_DAYS:-30}"
RETRY_HOURS="${RETRY_HOURS:-20}"
NOTIFY="${NOTIFY:-1}"
IMAGE="${IMAGE:-postgres:15-alpine}"
CONTAINER="finportal-restore-drill"
HERE="$(cd "$(dirname "$0")" && pwd)"
NODE="${NODE:-$(ls -d "$HOME"/.nvm/versions/node/*/bin/node /opt/homebrew/bin/node /usr/local/bin/node 2>/dev/null | tail -1)}"
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=20 "$HOST")

mkdir -p "$DEST/drill-logs"
LOG="$DEST/drill-logs/drill-$(date -u +%Y%m%dT%H%M%SZ).log"
log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$LOG"; }
notify() {
  [ "$NOTIFY" = 1 ] || { log "(тестовий прогін: сповіщення не показано)"; return; }
  osascript -e "display notification \"$1\" with title \"Finportal backup\" sound name \"Basso\"" >/dev/null 2>&1 || true
}
fail() { log "FAIL: $1"; notify "Навчальне відновлення фінпорталу провалилось: $1"; exit 1; }

if [ "${1:-}" = "--if-due" ]; then
  now=$(date +%s)
  last_ok=$(stat -f %m "$DEST/.drill-last-ok" 2>/dev/null || echo 0)
  last_try=$(stat -f %m "$DEST/.drill-last-try" 2>/dev/null || echo 0)
  if [ $((now - last_ok)) -lt $((DRILL_DAYS * 86400)) ] || [ $((now - last_try)) -lt $((RETRY_HOURS * 3600)) ]; then rm -f "$LOG"; exit 0; fi
  shift
fi

FILE="${1:-}"
if [ -z "$FILE" ]; then
  for f in $(ls -1t "$DEST"/db-finportal-*.dump.age 2>/dev/null); do [ -e "$f.verified" ] && { FILE="$f"; break; }; done
fi
: > "$DEST/.drill-last-try"
[ -n "$FILE" ] && [ -f "$FILE" ] || fail "у сховищі немає перевіреної копії"
[ -s "$FILE.counts" ] || fail "до $(basename "$FILE") немає підрахунку (.counts) — нема з чим звіряти"
log "копія: $(basename "$FILE")"

TMP="$(mktemp -d)"
cleanup() { "${SSH[@]}" "docker rm -f $CONTAINER >/dev/null 2>&1"; rm -rf "$TMP"; }
trap cleanup EXIT

PW="$(openssl rand -hex 16)"   # одноразовий, лише для контейнера без мережі
PQ="docker exec -i $CONTAINER psql -U postgres -qAtX"
"${SSH[@]}" "{ docker rm -f $CONTAINER >/dev/null 2>&1 || true; } && docker run -d --name $CONTAINER --network none -e POSTGRES_PASSWORD=$PW $IMAGE >/dev/null \
  && for i in \$(seq 1 60); do $PQ -d postgres -c 'select 1' </dev/null >/dev/null 2>&1 && break; sleep 2; done \
  && sleep 3 && $PQ -d postgres -c 'create database drill' </dev/null" >/dev/null || fail "тимчасова база не піднялась"
log "тимчасова база: $IMAGE, без мережі"

t0=$(date +%s)
"$NODE" "$HERE/age-lite.mjs" decrypt "$KEY" "$FILE" 2> "$TMP/decrypt.err" \
  | "$NODE" "$HERE/drill.mjs" sql 2> "$TMP/sql.err" \
  | "${SSH[@]}" "$PQ -d drill" > /dev/null 2> "$TMP/restore.err"
rcs=("${PIPESTATUS[@]}")
[ "${rcs[0]}" -eq 0 ] || fail "копія не розшифрувалась: $(head -c 200 "$TMP/decrypt.err")"
[ "${rcs[1]}" -eq 0 ] || fail "знімок не перетворився на SQL: $(head -c 200 "$TMP/sql.err")"
[ "${rcs[2]}" -eq 0 ] || fail "заливка в тимчасову базу: $(grep -m2 -iE 'error|помилк' "$TMP/restore.err" | tr '\n' ' ' | cut -c1-200)"
log "$(cat "$TMP/sql.err") · залито за $(( $(date +%s) - t0 )) с"

# Вивантажити все з відновленої бази й звірити з мить-бекапу (рядки + вміст)
"${SSH[@]}" "$PQ -d drill" <<'SQL' | "$NODE" "$HERE/drill.mjs" verify "$FILE.counts" > "$TMP/verify.txt" 2>&1
select json_build_object(
  'global_settings', (select coalesce(json_agg(to_jsonb(g) order by g.id), '[]'::json) from public.global_settings g),
  'monthly_data',    (select coalesce(json_agg(to_jsonb(m) order by m.month_key), '[]'::json) from public.monthly_data m));
SQL
vrc=${PIPESTATUS[1]}
tee -a "$LOG" < "$TMP/verify.txt"
[ "$vrc" -eq 0 ] || fail "відновлене не збіглося з бекапом ($(basename "$FILE"))"
log "OK: обидві таблиці відновились рядок у рядок, файли інвойсів цілі"
: > "$DEST/.drill-last-ok"
