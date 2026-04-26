#!/usr/bin/env bash
# synaps-skills installer — run once after cloning, or anytime to check status
# Works on: Linux, macOS, WSL, Git Bash (Windows)
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
CHECK_ONLY=false
CLAUDE_CODE=false
EXA_KEY=""

for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=true ;;
    --claude-code) CLAUDE_CODE=true ;;
    --exa-key=*) EXA_KEY="${arg#--exa-key=}" ;;
  esac
done

# ─── Helpers ──────────────────────────────────────────────────

ok()   { echo "  ✅ $1"; }
warn() { echo "  ⚠️  $1"; }
fail() { echo "  ❌ $1"; }
info() { echo "  ℹ️  $1"; }
head() { echo ""; echo "━━━ $1 ━━━"; }

ISSUES=0
issue() { fail "$1"; ISSUES=$((ISSUES + 1)); }

# ─── Detect OS and shell profiles ─────────────────────────────

OS="linux"
if [[ "$OSTYPE" == darwin* ]]; then
  OS="mac"
elif [[ "${OSTYPE:-}" == msys* ]] || [[ "${OSTYPE:-}" == cygwin* ]] || [[ -n "${MSYSTEM:-}" ]]; then
  OS="windows"
elif grep -qi microsoft /proc/version 2>/dev/null; then
  OS="wsl"
fi

# Collect ALL shell profile files to write to
PROFILES=()

detect_profiles() {
  local shell_name
  shell_name="$(basename "${SHELL:-bash}")"

  case "$shell_name" in
    zsh)
      # macOS default — write to both .zshrc (interactive) and .zprofile (login)
      [ -f "$HOME/.zshrc" ]     && PROFILES+=("$HOME/.zshrc")
      [ -f "$HOME/.zprofile" ]  && PROFILES+=("$HOME/.zprofile")
      # If neither exists, create .zshrc
      if [ ${#PROFILES[@]} -eq 0 ]; then
        touch "$HOME/.zshrc"
        PROFILES+=("$HOME/.zshrc")
      fi
      ;;
    fish)
      mkdir -p "$HOME/.config/fish"
      PROFILES+=("$HOME/.config/fish/config.fish")
      ;;
    *)
      # bash (Linux, WSL, Git Bash)
      # .bashrc for interactive, .bash_profile or .profile for login
      if [ -f "$HOME/.bashrc" ]; then
        PROFILES+=("$HOME/.bashrc")
      fi
      if [ -f "$HOME/.bash_profile" ]; then
        PROFILES+=("$HOME/.bash_profile")
      elif [ -f "$HOME/.profile" ]; then
        PROFILES+=("$HOME/.profile")
      fi
      # If nothing exists, create .bashrc
      if [ ${#PROFILES[@]} -eq 0 ]; then
        touch "$HOME/.bashrc"
        PROFILES+=("$HOME/.bashrc")
      fi
      ;;
  esac
}

detect_profiles

# Primary profile (first one) — used for display messages
PRIMARY_PROFILE="${PROFILES[0]}"

# Write a line to all detected profiles (idempotent — skips if already present)
write_to_profiles() {
  local marker="$1"  # unique grep pattern
  local content="$2" # what to append

  for profile in "${PROFILES[@]}"; do
    if ! grep -q "$marker" "$profile" 2>/dev/null; then
      echo "" >> "$profile"
      echo "$content" >> "$profile"
    fi
  done
}

# Check if a marker exists in ANY profile
in_any_profile() {
  local marker="$1"
  for profile in "${PROFILES[@]}"; do
    if grep -q "$marker" "$profile" 2>/dev/null; then
      return 0
    fi
  done
  return 1
}

head "Environment"
ok "OS: $OS"
ok "Shell: $(basename "${SHELL:-bash}")"
ok "Profiles: ${PROFILES[*]}"

# ─── 1. Synaps settings.json ─────────────────────────────────────

head "Synaps Settings"

SETTINGS="$HOME/.synaps/agent/settings.json"
mkdir -p "$(dirname "$SETTINGS")"

if [ -f "$SETTINGS" ] && grep -q "$REPO_DIR" "$SETTINGS" 2>/dev/null; then
  ok "settings.json already points to $REPO_DIR"
elif [ "$CHECK_ONLY" = true ]; then
  issue "settings.json does not include $REPO_DIR"
  info "Run without --check to fix"
else
  if [ ! -f "$SETTINGS" ]; then
    echo "{\"skills\":[\"$REPO_DIR\"]}" > "$SETTINGS"
    ok "Created $SETTINGS"
  elif command -v node &>/dev/null; then
    node -e "
      const fs = require('fs');
      const s = JSON.parse(fs.readFileSync('$SETTINGS','utf8'));
      s.skills = s.skills || [];
      if (!s.skills.includes('$REPO_DIR')) s.skills.push('$REPO_DIR');
      fs.writeFileSync('$SETTINGS', JSON.stringify(s, null, 2) + '\n');
    "
    ok "Added $REPO_DIR to settings.json"
  else
    issue "Node.js not found — can't update settings.json"
    info "Manually add to $SETTINGS: {\"skills\":[\"$REPO_DIR\"]}"
  fi
fi

# ─── 2. npm install for skills that need it ───────────────────

head "Node Dependencies"

for dir in \
  "$REPO_DIR/web-tools-plugin/scripts/browser" \
  "$REPO_DIR/web-tools-plugin/scripts/fetch" \
  "$REPO_DIR/web-tools-plugin/scripts/youtube"; do
  skill=$(basename "$dir")
  [ ! -f "$dir/package.json" ] && continue
  if [ -d "$dir/node_modules" ]; then
    ok "$skill/node_modules exists"
  elif [ "$CHECK_ONLY" = true ]; then
    issue "$skill needs npm install"
  else
    echo "  📦 Installing $skill..."
    (cd "$dir" && npm install --silent 2>&1) && ok "$skill installed" || issue "$skill npm install failed"
  fi
done

# ─── 3. External dependencies ────────────────────────────────

head "External Dependencies"

# Node.js
if command -v node &>/dev/null; then
  NODE_VER=$(node -v | sed 's/v//')
  NODE_MAJOR=$(echo "$NODE_VER" | cut -d. -f1)
  if [ "$NODE_MAJOR" -ge 18 ]; then
    ok "node $NODE_VER"
  else
    issue "node $NODE_VER — need ≥ 18"
    info "Install via nvm: nvm install --lts"
  fi
else
  issue "node not found"
  case "$OS" in
    mac)     info "Install: brew install node  OR  nvm install --lts" ;;
    windows) info "Install: https://nodejs.org or nvm-windows" ;;
    *)       info "Install: curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash && nvm install --lts" ;;
  esac
