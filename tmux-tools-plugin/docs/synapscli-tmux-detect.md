# Proposal: auto-detect `$TMUX` in synapscli and surface it to the agent

## Problem

When Synaps starts inside a tmux session, the agent has access to powerful workflows it can't access otherwise — spawning side panes, driving long-running interactive commands, letting the user watch and steer in real time. Today, the agent has no idea it's in tmux unless it explicitly checks `$TMUX` via a `bash` tool call. That means the relevant skill (`tmux-tools`) is never auto-suggested, and most agent runs default to the worse `bash`-only workflow.

## Goal

When `$TMUX` is set at synapscli startup:

1. Surface the fact to the agent's system prompt or initial context.
2. Optionally auto-load skills that declare `auto_load_when: tmux` in their frontmatter.
3. Expose a few tmux-aware variables (session/window/pane ids) for skills to use.

## Design

Three small changes, isolated, no breakage of existing flows.

### 1. Detection at startup

Add a new module `src/runtime/tmux.rs`:

```rust
//! Detect whether synapscli is running inside tmux, and capture
//! useful pane/window context for skills that want it.

use std::env;
use std::process::Command;

#[derive(Debug, Clone)]
pub struct TmuxContext {
    pub socket: String,        // value of $TMUX (server socket path,pid,session)
    pub session_name: String,  // e.g. "main"
    pub window_index: u32,     // e.g. 0
    pub pane_index: u32,       // e.g. 1
    pub pane_id: String,       // e.g. "%2"
    pub pane_count: u32,       // panes currently in this window
}

impl TmuxContext {
    pub fn detect() -> Option<Self> {
        let socket = env::var("TMUX").ok()?;
        // Run `tmux display-message -p` to fill in the rest.
        let format = "#{session_name}|#{window_index}|#{pane_index}|#{pane_id}|#{window_panes}";
        let out = Command::new("tmux")
            .args(["display-message", "-p", format])
            .output()
            .ok()?;
        if !out.status.success() { return None; }
        let s = String::from_utf8_lossy(&out.stdout);
        let parts: Vec<&str> = s.trim().split('|').collect();
        if parts.len() != 5 { return None; }
        Some(Self {
            socket,
            session_name: parts[0].to_string(),
            window_index: parts[1].parse().ok()?,
            pane_index:   parts[2].parse().ok()?,
            pane_id:      parts[3].to_string(),
            pane_count:   parts[4].parse().ok()?,
        })
    }
}
```

### 2. Inject into agent system prompt

In the chatui boot sequence (around `chatui/mod.rs:198` where plugins/skills are discovered), call `TmuxContext::detect()` and append a short hint to the system prompt:

```text
## Runtime context

You are running inside tmux (session=`main`, window=0, pane=%2 of 3).
You can spawn worker panes via the `tmux` skill (run `load_skill tmux`)
to drive long-running, interactive, or streaming work the user can
watch and intervene in. Prefer this over blocking `bash` tool calls
for installs needing sudo, log tailing, builds, or parallel shells.
```

This is conditional — only added when tmux is detected. Cost: ~80 tokens.

### 3. Skill frontmatter: `auto_load_when`

Extend `SkillFrontmatter` (in `src/skills/loader.rs`) with an optional `auto_load_when` field:

```yaml
---
name: tmux
description: ...
auto_load_when: tmux
---
```

When the loader builds the skill list, any skill with `auto_load_when: tmux` is _eagerly_ loaded into the agent context (its body inlined into the system prompt) when `TmuxContext::detect()` returns Some. Other values (`auto_load_when: ssh`, `auto_load_when: docker`) can be added later as the runtime context grows.

This is opt-in per skill — existing skills are unaffected.

## Implementation sketch

```
src/runtime/
  mod.rs              — pub mod tmux;
  tmux.rs             — TmuxContext::detect()

src/chatui/mod.rs     — call TmuxContext::detect() once, store in app state
src/chatui/system.rs  — append runtime context block to system prompt
src/skills/loader.rs  — extend SkillFrontmatter, gate auto-load on detect()
```

Approx. 80-120 lines of Rust. No new dependencies (uses `std::process::Command` to shell out to `tmux`, which is already required to be installed for the user to be in tmux at all).

## Tests

```rust
#[test]
fn tmux_context_parses_display_message_output() {
    // mock tmux output
}

#[test]
fn skill_loader_eagerly_loads_auto_load_when_tmux() {
    // env::set_var("TMUX", "/tmp/tmux-1000/default,123,0");
    // assert tmux skill is in eager set
}

#[test]
fn skill_loader_skips_auto_load_when_no_tmux() {
    // env::remove_var("TMUX");
    // assert tmux skill is NOT in eager set (only on-demand via load_skill)
}
```

## Open questions

- **Should it auto-load the skill or just hint?** Safer default: hint only (Section 2), let the agent decide via `load_skill tmux`. The frontmatter field (Section 3) is opt-in for users who want eager loading.
- **What about nested tmux?** `$TMUX` is set in nested tmux too, but worker-pane spawning would target the inner server. That's probably fine.
- **What if `tmux` binary is missing?** Shouldn't happen if `$TMUX` is set, but `detect()` returns None gracefully.

## Out of scope

- A built-in `pane` Rust tool replacing the plugin's shell script (the script works, no need to duplicate)
- Detecting screen, zellij, or other multiplexers (different scope, different plugin)
- Tmux session persistence / layout management

---

If accepted, this enables: `synaps` started inside tmux automatically tells the agent "you're in tmux, here's how to leverage that," without the user needing to know. The user experience becomes: open tmux, run synaps, watch it spawn helpful side panes the moment a long install starts. That's the workflow this PR makes the default.
