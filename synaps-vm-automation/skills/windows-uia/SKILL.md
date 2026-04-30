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

## Installer and popup recovery guidance

For installer-like flows, prefer high-level safe advancement behavior:

- proceed only with affirmative buttons such as Next, Continue, Install, Finish, Close
- do not click Cancel, Back, Decline, No unless explicitly allowed by the user/task
- do not accept license checkboxes unless `accept_licenses=true` is part of the plan/request
- stop and report structured error dialogs instead of clicking blindly

For common popups, dismiss only configured safe buttons such as OK/Allow/Continue. If an external or obstructing window appears, report its title/process in the trace and escalate.
