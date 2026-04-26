#!/usr/bin/env bash
# setup.sh — install/repair the web-tools plugin's runtime dependencies.
#
# Idempotent. Safe to re-run. Designed to be invoked:
#   • once after plugin install (manually, or via Synaps post-install hook)
#   • by an agent if a capability fails with a "missing dep" error
#   • directly by the user: `bash setup.sh [--check] [--minimal] [--reinstall]`
#
# Scope: web-tools-plugin only. The umbrella `install.sh` at the repo root
# covers the whole tree; this script is the per-plugin equivalent that a
# self-healing agent can invoke without touching unrelated plugins.
#
# What it does (in order):
#   1. Verify Node ≥ 18 (required by every JS capability).
#   2. `npm install` in scripts/<dir>/ for any package.json with deps.
#   3. yt-dlp + JS-runtime config (youtube capability).
#   4. python3-secretstorage on Linux (Chrome cookie decryption for yt-dlp).
#   5. ffmpeg + whisper (transcribe — warn only, optional).
#   6. pdftotext (pdf — warn only).
#   7. pandoc (docs — warn only).
#   8. velocirag (self-healing memory — warn only, plugin still works without).
#   9. Memory tree at ~/.synaps-cli/memory/web/{notes,db}.
#  10. Playwright browser binaries (browser capability — warn only).
#
# Flags:
#   --check       report status only, install nothing (exit 0 if all green)
#   --reinstall   nuke node_modules first, then reinstall
#   --minimal     only fetch + memory; skip transcribe/pdf/docs/playwright
#   -h, --help    show this header
#
# Exit codes: 0 ok / 1 hard issue (Node missing, npm install failed)
#                   / 2 unknown flag

set -euo pipefail

# ─── Resolve plugin root ─────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ─── Args ────────────────────────────────────────────────────
CHECK_ONLY=false
REINSTALL=false
MINIMAL=false

for arg in "$@"; do
    case "$arg" in
        --check)     CHECK_ONLY=true ;;
        --reinstall) REINSTALL=true ;;
        --minimal)   MINIMAL=true ;;
        -h|--help)
            sed -n '1,30p' "$0"
            exit 0
            ;;
        *)
            echo "  ❌ unknown flag: $arg" >&2
            exit 2
            ;;
    esac
done

# ─── Helpers (match install.sh style) ────────────────────────
ok()      { echo "  ✅ $1"; }
warn()    { echo "  ⚠️  $1"; }
fail()    { echo "  ❌ $1"; }
info()    { echo "  ℹ️  $1"; }
section() { echo ""; echo "━━━ $1 ━━━"; }

ISSUES=0
issue() { fail "$1"; ISSUES=$((ISSUES + 1)); }

# Detect OS for install hints
OS="linux"
case "$(uname -s)" in
    Darwin*) OS="mac" ;;
    MINGW*|MSYS*|CYGWIN*) OS="windows" ;;
esac

# ─── 1. Node ─────────────────────────────────────────────────
section "Node.js (required)"

if command -v node >/dev/null 2>&1; then
    NODE_VER="$(node -v | sed 's/v//')"
    NODE_MAJOR="$(echo "$NODE_VER" | cut -d. -f1)"
    if [ "$NODE_MAJOR" -ge 18 ]; then
        ok "node $NODE_VER"
    else
        issue "node $NODE_VER too old (need ≥ 18)"
        case "$OS" in
            mac) info "Install: brew install node  OR  nvm install --lts" ;;
            *)   info "Install: nvm install --lts  (https://github.com/nvm-sh/nvm)" ;;
        esac
        exit 1
    fi
else
    issue "node not found — required by every web-tools capability"
    case "$OS" in
        mac)     info "Install: brew install node  OR  nvm install --lts" ;;
        windows) info "Install: https://nodejs.org or nvm-windows" ;;
        *)       info "Install: nvm install --lts  (https://github.com/nvm-sh/nvm)" ;;
    esac
    exit 1
fi

# ─── 2. npm install per capability dir ───────────────────────
section "Node Dependencies"

