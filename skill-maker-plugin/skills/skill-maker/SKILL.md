---
name: skill-maker
description: Scaffolds, validates, and lints Synaps CLI plugins and skills. Use when creating a new plugin, adding a skill, or auditing existing ones for convention drift.
---

# skill-maker — Index

Bash-based tooling to lower the friction of authoring Synaps CLI plugins.

> Status: WIP — slice 1 (validate + list) shipped. Scaffolding (`skill new …`)
> and lint coming next.

## Quick start

```bash
# Validate one plugin
bin/skill validate ../web-tools-plugin

# Validate every plugin under a path
bin/skill validate ~/Projects/Maha-Media/synaps-skills

# List plugins
bin/skill list ~/Projects/Maha-Media/synaps-skills

# List skills inside a plugin
bin/skill list ../web-tools-plugin
```

See `docs/specs/skill-maker.md` for the full design.
