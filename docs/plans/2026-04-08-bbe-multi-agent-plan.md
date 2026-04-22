# Multi-Backend Agents for BBE — Implementation Plan

**Goal:** Let each BBE agent role (Sage, Quinn, Glitch, Arbiter) be powered by pi or qwen, selectable via `--agent` flag.
**Architecture:** New `call-qwen.py` mirrors `call-opus.py` using acpx. Dispatch layer in `common.sh` routes per role. Agent wrappers change one call each. Pipeline parses `--agent` flag into env vars.
**Design Doc:** `docs/plans/2026-04-08-bbe-multi-agent-design.md`
**Estimated Tasks:** 8
**Complexity:** Medium

---

## Task 1: Create `call-qwen.py` — Qwen backend caller

**Files:**
- Create: `black-box-engineering/scripts/call-qwen.py`

**Step 1: Implement**

Create `call-qwen.py` with the same interface as `call-opus.py`: takes system-prompt-file, user-prompt-file, output-file as args.

```python
#!/usr/bin/env python3
"""call-qwen.py — Call Qwen Code via acpx

Usage: call-qwen.py <system-prompt-file> <user-prompt-file> <output-file>

Mirrors call-opus.py but uses acpx qwen exec instead of pi CLI.
Combines system + user prompts since acpx has no --system-prompt flag.
"""
import json
import sys
import os
import subprocess
import tempfile


def extract_json(text):
    """Extract the first valid JSON object from text, even if surrounded by noise."""
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # Strip markdown code fences
    stripped = text
    if stripped.startswith("```"):
        lines = stripped.split("\n")
        lines = [l for l in lines if not l.strip().startswith("```")]
        stripped = "\n".join(lines).strip()
        try:
            return json.loads(stripped)
        except json.JSONDecodeError:
            pass

    # Find the first { ... } via brace matching
    start = text.find("{")
    while start != -1:
        depth = 0
        in_string = False
        escape_next = False
        for i in range(start, len(text)):
            c = text[i]
            if escape_next:
                escape_next = False
                continue
            if c == "\\" and in_string:
                escape_next = True
                continue
            if c == '"' and not escape_next:
                in_string = not in_string
                continue
            if in_string:
                continue
            if c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    candidate = text[start:i+1]
                    try:
                        return json.loads(candidate)
                    except json.JSONDecodeError:
                        break
        start = text.find("{", start + 1)

    return None


def main():
    if len(sys.argv) != 4:
        print("Usage: call-qwen.py <system-prompt-file> <user-prompt-file> <output-file>", file=sys.stderr)
        sys.exit(1)

    system_file, user_file, output_file = sys.argv[1], sys.argv[2], sys.argv[3]

    system_prompt = open(system_file).read().strip()
    user_prompt = open(user_file).read().strip()

    # Combine system + user into a single prompt
    combined = f"""## System Instructions

{system_prompt}

---

## Task

{user_prompt}"""

    model = os.environ.get("QWEN_MODEL", "")

    # Write combined prompt to temp file (acpx reads from --file)
    with tempfile.NamedTemporaryFile(mode="w", suffix=".md", delete=False) as tmp:
        tmp.write(combined)
        tmp_path = tmp.name

    try:
        cmd = ["acpx", "--approve-all", "--format", "quiet"]
        if model:
            cmd.extend(["--model", model])
        cmd.extend(["qwen", "exec", "--file", tmp_path])

        agent_label = f"qwen" + (f" model={model}" if model else "")
        print(f"  acpx: {agent_label}", file=sys.stderr)

        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=600,
        )
    except subprocess.TimeoutExpired:
        print("ERROR: acpx qwen call timed out after 600s", file=sys.stderr)
        sys.exit(1)
    finally:
        os.unlink(tmp_path)

    if result.returncode != 0:
        print(f"ERROR: acpx exited with code {result.returncode}", file=sys.stderr)
        if result.stderr:
            print(f"  stderr: {result.stderr[:500]}", file=sys.stderr)
        sys.exit(1)

    text = result.stdout.strip()

    if not text:
        print("ERROR: Empty response from acpx qwen", file=sys.stderr)
        sys.exit(1)

    parsed = extract_json(text)
    if parsed is None:
        with open(output_file + ".raw", "w") as f:
            f.write(text)
        print(f"ERROR: Response is not valid JSON. Raw saved to {output_file}.raw", file=sys.stderr)
        sys.exit(1)

    with open(output_file, "w") as f:
        json.dump(parsed, f, indent=2)

    print(f"  OK: {len(text)} chars", file=sys.stderr)