# Helper: does this package.json declare any runtime/dev deps?
has_node_deps() {
    local pkg="$1"
    [ -f "$pkg" ] || return 1
    node -e '
        const p = require(process.argv[1]);
        const d = Object.keys(p.dependencies || {}).length;
        const dd = Object.keys(p.devDependencies || {}).length;
        process.exit((d + dd) > 0 ? 0 : 1);
    ' "$pkg" 2>/dev/null
}

NODE_DIRS=(
    "$PLUGIN_ROOT/scripts/fetch"
    "$PLUGIN_ROOT/scripts/browser"
    "$PLUGIN_ROOT/scripts/youtube"
)

for dir in "${NODE_DIRS[@]}"; do
    name="$(basename "$dir")"
    [ -f "$dir/package.json" ] || { info "$name: no package.json (skipped)"; continue; }

    # In --minimal mode, only fetch is mandatory.
    if [ "$MINIMAL" = true ] && [ "$name" != "fetch" ]; then
        info "$name: skipped (--minimal)"
        continue
    fi

    if ! has_node_deps "$dir/package.json"; then
        ok "$name: no node deps declared"
        continue
    fi

    if [ "$REINSTALL" = true ] && [ -d "$dir/node_modules" ]; then
        if [ "$CHECK_ONLY" = true ]; then
            info "$name: (would remove node_modules for --reinstall)"
        else
            info "$name: removing node_modules (--reinstall)…"
            rm -rf "$dir/node_modules"
        fi
    fi

    if [ -d "$dir/node_modules" ]; then
        ok "$name/node_modules exists"
    elif [ "$CHECK_ONLY" = true ]; then
        issue "$name needs npm install"
    else
        echo "  📦 Installing $name…"
        if (cd "$dir" && npm install --silent 2>/tmp/web-setup-$name.log); then
            ok "$name installed"
        else
            issue "$name: npm install failed — see /tmp/web-setup-$name.log"
            tail -10 "/tmp/web-setup-$name.log" >&2 || true
        fi
    fi
done

# ─── 3. yt-dlp (youtube) ─────────────────────────────────────
if [ "$MINIMAL" = false ]; then
    section "yt-dlp (youtube capability)"

    if command -v yt-dlp >/dev/null 2>&1; then
        ok "yt-dlp $(yt-dlp --version 2>/dev/null)"
    elif [ "$CHECK_ONLY" = true ]; then
        warn "yt-dlp not found — youtube capability will fail"
    else
        warn "yt-dlp not found — needed for youtube capability"
        case "$OS" in
            mac)     info "Install: brew install yt-dlp  OR  pip install -U yt-dlp" ;;
            windows) info "Install: pip install -U yt-dlp  OR  winget install yt-dlp" ;;
            *)       info "Install: pip install --user -U yt-dlp" ;;
        esac
    fi

    # JS-runtime config (required since youtube extractor needs ejs)
    YTDLP_CONF_DIR="$HOME/.config/yt-dlp"
    YTDLP_CONF="$YTDLP_CONF_DIR/config"
    if [ -f "$YTDLP_CONF" ] && grep -q "js-runtimes" "$YTDLP_CONF" 2>/dev/null; then
        ok "yt-dlp config has JS runtime"
    elif [ "$CHECK_ONLY" = true ]; then
        warn "yt-dlp config missing JS runtime — youtube transcripts will likely fail"
        info "Re-run without --check to write the config"
    else
        mkdir -p "$YTDLP_CONF_DIR"
        if [ -f "$YTDLP_CONF" ]; then
            echo "" >> "$YTDLP_CONF"
            echo "--js-runtimes node" >> "$YTDLP_CONF"
            echo "--remote-components ejs:github" >> "$YTDLP_CONF"
        else
            cat > "$YTDLP_CONF" <<'EOF'
