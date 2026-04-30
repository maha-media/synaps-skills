# windows-uia

Windows is first-class for v0 through AutoHotkey v2 plus UI Automation concepts.

## Selector strategy

Prefer selectors in this order:

1. exact UIA AutomationId / role / name
2. class/title constrained UIA selector
3. fuzzy UIA name match
4. visible text or semantic fallback
5. screenshot/OCR fallback if available
6. LLM escalation with trace and observation

Avoid raw coordinates except as a last resort. Prefer `ui.invoke` or `ui.click` against an element found by selector.

## Examples

- Notepad: start process, wait for editor role `Edit`, set text.
- Installer wizard: wait for window title, find `Next` button by name/role, invoke, wait for next page.

When a selector fails, inspect `/plan/trace/{id}`, observe current UI, and commit the lesson to VM memory.
