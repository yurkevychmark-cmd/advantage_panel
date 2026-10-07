# ADvantage finance portal

Live: https://admin-panel9.netlify.app (Netlify, publish directory `v10/`, deploys on push to `main`).

## Layout
| Path | What |
|---|---|
| `src/index.src.html` | **The source — the only file to edit.** React 18 app inside `<script type="text/babel">`. |
| `v10/` | **Generated** site Netlify serves: `index.html`, `app.<hash>.js` (JSX compiled ahead of time), `vendor/` (pinned React 18.3.1, ReactDOM 18.3.1, supabase-js 2.117.2). Never edit by hand. |
| `tools/build.mjs` | Build: source → `v10/` (esbuild, IIFE bundle, CDN tags → local vendor files). |
| `tests/verify.test.mjs` | Tests that run the built `app.js` and check the portal's own finance formulas (`FIN.*`). |
| `build.sh` / `verify.sh` | Entry points. |

## Workflow
```bash
npm install            # once (esbuild)
./build.sh             # src/index.src.html -> v10/
./verify.sh            # must print "verify.sh: GREEN" before review / push
FINPORTAL_BACKUP=~/Desktop/ADvantage/Finance\ Department/finportal-full-backup-<date>.json ./verify.sh   # + checks a real backup
```
Commit `src/` and `v10/` together. `verify.sh` fails if `v10/` is out of date with `src/`, if any CDN/Babel script is
left, or if a finance test breaks.

For quick UI work without a build you can still open `src/index.src.html` directly — it keeps the CDN + in-browser
Babel tags; the build replaces them.
