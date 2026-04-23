---
name: black-box-engineering
description: Multi-agent code builder pipeline — designs, builds, blind-tests, scores, and refines any complex problem through iterative feedback until convergence. Uses native Synaps subagents for orchestration. Two modes — informed (default, collaborative) and holdout (full information walls).
---

# Black-Box Engineering

> *"Quinn never sees the tests. Sage never sees the code. The code converges anyway."*
> *— or, in informed mode: "Trust but verify with numbers."*

A domain-agnostic multi-agent pipeline that runs entirely inside Synaps. You — the TUI agent — ARE the orchestrator. You dispatch Sage, Quinn, Glitch, and Arbiter as native subagents, driving a feedback loop: design → build → test → judge → fix until convergence.

## Architecture

```
┌──────────────────────────────────────────────────────┐
│  YOU (the TUI agent) = ORCHESTRATOR                  │
│                                                      │
│  subagent_start(sage.md)    → scenarios.json         │
│  subagent_start(quinn.md)   → writes files    ×N     │
│  subagent_start(glitch.md)  → test report            │
│  subagent_start(arbiter.md) → verdict                │
│  if REWORK → fix loop (Quinn→Glitch→Arbiter)        │
│                                                      │
│  Each subagent spins up visibly in the TUI,          │
│  works with full tool access, then completes.        │
│  You poll progress and report to the user.           │
└──────────────────────────────────────────────────────┘
```

**Why you are the orchestrator:** Subagents don't get `subagent_start`/`subagent_collect` tools — only the top-level TUI session has them. So a nested orchestrator subagent can't dispatch crew members. You must do it directly.

## Two Operating Modes

| Mode | Flag | Philosophy | Best For |
|------|------|-----------|----------|
| **Informed** (default) | *(none)* | Agents share context. Quality measured by numeric scores. | Most development work — faster, collaborative |
| **Holdout** | `--holdout` | Full information walls between agents. Behavior-only judgment. | Complex/testable work where bias elimination matters |

## The Crew

| Agent | Role | Default Model | What It Does |
|-------|------|---------------|-------------|
| **Sage** | Test scenario writer | Opus | Reads design doc, writes behavioral test scenarios |
| **Quinn** | Coder | Sonnet | Reads tasks, writes code directly using tools, commits |
| **Glitch** | Test executor | Sonnet | Reads code + scenarios, runs real tests via bash, reports |
| **Arbiter** | Judge | Opus | Reviews test results against spec, produces scored verdict |

All agents have full tool access (`bash`, `read`, `write`, `edit`, `grep`, `find`, `ls`). Quinn writes files directly — no JSON intermediary. Glitch can actually execute tests — not just simulate them.

### The Iron Law (Holdout Mode Only)

```
┌─────────────────────────────────────────────────────────┐
│  QUINN NEVER SEES THE TEST SPECS.                       │
│  SAGE NEVER SEES QUINN'S CODE.                          │
│  ARBITER NEVER SEES SOURCE CODE.                        │
│  GLITCH NEVER SEES THE DESIGN DOC.                      │
│                                                         │
│  You enforce this by controlling what goes into each    │
│  subagent's task parameter. Double-check before every   │
│  subagent dispatch.                                     │
│  Activated with: --holdout                              │
└─────────────────────────────────────────────────────────┘
```

## Pipeline Flow

