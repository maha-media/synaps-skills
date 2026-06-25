"use strict";
// HIDDEN — write/path confinement. contract.server_invariants + store_limits:
//   "every write stays inside .plans/ (write-confinement); path traversal and
//    symlink escape rejected". Writes are confined to writable_filenames under
//   .plans/. A slug that escapes the writable root must be rejected, never used
//   to write outside .plans/.
const fs = require("node:fs");
const path = require("node:path");
module.exports = {
  id: "write-confinement",
  label: "store writes stay inside .plans/; traversal slugs rejected",
  category: "write-confinement-violation",
  async run(sut, t) {
    const repo = sut.newRepo();
    const plansDir = path.join(repo, ".plans");
    const mkEv = (slug) => ({ plan_id: slug, section_id: "s1", type: "comment", actor: "human", text: "t" });

    const escapeSlugs = [
      "../evil", "../../evil", "..", "a/../../b", "/abs", "a/b",
      "a\\b", "..\\evil", "....//evil",
    ];
    for (const slug of escapeSlugs) {
      let rejected = false;
      try { sut.appendEvent(repo, slug, mkEv(slug), {}); }
      catch (_) { rejected = true; }
      // an escaping slug must be rejected
      t.check(rejected, "write-confinement-violation");
    }

    // a legal slug must append, and the resulting files must live inside .plans/
    let okAppended = false;
    try { sut.appendEvent(repo, "good-slug", mkEv("good-slug"), {}); okAppended = true; } catch (_) {}
    t.check(okAppended, "write-confinement-violation");

    // No write may have escaped the repo's .plans/ directory: the parent of
    // .plans/ (the repo root) must contain no stray event/notes files, and no
    // sibling of the repo dir was created.
    function listAll(dir) {
      const out = [];
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        out.push(full);
        if (e.isDirectory()) out.push(...listAll(full));
      }
      return out;
    }
    const inRepo = listAll(repo);
    const writes = inRepo.filter((f) => /\.(events|notes)\.json$/.test(f) || /agents\.json$/.test(f));
    for (const w of writes) {
      // every write file must be located under <repo>/.plans/
      const rel = path.relative(plansDir, w);
      t.check(!rel.startsWith(".."), "write-confinement-violation");
      t.check(!path.isAbsolute(rel), "write-confinement-violation");
    }
    // the repo root itself (outside .plans) must not directly hold write files
    let rootEntries = [];
    try { rootEntries = fs.readdirSync(repo); } catch (_) {}
    for (const name of rootEntries) {
      if (name === ".plans") continue;
      t.check(!/\.(events|notes)\.json$/.test(name), "write-confinement-violation");
    }
  },
};