fi

# yt-dlp (youtube skill)
if command -v yt-dlp &>/dev/null; then
  ok "yt-dlp $(yt-dlp --version)"
else
  warn "yt-dlp not found — needed for youtube downloads/metadata"
  case "$OS" in
    mac)     info "Install: brew install yt-dlp  OR  pip install -U yt-dlp" ;;
    windows) info "Install: pip install -U yt-dlp  OR  winget install yt-dlp" ;;
    *)       info "Install: pip install -U yt-dlp" ;;
  esac
fi

# yt-dlp config (JS runtime for YouTube extraction)
YTDLP_CONF_DIR="$HOME/.config/yt-dlp"
YTDLP_CONF="$YTDLP_CONF_DIR/config"
if [ -f "$YTDLP_CONF" ] && grep -q "js-runtimes" "$YTDLP_CONF" 2>/dev/null; then
  ok "yt-dlp config has JS runtime"
elif [ "$CHECK_ONLY" = true ]; then
  warn "yt-dlp config missing JS runtime"
else
  mkdir -p "$YTDLP_CONF_DIR"
  # Append if file exists, create if not — don't overwrite existing config
  if [ -f "$YTDLP_CONF" ]; then
    echo "" >> "$YTDLP_CONF"
    echo "--js-runtimes node" >> "$YTDLP_CONF"
    echo "--remote-components ejs:github" >> "$YTDLP_CONF"
  else
    cat > "$YTDLP_CONF" << 'EOF'
--js-runtimes node
--remote-components ejs:github
EOF
  fi
  ok "yt-dlp config created ($YTDLP_CONF)"
fi

