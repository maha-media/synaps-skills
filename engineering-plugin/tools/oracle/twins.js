/*
 * twins.js — differential twins (spec §4.6, §9 #4). Spawns TWO zero-contact
 * Builder siblings from the SAME frozen contract. Neither can read the other's
 * worktree/context (separate lineages under a neutral orchestrator — no shared
 * ancestry). With the tmux fleet, N twins are nearly free; here twins are
 * represented as isolated build artifact dirs + sibling dispatch records.
 *
 * Policy (Open decision #4): ON-DEMAND by default; `alwaysOn` flag forces
 * always-on for designated risk areas. Orchestrator infra. Stdlib only.
 */
"use strict";
const { LineageLedger } = require("./lineage.js");

/**
 * Register two zero-contact Builder twins as siblings under the orchestrator.
 * @param {object} opts { ledger, parentId, twinADir, twinBDir, model?, agent?, system_prompt? }
 * Returns { a, b } twin handles with lineage_id + targetDir.
 */
function spawnTwins(opts) {
  opts = opts || {};
  const ledger = opts.ledger || new LineageLedger({});
  const parentId = opts.parentId;
  const base = {
    role: "builder",
    agent: opts.agent,
    system_prompt: opts.system_prompt || (opts.agent ? undefined : "builder twin: code to the frozen contract; zero contact with the other twin; never read the oracle"),
    model: opts.model, // omitted → resolves to session model
    parent_id: parentId,
  };
  const a = ledger.dispatch(Object.assign({}, base, { lineage_id: opts.aId || undefined }));
  const b = ledger.dispatch(Object.assign({}, base, { lineage_id: opts.bId || undefined }));
  // Zero contact + siblings: must not be ancestor/descendant of each other.
  ledger.assertSiblings(a.lineage_id, b.lineage_id);
  return {
    ledger,
    a: { lineage_id: a.lineage_id, targetDir: opts.twinADir, model: a.model },
    b: { lineage_id: b.lineage_id, targetDir: opts.twinBDir, model: b.model },
    config: { alwaysOn: !!opts.alwaysOn },
  };
}

module.exports = { spawnTwins };
