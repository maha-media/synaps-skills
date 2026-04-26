# Multi-Backend Agents for Black-Box Engineering — Design

## Problem

All 4 BBE agents (Sage, Quinn, Glitch, Arbiter) are hardwired to `call-opus.py` → `pi -p --model opus`. No way to use Qwen Code or any other agent backend.

## Solution

Add a dispatch layer so each agent role can be powered by **pi** (default) or **qwen** (via acpx), selectable per-run via `--agent` flag.

## Architecture

### CLI Interface

```bash
# All agents use qwen
run-pipeline.sh plan.md design.md --agent qwen

# Per-role assignment (unspecified roles default to pi)
run-pipeline.sh plan.md design.md --agent sage=qwen
run-pipeline.sh plan.md design.md --agent quinn=qwen,glitch=qwen

# Explicit full mapping
run-pipeline.sh plan.md design.md --agent sage=pi,quinn=qwen,glitch=qwen,arbiter=pi
```

### Dispatch Flow

```
run-pipeline.sh
  --agent flag → parse into BBE_SAGE_AGENT, BBE_QUINN_AGENT, etc.
  
common.sh
  call_agent(role, system, user, output)
    ├── BBE_<ROLE>_AGENT=pi   → call_opus(system, user, output)     [existing]
    └── BBE_<ROLE>_AGENT=qwen → call_qwen(system, user, output)     [new]

call-qwen.py  (new, mirrors call-opus.py)
  1. Read system prompt + user prompt
  2. Combine into single prompt (acpx has no --system-prompt flag)
  3. Write combined prompt to temp file
  4. Run: acpx --approve-all --format quiet qwen exec --file <tmpfile>
  5. Extract JSON from stdout
  6. Write to output file
```

### Agent Wrapper Change (each one)

```bash
# Before
retry_call_opus "$SYSTEM_PROMPT" "$TASK_FILE" "$OUTPUT_FILE"

# After  
retry_call_agent "QUINN" "$SYSTEM_PROMPT" "$TASK_FILE" "$OUTPUT_FILE"
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BBE_SAGE_AGENT` | `pi` | Backend for Sage |
| `BBE_QUINN_AGENT` | `pi` | Backend for Quinn |
| `BBE_GLITCH_AGENT` | `pi` | Backend for Glitch |
| `BBE_ARBITER_AGENT` | `pi` | Backend for Arbiter |
| `QWEN_MODEL` | *(qwen default)* | Model override for qwen calls |

### Key Decisions

1. **System prompt folding**: acpx qwen exec has no `--system-prompt` equivalent. `call-qwen.py` prefixes the system prompt as `## System Instructions` in the combined prompt. JSON output rules stay identical.

2. **`--format quiet`**: Use quiet mode to get clean assistant text only, no ACP framing noise. Same JSON extraction logic as call-opus.py.

3. **Defaults to pi**: Zero behavior change if `--agent` is not passed. Fully backwards compatible.

4. **Per-role granularity via env vars**: The `--agent` flag is sugar that sets env vars. Advanced users can set `BBE_QUINN_AGENT=qwen` directly.

5. **Retry logic reused**: `retry_call_agent` wraps `call_agent` with the same retry/delay logic as `retry_call_opus`.
