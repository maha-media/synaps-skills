---
name: tmux
description: Worker-pane patterns for Synaps agents inside tmux. When `$TMUX` is set, prefer driving long-running, interactive, or streaming work in a side pane the user can watch and interact with — rather than blocking inside `bash` tool calls. Use for installs needing sudo, log tailing, build/test daemons, parallel shells, and anything where the user might need to inject input.
---

# tmux worker panes for agents

When you're running inside tmux (`$TMUX` is set), you have a superpower beyond the `bash` tool: you can **spawn side panes and drive them**. This is materially different from `bash` calls in three ways:

1. **Visible to the user.** The user watches output stream in real time and can intervene (type passwords, hit Ctrl-C, answer prompts).
2. **Long-running without blocking your turn.** Start an install, do other work, poll later — no 30-second tool-timeout problem.
3. **Parallel.** Build in one pane, tail logs in another, run a REPL in a third. Each is a stable, named handle.

Use this skill when:

- A command needs **sudo** or any interactive prompt (password, "Are you sure? [y/N]", ssh fingerprint accept)
- You're starting a **long-running process** (apt install, large pip install, cargo build, docker pull) and want to keep working
- You want to **tail logs** while doing other work (`tail -f app.log`, `journalctl -fu service`)
- You're running **multiple things in parallel** (build + test + lint)
- You want the user to **see what you're doing** in real time (debugging, demos, anything novel)

Don't use it for:
- Quick deterministic commands that return in <2s — that's what `bash` is for
- Anything where the output is the only thing that matters and you can `bash` it

## Detect tmux

```bash
[ -n "${TMUX:-}" ] && echo "in tmux" || echo "not in tmux"
tmux display-message -p '#{session_name}:#{window_index}.#{pane_index}'
```

If `$TMUX` is unset, this skill doesn't apply — fall back to `bash` tool calls.

## Core idiom: spawn → run → close

```bash
PANE=${CLAUDE_PLUGIN_ROOT}/scripts/tmux/pane.sh

# 1. Spawn a named worker pane (idempotent — reuses if exists)
$PANE spawn install --size 30 --side below

# 2. Run a command, wait for prompt return, get output
$PANE run install "sudo apt-get update" --timeout 60

# 3. Close when done
$PANE close install
```

The `spawn` is idempotent: calling `spawn install` twice returns the same pane id. That means you can re-enter the same workflow and reattach to existing panes without conflict.

## Subcommand reference

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/tmux/pane.sh spawn  NAME [--size PCT] [--side below|above|right|left]
${CLAUDE_PLUGIN_ROOT}/scripts/tmux/pane.sh run    NAME "CMD" [--timeout S] [--lines N]
${CLAUDE_PLUGIN_ROOT}/scripts/tmux/pane.sh send   NAME "INPUT"           # fire-and-forget input + Enter
${CLAUDE_PLUGIN_ROOT}/scripts/tmux/pane.sh keys   NAME KEY [KEY...]      # raw tmux keys (C-c, Up, etc.)
${CLAUDE_PLUGIN_ROOT}/scripts/tmux/pane.sh poll   NAME [--lines N] [--full]
${CLAUDE_PLUGIN_ROOT}/scripts/tmux/pane.sh wait   NAME [--timeout S]     # block until shell prompt returns
${CLAUDE_PLUGIN_ROOT}/scripts/tmux/pane.sh close  NAME
${CLAUDE_PLUGIN_ROOT}/scripts/tmux/pane.sh list                          # show all panes
${CLAUDE_PLUGIN_ROOT}/scripts/tmux/pane.sh id     NAME                   # print %id, exit 1 if missing
```

Naming uses tmux pane titles, scoped to the tmux server (cross-window). Pick descriptive names: `install`, `build`, `logs`, `repl`, `db`.

## Bonus: drive Synaps's `/plugins` UI from a side pane

`scripts/tmux/synaps.sh` composes `pane.sh` to drive the Synaps TUI itself — useful for the **edit → push → install** loop when you've just pushed a plugin update to a marketplace repo and want to pull it into the running Synaps without leaving your seat.

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/tmux/synaps.sh refresh [MARKETPLACE]            # refresh marketplace cache
${CLAUDE_PLUGIN_ROOT}/scripts/tmux/synaps.sh install PLUGIN [--marketplace M] # install a cached plugin
${CLAUDE_PLUGIN_ROOT}/scripts/tmux/synaps.sh update  PLUGIN                   # update an installed plugin to latest cached SHA
${CLAUDE_PLUGIN_ROOT}/scripts/tmux/synaps.sh sync    PLUGIN [--marketplace M] # refresh + install/update in one shot
${CLAUDE_PLUGIN_ROOT}/scripts/tmux/synaps.sh status  [PLUGIN]                 # print installed/cached state (no TUI)
```

It opens Synaps in a fresh side pane (`synaps-sync`), navigates `/plugins` via key sends, polls `~/.synaps-cli/plugins.json` for state changes (not screen scraping), then quits cleanly. Common flow after pushing a plugin update:

```bash
# from your repo, after `git push`:
${CLAUDE_PLUGIN_ROOT}/scripts/tmux/synaps.sh sync memkoshi
# → spawns pane → runs synaps → /plugins → r (refresh) → Tab → u (update) → quit
# → returns: "updated: abc12345 → def67890"
```

