#!/usr/bin/env bash
# run-pipeline.sh — Black-Box Engineering pipeline launcher
#
# Prepares the pipeline task prompt and either:
#   1. Emits a JSON payload for the calling synaps TUI agent to dispatch
#      via native subagent() (default, --emit)
#   2. Launches a standalone synaps process (--standalone)
#
# Usage: run-pipeline.sh <plan-file> <design-file> [options]
#
# From inside synaps TUI, the agent runs this script via bash, reads the
# JSON output, and dispatches the orchestrator as a subagent — keeping
# everything within the current session's subagent tree.
#
# Prerequisites:
#   - Plan file with numbered tasks
#   - Design doc describing the system
#   - synaps CLI (only required for --standalone mode)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ─── Parse arguments ──────────────────────────────────────────

PLAN_FILE=""
DESIGN_FILE=""
WORKDIR="."
THRESHOLD="0.8"
MAX_FIXES="2"
MAX_CALLS="10"
HOLDOUT_MODE="false"
FRESH=0
STANDALONE=0

# Model defaults — Sage+Arbiter on Opus, Quinn+Glitch on Sonnet
SAGE_MODEL="${BBE_SAGE_MODEL:-claude-opus-4-7}"
QUINN_MODEL="${BBE_QUINN_MODEL:-claude-sonnet-4-6}"
GLITCH_MODEL="${BBE_GLITCH_MODEL:-claude-sonnet-4-6}"
ARBITER_MODEL="${BBE_ARBITER_MODEL:-claude-opus-4-7}"

while [[ $# -gt 0 ]]; do
  case $1 in
    --workdir)    WORKDIR="$2"; shift 2 ;;
    --threshold)  THRESHOLD="$2"; shift 2 ;;
    --max-fixes)  MAX_FIXES="$2"; shift 2 ;;
    --max-calls)  MAX_CALLS="$2"; shift 2 ;;
    --holdout)    HOLDOUT_MODE="true"; shift ;;
    --fresh)      FRESH=1; shift ;;
    --standalone) STANDALONE=1; shift ;;
    --agent)
      AGENT_SPEC="$2"; shift 2
      # Parse agent spec: "opus" (global), "sonnet" (global), or "sage=opus,quinn=sonnet" (per-role)
      if [[ "$AGENT_SPEC" == *"="* ]]; then
        IFS=',' read -ra PAIRS <<< "$AGENT_SPEC"
        for pair in "${PAIRS[@]}"; do
          role="${pair%%=*}"
          model="${pair#*=}"
          case "$(echo "$role" | tr '[:upper:]' '[:lower:]')" in
            sage)    [[ "$model" == "opus" ]] && SAGE_MODEL="claude-opus-4-7" || SAGE_MODEL="claude-sonnet-4-6" ;;
            quinn)   [[ "$model" == "opus" ]] && QUINN_MODEL="claude-opus-4-7" || QUINN_MODEL="claude-sonnet-4-6" ;;
            glitch)  [[ "$model" == "opus" ]] && GLITCH_MODEL="claude-opus-4-7" || GLITCH_MODEL="claude-sonnet-4-6" ;;
            arbiter) [[ "$model" == "opus" ]] && ARBITER_MODEL="claude-opus-4-7" || ARBITER_MODEL="claude-sonnet-4-6" ;;
            *) echo "ERROR: Unknown role '$role'" >&2; exit 1 ;;
          esac
        done
      else
        case "$AGENT_SPEC" in
          opus)
            SAGE_MODEL="claude-opus-4-7"; QUINN_MODEL="claude-opus-4-7"
            GLITCH_MODEL="claude-opus-4-7"; ARBITER_MODEL="claude-opus-4-7" ;;
          sonnet)
            SAGE_MODEL="claude-sonnet-4-6"; QUINN_MODEL="claude-sonnet-4-6"
            GLITCH_MODEL="claude-sonnet-4-6"; ARBITER_MODEL="claude-sonnet-4-6" ;;
          *) echo "ERROR: Unknown agent spec '$AGENT_SPEC'. Use 'opus', 'sonnet', or 'role=model,...'" >&2; exit 1 ;;
        esac
      fi
      ;;
    --help|-h)
      cat <<EOF
Usage: run-pipeline.sh <plan-file> <design-file> [options]

Launches the Black-Box Engineering pipeline via Synaps subagents.

Options:
  --workdir <dir>       Working directory (default: .)
  --holdout             Enable information holdout between agents
  --threshold <float>   Pass threshold 0-1 (default: 0.8)
  --max-fixes <int>     Max fix iterations (default: 2)
  --max-calls <int>     Hard cap on total agent calls (default: 10)
  --fresh               Delete checkpoint and start clean
  --standalone          Launch via 'synaps run' instead of emitting JSON
                        (for use outside synaps TUI)
  --agent <spec>        Model selection:
                          'sonnet'  — all agents on Sonnet (lightweight)
                          'opus'    — all agents on Opus (maximum quality)
                          'sage=opus,quinn=sonnet'  — per-role mix
                        Default: sage+arbiter=opus, quinn+glitch=sonnet
  -h, --help            Show this help

Environment:
  BBE_SAGE_MODEL        Override Sage model (default: claude-opus-4-7)
  BBE_QUINN_MODEL       Override Quinn model (default: claude-sonnet-4-6)
  BBE_GLITCH_MODEL      Override Glitch model (default: claude-sonnet-4-6)
  BBE_ARBITER_MODEL     Override Arbiter model (default: claude-opus-4-7)
