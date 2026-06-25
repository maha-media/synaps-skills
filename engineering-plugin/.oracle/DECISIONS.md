# Oracle Decision Records

Audit of open-decision resolutions confirmed at each checkpoint (spec §9).

## C-O0
- **#6 Contract location / owner:** `.oracle/contract/` is owned by the **Architect**
  lineage. The frozen artifact is `.oracle/contract/frozen.json` (immutable, hashed).
  Re-freeze is a controlled event via `ContractFreezer.freeze({refreeze:true})` paired
  with a new commit-reveal cycle (O3). Never an ad-hoc Designer/Builder edit. The
  source contract `.oracle/contract/contract.json` was frozen from the observable
  behavior of the P0–P5 build + parent spec.
- **Write-segregation (central control):** enforced at the orchestrator/merge boundary
  by `tools/oracle/diff_gate.js` (path-canonicalizing diff gate) + defense-in-depth git
  hook `tools/oracle/git_guard.sh`. Builder-lineage diffs touching `.oracle/**`,
  `tools/oracle/**`, or `test/oracle-harness/**` are rejected. Rename/symlink/traversal
  smuggling is canonicalized away before matching.
- **Lineage (siblings, not nested):** `tools/oracle/lineage.js` dispatch ledger refuses a
  dispatch missing both `agent` and `system_prompt`, resolves an absent `model` to the
  session model (`claude-opus-4-8`), and rejects any configuration where Designer is an
  ancestor/descendant of Builder.