if __name__ == "__main__":
    main()
```

**Step 2: Verify**
Run: `python3 black-box-engineering/scripts/call-qwen.py --help 2>&1 || true`
Expected: Usage message to stderr, exit 1

**Step 3: Commit**
```bash
git add -A && git commit -m "feat(bbe): add call-qwen.py — acpx backend for agent calls"
```

---

## Task 2: Add dispatch layer to `common.sh`

**Files:**
- Modify: `black-box-engineering/scripts/common.sh`

**Step 1: Implement**

Add after the existing `retry_call_opus` function:

```bash
# ─── Qwen (acpx → Qwen Code) ────────────────────────────────

# Args: $1 = system prompt file, $2 = user prompt file, $3 = output file
call_qwen() {
  local system_file="$1"
  local user_file="$2"
  local output_file="$3"
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

  QWEN_MODEL="${QWEN_MODEL:-}" python3 "$script_dir/call-qwen.py" "$system_file" "$user_file" "$output_file"
}

retry_call_qwen() {
  local system_file="$1"
  local user_file="$2"
  local output_file="$3"
  local delays=(2 5 10)
  local attempt=0

  while (( attempt < QP_MAX_RETRIES )); do
    if call_qwen "$system_file" "$user_file" "$output_file"; then
      return 0
    fi
    echo "WARN: Qwen attempt $((attempt + 1)) failed, retrying in ${delays[$attempt]:-10}s..." >&2
    sleep "${delays[$attempt]:-10}"
    ((attempt++))
  done

  echo "ERROR: All $QP_MAX_RETRIES Qwen attempts failed" >&2
  return 1
}

# ─── Agent dispatch ──────────────────────────────────────────

# Default backends (overridden by --agent flag or env vars)
BBE_SAGE_AGENT="${BBE_SAGE_AGENT:-pi}"
BBE_QUINN_AGENT="${BBE_QUINN_AGENT:-pi}"
BBE_GLITCH_AGENT="${BBE_GLITCH_AGENT:-pi}"
BBE_ARBITER_AGENT="${BBE_ARBITER_AGENT:-pi}"

# Dispatch to the right backend for a given role
# Args: $1 = role (SAGE|QUINN|GLITCH|ARBITER), $2 = system, $3 = user, $4 = output
call_agent() {
  local role="$1"
  local system_file="$2"
  local user_file="$3"
  local output_file="$4"

  local agent_var="BBE_${role}_AGENT"
  local agent="${!agent_var:-pi}"

  case "$agent" in
    pi)   call_opus "$system_file" "$user_file" "$output_file" ;;
    qwen) call_qwen "$system_file" "$user_file" "$output_file" ;;
    *)    echo "ERROR: Unknown agent backend '$agent' for $role" >&2; return 1 ;;
  esac
}

retry_call_agent() {
  local role="$1"
  local system_file="$2"
  local user_file="$3"
  local output_file="$4"

  local agent_var="BBE_${role}_AGENT"
  local agent="${!agent_var:-pi}"

  case "$agent" in
    pi)   retry_call_opus "$system_file" "$user_file" "$output_file" ;;
    qwen) retry_call_qwen "$system_file" "$user_file" "$output_file" ;;
    *)    echo "ERROR: Unknown agent backend '$agent' for $role" >&2; return 1 ;;
  esac
}