# Python (transcribe skill)
if command -v python3 &>/dev/null; then
  PY_VER=$(python3 --version | awk '{print $2}')
  PY_MINOR=$(echo "$PY_VER" | cut -d. -f2)
  if [ "$PY_MINOR" -ge 10 ]; then
    ok "python3 $PY_VER"
  else
    warn "python3 $PY_VER — transcribe skill needs ≥ 3.10"
  fi
else
  warn "python3 not found — needed for transcribe skill"
  case "$OS" in
    mac)     info "Install: brew install python" ;;
    windows) info "Install: https://python.org or winget install Python.Python.3.12" ;;
    *)       info "Install: sudo apt install python3 python3-pip" ;;
  esac
fi

# ffmpeg (transcribe skill)
if command -v ffmpeg &>/dev/null; then
  ok "ffmpeg found"
else
  warn "ffmpeg not found — needed for transcribe skill"
  case "$OS" in
    mac)     info "Install: brew install ffmpeg" ;;
    windows) info "Install: winget install Gyan.FFmpeg" ;;
    *)       info "Install: sudo apt install ffmpeg" ;;
  esac
fi

# whisper (transcribe skill)
if command -v python3 &>/dev/null && python3 -c "import whisper" 2>/dev/null; then
  ok "openai-whisper installed"
else
  warn "openai-whisper not installed — needed for transcribe skill"
  info "Install: pip install openai-whisper"
fi

# pdftotext / poppler (pdf skill)
if command -v pdftotext &>/dev/null; then
  ok "pdftotext (poppler) found"
else
  warn "pdftotext not found — needed for pdf skill"
  case "$OS" in
    mac)     info "Install: brew install poppler" ;;
    windows) info "Install: choco install poppler  (or via WSL: sudo apt install poppler-utils)" ;;
    *)       info "Install: sudo apt install poppler-utils" ;;
  esac
fi

# pandoc (docs skill)
if command -v pandoc &>/dev/null; then
  ok "pandoc found"
else
  warn "pandoc not found — needed for docs skill (DOCX/PPTX/EPUB ↔ markdown)"
  case "$OS" in
    mac)     info "Install: brew install pandoc" ;;
    windows) info "Install: https://pandoc.org/installing.html  (or via WSL: sudo apt install pandoc)" ;;
    *)       info "Install: sudo apt install pandoc" ;;
  esac
fi

# memkoshi (web plugin self-healing memory)
if command -v velocirag &>/dev/null; then
  VR_VER="$(velocirag --version 2>/dev/null | command head -1)"
  ok "velocirag ${VR_VER:-installed}"
elif [ "$CHECK_ONLY" = true ]; then
  warn "velocirag not installed — needed for web plugin self-healing memory"
  info "Install: pip install --user velocirag (add --break-system-packages on PEP 668 systems)"
else
  if command -v pip &>/dev/null || command -v pip3 &>/dev/null; then
    PIP=$(command -v pip3 || command -v pip)
    echo "  📦 Installing velocirag..."
    # Try plain --user first; fall back to --break-system-packages for PEP 668 distros
    if "$PIP" install --user --quiet velocirag 2>/tmp/vr-install.err; then
      ok "velocirag installed"
    elif grep -q "externally-managed\|PEP 668" /tmp/vr-install.err 2>/dev/null && \
         "$PIP" install --user --quiet --break-system-packages velocirag 2>&1; then
      ok "velocirag installed (--break-system-packages)"
    else
      warn "velocirag install failed — web plugin will run without memory"
      info "Manual: $PIP install --user --break-system-packages velocirag"
    fi
    rm -f /tmp/vr-install.err
  else
    warn "pip not found — can't install velocirag"
    info "Install: pip install --user velocirag"
  fi
fi

# web-plugin memory directory
WEB_MEMORY_ROOT="$HOME/.synaps-cli/memory/web"
if [ -d "$WEB_MEMORY_ROOT/notes" ] && [ -d "$WEB_MEMORY_ROOT/db" ]; then
  ok "web memory tree exists ($WEB_MEMORY_ROOT)"
elif [ "$CHECK_ONLY" = true ]; then
  warn "web memory tree missing"
else
  mkdir -p "$WEB_MEMORY_ROOT/notes" "$WEB_MEMORY_ROOT/db"
  ok "web memory tree created ($WEB_MEMORY_ROOT/{notes,db})"
fi

