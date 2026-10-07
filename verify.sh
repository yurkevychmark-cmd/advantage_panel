#!/usr/bin/env bash
# Finance portal verification — must be green before a task goes to review.
#   1) v10/ (what Netlify serves) is built from src/ and up to date, with no CDN scripts and no in-browser Babel
#   2) the portal's own finance formulas pass the tests (tests/verify.test.mjs runs the built app)
# Optional: FINPORTAL_BACKUP=/path/to/finportal-full-backup-*.json ./verify.sh  — also sanity-checks a real backup.
set -euo pipefail
cd "$(dirname "$0")"
[ -x node_modules/.bin/esbuild ] || npm install --silent
echo "== build up to date"
node tools/build.mjs --check
echo "== no CDN / Babel at runtime"
if grep -Eq 'unpkg\.com|cdn\.jsdelivr\.net|babel' v10/index.html; then echo "FAIL: v10/index.html still loads a CDN script or Babel"; exit 1; fi
for f in $(grep -oE 'src="[^"]+\.js"' v10/index.html | cut -d'"' -f2); do [ -f "v10/$f" ] || { echo "FAIL: v10/$f referenced but missing"; exit 1; }; done
echo "OK: all scripts are local"
echo "== finance formulas"
node tests/verify.test.mjs
echo "verify.sh: GREEN"