--js-runtimes node
--remote-components ejs:github
EOF
        fi
        ok "yt-dlp config written ($YTDLP_CONF)"
    fi

    # Linux-only: secretstorage for Chrome cookie decryption
    if [ "$OS" = "linux" ]; then
        if command -v python3 >/dev/null 2>&1 && \
           python3 -c "import secretstorage" >/dev/null 2>&1; then
            ok "python3-secretstorage present (Chrome cookie decryption OK)"
        elif [ "$CHECK_ONLY" = true ]; then
            warn "python3-secretstorage missing — yt-dlp can't read Chrome cookies on Linux"
            info "Install: sudo apt install python3-secretstorage"
        else
            warn "python3-secretstorage missing — yt-dlp can't decrypt Chrome cookies"
            info "Install: sudo apt install python3-secretstorage"
            info "(needed for --cookies-from-browser=chrome on Linux)"
        fi
    fi
fi

# ─── 4. Python (transcribe) ──────────────────────────────────
if [ "$MINIMAL" = false ]; then
    section "Transcribe capability (optional)"

    if command -v python3 >/dev/null 2>&1; then
        PY_VER="$(python3 --version | awk '{print $2}')"
        PY_MAJOR="$(echo "$PY_VER" | cut -d. -f1)"
        PY_MINOR="$(echo "$PY_VER" | cut -d. -f2)"
        if [ "$PY_MAJOR" -ge 3 ] && [ "$PY_MINOR" -ge 10 ]; then
            ok "python3 $PY_VER"
        else
            warn "python3 $PY_VER — transcribe needs ≥ 3.10"
        fi
    else
        warn "python3 not found — needed for transcribe capability"
    fi

    if command -v ffmpeg >/dev/null 2>&1; then
        ok "ffmpeg present"
    else
        warn "ffmpeg not found — needed for transcribe"
        case "$OS" in
            mac)     info "Install: brew install ffmpeg" ;;
            windows) info "Install: winget install Gyan.FFmpeg" ;;
            *)       info "Install: sudo apt install ffmpeg" ;;
        esac
    fi

    if command -v python3 >/dev/null 2>&1 && python3 -c "import whisper" 2>/dev/null; then
        ok "openai-whisper installed"
    else
        warn "openai-whisper not installed — needed for transcribe"
        info "Install: pip install --user openai-whisper"
    fi
fi

# ─── 5. pdftotext ────────────────────────────────────────────
if [ "$MINIMAL" = false ]; then
    section "PDF capability (optional)"

    if command -v pdftotext >/dev/null 2>&1; then
        ok "pdftotext (poppler) present"
    else
        warn "pdftotext not found — needed for pdf capability"
        case "$OS" in
            mac)     info "Install: brew install poppler" ;;
            windows) info "Install: choco install poppler  (or WSL: sudo apt install poppler-utils)" ;;
            *)       info "Install: sudo apt install poppler-utils" ;;
        esac
    fi
fi

# ─── 6. pandoc ───────────────────────────────────────────────
if [ "$MINIMAL" = false ]; then
    section "Docs capability (optional)"

    if command -v pandoc >/dev/null 2>&1; then
        ok "pandoc present"
    else
        warn "pandoc not found — needed for docs capability (DOCX/PPTX/EPUB ↔ markdown)"
        case "$OS" in
            mac)     info "Install: brew install pandoc" ;;
            windows) info "Install: https://pandoc.org/installing.html" ;;
            *)       info "Install: sudo apt install pandoc" ;;
        esac
    fi
fi

# ─── 7. Playwright browsers ──────────────────────────────────
if [ "$MINIMAL" = false ]; then
    section "Playwright browsers (browser capability)"

    BROWSER_DIR="$PLUGIN_ROOT/scripts/browser"
    if [ -d "$BROWSER_DIR/node_modules/playwright" ]; then
        # Check if at least chromium is downloaded
        if [ -d "$HOME/.cache/ms-playwright" ] && \
           find "$HOME/.cache/ms-playwright" -maxdepth 2 -name 'chromium*' -type d 2>/dev/null | grep -q .; then
            ok "playwright browser binaries present"
        elif [ "$CHECK_ONLY" = true ]; then
            warn "playwright browser binaries missing — browser capability will fail"
            info "Re-run without --check, or: (cd $BROWSER_DIR && npx playwright install chromium)"
        else
            echo "  📦 Downloading Chromium for Playwright (this can take a minute)…"
            if (cd "$BROWSER_DIR" && npx playwright install chromium 2>/tmp/web-setup-playwright.log); then
                ok "playwright Chromium installed"
            else
                warn "playwright install failed — see /tmp/web-setup-playwright.log"
                tail -10 /tmp/web-setup-playwright.log >&2 || true
            fi
        fi
    else
        info "playwright npm package not present (browser capability disabled)"
    fi
