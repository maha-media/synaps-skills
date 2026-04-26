#!/usr/bin/env bash
# Wrapper for approve.py that finds a Python interpreter capable of `import memkoshi`.
# Supports memkoshi installed via:
#   1. $MEMKOSHI_PYTHON (explicit override)
#   2. pipx (isolated venv at ~/.local/share/pipx/venvs/memkoshi/)
#   3. system python3 (pip install --user / system pip)
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APPROVE_PY="$SCRIPT_DIR/approve.py"

find_python() {
    # 1. Explicit override
    if [ -n "${MEMKOSHI_PYTHON:-}" ] && "$MEMKOSHI_PYTHON" -c "import memkoshi" 2>/dev/null; then
        echo "$MEMKOSHI_PYTHON"
        return 0
    fi

    # 2. pipx venv
    local pipx_py="$HOME/.local/share/pipx/venvs/memkoshi/bin/python"
    if [ -x "$pipx_py" ] && "$pipx_py" -c "import memkoshi" 2>/dev/null; then
        echo "$pipx_py"
        return 0
    fi

    # 2b. pipx-managed (ask pipx where it is)
    if command -v pipx >/dev/null 2>&1; then
        local venv_dir
        venv_dir="$(pipx environment --value PIPX_LOCAL_VENVS 2>/dev/null || true)"
        if [ -n "$venv_dir" ] && [ -x "$venv_dir/memkoshi/bin/python" ] \
           && "$venv_dir/memkoshi/bin/python" -c "import memkoshi" 2>/dev/null; then
            echo "$venv_dir/memkoshi/bin/python"
            return 0
        fi
    fi

    # 3. system python3
    if command -v python3 >/dev/null 2>&1 && python3 -c "import memkoshi" 2>/dev/null; then
        echo "python3"
        return 0
    fi

    return 1
}

PY="$(find_python)" || {
    cat >&2 <<'EOF'
error: cannot find a Python interpreter with `memkoshi` importable.

Install memkoshi one of these ways:
  pipx install git+https://github.com/HaseebKhalid1507/memkoshi.git
  pip install --user --break-system-packages git+https://github.com/HaseebKhalid1507/memkoshi.git

Or set MEMKOSHI_PYTHON to a python that has memkoshi installed.
EOF
    exit 127
}

exec "$PY" "$APPROVE_PY" "$@"
