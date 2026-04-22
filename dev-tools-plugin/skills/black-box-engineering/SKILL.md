---
name: black-box-engineering
description: Multi-agent code builder pipeline — designs, builds, blind-tests, scores, and refines any complex problem through iterative feedback until convergence. Uses native Synaps subagents for orchestration. Two modes — informed (default, collaborative) and holdout (full information walls).
---

# Black-Box Engineering

> *"Quinn never sees the tests. Sage never sees the code. The code converges anyway."*
> *— or, in informed mode: "Trust but verify with numbers."*

A domain-agnostic multi-agent pipeline that runs entirely inside Synaps. The orchestrator agent dispatches Sage, Quinn, Glitch, and Arbiter as native subagents, driving a feedback loop: design → build → test → judge → fix until convergence.

## Architecture

```
┌───────────────────────────────────────────────────┐
│  synaps run "..." --agent orchestrator.md          │
│                                                    │
│  Orchestrator (Opus)                               │
│    ├─ subagent(sage.md, opus)    → scenarios.json  │
│    ├─ subagent(quinn.md, sonnet) → writes files    │
│    ├─ subagent(glitch.md, sonnet)→ test report     │
│    ├─ subagent(arbiter.md, opus) → verdict         │
│    └─ if REWORK → fix loop (Quinn→Glitch→Arbiter) │
│                                                    │
│  Each subagent gets: bash, read, write, edit,      │
│  grep, find, ls — full tool access                 │
└───────────────────────────────────────────────────┘
```

**Key advantage over script-based pipelines:** subagents run in-process with shared auth, real tool execution (Quinn writes files directly, Glitch runs actual tests), automatic token tracking, and mid-run steering.

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
│  The orchestrator enforces this by controlling what     │
│  goes into each subagent's task parameter.              │
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
               └───────────┬───────────┘
                           │
                ┌──────────▼──────────┐
  Phase 1       │    📋 SAGE          │  subagent(sage.md, opus)
                │  Reads design doc   │
                │  Writes scenarios   │
                └──────────┬──────────┘
                           │
                ┌──────────▼──────────┐
  Phase 2       │    🔧 QUINN         │  subagent(quinn.md, sonnet) × N
                │  Reads plan tasks   │  ← Sequential, task by task
                │  Writes code + git  │  ← Uses tools directly
                └──────────┬──────────┘
                           │
              ┌────────────▼────────────┐
  Phase 3     │    🧪 GLITCH           │  subagent(glitch.md, sonnet)
              │  Reads scenarios+code   │
              │  Runs actual tests      │  ← bash, not simulation
              │  Reports pass/fail      │
              └────────────┬────────────┘
                           │
              ┌────────────▼────────────┐
  Phase 4     │    ⚖️  ARBITER          │  subagent(arbiter.md, opus)
              │  Two-stage review:      │
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

| Component | Purpose | How to Verify |
|-----------|---------|---------------|
| **synaps** | CLI — runs the orchestrator and all subagents | `synaps --version` |

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

```bash
SKILL_DIR="/path/to/synaps-skills/dev-tools-plugin/skills/black-box-engineering"

bash "$SKILL_DIR/run-pipeline.sh" \
  <plan-file> <design-file> \
  --workdir <project-dir> \
  [--holdout] \
  [--threshold 0.8] \
  [--max-fixes 2] \
  [--max-calls 10] \
  [--fresh]
```

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
| `--agent <spec>` | No | Model selection (see below) |

### Model Selection

By default, Sage and Arbiter use Opus (deep reasoning), Quinn and Glitch use Sonnet (speed). Override with `--agent`:

| Command | Effect |
|---------|--------|
| `--agent sonnet` | All agents on Sonnet (lightweight) |
| `--agent opus` | All agents on Opus (maximum quality) |
| `--agent quinn=opus` | Quinn also uses Opus, rest keep defaults |

**Recommended configurations:**
- **Default:** Sage + Arbiter on Opus, Quinn + Glitch on Sonnet — best balance
- **Lightweight:** `--agent sonnet` — fast and cheap for simpler tasks
- **Maximum quality:** `--agent opus` — all Opus for complex/critical work

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

## Your Job (the Human)

### Before Launch
1. Run `workflow` Phase 1 (Brainstorm) → produce design doc
2. Run `workflow` Phase 2 (Plan) → produce plan with `## Task N:` headers
3. Classify complexity tier
4. Decide mode: `--holdout` for complex testable work
5. Ensure synaps CLI is installed

### During Pipeline
1. **Monitor**: Watch stdout for phase banners and scores
2. **Intervene only if**:
   - Arbiter returns REVIEW verdict — human decides
   - Max iterations reached — review escalation report
3. **Never**: manually call agent scripts or bypass the orchestrator

### After Convergence
1. Review the committed code
2. Run `workflow` Phase 4 (Finish) for merge/PR/cleanup

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Converged successfully |
| `1` | Max iterations reached |
| `2` | Infrastructure blocker |
| `3` | Call budget exhausted |

## Skill Structure

```
black-box-engineering/
├── SKILL.md                    # This file
├── run-pipeline.sh             # Thin launcher → synaps run
├── scaffold.sh                 # Creates .convergence/ structure
├── agents/
│   ├── orchestrator.md         # Pipeline controller (Opus)
│   ├── sage.md                 # Scenario writer (Opus)
│   ├── quinn.md                # Coder (Sonnet)
│   ├── glitch.md               # Tester (Sonnet)
│   └── arbiter.md              # Judge (Opus)
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

**Do not:**
- Try to call old script-based wrappers — they've been replaced by native subagents
- Manually dispatch agents — the orchestrator does this
- Bypass the orchestrator — it enforces holdout walls and manages checkpoints
