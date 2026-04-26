#!/usr/bin/env bash
# setup.sh — install/repair memkoshi + stelline for the memkoshi plugin.
#
# Idempotent. Safe to re-run. Designed to be invoked:
#   • once after plugin install (manually, or via Synaps post-install hook)
#   • by `boot-context.sh` if it detects memkoshi is missing
#   • directly by the user: `bash setup.sh [--check] [--no-stelline]`
#
# What it does (in order):
#   1. Verify python3 ≥ 3.10 + pipx are available; install pipx if possible.
#   2. Install memkoshi (from git, since not on PyPI) into an isolated pipx venv.
#   3. Inject stelline (also git-only) into the same venv so the optional
#      `[stelline]` extra is satisfied — gives the richer write path.
#   4. Run `memkoshi init` to create ~/.memkoshi if it doesn't exist.
#   5. Smoke-test that `import stelline` succeeds inside the venv.
#
# Flags:
#   --check         report status only, install nothing (exit 0 if all green)
#   --no-stelline   skip the stelline injection (regex extractor only)
#   --reinstall     uninstall existing memkoshi venv first, then reinstall
#
# Exit codes: 0 ok / non-zero something failed (with a clear message).

set -euo pipefail

# ─── Args ────────────────────────────────────────────────────
CHECK_ONLY=false
SKIP_STELLINE=false
REINSTALL=false

MEMKOSHI_GIT="${MEMKOSHI_GIT:-git+https://github.com/HaseebKhalid1507/memkoshi.git}"
STELLINE_GIT="${STELLINE_GIT:-git+https://github.com/HaseebKhalid1507/Stelline.git}"

for arg in "$@"; do
    case "$arg" in
        --check)        CHECK_ONLY=true ;;
        --no-stelline)  SKIP_STELLINE=true ;;
        --reinstall)    REINSTALL=true ;;
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
ok()    { echo "  ✅ $1"; }
warn()  { echo "  ⚠️  $1"; }
fail()  { echo "  ❌ $1"; }
info()  { echo "  ℹ️  $1"; }
section() { echo ""; echo "━━━ $1 ━━━"; }

ISSUES=0
issue() { fail "$1"; ISSUES=$((ISSUES + 1)); }

# Resolve where memkoshi's pipx venv lives so we can verify imports & inject.
pipx_memkoshi_venv() {
    if command -v pipx >/dev/null 2>&1; then
        local home
        home="$(pipx environment --value PIPX_HOME 2>/dev/null || true)"
        [ -z "$home" ] && home="$HOME/.local/share/pipx"
        echo "$home/venvs/memkoshi"
    else
        echo ""
    fi
}

# ─── 1. Python + pipx ────────────────────────────────────────
section "Prerequisites"

if ! command -v python3 >/dev/null 2>&1; then
    issue "python3 not found — install Python ≥ 3.10 first"
    exit 1
fi

PY_VER="$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
PY_OK="$(python3 -c 'import sys; print(int(sys.version_info >= (3, 10)))')"
if [ "$PY_OK" = "1" ]; then
    ok "python3 $PY_VER"
else
    issue "python3 $PY_VER too old (need ≥ 3.10)"
    exit 1
fi

if command -v pipx >/dev/null 2>&1; then
    ok "pipx $(pipx --version 2>/dev/null || echo present)"
else
    if [ "$CHECK_ONLY" = true ]; then
        issue "pipx not installed — run 'python3 -m pip install --user pipx && python3 -m pipx ensurepath'"
    else
        info "installing pipx via pip --user…"
        if python3 -m pip install --user --quiet pipx 2>/dev/null \
            || python3 -m pip install --user --quiet --break-system-packages pipx 2>/dev/null; then
            python3 -m pipx ensurepath >/dev/null 2>&1 || true
            export PATH="$HOME/.local/bin:$PATH"
            if command -v pipx >/dev/null 2>&1; then
                ok "pipx installed (you may need to restart your shell to pick up PATH)"
            else
                issue "pipx installed but not on PATH; add \$HOME/.local/bin to PATH and re-run"
                exit 1
            fi
        else
            issue "pipx install failed — install manually: python3 -m pip install --user pipx"
            exit 1
        fi
    fi
fi

# python3-venv module (apt distros split this out)
if ! python3 -c "import venv" >/dev/null 2>&1; then
    warn "python3 'venv' module missing — required by pipx"
    info "Debian/Ubuntu: sudo apt install python3-venv (or python${PY_VER}-venv)"
    info "Fedora/RHEL:   sudo dnf install python3-virtualenv"
fi

# ─── 2. memkoshi venv ────────────────────────────────────────
section "Memkoshi"

VENV="$(pipx_memkoshi_venv)"
VENV_PY="$VENV/bin/python"

memkoshi_installed() {
    [ -x "$VENV_PY" ] && "$VENV_PY" -c "import memkoshi" >/dev/null 2>&1
}

