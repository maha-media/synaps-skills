# Engineering Plugin

Disciplined software delivery skills for Synaps agents. These skills favor small verified changes, clear invariants, isolated worktrees, and evidence before completion claims.

## Skills

| Skill | Use when |
|---|---|
| `spec-driven-development` | Requirements are unclear, architectural, or larger than a quick fix |
| `planning-and-task-breakdown` | A spec or clear request needs ordered implementation tasks |
| `worktrees-by-default` | Any implementation, bug fix, refactor, or doc/config change is about to touch repo files |
| `type-driven-design` | Designing Rust APIs, protocol/config boundaries, domain models, or invariants |
| `test-driven-development` | Adding behavior or fixing bugs where tests can drive the change |
| `incremental-implementation` | Delivering multi-file work in small verified slices |
| `systematic-debugging` | A test/build/runtime behavior is broken and root cause is unknown |
| `verification-before-completion` | Before any claim that work is done, fixed, passing, ready, or clean |
| `code-review` | Before merge or when evaluating a code change |
| `security-review` | User input, secrets, auth, plugins, sidecars, shell, filesystem, network, or external I/O are involved |
| `convergence-loop` | A pre-planned multi-agent designer/builder/tester/judge loop is justified |

## Common Flows

### Small bug fix

```text
systematic-debugging -> test-driven-development -> verification-before-completion -> code-review
```

### Feature or multi-file change

```text
spec-driven-development -> planning-and-task-breakdown -> worktrees-by-default -> type-driven-design -> test-driven-development/incremental-implementation -> verification-before-completion -> code-review
```

### Security-sensitive change

```text
spec-driven-development -> planning-and-task-breakdown -> security-review threat surface -> implementation -> security-review -> verification-before-completion
```

### Complex autonomous work

```text
planning-and-task-breakdown declares convergence mode -> convergence-loop -> verification-before-completion
```

## Operating Principles

- Autonomous by default: do not pause for human approval unless the user explicitly requested a checkpoint or a required safety decision cannot be inferred.
- Worktrees are mandatory before edits that ship.
- Encode important invariants in types where practical.
- Prefer straightforward code until an abstraction is earned by real duplication or a real invariant.
- Verify with fresh command output before making success claims.
- Keep dangerous boundaries visible: shell execution, sidecars, raw protocol frames, filesystem writes, secrets, and plugin permissions.

## Maintenance Notes

- Avoid duplicating long procedures across skills. Reinforce important gates briefly and link to the source skill.
- Keep examples concise and language-aware. Rust is common, but plugins may use shell, Node, or Python.
- If a skill tells the agent to stop for human approval, make sure it is explicitly conditional on interactive/user-requested checkpoints.
