# Task: {{TASK_NAME}}

## Instructions

{{TASK_DESCRIPTION}}

## Plan Context

**Goal:** {{PLAN_GOAL}}
**Architecture:** {{PLAN_ARCHITECTURE}}

## Files Context

{{#each FILES}}
### {{path}} ({{status}})

```{{language}}
{{content}}
```

{{/each}}

## Constraints

- Follow existing patterns in the codebase
- Write files directly using `write` or `edit` tools
- Run verification commands after writing (lint, type check, smoke test)
- For new files, use `write` tool
- For small changes to existing files, use `edit` tool
- For large rewrites of existing files, use `write` tool