```
                    ┌──────────────┐
                    │   Plan File  │ ← from workflow Phase 2
                    │  Design Doc  │ ← from workflow Phase 1
                    └──────┬───────┘
                           │
               ┌───────────▼───────────┐
  Phase 0      │    🔍 SETUP           │
               │  Parse plan, scaffold │
               │  .convergence/        │
               │  tmux launch choice   │
               └───────────┬───────────┘
                           │
                ┌──────────▼──────────┐
  Phase 1       │    📋 SAGE          │  subagent_start(sage.md)
                │  Reads design doc   │  ← visible in TUI
                │  Writes scenarios   │
                └──────────┬──────────┘
                           │
                ┌──────────▼──────────┐
  Phase 2       │    🔧 QUINN         │  subagent_start(quinn.md) × N
                │  Reads plan tasks   │  ← each task visible
                │  Writes code + git  │
                └──────────┬──────────┘
                           │
              ┌────────────▼────────────┐
  Phase 3     │    🧪 GLITCH           │  subagent_start(glitch.md)
              │  Reads scenarios+code   │  ← visible in TUI
              │  Runs actual tests      │
              │  Reports pass/fail      │
              └────────────┬────────────┘
                           │
              ┌────────────▼────────────┐
  Phase 4     │    ⚖️  ARBITER          │  subagent_start(arbiter.md)
              │  Two-stage review:      │  ← visible in TUI
              │  1. Right thing? (spec) │
              │  2. Right way? (quality)│
              │  Numeric 0.0–1.0 score  │
              └────────────┬────────────┘
                           │
                    ┌──────▼──────┐
                    │  CONVERGED? │
                    │  score ≥ T  │
                    └──┬──────┬──┘
                  YES  │      │  NO (max 2 fix iterations)
                       │      │
              ┌────────▼┐  ┌──▼───────────┐
              │  SHIP ✅ │  │  FIX LOOP 🔄 │
              └─────────┘  │  Quinn fix   │
                           │  → Glitch    │
                           │  → Arbiter   │
                           └──────────────┘
```

## Prerequisites

### Required Inputs

| Input | Source | Format |
|-------|--------|--------|
| **Plan file** | `workflow` Phase 2 (Plan) | Markdown with `## Task N: Title` headers |
| **Design doc** | `workflow` Phase 1 (Brainstorm) | Markdown describing the system |

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BBE_SAGE_MODEL` | `claude-opus-4-7` | Model for Sage |
| `BBE_QUINN_MODEL` | `claude-sonnet-4-6` | Model for Quinn |
| `BBE_GLITCH_MODEL` | `claude-sonnet-4-6` | Model for Glitch |
| `BBE_ARBITER_MODEL` | `claude-opus-4-7` | Model for Arbiter |

## Running the Pipeline

### Step 1: Prepare the config

```bash
SKILL_DIR="~/.synaps-cli/plugins/dev-tools/skills/black-box-engineering"

PAYLOAD=$(bash "$SKILL_DIR/run-pipeline.sh" \
  <plan-file> <design-file> \
  --workdir <project-dir> \
  [--holdout] [--fresh] [--agent sonnet])
```

This emits a JSON payload with `agent`, `task_file`, paths, models, and settings. Parse it to get the config.

### Step 2: Ask about tmux (see Tmux Launch Options below)

### Step 3: Execute the orchestration protocol (see below)

### Standalone mode (outside synaps TUI)

For running from a plain terminal without the TUI:

```bash
bash "$SKILL_DIR/run-pipeline.sh" \
  <plan-file> <design-file> \
  --workdir <project-dir> \
  --standalone \
  [--holdout] [--threshold 0.8] [--max-fixes 2] [--max-calls 10] [--fresh]
```

This launches `synaps run` with the orchestrator agent directly.

### Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| `<plan-file>` | ✅ | Path to the implementation plan |
| `<design-file>` | ✅ | Path to the design/spec document |
| `--workdir <dir>` | No | Project directory (default: `.`) |
| `--holdout` | No | Enable information holdout (default: informed mode) |
| `--threshold <float>` | No | Pass score 0.0–1.0 (default: `0.8`) |
| `--max-fixes <int>` | No | Max fix iterations (default: `2`) |
| `--max-calls <int>` | No | Hard cap on subagent calls (default: `10`) |
| `--fresh` | No | Delete checkpoint, start clean |
| `--standalone` | No | Launch via `synaps run` (for use outside TUI) |
| `--agent <spec>` | No | Model selection (see below) |

### Model Selection

By default, Sage and Arbiter use Opus (deep reasoning), Quinn and Glitch use Sonnet (speed). Override with `--agent`:

| Command | Effect |
|---------|--------|
| `--agent sonnet` | All agents on Sonnet (lightweight) |
| `--agent opus` | All agents on Opus (maximum quality) |
| `--agent quinn=opus` | Quinn also uses Opus, rest keep defaults |

---

## Tmux Launch Options

Before starting the pipeline, check if tmux is available and ask the user how they want to run it. Present these options:

```
🚀 Ready to launch BBE pipeline. How would you like to run it?

