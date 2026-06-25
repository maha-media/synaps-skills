# CAC build decisions

Checkpoint-Aware Compaction was built under its own rule. Rather than treating
CAC as an ordinary feature, each build phase `C-CAC-0 … C-CAC-5` was a real
*checkpoint-and-yield* boundary in the §5 sense: the work for a checkpoint was
not considered "reached" until its gate was asserted green (red→green proof on
the new tests), the working tree was clean (commit landed), and a durable
artifact existed on disk — only then did the build advance to the next phase.
Compaction (context relief) happened *between* these checkpoints, never inside
one, exactly as §8 prescribes for `convergence-loop` /
`incremental-implementation`. The dogfood is therefore literal: the CAC
implementation is itself a worked example of the resume contract it encodes
(§12).

The six checkpoints:

- **C-CAC-0** — resume token + config + state machine (§5/§5.1/§9):
  `state.js`, `resume_token.js`, `config.js`.
- **C-CAC-1** — safe-point detection + pre-compact wall (§4/§7):
  `safepoint.js`, `pregate.js`, `git.js`.
- **C-CAC-2** — artifact-anchored summary (§6): `summary.js`
  (+ `git.logOneline`).
- **C-CAC-3** — post-compact continuity + auto re-issue + watchdog (§5.2/§5.3/§7):
  `postgate.js`, `watchdog.js`.
- **C-CAC-4** — hook wiring + skill edits (§7/§8): `hooks.js`, the additive
  `POST /api/checkpoint` SSE producer, the three registered hooks in
  `plugin.json`, and the §8 rule edits to four skills.
- **C-CAC-5** — e2e self-test / dogfood (§2/§11/§12): `pressure.js`
  (§2 hysteresis), `test/cac/{pressure,e2e}.test.js`, the runnable
  `test/cac/e2e.js` driver, and the shared `test/cac/scenarios.js` covering
  S-CAC-1..7.

Each row above was a commit + green proof + clean tree before the next began —
the same precondition triad (`gate_green && tree_clean && token_persisted`) that
`state.js` enforces on the `CHECKPOINT_REACHED → SUSPENDED` edge.
