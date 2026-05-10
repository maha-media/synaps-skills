#!/usr/bin/env bash
# bridge-cli.sh — Synaps bridge management wrapper.
# Invoked as: /bridge <subcommand> [args...]
#
# Subcommands:
#   start             Start the synaps-bridge systemd user service.
#   stop              Stop the synaps-bridge systemd user service.
#   restart           Restart the synaps-bridge systemd user service.
#   status            Show systemd service status + live daemon status.
#   threads [--format=table|json]
#                     List active bridge sessions.
#   model <key> <model>
#                     Change the model for an active session.
#   reap <key>        Forcibly reap an active session.
#   help | --help     Show this help.
set -euo pipefail

DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

usage() {
  cat <<'EOF'
Usage: /bridge <subcommand> [args]

Subcommands:
  start             Start the synaps-bridge daemon (systemd --user)
  stop              Stop the synaps-bridge daemon
  restart           Restart the synaps-bridge daemon
  status            Show service + live daemon status
  threads           List active bridge sessions
  model <key> <m>   Switch model for a session
  reap <key>        Force-reap an active session
  help              Show this message
EOF
}

if [[ $# -eq 0 ]]; then
  usage
  exit 0
fi

subcommand="${1}"
shift

case "${subcommand}" in
  start)
    exec systemctl --user start synaps-bridge
    ;;

  stop)
    exec systemctl --user stop synaps-bridge
    ;;

  restart)
    exec systemctl --user restart synaps-bridge
    ;;

  status)
    # Show systemd status first; allow non-zero exit (service may be inactive).
    systemctl --user status synaps-bridge --no-pager || true
    echo ""
    # Then show live daemon status; allow failure (daemon may be down).
    node "${DIR}/control-cli.mjs" status "$@" || true
    ;;

  threads)
    exec node "${DIR}/control-cli.mjs" threads "$@"
    ;;

  model)
    exec node "${DIR}/control-cli.mjs" model "$@"
    ;;

  reap)
    exec node "${DIR}/control-cli.mjs" reap "$@"
    ;;

  help|--help|-h)
    usage
    exit 0
    ;;

  *)
    echo "bridge-cli: unknown subcommand '${subcommand}'" >&2
    echo "" >&2
    usage >&2
    exit 1
    ;;
esac