EOF
      exit 0
      ;;
    *)
      if [[ -z "$PLAN_FILE" ]]; then
        PLAN_FILE="$1"
      elif [[ -z "$DESIGN_FILE" ]]; then
        DESIGN_FILE="$1"
      else
        echo "ERROR: Unexpected argument: $1" >&2; exit 1
      fi
      shift
      ;;
  esac
done

# ─── Validate ─────────────────────────────────────────────────

if [[ -z "$PLAN_FILE" || -z "$DESIGN_FILE" ]]; then
  echo "ERROR: Both <plan-file> and <design-file> are required" >&2
  echo "Usage: run-pipeline.sh <plan-file> <design-file> [--workdir <dir>]" >&2
  exit 1
fi

if [[ "$STANDALONE" -eq 1 ]] && ! command -v synaps &>/dev/null; then
  echo "ERROR: synaps CLI not found in PATH (required for --standalone)" >&2
  echo "Install: https://github.com/maha-media/synaps-cli" >&2
  exit 1
fi

# Resolve to absolute paths
PLAN_FILE="$(cd "$(dirname "$PLAN_FILE")" && pwd)/$(basename "$PLAN_FILE")"
DESIGN_FILE="$(cd "$(dirname "$DESIGN_FILE")" && pwd)/$(basename "$DESIGN_FILE")"
WORKDIR="$(cd "$WORKDIR" && pwd)"

if [[ ! -f "$PLAN_FILE" ]]; then
  echo "ERROR: Plan file not found: $PLAN_FILE" >&2; exit 1
fi
if [[ ! -f "$DESIGN_FILE" ]]; then
  echo "ERROR: Design doc not found: $DESIGN_FILE" >&2; exit 1
fi

# ─── Fresh start ──────────────────────────────────────────────

if [[ "$FRESH" -eq 1 && -d "$WORKDIR/.convergence" ]]; then
  echo "🗑️  Fresh start — removing $WORKDIR/.convergence/"
  rm -rf "$WORKDIR/.convergence"
fi

# ─── Build task prompt ────────────────────────────────────────

TASK="Run the Black-Box Engineering pipeline with these parameters:

plan_file: $PLAN_FILE
design_file: $DESIGN_FILE
skill_dir: $SCRIPT_DIR
workdir: $WORKDIR
threshold: $THRESHOLD
max_fixes: $MAX_FIXES
max_calls: $MAX_CALLS
holdout: $HOLDOUT_MODE
sage_model: $SAGE_MODEL
quinn_model: $QUINN_MODEL
glitch_model: $GLITCH_MODEL
arbiter_model: $ARBITER_MODEL"

# ─── Launch ───────────────────────────────────────────────────

ORCHESTRATOR="$SCRIPT_DIR/agents/orchestrator.md"

if [[ ! -f "$ORCHESTRATOR" ]]; then
  echo "ERROR: Orchestrator agent not found: $ORCHESTRATOR" >&2
  exit 1
fi

# Scaffold .convergence/ for the orchestrator
mkdir -p "$WORKDIR/.convergence/prompts"

# Write the task prompt to a file the TUI agent can read
TASK_FILE="$WORKDIR/.convergence/prompts/orchestrator-task.md"
echo "$TASK" > "$TASK_FILE"

if [[ "$STANDALONE" -eq 1 ]]; then
  # ─── Standalone mode: launch via synaps run ───
  echo "══════════════════════════════════════════════════════" >&2
  echo "  🚀 Black-Box Engineering Pipeline (standalone)" >&2
  echo "══════════════════════════════════════════════════════" >&2
  echo "  Plan:      $PLAN_FILE" >&2
  echo "  Design:    $DESIGN_FILE" >&2
  echo "  Workdir:   $WORKDIR" >&2
  echo "  Mode:      $([ "$HOLDOUT_MODE" = "true" ] && echo "HOLDOUT 🔒" || echo "INFORMED")" >&2
  echo "  Threshold: $THRESHOLD" >&2
  echo "  Budget:    $MAX_CALLS calls, $MAX_FIXES fix iterations" >&2
  echo "  Models:    Sage=$SAGE_MODEL Quinn=$QUINN_MODEL" >&2
  echo "             Glitch=$GLITCH_MODEL Arbiter=$ARBITER_MODEL" >&2
  echo "══════════════════════════════════════════════════════" >&2
  echo "" >&2
  exec synaps run "$TASK" --agent "$ORCHESTRATOR"
else
  # ─── Default: emit JSON for synaps TUI subagent dispatch ───
  # The calling agent reads this JSON and dispatches via subagent()
  cat <<EMIT_JSON
{
  "agent": "$ORCHESTRATOR",
  "task_file": "$TASK_FILE",
  "plan_file": "$PLAN_FILE",
  "design_file": "$DESIGN_FILE",
  "workdir": "$WORKDIR",
  "holdout": $HOLDOUT_MODE,
  "threshold": $THRESHOLD,
  "max_fixes": $MAX_FIXES,
  "max_calls": $MAX_CALLS,
  "models": {
    "sage": "$SAGE_MODEL",
    "quinn": "$QUINN_MODEL",
    "glitch": "$GLITCH_MODEL",
    "arbiter": "$ARBITER_MODEL"
  }
}
EMIT_JSON
fi