1. ▶️  Here — I'll orchestrate in this session (you'll see each agent spin up)
2. 📺 New pane — launch in a side pane you can watch
3. 🪟 New window — launch in a separate tmux window tab
```

### Option 1: Current session (default)
Follow the **Orchestration Protocol** below. Each crew member spins up as a visible `subagent_start` call. You poll and report progress inline.

### Option 2: New tmux pane
```
tmux_split(
  direction: "horizontal",   # or "vertical" — ask user preference
  size: "50%",
  command: "synaps run \"$(cat <task_file>)\" --agent <orchestrator.md>",
  title: "🔧 BBE Pipeline"
)
```
Then monitor the pane with `tmux_capture` periodically and report key events.

### Option 3: New tmux window
```
tmux_window(
  action: "create",
  name: "BBE Pipeline",
  command: "synaps run \"$(cat <task_file>)\" --agent <orchestrator.md>"
)
```
Then switch back to the current window and monitor with `tmux_capture`.

### For pane/window options:
- Build the standalone command: `bash <skill_dir>/run-pipeline.sh <plan> <design> --standalone [opts]`
- Use `tmux_split` or `tmux_window` to launch it
- Periodically `tmux_capture` to report progress to the user
- When the pipeline finishes, report the final result

---

## Orchestration Protocol

**Follow this when running in the current session (Option 1).** You are the orchestrator.

### Phase 0: Setup

1. Parse the JSON payload from `run-pipeline.sh`
2. Read the task file to get all parameters
3. Read the plan file and design file
4. Scaffold `.convergence/`:
   ```bash
   cd <workdir> && mkdir -p .convergence/{scenarios,reports,verdicts,prompts,scores,evolution}
   echo '*' > .convergence/.gitignore
   ```
5. Check for existing checkpoint (`.convergence/checkpoint`) — resume if present
6. Parse tasks from the plan: look for `## Task N:` headers
7. Report setup summary to user

### Phase 1: Sage — Write Test Scenarios

Dispatch Sage as a reactive subagent:

```
handle = subagent_start(
  agent: "dev-tools:sage",
  model: <sage_model>,
  task: "<sage_task>",
  timeout: 600
)
```

**Sage's task** (build from the files you read):
- In **informed mode**: include the full design doc AND the plan
- In **holdout mode**: include ONLY the design doc (Sage never sees the plan)
- Tell Sage to write output to `<workdir>/.convergence/scenarios/scenarios.json`

**Poll** with `subagent_status(handle)` every ~15s. Report progress:
```
🌿 Sage writing scenarios... (30s, 6 tool calls)
```

After Sage finishes (`subagent_collect`):
1. Verify scenarios JSON exists and parses
2. Count and log scenarios
3. Save checkpoint

### Phase 2: Quinn — Code Each Task

For each task **sequentially**, dispatch Quinn:

```
handle = subagent_start(
  agent: "dev-tools:quinn",
  model: <quinn_model>,
  task: "<quinn_task>",
  timeout: 600
)
```

**Quinn's task** for each numbered task:
- The task body from the plan
- The plan's overall goal and architecture (header)
- In **informed mode**: include scenario names (NOT full specs) as hints
- In **holdout mode**: Quinn NEVER sees any test scenario info
- Tell Quinn to work in `<workdir>` and write/modify files there
- Include content of existing files Quinn needs to modify (read them first)