# Check that the selected agent backend is available
# Args: $1 = role name
check_agent() {
  local role="$1"
  local agent_var="BBE_${role}_AGENT"
  local agent="${!agent_var:-pi}"

  case "$agent" in
    pi)
      if ! check_pi; then
        echo "ERROR: pi CLI not found — $role requires pi" >&2
        return 1
      fi
      ;;
    qwen)
      if ! command -v acpx &>/dev/null; then
        echo "ERROR: acpx not found — $role (qwen backend) requires acpx" >&2
        echo "  Install: npm install -g acpx@latest" >&2
        return 1
      fi
      if ! command -v qwen &>/dev/null; then
        echo "ERROR: qwen CLI not found — $role (qwen backend) requires qwen" >&2
        echo "  Install: npm install -g @qwen-code/qwen-code" >&2
        return 1
      fi
      ;;
    *)
      echo "ERROR: Unknown agent backend '$agent' for $role" >&2
      return 1
      ;;
  esac
  return 0
}
```

**Step 2: Verify**
Run: `bash -c 'source black-box-engineering/scripts/common.sh && echo "BBE_QUINN_AGENT=$BBE_QUINN_AGENT"'`
Expected: `BBE_QUINN_AGENT=pi`

**Step 3: Commit**
```bash
git add -A && git commit -m "feat(bbe): add agent dispatch layer to common.sh — pi/qwen routing"
```

---

## Task 3: Wire Quinn to use dispatch

**Files:**
- Modify: `black-box-engineering/scripts/quinn.sh`

**Step 1: Implement**

Replace these lines:

```bash
# Check pi CLI
if ! check_pi; then
  echo "ERROR: pi CLI not found — Quinn requires pi" >&2
  exit 1
fi

# Call Quinn via Opus (pi CLI)
if ! retry_call_opus "$SYSTEM_PROMPT" "$TASK_FILE" "$OUTPUT_FILE"; then
  echo "ERROR: Quinn failed to produce valid output after retries" >&2
  exit 1
fi
```

With:

```bash
# Check agent backend
if ! check_agent "QUINN"; then
  exit 1
fi

# Call Quinn via configured backend
if ! retry_call_agent "QUINN" "$SYSTEM_PROMPT" "$TASK_FILE" "$OUTPUT_FILE"; then
  echo "ERROR: Quinn failed to produce valid output after retries" >&2
  exit 1
fi
```

**Step 2: Verify**
Run: `grep -c "retry_call_agent" black-box-engineering/scripts/quinn.sh`
Expected: `1`

**Step 3: Commit**
```bash
git add -A && git commit -m "feat(bbe): wire Quinn to agent dispatch"
```

---

## Task 4: Wire Sage to use dispatch

**Files:**
- Modify: `black-box-engineering/scripts/sage.sh`

**Step 1: Implement**

Replace these lines:

```bash
if ! check_pi; then
  echo "ERROR: pi CLI not found — Sage requires pi" >&2
  exit 1
fi

# Call Sage via Opus (pi CLI)
if ! retry_call_opus "$SYSTEM_PROMPT" "$SAGE_PROMPT" "$OUTPUT_FILE"; then
  echo "ERROR: Sage failed to produce valid output after retries" >&2
  exit 1
fi
```

With:

```bash
# Check agent backend
if ! check_agent "SAGE"; then
  exit 1
fi

# Call Sage via configured backend
if ! retry_call_agent "SAGE" "$SYSTEM_PROMPT" "$SAGE_PROMPT" "$OUTPUT_FILE"; then
  echo "ERROR: Sage failed to produce valid output after retries" >&2
  exit 1
fi
```

**Step 2: Verify**
Run: `grep -c "retry_call_agent" black-box-engineering/scripts/sage.sh`
Expected: `1`

**Step 3: Commit**
```bash
git add -A && git commit -m "feat(bbe): wire Sage to agent dispatch"
```

---

## Task 5: Wire Glitch to use dispatch

**Files:**
- Modify: `black-box-engineering/scripts/glitch.sh`

**Step 1: Implement**

Replace these lines:

```bash
# Check pi CLI
if ! check_pi; then
  echo "ERROR: pi CLI not found — Glitch requires pi" >&2
  exit 1
fi

# Call Glitch via Opus (pi CLI)
if ! retry_call_opus "$SYSTEM_PROMPT" "$TASK_FILE" "$OUTPUT_FILE"; then
  echo "ERROR: Glitch failed to produce valid output after retries" >&2
  exit 1
fi
```

With:

```bash
# Check agent backend
if ! check_agent "GLITCH"; then
  exit 1
fi

