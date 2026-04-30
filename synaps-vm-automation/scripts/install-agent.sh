#!/usr/bin/env bash
set -euo pipefail
INSTALL_ROOT=${INSTALL_ROOT:-"$HOME/.config/synaps-vm-agent"}
HOST=${HOST:-127.0.0.1}
PORT=${PORT:-8765}
mkdir -p "$INSTALL_ROOT"
chmod 700 "$INSTALL_ROOT"
TOKEN_FILE="$INSTALL_ROOT/token"
CONFIG_FILE="$INSTALL_ROOT/config.json"
python3 - <<'PY' > "$TOKEN_FILE"
import secrets
print(secrets.token_urlsafe(32), end='')
PY
chmod 600 "$TOKEN_FILE"
TOKEN=$(cat "$TOKEN_FILE")
cat > "$CONFIG_FILE" <<JSON
{"host":"$HOST","port":$PORT,"token":"$TOKEN","auth_required":true,"allow_exec":false}
JSON
chmod 600 "$CONFIG_FILE"
mkdir -p "$HOME/.config/systemd/user"
cat > "$HOME/.config/systemd/user/synaps-vm-agent.service" <<EOF
[Unit]
Description=Synaps VM Agent

[Service]
ExecStart=$(command -v python3) -m synaps_vm_agent.server --config $CONFIG_FILE
Restart=on-failure

[Install]
WantedBy=default.target
EOF
cat <<EOF
Installed user service file. Token was generated locally and not printed.
Start with: systemctl --user daemon-reload && systemctl --user enable --now synaps-vm-agent
Verify: curl http://127.0.0.1:$PORT/health
Unauthorized protected endpoint check: curl -i http://127.0.0.1:$PORT/capabilities
EOF
