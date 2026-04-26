# browser — Playwright via CDP

Real-browser automation. Use when JS rendering, auth state, or interactive
DOM is required. **Don't** use for plain file URLs (raw `.md`, `.json`, etc.) —
fall back to `curl` or `fetch` for those.

All scripts auto-call memory recall on start and auto-log failures.

## Setup

```bash
cd "${CLAUDE_PLUGIN_ROOT}/scripts/browser"
npm install
```

If no system Chrome/Chromium available, also:
```bash
npx playwright install chromium
```

## Start the browser

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/browser/browser-start.js                # fresh profile
${CLAUDE_PLUGIN_ROOT}/scripts/browser/browser-start.js --profile      # copy your default Chrome profile (cookies/logins)
${CLAUDE_PLUGIN_ROOT}/scripts/browser/browser-start.js --headless     # headless
${CLAUDE_PLUGIN_ROOT}/scripts/browser/browser-start.js --port=9333    # custom CDP port
```

`--profile` syncs `~/.config/google-chrome/` (Linux), `~/Library/Application Support/Google/Chrome/`
(macOS), or `%LOCALAPPDATA%/Google/Chrome/User Data/` (Windows) into the
controlled profile so logged-in sites work out of the box.

## Drive the active tab

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/browser/browser-nav.js https://example.com           # current tab
${CLAUDE_PLUGIN_ROOT}/scripts/browser/browser-nav.js https://example.com --new     # new tab

${CLAUDE_PLUGIN_ROOT}/scripts/browser/browser-eval.js 'document.title'             # async JS
${CLAUDE_PLUGIN_ROOT}/scripts/browser/browser-eval.js 'document.querySelectorAll("a").length'

${CLAUDE_PLUGIN_ROOT}/scripts/browser/browser-screenshot.js                        # viewport → /tmp/...
${CLAUDE_PLUGIN_ROOT}/scripts/browser/browser-screenshot.js --full                 # full page
${CLAUDE_PLUGIN_ROOT}/scripts/browser/browser-screenshot.js ./out.png              # custom path

${CLAUDE_PLUGIN_ROOT}/scripts/browser/browser-pick.js "Click the submit button"    # interactive picker

${CLAUDE_PLUGIN_ROOT}/scripts/browser/browser-cookies.js                           # dump cookies
```

## Extract page content (Readability + Turndown → markdown)

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/browser/browser-content.js https://example.com/article
```

## Self-healing notes

- **PRE**: each script runs `recall(<host or intent>, op=browser-*)` and prints
  hits to stderr. If memory shows a known fix (e.g. selector pattern or
  consent-banner playbook), apply it before retrying.
- **POST on failure**: each script logs to `failures.jsonl` and emits a
  `STALE` warning if `(host, op, err_class)` has fired ≥ 2× in 7d.

## Common error classes & escalations

| `err_class`      | Meaning                              | Try…                                                |
|------------------|--------------------------------------|-----------------------------------------------------|
| `no_browser`     | `connectOverCDP` failed              | `browser-start.js` first; check port 9222           |
| `timeout`        | 30s page-load cap hit                | retry with explicit `waitUntil:'domcontentloaded'`  |
| `selector_stale` | element not found                    | re-pick with `browser-pick.js` and re-query DOM     |
| `consent_banner` | UI hidden behind consent overlay     | dismiss with `browser-eval.js` clicking the button  |
| `captcha`        | Cloudflare/reCAPTCHA challenge       | switch to `--profile` (logged-in cookies); commit a `kind-fix` note for the host |
| `dns`            | host unresolvable                    | sanity-check URL; not a browser issue               |

## Efficiency

**Don't** screenshot to inspect DOM — parse directly:
```bash
${CLAUDE_PLUGIN_ROOT}/scripts/browser/browser-eval.js '(function(){return Array.from(document.querySelectorAll("button,input")).map(e=>({tag:e.tagName,id:e.id,text:(e.textContent||e.value||"").slice(0,80)}))})()'
```

**Don't** chain N calls — wrap in IIFE:
```bash
${CLAUDE_PLUGIN_ROOT}/scripts/browser/browser-eval.js '(function(){const t=document.querySelector("#x").innerText;document.querySelector("#go").click();return t})()'
```

## Env

| Variable          | Default                     | Notes                              |
|-------------------|-----------------------------|------------------------------------|
| `BROWSER_CDP_URL` | `http://localhost:9222`     | Override CDP endpoint              |
| `WEB_HOOKS_QUIET` | unset                       | Suppress hook stderr surface       |

## When NOT to use browser

Plain file URLs — use `curl` / `fetch`:
- `files.catbox.moe`, `raw.githubusercontent.com`, `gist.githubusercontent.com`
- `*.md`, `*.txt`, `*.json`, `*.csv`, `*.xml`, `*.yaml`, `*.log`, `*.py`, `*.js`