# Call Glitch via configured backend
if ! retry_call_agent "GLITCH" "$SYSTEM_PROMPT" "$TASK_FILE" "$OUTPUT_FILE"; then
  echo "ERROR: Glitch failed to produce valid output after retries" >&2
  exit 1
fi
```

**Step 2: Verify**
Run: `grep -c "retry_call_agent" black-box-engineering/scripts/glitch.sh`
Expected: `1`

**Step 3: Commit**
```bash
git add -A && git commit -m "feat(bbe): wire Glitch to agent dispatch"
```

---

## Task 6: Wire Arbiter to use dispatch

**Files:**
- Modify: `black-box-engineering/scripts/arbiter.sh`

**Step 1: Implement**

Replace these lines:

```bash
if ! check_pi; then
  echo "ERROR: pi CLI not found — Arbiter requires pi" >&2
  exit 1
fi

# Call Arbiter via Opus (pi CLI)
if ! retry_call_opus "$SYSTEM_PROMPT" "$PROMPT_FILE" "$OUTPUT_FILE"; then
  echo "ERROR: Arbiter failed to produce valid output after retries" >&2
  exit 1
fi
```

With:

```bash
# Check agent backend
if ! check_agent "ARBITER"; then
  exit 1
fi

# Call Arbiter via configured backend
if ! retry_call_agent "ARBITER" "$SYSTEM_PROMPT" "$PROMPT_FILE" "$OUTPUT_FILE"; then
  echo "ERROR: Arbiter failed to produce valid output after retries" >&2
  exit 1
fi
```

**Step 2: Verify**
Run: `grep -c "retry_call_agent" black-box-engineering/scripts/arbiter.sh`
Expected: `1`

**Step 3: Commit**
```bash
git add -A && git commit -m "feat(bbe): wire Arbiter to agent dispatch"
```

---

## Task 7: Parse `--agent` flag in `run-pipeline.sh`

**Files:**
- Modify: `black-box-engineering/run-pipeline.sh`

**Step 1: Implement**

Add to the argument parsing block, after the `--fresh` case:

```bash
    --agent)
      AGENT_SPEC="$2"; shift 2
      # Parse agent spec: "qwen" (global) or "sage=qwen,quinn=pi" (per-role)
      if [[ "$AGENT_SPEC" == *"="* ]]; then
        IFS=',' read -ra PAIRS <<< "$AGENT_SPEC"
        for pair in "${PAIRS[@]}"; do
          role="${pair%%=*}"
          backend="${pair#*=}"
          role_upper="$(echo "$role" | tr '[:lower:]' '[:upper:]')"
          case "$role_upper" in
            SAGE|QUINN|GLITCH|ARBITER)
              export "BBE_${role_upper}_AGENT=$backend"
              ;;
            *) echo "ERROR: Unknown role '$role' in --agent spec" >&2; exit 1 ;;
          esac
        done
      else
        # Global: all agents use the same backend
        export BBE_SAGE_AGENT="$AGENT_SPEC"
        export BBE_QUINN_AGENT="$AGENT_SPEC"
        export BBE_GLITCH_AGENT="$AGENT_SPEC"
        export BBE_ARBITER_AGENT="$AGENT_SPEC"
      fi
      ;;
```

Add to the preflight section, after the existing `check_pi` block, replace:

```bash
if ! check_pi; then
  fail "pi CLI not found in PATH"; exit 2
fi
ok "pi CLI: $OPUS_MODEL (thinking: $OPUS_THINKING) — all agents"
```

With:

```bash
# Check agent backends for each role
AGENT_SUMMARY=""
for role in SAGE QUINN GLITCH ARBITER; do
  agent_var="BBE_${role}_AGENT"
  agent="${!agent_var:-pi}"
  if ! check_agent "$role"; then
    fail "$role backend '$agent' not available"; exit 2
  fi
  AGENT_SUMMARY="${AGENT_SUMMARY}${role}=${agent} "
done
ok "Agent backends: $AGENT_SUMMARY"
if [[ "${BBE_SAGE_AGENT:-pi}" == "pi" || "${BBE_QUINN_AGENT:-pi}" == "pi" || "${BBE_GLITCH_AGENT:-pi}" == "pi" || "${BBE_ARBITER_AGENT:-pi}" == "pi" ]]; then
  ok "pi CLI: $OPUS_MODEL (thinking: $OPUS_THINKING)"