**Poll and report:**
```
🛠️  Quinn [Task 2/3] coding... (25s, 8 tool calls)
```

After each Quinn task finishes:
1. `bash cd <workdir> && git add -A && git commit -m "feat: <task-title> (Quinn, task N)" --allow-empty -q`
2. Save checkpoint

### Phase 3: Glitch — Test the Code

Dispatch Glitch:

```
handle = subagent_start(
  agent: "dev-tools:glitch",
  model: <glitch_model>,
  task: "<glitch_task>",
  timeout: 600
)
```

**Glitch's task**:
- The scenarios from `.convergence/scenarios/scenarios.json`
- In **informed mode**: include the design doc for context
- In **holdout mode**: Glitch NEVER sees the design doc
- Tell Glitch to explore code in `<workdir>`, run tests, write report to `.convergence/reports/run-<iteration>.json`
- List key source files for Glitch to examine

**Poll and report:**
```
🔬 Glitch testing... (40s, 14 tool calls)
```

After Glitch finishes:
1. Verify report JSON exists and parses
2. Log pass/fail counts

### Phase 4: Arbiter — Judge the Result

Dispatch Arbiter:

```
handle = subagent_start(
  agent: "dev-tools:arbiter",
  model: <arbiter_model>,
  task: "<arbiter_task>",
  timeout: 600
)
```

**Arbiter's task**:
- The design doc (always)
- The test report from Glitch (always)
- The pass threshold
- In **informed mode**: include source code listing
- In **holdout mode**: Arbiter NEVER sees source code
- Tell Arbiter to write verdict to `.convergence/verdicts/verdict-<iteration>.json`

After Arbiter finishes:
1. Read and parse verdict JSON
2. Extract: overall score, verdict (PROCEED/REVIEW/REWORK), structured feedback
3. Log verdict and dimension scores

### Phase 5: Verdict Routing

**PROCEED** (overall ≥ threshold):
- `bash cd <workdir> && git add -A && git commit -m "ship: converged (score <overall>)" --allow-empty -q`
- Report success with final summary
- Stop

**REVIEW** (overall 0.7 – threshold):
- Report review-band score
- Tell user: human decision needed
- Stop

**REWORK** (overall < 0.7):
- Check iteration count ≥ max_fixes → escalation report, stop
- Check call budget → if exhausted, stop
- Check stagnation (last 3 scores within 0.05)
- Extract structured feedback → go to Fix Loop

### Fix Loop

1. Build fix prompt for Quinn:
   - Structured feedback (behavior gaps + observed behavior)
   - The design doc
   - In informed mode: failing scenario names
   - In holdout mode: only behavior descriptions
   - Tell Quinn to read current files, fix issues, write updates
   - If stagnation: tell Quinn to try fundamentally different approach

2. Dispatch Quinn via `subagent_start` (same polling pattern)
3. Commit: `bash cd <workdir> && git add -A && git commit -m "fix: iteration <N> (Quinn)" --allow-empty -q`
4. Go back to Phase 3 → Phase 4 → Phase 5

---

## Quality Scoring System

### Score Schema

```json
{
  "overall": 0.82,
  "dimensions": {
    "spec_compliance": 0.9,
    "code_quality": 0.8,
    "test_coverage": 0.7,
    "edge_cases": 0.8,
    "security": 0.85
  },
  "verdict": "PROCEED",
  "stage": "right_thing"
}
```

### Verdict Thresholds

| Score | Verdict | Action |
|-------|---------|--------|
| ≥ 0.8 | **PROCEED** | Pipeline converged |
| 0.7 – 0.79 | **REVIEW** | Human decides |
| < 0.7 | **REWORK** | Automatic fix loop |

## Adaptive Design Gate