if [ "$REINSTALL" = true ] && memkoshi_installed; then
    if [ "$CHECK_ONLY" = true ]; then
        info "(would uninstall memkoshi for --reinstall)"
    else
        info "uninstalling existing memkoshi venv (--reinstall)…"
        pipx uninstall memkoshi >/dev/null 2>&1 || true
    fi
fi

if memkoshi_installed; then
    MK_VER="$("$VENV_PY" -c 'import memkoshi; print(getattr(memkoshi, "__version__", "?"))' 2>/dev/null)"
    ok "memkoshi $MK_VER (venv: $VENV)"
elif [ "$CHECK_ONLY" = true ]; then
    issue "memkoshi not installed — run this script without --check"
else
    info "installing memkoshi from $MEMKOSHI_GIT (this can take 30-60s)…"
    if pipx install "$MEMKOSHI_GIT" >/tmp/memkoshi-install.log 2>&1; then
        ok "memkoshi installed"
    else
        fail "memkoshi install failed — see /tmp/memkoshi-install.log"
        tail -10 /tmp/memkoshi-install.log >&2 || true
        exit 1
    fi
fi

# Make sure ~/.local/bin is reachable so user can call `memkoshi`.
if [ -x "$HOME/.local/bin/memkoshi" ]; then
    if echo ":$PATH:" | grep -q ":$HOME/.local/bin:"; then
        ok "memkoshi CLI on PATH"
    else
        warn "memkoshi CLI installed at ~/.local/bin/memkoshi but PATH doesn't include it"
        info "fix: add 'export PATH=\"\$HOME/.local/bin:\$PATH\"' to your shell profile"
    fi
fi

# ─── 3. stelline (optional but default) ──────────────────────
if [ "$SKIP_STELLINE" = true ]; then
    section "Stelline (skipped via --no-stelline)"
    info "Write path will use the regex 'hybrid' extractor only."
else
    section "Stelline (richer write path)"

    stelline_installed() {
        [ -x "$VENV_PY" ] && "$VENV_PY" -c "import stelline" >/dev/null 2>&1
    }

    if stelline_installed; then
        SL_VER="$("$VENV_PY" -c 'import stelline; print(getattr(stelline, "__version__", "?"))' 2>/dev/null)"
        ok "stelline $SL_VER (injected into memkoshi venv)"
    elif [ "$CHECK_ONLY" = true ]; then
        issue "stelline not installed — re-run without --check, or pass --no-stelline to skip"
    elif ! memkoshi_installed; then
        warn "skipping stelline — memkoshi venv missing (above install probably failed)"
    else
        info "injecting stelline from $STELLINE_GIT…"
        if pipx inject memkoshi "$STELLINE_GIT" >/tmp/stelline-install.log 2>&1; then
            ok "stelline injected"
        else
            warn "stelline injection failed — memkoshi will fall back to regex extractor"
            tail -10 /tmp/stelline-install.log >&2 || true
            info "(this is non-fatal; recall via VelociRAG still works)"
        fi
    fi

    # Smoke-test the bridge can find stelline.
    if memkoshi_installed && stelline_installed; then
        if "$VENV_PY" -c "
from stelline.config import StellineConfig
from stelline.context import ContextLoader
from stelline.pipeline import StellinePipeline
from stelline.tracker import SessionTracker
" >/dev/null 2>&1; then
            ok "stelline_bridge imports verified"
        else
            warn "stelline installed but bridge imports failed (API drift?)"
        fi
    fi
fi

# ─── 4. Storage init ─────────────────────────────────────────
section "Storage"

STORAGE="${MEMKOSHI_STORAGE:-$HOME/.memkoshi}"
if [ -f "$STORAGE/memkoshi.db" ]; then
    ok "storage exists at $STORAGE"
elif [ "$CHECK_ONLY" = true ]; then
    issue "storage not initialised — re-run without --check (will run 'memkoshi init')"
elif memkoshi_installed; then
    info "running 'memkoshi init'…"
    if "$VENV/bin/memkoshi" init >/dev/null 2>&1; then
        ok "storage initialised at $STORAGE"
    else
        warn "memkoshi init failed (run manually: memkoshi init)"
    fi
fi

# ─── Summary ─────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ "$ISSUES" -gt 0 ]; then
    echo "  Memkoshi setup — $ISSUES issue(s) need attention"
    exit 1
else
    if [ "$CHECK_ONLY" = true ]; then
        echo "  Memkoshi setup — all green ✓"
    else
        echo "  Memkoshi setup — done 🎉"
        echo ""
        echo "  Try:  memkoshi commit \"We chose plan X over Y because …\""
        echo "        memkoshi review            # see what got staged"
        echo "        memkoshi recall \"plan\"     # 4-layer search via VelociRAG"
    fi
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