fi
if [[ "${BBE_SAGE_AGENT:-pi}" == "qwen" || "${BBE_QUINN_AGENT:-pi}" == "qwen" || "${BBE_GLITCH_AGENT:-pi}" == "qwen" || "${BBE_ARBITER_AGENT:-pi}" == "qwen" ]]; then
  ok "qwen: acpx $(acpx --version 2>/dev/null || echo 'unknown')"
fi
```

Add to the `--help` output:

```
  --agent <spec>        Agent backend: 'qwen' (all) or 'sage=qwen,quinn=pi' (per-role)
```

**Step 2: Verify**
Run: `bash black-box-engineering/run-pipeline.sh --help 2>&1 | grep -c agent`
Expected: `1` (the help line)

**Step 3: Commit**
```bash
git add -A && git commit -m "feat(bbe): parse --agent flag in run-pipeline.sh"
```

---

## Task 8: Update SKILL.md documentation

**Files:**
- Modify: `black-box-engineering/SKILL.md`

**Step 1: Implement**

In **The Crew** table, add a "Backend" column:

```markdown
| Agent | Role | Default Backend | Informed Mode | Holdout Mode |
|-------|------|-----------------|---------------|--------------|
| **Sage** | Test scenario writer | pi (Opus) | Sees design doc + plan | Sees design doc only |
| **Quinn** | Coder | pi (Opus) | Sees plan, tasks, test feedback | Sees plan + tasks |
| **Glitch** | Test executor | pi (Opus) | Sees scenarios + code + design | Sees scenarios + code |
| **Arbiter** | Judge | pi (Opus) | Sees design + report + code | Sees design + report |
```

Add new section after "Running the Pipeline" arguments table:

```markdown
### Agent Backend Selection

By default all agents use pi CLI with Claude Opus. Use `--agent` to route agents to Qwen Code (via acpx):

| Command | Effect |
|---------|--------|
| `--agent qwen` | All agents use Qwen Code |
| `--agent quinn=qwen` | Only Quinn uses Qwen, rest use pi |
| `--agent quinn=qwen,glitch=qwen` | Mix backends per role |

Per-role environment variables (override `--agent`):

| Variable | Default | Description |
|----------|---------|-------------|
| `BBE_SAGE_AGENT` | `pi` | Backend for Sage (`pi` or `qwen`) |
| `BBE_QUINN_AGENT` | `pi` | Backend for Quinn |
| `BBE_GLITCH_AGENT` | `pi` | Backend for Glitch |
| `BBE_ARBITER_AGENT` | `pi` | Backend for Arbiter |
| `QWEN_MODEL` | *(qwen default)* | Model override for qwen-backed agents |

**Qwen Code prerequisites:** `npm install -g @qwen-code/qwen-code acpx@latest` and run `qwen auth qwen-oauth` (or configure API key). See the `qwen-code` skill for setup details.
```

Add `--agent` to the arguments table:

```markdown
| `--agent <spec>` | No | Agent backend: `qwen` (all) or `sage=qwen,quinn=pi` (per-role). Default: `pi` |
```

Add to Environment Variables table:

```markdown
| `BBE_SAGE_AGENT` | `pi` | Agent backend for Sage (`pi` or `qwen`) |
| `BBE_QUINN_AGENT` | `pi` | Agent backend for Quinn |
| `BBE_GLITCH_AGENT` | `pi` | Agent backend for Glitch |
| `BBE_ARBITER_AGENT` | `pi` | Agent backend for Arbiter |
| `QWEN_MODEL` | *(default)* | Model override for qwen-backed agents |
```

Add to Prerequisites table:

```markdown
| **acpx + qwen** | CLI for qwen-backed agents (optional) | `acpx --version && qwen --version` |
```

**Step 2: Verify**
Run: `grep -c "qwen" black-box-engineering/SKILL.md`
Expected: ≥ 10

**Step 3: Commit**
```bash
git add -A && git commit -m "docs(bbe): document --agent flag and qwen backend support"
```
