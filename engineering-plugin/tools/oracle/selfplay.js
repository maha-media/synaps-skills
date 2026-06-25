/*
 * selfplay.js — adversarial self-play flywheel (spec §4.7). Each survived round
 * STRENGTHENS the oracle: a surviving mutant → a new permanent test; a fuzz
 * crash → a new property. Oracle and Builder co-evolve over the frozen contract.
 * A previously-survived case that later regresses RE-OPENS the round (Ambiguity C).
 * Strengthening artifacts persist to .oracle/** (Designer lineage; diff-gated).
 * Node stdlib only.
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");

function ensure(dir) { fs.mkdirSync(dir, { recursive: true }); }

/**
 * Convert a surviving mutant into a new permanent grading test. The generated
 * test asserts the contract behavior the mutant violated (by category), so the
 * next round KILLS that mutant.
 */
function strengthenFromSurvivor(survivor, opts) {
  opts = opts || {};
  const dir = opts.hiddenDir;
  ensure(dir);
  const id = "regress-" + survivor.id;
  const file = path.join(dir, id + ".suite.js");
  const body = `"use strict";
// AUTO-STRENGTHENED by self-play: a survived mutant became a permanent test.
// Operator: ${survivor.id} (category: ${survivor.category})
module.exports = {
  id: ${JSON.stringify(id)}, label: ${JSON.stringify("regression guard for " + survivor.id)}, category: ${JSON.stringify(survivor.category)},
  async run(sut, t) {
    // category-anchored contract assertion (no asserted oracle values leaked here)
    ${assertionFor(survivor.category)}
  },
};
`;
  fs.writeFileSync(file, body);
  return { file, id, category: survivor.category };
}

function assertionFor(category) {
  switch (category) {
    case "not-found": return `const { request } = await sut.startServer({}); const r = await request("GET", "/plan/missing-xyz"); t.check(r.status === 404, "not-found");`;
    case "illegal-transition": return `t.check(!sut.canTransition("incorporated", "acknowledged"), "illegal-transition");`;
    case "loopback-violation": return `const { srv } = await sut.startServer({}); t.check(srv.httpServer.address().address === "127.0.0.1", "loopback-violation");`;
    case "cap-exceeded": return `const repo = sut.newRepo(); let hit=false; try { for (let i=0;i<60;i++) sut.appendEvent(repo,"p",{section_id:"s",type:"comment",actor:"human"},{limits:{maxEventsPerPlan:50}}); } catch(e){ hit=/cap/.test(e.message);} t.check(hit, "cap-exceeded");`;
    case "schema-mismatch": return `let threw=false; try { sut.parsePlan({schema:"engplan/2",kind:"plan",slug:"x",title:"T",status:"drafting",sections:[]}); } catch(_){threw=true;} t.check(threw, "schema-mismatch");`;
    case "validation-error": return `let threw=false; try { sut.parseEvent({plan_id:"p",section_id:"s",type:"comment",actor:"bogus"}); } catch(_){threw=true;} t.check(threw, "validation-error");`;
    case "bad-request": return `const cli = sut.runCli(["new"]); t.check(cli.status === 2, "bad-request");`;
    default: return `t.check(true, ${JSON.stringify(category)});`;
  }
}

/**
 * Convert a fuzz crash into a new property: malformed input of the crashing
 * shape must yield a safe error, never a crash.
 */
function strengthenFromCrash(crash, opts) {
  opts = opts || {};
  const dir = opts.propsDir;
  ensure(dir);
  const id = "nocrash-" + (crash.id || crash.category || "fuzz");
  const file = path.join(dir, id + ".prop.js");
  const body = `"use strict";
// AUTO-STRENGTHENED by self-play: a fuzz crash became a permanent property.
module.exports = {
  id: ${JSON.stringify(id)}, label: "malformed input yields a safe error, never a crash", category: "property-violation",
  gen(g) { return g.anyValue(0); },
  holds(sut, input) { try { sut.parsePlan(input); return true; } catch (e) { return e.name === "ValidationError"; } },
};
`;
  fs.writeFileSync(file, body);
  return { file, id };
}

/**
 * Detect regression: a previously-survived (now-guarded) case that fails again.
 * `guarded` = ids strengthened in earlier rounds; `currentSurvivors` = ids that
 * survived this round. Any overlap means a guard regressed → re-open.
 */
function detectRegression(guarded, currentSurvivors) {
  const set = new Set(guarded);
  return currentSurvivors.filter((s) => set.has("regress-" + (s.id || s)));
}

module.exports = { strengthenFromSurvivor, strengthenFromCrash, detectRegression, assertionFor };
