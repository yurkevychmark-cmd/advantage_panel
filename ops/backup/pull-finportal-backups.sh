#!/bin/bash
# Забрати зашифровані бекапи бази фінпорталу із сервера на Mac Марка і перевірити їх.
#
# Запускає launchd щогодини (co.advantage-agency.finportal-backup-pull.plist поруч). Сервер знімає копію раз на
# добу (finportal-backup.sh, крон 03:47) і тримає 7 останніх. Тут — сховище: кожну нову копію розшифровуємо в
# пам'яті приватним ключем і звіряємо sha256 з тим, що сервер порахував при знятті (відкритий текст на диск не
# пишеться); ротація 7 денних / 4 тижневі / 6 місячних (rotate.mjs); раз на місяць — навчальне відновлення
# (restore-drill.sh). Якщо копія не сходиться, найсвіжіша старша за STALE_HOURS або відновлення провалилось —
# сповіщення macOS.
#
# Схема, age-lite.mjs і rotate.mjs — з бекапу BizDev / платформи (Павло). Ключ — той самий приватний ключ Марка.

set -uo pipefail
umask 077

# Справжні теки — поза ~/Desktop: фонову задачу launchd macOS (TCC) туди не пускає.
CONF_DIR="$HOME/.config/advantage-db-backup-finportal"
DEST="${DEST:-$HOME/db-backups-finportal}"
KEY="${KEY:-$HOME/.config/advantage-db-backup-bizdev/age-key.txt}"
HOST="${HOST:-$(cat "$CONF_DIR/host" 2>/dev/null)}"
SRC="${SRC:-finportal/backups/}"
STALE_HOURS="${STALE_HOURS:-26}"
NOTIFY="${NOTIFY:-1}"
HERE="$(cd "$(dirname "$0")" && pwd)"
NODE="${NODE:-$(ls -d "$HOME"/.nvm/versions/node/*/bin/node /opt/homebrew/bin/node /usr/local/bin/node 2>/dev/null | tail -1)}"

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }
notify() {
  log "ALERT: $1"
  [ "$NOTIFY" = 1 ] || return 0
  osascript -e "display notification \"$1\" with title \"Finportal backup\" sound name \"Basso\"" >/dev/null 2>&1 || true
}

mkdir -p "$DEST"
if [ -z "$HOST" ] || ! ls "$DEST" >/dev/null 2>&1 || ! [ -r "$KEY" ]; then
  notify "немає сервера ($CONF_DIR/host), теки бекапів або ключа — перевірка не відбулась"
  exit 1
fi

touch "$DEST/.rotated"
if rsync -a --timeout=60 -e "ssh -o BatchMode=yes -o ConnectTimeout=20" \
    --exclude-from="$DEST/.rotated" \
    --include='db-finportal-*.dump.age' --include='db-finportal-*.dump.age.sha256' --include='db-finportal-*.dump.age.counts' \
    --include='last-success' --exclude='*' "$HOST:$SRC" "$DEST/"; then
  log "pulled from $HOST"
else
  log "pull failed (offline?) — перевіримо свіжість того, що вже є"
fi

for f in "$DEST"/db-finportal-*.dump.age; do
  [ -e "$f" ] || continue
  [ -e "$f.verified" ] && continue
  [ -s "$f.sha256" ] || continue
  want="$(tr -d '[:space:]' < "$f.sha256")"
  got="$("$NODE" "$HERE/age-lite.mjs" decrypt "$KEY" "$f" | shasum -a 256 | cut -c1-64)"
  if [ "$got" = "$want" ]; then : > "$f.verified"; log "verified $(basename "$f")"
  else notify "$(basename "$f") не розшифрувався або не збігся зі знімком"; fi
done

"$NODE" "$HERE/rotate.mjs" "$DEST" | tail -1 | sed "s/^/$(date -u +%FT%TZ) rotate: /"

newest="$(ls -1t "$DEST"/db-finportal-*.dump.age 2>/dev/null | head -1)"
if [ -z "$newest" ]; then
  notify "у сховищі ще немає жодної копії бази фінпорталу"
else
  hours=$(( ($(date +%s) - $(stat -f %m "$newest")) / 3600 ))
  [ "$hours" -ge "$STALE_HOURS" ] && notify "остання копія бази фінпорталу — ${hours} год тому"
  log "newest $(basename "$newest"), ${hours}h old"
fi

NOTIFY="$NOTIFY" DEST="$DEST" KEY="$KEY" HOST="$HOST" "$HERE/restore-drill.sh" --if-due
