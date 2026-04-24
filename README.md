# 🧰 synaps-skills

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![GitHub](https://img.shields.io/github/stars/maha-media/synaps-skills?style=social)](https://github.com/maha-media/synaps-skills)

**Drop-in skills for [Synaps CLI](https://github.com/maha-media/synaps-cli)** — also works with Claude Code, Codex CLI, Amp, and Droid.

Give your coding agent web search, YouTube downloads, speech-to-text, browser automation, multi-agent pipelines, and structured dev workflows — all in one repo.

## ⚡ Quick Start

```bash
git clone https://github.com/maha-media/synaps-skills ~/synaps-skills
cd ~/synaps-skills && bash install.sh
```

That's it. The install script:

- ✅ Wires `~/.synaps/agent/settings.json` to load skills from the repo
- ✅ Runs `npm install` in skills that need it (browser-tools, youtube)
- ✅ Checks for external dependencies (yt-dlp, ffmpeg, whisper)
- ✅ Sets up auto-pull so the repo stays current on every shell login
- ✅ Tells you what's missing and how to fix it

<details>
<summary><strong>Other agents</strong> (Codex CLI / Amp / Droid / Claude Code)</summary>

<br>

**Codex CLI**
```bash
git clone https://github.com/maha-media/synaps-skills ~/.codex/skills/synaps-skills
```

**Amp**
```bash
git clone https://github.com/maha-media/synaps-skills ~/.config/amp/tools/synaps-skills
```

**Droid (Factory)**
```bash
git clone https://github.com/maha-media/synaps-skills ~/.factory/skills/synaps-skills
```

**Claude Code** (needs symlinks — Claude only looks one level deep)
```bash
git clone https://github.com/maha-media/synaps-skills ~/synaps-skills
cd ~/synaps-skills && bash install.sh --claude-code
```

</details>

## 📦 Plugins

Skills are bundled into plugins. Each plugin lives in its own directory and declares its skills via a `plugin.json` manifest.

### 🌐 web-tools-plugin

| Skill | What it does | Requires |
|-------|-------------|----------|
| **[exa-search](web-tools-plugin/skills/exa-search/SKILL.md)** | Web search & content extraction — neural, keyword, and deep search | `EXA_API_KEY` ([get one](https://dashboard.exa.ai/api-keys)) |
| **[browser-tools](web-tools-plugin/skills/browser-tools/SKILL.md)** | Browser automation via Playwright — navigate, run JS, screenshot, scrape | Node.js |
| **[youtube](web-tools-plugin/skills/youtube/SKILL.md)** | Transcripts, downloads, metadata, subtitles, playlists | Node.js, [yt-dlp](https://github.com/yt-dlp/yt-dlp) |
| **[transcribe](web-tools-plugin/skills/transcribe/SKILL.md)** | Local speech-to-text via Whisper — `.txt`, `.srt`, `.json` output | Python 3.10+, ffmpeg, [openai-whisper](https://github.com/openai/whisper) |
| **[scholar](web-tools-plugin/skills/scholar/SKILL.md)** | Academic paper search via OpenAlex — 200M+ works, abstracts, BibTeX citations, PDF links | Python 3, `requests` |

### 🛠️ dev-tools-plugin

| Skill | What it does | Requires |
|-------|-------------|----------|
| **[workflow](dev-tools-plugin/skills/workflow/SKILL.md)** | End-to-end dev workflow — brainstorm → plan → execute → finish | — |
| **[black-box-engineering](dev-tools-plugin/skills/black-box-engineering/SKILL.md)** | Multi-agent pipeline — design, build, blind-test, score, refine | synaps CLI |
| **[nvim-live](dev-tools-plugin/skills/nvim-live/SKILL.md)** | Real-time pair programming through Neovim RPC + tmux — agent sees and edits your buffer live | Neovim, tmux |

### 🏗️ engineering-plugin

| Skill | What it does | Requires |
|-------|-------------|----------|
| **[code-review](engineering-plugin/skills/code-review/SKILL.md)** | Structured multi-axis code review — correctness, readability, architecture, security, performance | — |
| **[security-review](engineering-plugin/skills/security-review/SKILL.md)** | Security-focused code review checklist — injection, traversal, secrets, auth, crypto | — |
| **[test-driven-development](engineering-plugin/skills/test-driven-development/SKILL.md)** | Red-green-refactor TDD cycle, test pyramid, anti-patterns | — |
| **[systematic-debugging](engineering-plugin/skills/systematic-debugging/SKILL.md)** | Root-cause debugging — reproduce, localize, reduce, fix, guard | — |
| **[spec-driven-development](engineering-plugin/skills/spec-driven-development/SKILL.md)** | Write specs before code — objectives, boundaries, success criteria | — |
| **[incremental-implementation](engineering-plugin/skills/incremental-implementation/SKILL.md)** | Vertical slices — implement, test, verify, commit, repeat | — |
| **[planning-and-task-breakdown](engineering-plugin/skills/planning-and-task-breakdown/SKILL.md)** | Decompose work into ordered, verifiable tasks with acceptance criteria | — |
| **[verification-before-completion](engineering-plugin/skills/verification-before-completion/SKILL.md)** | Evidence-based verification — run checks, confirm output before claiming done | — |

## 🔧 Install Script

`install.sh` handles all setup. Run it anytime to check or fix your environment:

```bash
cd ~/synaps-skills && bash install.sh
```

### What it checks

```
✅ Settings     → adds repo to ~/.synaps/agent/settings.json
✅ npm install  → browser-tools, youtube
✅ Auto-pull    → background git pull via ~/.bashrc or ~/.zshrc
✅ Dependencies:
   ├── node ≥ 18        (required)
   ├── yt-dlp           (youtube)
   ├── python3 ≥ 3.10   (transcribe)
   ├── ffmpeg            (transcribe)
   └── whisper           (transcribe)
```

### Flags

| Flag | Effect |
|------|--------|
| `--check` | Dry-run — check status, change nothing |
| `--exa-key=KEY` | Set `EXA_API_KEY` in your shell profile |
| `--claude-code` | Also create symlinks in `~/.claude/skills/` |

## 🧩 Skill Format

Each skill follows the [Agent Skills](https://agentskills.io/specification) standard:

```
skill-name/
├── SKILL.md          # Instructions the agent reads
├── script.js         # Helper scripts (optional)
└── package.json      # Dependencies (optional)
```

The `{baseDir}` placeholder in `SKILL.md` is replaced with the skill's directory path at runtime.

## 🤝 Contributing

1. Fork the repo
2. Add a skill inside the appropriate plugin's `skills/` directory with a `SKILL.md`
3. Follow the [Agent Skills spec](https://agentskills.io/specification)
4. Open a PR

Bug reports and feature requests welcome via [GitHub Issues](https://github.com/maha-media/synaps-skills/issues).

## 📜 License

[MIT](LICENSE) — [JR Morton](https://github.com/maha-media)