| Tier | Trigger | Design Requirement | Holdout Mode? |
|------|---------|-------------------|---------------|
| **Tiny** (<30 min) | Config changes, one-file edits | 2-sentence intent | No — overkill |
| **Medium** (30 min – 2hr) | Multi-file changes, refactors | 1-page design doc | Optional |
| **Large** (2hr+) | New features, architecture changes | Full brainstorming | Recommended |

## Checkpoint Format

Write to `.convergence/checkpoint` after each major step:
```
CP_SAGE_DONE=1
CP_TASKS_COMPLETED=3
CP_ITERATION=2
CP_CALL_COUNT=6
```

On startup, if checkpoint exists, read it and skip completed phases.

## Call Budget

Track total subagent dispatches. Each `subagent_start()` counts as 1.
- If count ≥ max_calls, stop immediately with budget exhaustion error
- Log remaining budget after each call

## Reporting

Use clear banners to mark phases:

```
══════════════════════════════════════════════════════
  🔍 PHASE 0: SETUP
══════════════════════════════════════════════════════
```

While polling a running agent, report progress:
```
  🌿 Sage working... (45s elapsed, 8 tool calls)
  🛠️  Quinn [Task 2/3] working... (30s elapsed, 5 tool calls)
  🔬 Glitch testing... (20s elapsed, 12 tool calls)
  ⚖️  Arbiter judging... (15s elapsed, 3 tool calls)
```

After each phase, report key metrics:
- Scenario count after Sage
- Files written after each Quinn task
- Pass/fail counts after Glitch
- Score dimensions and verdict after Arbiter

## Error Handling

- If a subagent times out: log it, check if partial results are usable, consider `subagent_resume`
- If a subagent produces invalid JSON: retry once, then fail with details
- If git commit fails: continue (non-critical)
- If a file is missing: log and adapt (don't crash the pipeline)

## Your Job (the Human)

### Before Launch
1. Run `workflow` Phase 1 (Brainstorm) → produce design doc
2. Run `workflow` Phase 2 (Plan) → produce plan with `## Task N:` headers
3. Classify complexity tier
4. Decide mode: `--holdout` for complex testable work

### During Pipeline
1. **Monitor**: Watch the TUI — each agent spins up visibly
2. **Intervene only if**:
   - Arbiter returns REVIEW verdict — human decides
   - Max iterations reached — review escalation report
3. Choose tmux pane/window for hands-off watching

### After Convergence
1. Review the committed code
2. Run `workflow` Phase 4 (Finish) for merge/PR/cleanup

## Skill Structure

```
black-box-engineering/
├── SKILL.md                    # This file — orchestration protocol
├── run-pipeline.sh             # Config prep + standalone launcher
├── scaffold.sh                 # Creates .convergence/ structure
├── agents/
│   ├── orchestrator.md         # Standalone mode agent (synaps run)
│   ├── sage.md                 # Scenario writer
│   ├── quinn.md                # Coder
│   ├── glitch.md               # Tester
│   └── arbiter.md              # Judge
├── scripts/
│   ├── common.sh               # Minimal shared helpers
│   └── score-utils.sh          # Scoring + evolution tracking
├── prompts/
│   ├── task-template.md        # Template for Quinn task prompts
│   └── feedback-schema.json    # Holdout-safe feedback schema
├── templates/
│   ├── design-doc.md           # Design doc template
│   ├── plan-header.md          # Plan header template
│   ├── task-template.md        # Task template
│   ├── escalation-report.md    # Escalation template
│   └── score-schema.json       # Scoring schema
└── tests/
    └── ...                     # Pipeline tests
```

## Relationship to Other Skills

| Skill | Relationship |
|-------|-------------|
| `workflow` Phase 1 (Brainstorm) | Produces the design doc (input) |
| `workflow` Phase 2 (Plan) | Produces the plan file (input) |
| `workflow` Phase 3 (Execute) | Alternative: manual execution |
| `workflow` Phase 4 (Finish) | Post-convergence merge/PR/cleanup |