fi

# ─── 8. velocirag (self-healing memory) ──────────────────────
section "Self-healing memory"

if command -v velocirag >/dev/null 2>&1; then
    VR_VER="$(velocirag --version 2>/dev/null | command head -1)"
    ok "velocirag ${VR_VER:-installed}"
elif [ "$CHECK_ONLY" = true ]; then
    warn "velocirag not installed — plugin runs without memory (recall/commit no-op)"
    info "Install: pip install --user velocirag (add --break-system-packages on PEP 668)"
else
    PIP=""
    command -v pip3 >/dev/null 2>&1 && PIP="pip3"
    [ -z "$PIP" ] && command -v pip >/dev/null 2>&1 && PIP="pip"
    if [ -n "$PIP" ]; then
        echo "  📦 Installing velocirag…"
        if "$PIP" install --user --quiet velocirag 2>/tmp/web-setup-vr.log; then
            ok "velocirag installed"
        elif grep -q "externally-managed\|PEP 668" /tmp/web-setup-vr.log 2>/dev/null && \
             "$PIP" install --user --quiet --break-system-packages velocirag 2>&1; then
            ok "velocirag installed (--break-system-packages)"
        else
            warn "velocirag install failed — plugin runs without memory"
            info "Manual: $PIP install --user --break-system-packages velocirag"
            tail -10 /tmp/web-setup-vr.log >&2 || true
        fi
        rm -f /tmp/web-setup-vr.log
    else
        warn "pip not found — can't install velocirag"
        info "Install pip first, then: pip install --user velocirag"
    fi
fi

# Memory tree
WEB_MEMORY_ROOT="$HOME/.synaps-cli/memory/web"
if [ -d "$WEB_MEMORY_ROOT/notes" ] && [ -d "$WEB_MEMORY_ROOT/db" ]; then
    ok "memory tree exists ($WEB_MEMORY_ROOT)"
elif [ "$CHECK_ONLY" = true ]; then
    warn "memory tree missing at $WEB_MEMORY_ROOT"
else
    mkdir -p "$WEB_MEMORY_ROOT/notes" "$WEB_MEMORY_ROOT/db"
    ok "memory tree created ($WEB_MEMORY_ROOT/{notes,db})"
fi

# ─── 9. Search API key ───────────────────────────────────────
section "Search capability (optional)"

if [ -n "${EXA_API_KEY:-}" ]; then
    ok "EXA_API_KEY is set in current shell"
else
    # Look in common shell profiles (non-interactive shells don't source these)
    FOUND=false
    for prof in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
        [ -f "$prof" ] && grep -q "EXA_API_KEY" "$prof" 2>/dev/null && { FOUND=true; break; }
    done
    if [ "$FOUND" = true ]; then
        ok "EXA_API_KEY in shell profile (restart shell or 'source' to activate)"
    else
        warn "EXA_API_KEY not set — search capability via Exa won't work"
        info "Get a key: https://exa.ai/  →  add to ~/.bashrc: export EXA_API_KEY=…"
    fi
fi

# ─── Summary ─────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ "$ISSUES" -gt 0 ]; then
    echo "  web-tools setup — $ISSUES hard issue(s) need attention"
    exit 1
else
    if [ "$CHECK_ONLY" = true ]; then
        echo "  web-tools setup — all green ✓"
    else
        echo "  web-tools setup — done 🎉"
        echo ""
        echo "  Try:  node $PLUGIN_ROOT/scripts/status/web-status.js"
        echo "        node $PLUGIN_ROOT/scripts/fetch/fetch.js https://example.com"
    fi
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
