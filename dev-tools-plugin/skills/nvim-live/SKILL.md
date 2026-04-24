---
name: nvim-live
description: Real-time collaborative editing through Neovim RPC + tmux pane awareness. The agent sees what you see, edits what you're editing, and verifies the result — all live. Load this when the user has neovim open in a tmux pane.
---

# Neovim Live — Real-Time Pair Programming

You have eyes and hands inside the user's editor. Use them.

## The Loop

```
OBSERVE → UNDERSTAND → ACT → VERIFY
   │          │          │       │
   ▼          ▼          ▼       ▼
 Capture    Read RPC   Push    Capture
 tmux pane  state      edits   pane again
```

Every interaction follows this loop. Never push blind — always observe first, always verify after.

## Setup (once per session)

```bash
# Find the nvim socket
NVIM_SOCK=$(find /run/user/$(id -u) /tmp -name "nvim.*" -type s 2>/dev/null | head -1)

# Find which tmux pane has nvim
NVIM_PANE=$(tmux list-panes -F '#{pane_index}:#{pane_current_command}' | grep nvim | cut -d: -f1)
```

Store both. Everything below uses `$NVIM_SOCK` and `$NVIM_PANE`.

## Observe — See What They See

```bash
# What's on screen right now?
tmux capture-pane -t $NVIM_PANE -p

# What file are they in?
nvim --server "$NVIM_SOCK" --remote-expr 'expand("%:p")'

# Where's their cursor?
nvim --server "$NVIM_SOCK" --remote-expr '[line("."), col(".")]'

# What mode? (don't interrupt insert mode)
nvim --server "$NVIM_SOCK" --remote-expr 'mode()'

# What buffers are open?
nvim --server "$NVIM_SOCK" --remote-expr 'join(map(getbufinfo({"buflisted":1}), "v:val.name"), "\n")'
```

**Rule: Check mode before every write operation.** If the user is in insert mode (`i`), wait. Never yank the buffer out from under their fingers.

## Act — Edit Live

### Single-line operations
```bash
# Add a line after line N
nvim --server "$NVIM_SOCK" --remote-send ':call append(N, "content")\n'

# Replace line N
nvim --server "$NVIM_SOCK" --remote-send ':call setline(N, "content")\n'

# Delete line N
nvim --server "$NVIM_SOCK" --remote-send ':Nd\n'

# Delete range
nvim --server "$NVIM_SOCK" --remote-send ':5,10d\n'
```

### Multi-line operations
```bash
# Insert a block after line N
nvim --server "$NVIM_SOCK" --remote-send ':call append(N, ["line1", "line2", "line3"])\n'

# Search and replace
nvim --server "$NVIM_SOCK" --remote-send ':%%s/old/new/g\n'
```

### Navigation
```bash
# Open a file
nvim --server "$NVIM_SOCK" --remote-send ':e /path/to/file\n'

# Jump to line
nvim --server "$NVIM_SOCK" --remote-send ':42\n'

# Split open
nvim --server "$NVIM_SOCK" --remote-send ':vsplit /path/to/file\n'

# Save
nvim --server "$NVIM_SOCK" --remote-send ':w\n'
```

### Read content
```bash
# Specific line
nvim --server "$NVIM_SOCK" --remote-expr 'getline(5)'

# Range
nvim --server "$NVIM_SOCK" --remote-expr 'join(getline(1, 20), "\n")'

# Whole buffer
nvim --server "$NVIM_SOCK" --remote-expr 'join(getline(1, "$"), "\n")'
```

## Productivity Patterns

### Pattern 1: Guided Implementation
User asks for a feature. Instead of writing a file and telling them to open it:
1. Open the target file in their nvim: `:e path`
2. Jump to the insertion point: `:42`
3. Push the code directly into their buffer
4. Let them review it live — they see every line appear
5. They tweak, you adjust. Real-time feedback loop.

**Why it's faster:** Zero context switching. No "open the file I just wrote." No copy-paste. They're already looking at it.

### Pattern 2: Code Review in Buffer
User asks you to review code they're editing:
1. Read the buffer via RPC (not disk — they may have unsaved changes)
2. Push review comments as inline comments at specific lines
3. They see the feedback exactly where it matters
4. They fix, you verify — capture pane to confirm

### Pattern 3: Side-by-Side Compare
1. Open the reference file in a vsplit: `:vsplit /path/to/reference`
2. User sees both files simultaneously
3. Push edits into the working buffer while they compare

### Pattern 4: Teach by Doing
Instead of explaining what code to write:
1. Push a skeleton/stub into their buffer
2. Add TODO comments at decision points
3. Let them fill in the blanks
4. Check their work by reading the buffer back

### Pattern 5: Debug Companion
User is debugging:
1. Capture their pane to see error output
2. Read the relevant source via RPC
3. Push a fix directly into the buffer
4. They save and re-run — immediate feedback

### Pattern 6: Bulk Refactor
User needs changes across multiple files:
1. Open first file: `:e path1`
2. Push changes
3. Save: `:w`
4. Open next: `:e path2`
5. Repeat
6. User watches the whole refactor happen live

## Tmux Awareness

```bash
# See the nvim pane
tmux capture-pane -t $NVIM_PANE -p

# See the last 50 lines (scrollback)
tmux capture-pane -t $NVIM_PANE -p -S -50

# List all panes
tmux list-panes -F '#{pane_index}: #{pane_current_command} #{pane_width}x#{pane_height}'

# Open a new pane with a specific file
tmux split-window -h "nvim /path/to/file"
```

## Rules

1. **Observe before acting.** Always check what file is open and where the cursor is before pushing edits. Don't assume.
2. **Never interrupt insert mode.** Check `mode()` first. If it returns `i`, `R`, or `v`, wait for normal mode.
3. **Use RPC for edits, not keystrokes.** `append()` and `setline()` are atomic. Sending `i` + text + `Esc` is fragile and races with user input.
4. **Read the buffer, not the disk.** The user may have unsaved changes. `getline()` via RPC gives you the live buffer state.
5. **Announce before large changes.** "I'm going to add 20 lines after line 45" — let them scroll to watch.
6. **Verify after every edit.** Capture the pane or read the buffer back. Don't assume your edit landed cleanly.
7. **Prefer the user's editor over your tools.** If they have nvim open, edit through nvim. Don't use `write`/`edit` tools on the same file — it creates conflicts.
