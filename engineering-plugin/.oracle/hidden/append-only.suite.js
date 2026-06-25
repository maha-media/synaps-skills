"use strict";
// HIDDEN — append-only events. contract.lifecycle.invariants:
//   "events are append-only (an appended event is never removed or reordered)".
// After N appendEvent calls, a later readNotes must contain all prior events, in
// the same order, none removed/reordered.
module.exports = {
  id: "append-only-events",
  label: "appended events are never removed or reordered across reads",
  category: "append-only-violation",
  async run(sut, t) {
    const repo = sut.newRepo();
    const slug = "demo";
    const N = 12;
    const ids = [];
    for (let i = 0; i < N; i++) {
      const ev = { plan_id: slug, section_id: "s1", type: "comment", actor: "human", text: "m" + i };
      let appended;
      try { appended = sut.appendEvent(repo, slug, ev, { limits: { maxEventsPerPlan: 1000 } }); }
      catch (e) { t.fail(e && e.category ? e.category : "crash"); return; }
      // capture an identity to track order: prefer assigned id, fall back to text
      ids.push(appended && appended.id ? appended.id : ev.text);

      // after each append, every prior event must still be present in order
      const snap = sut.readNotes(repo, slug);
      const evs = (snap && snap.events) || [];
      t.check(Array.isArray(evs), "append-only-violation");
      t.check(evs.length === i + 1, "append-only-violation");
      for (let k = 0; k <= i; k++) {
        const got = evs[k];
        const gotId = got && got.id ? got.id : (got && got.text);
        t.check(gotId === ids[k], "append-only-violation");
      }
    }

    // final read: full set, ascending insertion order preserved
    const finalSnap = sut.readNotes(repo, slug);
    const fevs = (finalSnap && finalSnap.events) || [];
    t.check(fevs.length === N, "append-only-violation");
    for (let k = 0; k < N; k++) {
      const got = fevs[k];
      const gotId = got && got.id ? got.id : (got && got.text);
      t.check(gotId === ids[k], "append-only-violation");
    }
    // every appended id must still be reachable (none dropped)
    const present = new Set(fevs.map((e) => (e && e.id ? e.id : (e && e.text))));
    for (const id of ids) t.check(present.has(id), "append-only-violation");
  },
};
