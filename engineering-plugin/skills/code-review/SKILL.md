---
name: code-review
description: Structured multi-axis code review. Use before merging any change, after completing features, or when evaluating code from any source.
---

# Code Review and Quality

Multi-dimensional code review with quality gates. Every change gets reviewed before merge — no exceptions.

**The approval standard:** Approve when a change definitely improves overall code health, even if it isn't perfect. Perfect code doesn't exist — the goal is continuous improvement. Don't block because it isn't how you would've written it.

## The Five-Axis Review

### 1. Correctness
Does the code do what it claims to do?
- Does it match the spec or task requirements?
- Are edge cases handled (null, empty, boundary values)?
- Are error paths handled (not just the happy path)?
- Do tests pass? Are they testing the right things?
- Off-by-one errors, race conditions, state inconsistencies?

### 2. Readability & Simplicity
Can another engineer understand this without the author explaining?
- Names descriptive and consistent with project conventions?
- Control flow straightforward (no deep nesting, no clever tricks)?
- Code organized logically (related code grouped, clear boundaries)?
- **Could this be done in fewer lines?** 1000 lines where 100 suffice is a failure.
- **Are abstractions earning their complexity?** Don't generalize until the third use case.
- Dead code? No-op variables, backwards-compat shims, commented-out blocks?

### 3. Architecture
Does the change fit the system's design?
- Follows existing patterns or introduces a new one? If new, is it justified?
- Maintains clean module boundaries?
- Code duplication that should be shared?
- Dependencies flowing in the right direction (no circular deps)?
- Abstraction level appropriate (not over-engineered, not too coupled)?

### 4. Security
- User input validated and sanitized?
- Secrets kept out of code, logs, and version control?
- Auth/authorization checked where needed?
- SQL queries parameterized (no string concatenation)?
- Data from external sources treated as untrusted?
- Dependencies from trusted sources with no known vulnerabilities?

For deeper security review, see the **security-review** skill.

### 5. Performance
- N+1 query patterns?
- Unbounded loops or unconstrained data fetching?
- Synchronous operations that should be async?
- Missing pagination on list operations?
- Unnecessary allocations or copies?

## Review Output Format

Categorize ALL findings with severity:

- 🔴 **Critical** — Must fix. Bugs, security issues, data loss risks, correctness failures.
- 🟡 **Important** — Should fix. Code quality, maintainability, missing tests, unclear logic.
- 🟢 **Suggestion** — Consider. Style preferences, optional improvements, nice-to-haves.

```
## Review: [Change Description]

### Verdict: [APPROVE | REQUEST CHANGES | NEEDS DISCUSSION]

### Overview
[1-2 sentence summary of the change and overall quality]

### Issues

🔴 **[file:line] — [Issue title]**
[Description, why it matters, suggested fix]

🟡 **[file:line] — [Issue title]**  
[Description, suggestion]

🟢 **[file:line] — [Issue title]**
[Optional improvement]

### Positives
- [What was done well — acknowledge good patterns]
```

## Change Sizing

| Size | Lines Changed | Reviewability |
|------|--------------|---------------|
| Ideal | ~100 | Easy to review, focused |
| Acceptable | 100-300 | Manageable with effort |
| Too large | 300-1000 | Hard to review thoroughly |
| Way too large | 1000+ | Break this up |

## Review Process

1. **Read tests first** — understand intent before reading implementation
2. **Review in dependency order** — types/models → logic → interface → tests
3. **Check the diff, not just the new code** — what was removed matters too
4. **Run the tests yourself** if the change is significant
5. **Review for what's missing**, not just what's present

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "It works, so it's fine" | Working code can still be unmaintainable, insecure, or fragile. |
| "I'll clean it up later" | Later never comes. Technical debt compounds. |
| "It's just a small change" | Small changes can have large blast radii. Review proportional to risk. |
| "The reviewer is nitpicking" | Consistency matters. Small issues compound into large ones. |
| "We don't have time for reviews" | You don't have time for the bugs that unreviewed code introduces. |

## Red Flags

- No tests for new behavior
- Error handling that silently swallows errors
- `unwrap()` or `expect()` in non-test code without justification
- Magic numbers without explanation
- Dead code committed alongside new code
- Overly complex solution for a simple problem
- API changes without documentation updates

## Verification

Before approving:
- [ ] All five axes evaluated
- [ ] All Critical issues resolved
- [ ] Tests pass and cover new behavior
- [ ] Build is clean (`cargo build`, `cargo clippy`)
- [ ] Change is appropriately sized
- [ ] No secrets, credentials, or sensitive data in the diff
