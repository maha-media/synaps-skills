# O5 PRE-WORK Triage — adversary findings vs frozen contract

Contract: sha256:d07f2accd27bc527e8f7674afb7437ed464d7b87f4481be178ccc4cb1f9f3a80
Triaged against the FROZEN contract (ground truth), not opinion.

## Finding 1 — store-caps (cap-exceeded ×2)  →  REAL BUILD BUG  →  BUILDER
- Contract: `store_limits.maxBodyBytes = 262144` is declared under store_limits ⇒ the STORE layer must enforce it.
- Build: `lib/store.js` DEFAULTS includes maxBodyBytes but `appendEvent()` only enforces maxEventsPerPlan; oversized event/note body is silently written.
- HTTP layer (extensions/plans_server.js:87) DOES guard body size → 413, but direct store calls + reconcile bypass it. Store must enforce its own declared cap.
- Fix (lib/store.js): measure serialized event/body size; if > limits.maxBodyBytes throw an Error whose message matches the server's 413 regex (`/cap exceeded|too large/`) so HTTP maps to 413.
- Lineage: BUILDER (lib/** only). Forbidden from .oracle/**.

## Finding 2 — validId-rejects-traversal-and-nul (path-escape)  →  OVER-STRICT ORACLE  →  DESIGNER
- Contract id_pattern = `^[A-Za-z0-9][A-Za-z0-9_.-]*$` EXPLICITLY PERMITS `..` (e.g. `a..b`). validId correctly rejects `/`, `\`, NUL.
- The property asserts the bare substring `..` must be rejected — this CONTRADICTS the frozen contract. Path traversal is defended by write-confinement (lib/paths.js isInside + allowedWriteTarget), the contract's actual server_invariant, NOT by validId.
- Builder must NOT reject `..` — that would make the build violate the frozen contract id_pattern.
- Fix (DESIGNER, .oracle/properties/validid-traversal.prop.js): restrict forbidden tokens to the contract-forbidden set (`/`, `\`, NUL); OR assert traversal is rejected at the write boundary. Record justification inline.
- Lineage: DESIGNER (.oracle/** only). Builder never edits its own grade.

## Finding 3 — cli-exit-codes (missing-behavior)  →  OVER-STRICT ORACLE  →  DESIGNER
- Contract exit_codes: {0: success, 2: usage error for new|open|list|serve|reconcile}.
- `plan new` / `open` / `serve` are SERVING commands (bin/plan.js:114-119,146-150 start a server + open browser) — they do not terminate, so asserting `new → exit 0` is wrong (spawnSync times out → status null).
- The contract only mandates exit 2 for usage errors; exit 0 applies to terminating commands (list, reconcile).
- Fix (DESIGNER, .oracle/hidden/cli-exit-codes.suite.js): keep usage-error→2 assertions (correct) and list→0 (correct); replace the `new → exit 0` assertion with one valid for a serving command (e.g. valid `new` does NOT exit 2 AND prints the "created" artifact line). Record justification inline.
- Lineage: DESIGNER.

## Side fix (already applied, oracle infra — NOT a finding)
- tools/oracle/sut.js: runCli now prepends a no-op xdg-open/open/start shim to PATH so the product CLI's openBrowser() never hijacks the human's real browser during grading. Captured the runaway `127.0.0.1/plan/validslug` tabs.

## Dispatch plan
- BUILDER sibling (lib/**): Finding 1 only.
- DESIGNER sibling (.oracle/**): Findings 2 + 3.
- Both: separate sibling lineages; write-segregation enforced via tools/oracle/diff_gate.js (Builder diff touching .oracle/** rejected).

## FINAL RESOLUTION (verified)
- Finding 1 (store-caps): FIXED by Builder (lib/store.js maxBodyBytes enforcement). hidden 21/21.
- Finding 2 (validId-traversal): REALIGNED by Designer (forbidden set = /,\,NUL per frozen id_pattern). properties 3/3.
- Finding 3 (cli-exit-codes): REALIGNED by Designer (serving-new probe dropped; success via list->0; usage->2 kept). Fast, zero leaks.
- write-confine-drop: proven EQUIVALENT mutant, excluded from gate denominator (9/9 killed, 1 excluded).
- Self-play verdict: state=ship, survived_cleanly=true, reveal_verified=true, score=1.0, outstanding_finds=0.
- npm run oracle:e2e: GREEN (112 pass / 0 fail).
