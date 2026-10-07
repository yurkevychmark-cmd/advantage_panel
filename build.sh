#!/usr/bin/env bash
# Build the static portal: src/index.src.html -> v10/ (Netlify publish dir). Edit only the source.
set -euo pipefail
cd "$(dirname "$0")"
[ -x node_modules/.bin/esbuild ] || npm install --silent
node tools/build.mjs "$@"