# ─── 4. Shell profile: EXA_API_KEY ───────────────────────────

head "API Keys"

if [ -n "${EXA_API_KEY:-}" ]; then
  ok "EXA_API_KEY is set in current shell"
elif in_any_profile "EXA_API_KEY"; then
  ok "EXA_API_KEY already in shell profile (restart shell to activate)"
elif [ -n "$EXA_KEY" ]; then
  write_to_profiles "EXA_API_KEY" "export EXA_API_KEY=\"$EXA_KEY\""
  ok "EXA_API_KEY added to ${PROFILES[*]}"
else
  warn "EXA_API_KEY not set — needed for the web/search capability (Exa)"
  info "Re-run with: bash install.sh --exa-key=YOUR_KEY"
fi

# ─── 5. Shell profile: Auto-pull ─────────────────────────────

head "Auto-Pull"

if in_any_profile "synaps-skills"; then
  ok "Auto-pull already configured"
elif [ "$CHECK_ONLY" = true ]; then
  issue "Auto-pull not configured"
else
  SHELL_NAME="$(basename "${SHELL:-bash}")"
  if [ "$SHELL_NAME" = "fish" ]; then
    PULL_CMD="fish -c 'cd \"$REPO_DIR\" && git pull --ff-only --quiet &' 2>/dev/null"
  else
    PULL_CMD="(cd \"$REPO_DIR\" && git pull --ff-only --quiet 2>/dev/null &)"
  fi
  write_to_profiles "synaps-skills" "# Auto-pull synaps-skills on shell startup
$PULL_CMD"
  ok "Added auto-pull to ${PROFILES[*]}"
fi

# ─── 6. Claude Code symlinks ─────────────────────────────────

if [ "$CLAUDE_CODE" = true ]; then
  head "Claude Code Symlinks"
  mkdir -p "$HOME/.claude/skills"
  # Skills are nested inside plugins: <plugin>/skills/<skill>/SKILL.md
  for skill_md in "$REPO_DIR"/*/skills/*/SKILL.md; do
    [ -f "$skill_md" ] || continue
    skill_dir="$(dirname "$skill_md")"
    name="$(basename "$skill_dir")"
    if [ -L "$HOME/.claude/skills/$name" ]; then
      ok "$name already linked"
    elif [ "$CHECK_ONLY" = true ]; then
      issue "$name not linked"
    else
      ln -sf "$skill_dir" "$HOME/.claude/skills/$name"
      ok "$name → linked"
    fi
  done
fi

# ─── 7. Remove stale skill copies ────────────────────────────

head "Cleanup"

SKILLS_DIR="$HOME/.synaps/agent/skills"
CLEANED=0
if [ -d "$SKILLS_DIR" ]; then
  for skill_dir in "$SKILLS_DIR"/*/; do
    [ ! -d "$skill_dir" ] && continue
    name=$(basename "$skill_dir")
    # Skills now live inside plugin subdirectories: <plugin>/skills/<name>/SKILL.md
    if find "$REPO_DIR" -mindepth 3 -maxdepth 3 \
         -path "*/skills/$name/SKILL.md" -type f \
         -quit 2>/dev/null | grep -q .; then
      if [ "$CHECK_ONLY" = true ]; then
        warn "Stale copy: $SKILLS_DIR/$name (repo has this skill)"
      else
        rm -rf "$skill_dir"
        ok "Removed stale copy: $name"
        CLEANED=$((CLEANED + 1))
      fi
    fi
  done
fi
if [ "$CLEANED" -eq 0 ] && [ "$CHECK_ONLY" = false ]; then
  ok "No stale copies to clean"
fi

# ─── Summary ─────────────────────────────────────────────────

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ "$ISSUES" -gt 0 ]; then
  echo "  Done — $ISSUES issue(s) need attention (see above)"
else
  echo "  Done — all good! 🎉"
fi
echo ""
echo "  Skills loaded from: $REPO_DIR"
echo "  Shell profiles:     ${PROFILES[*]}"
echo ""
if [ "$CHECK_ONLY" = false ]; then
  echo "  ⟹  Restart your shell (or: source $PRIMARY_PROFILE)"
  echo "     then run 'synaps' — all skills are available."
  echo ""
  echo "  Tip: run 'bash install.sh --check' anytime to verify."
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