Flags: `--pane NAME` (default `synaps-sync`), `--keep-pane` (don't kill on success — for debugging), `--timeout SEC` (default 30), `--synaps-cmd CMD` (default `synaps`).

## Patterns

### Pattern 1 — sudo / interactive password

The user enters the password directly in the pane. You don't see it; you just wait.

```bash
$PANE spawn install --size 30
$PANE send install "sudo apt-get install -y python3.14-venv"
# Tell the user: "Waiting for sudo password in pane 'install' — please enter it"
$PANE wait install --timeout 120
$PANE poll install --lines 20      # confirm success
$PANE close install
```

### Pattern 2 — long install, do other work meanwhile

```bash
$PANE spawn install --size 25
$PANE send install "pipx install some-big-package"

# Do other work — write code, edit files, etc. — without blocking
# ... agent does N other tool calls ...

# Check progress periodically
$PANE poll install --lines 10

# When ready, wait for completion
$PANE wait install --timeout 300
$PANE poll install --lines 20
$PANE close install
```

### Pattern 3 — log tail in a persistent pane

Open it once at session start, leave it running, glance at it whenever relevant.

```bash
$PANE spawn logs --size 30 --side right
$PANE send logs "tail -f /var/log/app.log"

# Later — peek at logs without disturbing the tail
$PANE poll logs --lines 30

# At session end (don't close if user wants to keep watching)
# $PANE close logs
```

### Pattern 4 — parallel build + test

Two panes side by side, both running, both inspectable.

```bash
$PANE spawn build --size 50 --side right
$PANE spawn test  --size 50 --side below   # below the build pane

$PANE send build "cargo build --release"
$PANE send test  "cargo test"

$PANE wait build --timeout 600 &
$PANE wait test  --timeout 600 &
wait

echo "=== build ===" && $PANE poll build --lines 5
echo "=== test ===="  && $PANE poll test  --lines 10

$PANE close build
$PANE close test
```

### Pattern 5 — interactive REPL (python, psql, node)

```bash
$PANE spawn repl --size 40
$PANE send repl "python3"
$PANE wait repl --timeout 5      # wait for >>> prompt
$PANE send repl "import json; json.loads('{\"a\":1}')"
$PANE poll repl --lines 5

# Send Ctrl-D to exit cleanly
$PANE keys repl C-d
$PANE close repl
```

### Pattern 6 — interrupt a runaway command

```bash
$PANE keys NAME C-c              # Ctrl-C
$PANE keys NAME C-d              # Ctrl-D (EOF)
$PANE keys NAME q Enter          # send 'q' then Enter (e.g. less, man)
$PANE keys NAME Up Up Enter      # walk shell history
```

## Naming conventions

Pick one name per concern, not per command. Reuse across the session.

| Name | What runs there |
|---|---|
| `install` | apt/pip/cargo install workflows |
| `build` | compile/bundle |
| `test` | test runners |
| `logs` | tail -f / journalctl -f |
| `repl` | interactive interpreter |
| `db` | psql / mysql / redis-cli |
| `ssh` | remote session |
| `monitor` | top / htop / watch |

You can have many at once — tmux will tile them and the user can resize.

## When the user steers via the pane

The user can directly type into the worker pane (e.g. interrupt with Ctrl-C, type a password, answer a prompt). After they do:

```bash
$PANE poll NAME --lines 20    # see what they did and the result
```

This is the killer feature. The user becomes a peer in the workflow rather than a passive observer of `bash` tool output.

## Etiquette

- **Tell the user** what you're spawning and why before you do it. They're going to see a new pane appear.
- **Use small sizes by default** (`--size 25` to `--size 35`). Don't dominate their layout.
- **Close panes** when the work is done unless the user asked to keep them (e.g. log tails).
- **Name panes meaningfully** — `install` not `pane1`.
- **Don't spawn dozens** — combine related work into one named pane and reuse it.

## Auto-detection / future work

Synapscli core does **not** currently detect `$TMUX` and auto-suggest this skill. Today, you (the agent) need to check `$TMUX` yourself and load this skill when relevant. There's an open enhancement to make this automatic — see `docs/synapscli-tmux-detect.md` in this plugin for the proposed core change.

In the meantime, a one-liner check at session start is enough:

```bash
[ -n "${TMUX:-}" ] && echo "tmux detected — load_skill tmux for worker-pane patterns"
```

## Gotchas

- **Pane ids (%N) shift** when panes close — always address by name, not id. The script does this for you (`pane_id_required` re-resolves on each call).
- **`run` blocks** until the shell prompt returns (or timeout). For long jobs, prefer `send` + `wait` + `poll` so you can interleave other work.
- **Prompt detection is heuristic.** It looks for lines ending in `$ `, `# `, `> `, `% `. If you have a custom PS1 (powerline, multi-line), `wait` may time out even when idle. Check with `poll` and assume idle if last line stable across two polls.
- **`capture-pane` returns the visible screen**, ~30-50 lines. For history beyond that, use `--full` to grab the entire scrollback.
- **`send` includes Enter automatically.** For input without newline, use `keys NAME "text"` (no Enter) then `keys NAME Enter` separately.
- **The script requires `$TMUX` to be set** — won't work outside tmux.

## End-to-end smoke test

```bash
PANE=${CLAUDE_PLUGIN_ROOT}/scripts/tmux/pane.sh

$PANE spawn demo --size 25
$PANE run demo "echo hello; uname -a; pwd" --lines 5
$PANE send demo "sleep 2; echo done"
$PANE wait demo --timeout 10
$PANE poll demo --lines 3
$PANE close demo
$PANE list
```
