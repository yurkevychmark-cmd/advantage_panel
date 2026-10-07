#!/usr/bin/env bash
# Зашифрований нічний бекап бази фінпорталу (Supabase, Free plan — власних бекапів у Supabase немає).
#
# finportal-dump.mjs знімає всі рядки обох таблиць і файли інвойсів зі Storage → JSON іде конвеєром в age
# (відкритий текст на диск не потрапляє), поруч — sha256 відкритого знімка і підрахунок (.counts) для
# навчального відновлення. Копії забирає Mac Марка (pull-finportal-backups.sh), там же ротація 7/4/6 і
# щомісячне навчальне відновлення (restore-drill.sh). Побічно щоденний запит не дає Free-проєкту заснути.
#
# Схема — як у бекапі BizDev (/opt/bizdev/backup, автор схеми Павло). Відмінності: база не в контейнері на
# сервері, а в Supabase — тому не pg_dump, а REST із секретним ключем; плюс файли Storage.
#
# Живе на сервері в ~/finportal/backup, запускається кроном від marko (03:47). Конфіг — backup.env поруч,
# chmod 600: FINPORTAL_SUPABASE_URL, FINPORTAL_SERVICE_ROLE_KEY (кладе Марко), AGE_RECIPIENTS (публічні ключі
# age: Марка й бекапів платформи). Приватних ключів на сервері немає — свої бекапи сервер розшифрувати не може.

set -Eeuo pipefail
umask 077

HERE="$(cd "$(dirname "$0")" && pwd)"
CONFIG="${FINPORTAL_BACKUP_CONFIG:-$HERE/backup.env}"
[ -f "$CONFIG" ] && . "$CONFIG"

: "${AGE_RECIPIENTS:?AGE_RECIPIENTS не задано — публічні ключі age через пробіл}"
: "${FINPORTAL_SUPABASE_URL:?FINPORTAL_SUPABASE_URL не задано}"
: "${FINPORTAL_SERVICE_ROLE_KEY:?FINPORTAL_SERVICE_ROLE_KEY не задано — секретний ключ Supabase (кладе Марко)}"
export FINPORTAL_SUPABASE_URL FINPORTAL_SERVICE_ROLE_KEY FINPORTAL_INVOICE_BUCKET="${FINPORTAL_INVOICE_BUCKET:-invoices}"
SPOOL="${SPOOL:-$HOME/finportal/backups}"
RETAIN_LOCAL="${RETAIN_LOCAL:-7}"
STATUS_FILE="${STATUS_FILE:-$SPOOL/last-success}"
MIN_BYTES="${MIN_BYTES:-50000}"   # знімок ~1 МБ (07.10.2026); менше 50 КБ — щось зламалось
NODE="${NODE:-$(command -v node)}"

recipients=()
for r in $AGE_RECIPIENTS; do recipients+=(-r "$r"); done

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$SPOOL"
db_file="$SPOOL/db-finportal-$stamp.dump.age"

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }
cleanup_parts() { rm -f "$db_file.part" "$db_file.sha256.part" "$db_file.counts.part" "$SPOOL/.hash.fifo"; }
fail() { log "FAIL: $*"; cleanup_parts; exit 1; }
trap 'fail "рядок $LINENO: $BASH_COMMAND"' ERR
trap cleanup_parts EXIT

log "start $stamp"
mkfifo "$SPOOL/.hash.fifo"
sha256sum < "$SPOOL/.hash.fifo" | cut -c1-64 > "$db_file.sha256.part" &
hash_pid=$!
"$NODE" "$HERE/finportal-dump.mjs" --counts "$db_file.counts.part" \
  | tee "$SPOOL/.hash.fifo" \
  | age "${recipients[@]}" -o "$db_file.part"
rcs=("${PIPESTATUS[@]}")
wait "$hash_pid" || fail "sha256 не порахувався"
[ "${rcs[0]}" -eq 0 ] || fail "знімок не знявся (finportal-dump.mjs код ${rcs[0]})"
[ "${rcs[1]}" -eq 0 ] && [ "${rcs[2]}" -eq 0 ] || fail "шифрування не вдалось (tee ${rcs[1]}, age ${rcs[2]})"

size=$(stat -c %s "$db_file.part")
[ "$size" -ge "$MIN_BYTES" ] || fail "копія підозріло мала: $size байт < $MIN_BYTES"
[ -s "$db_file.sha256.part" ] && [ -s "$db_file.counts.part" ] || fail "немає sha256 або підрахунку"

mv "$db_file.counts.part" "$db_file.counts"
mv "$db_file.sha256.part" "$db_file.sha256"
mv "$db_file.part" "$db_file"
log "ok $(basename "$db_file") ${size} bytes · $(tr '\n' ' ' < "$db_file.counts" | sed -E 's/sha\.[^ ]*//g' | tr -s ' ')"

# Локальна черга: останні RETAIN_LOCAL копій (довге зберігання — на Mac, rotate.mjs)
ls -1t "$SPOOL"/db-finportal-*.dump.age 2>/dev/null | tail -n +"$((RETAIN_LOCAL + 1))" \
  | sed 'p;s/$/.sha256/p;s/\.sha256$/.counts/' | xargs -r rm -f
date -u +%FT%TZ > "$STATUS_FILE"
