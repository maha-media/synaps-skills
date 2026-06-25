"use strict";
// PROPERTY — validId rejects any string containing a character OUTSIDE the
// frozen id_pattern char class. The forbidden tokens are exactly '/', '\\', and
// NUL — the structural separators / control chars that id_pattern
// `^[A-Za-z0-9][A-Za-z0-9_.-]*$` cannot match.
//
// REALIGNED to frozen contract (data_schemas."engplan/1".plan.id_pattern):
//   id_pattern = ^[A-Za-z0-9][A-Za-z0-9_.-]*$  EXPLICITLY PERMITS '..'
//   (e.g. "a..b", "pre..post" match the pattern — '.' is in the char class).
//   A prior version of this property asserted validId rejects any id containing
//   the substring '..', which CONTRADICTS the frozen id_pattern and fails a
//   contract-compliant build (which correctly accepts "a..b"). Traversal is NOT
//   defended at the id level; per server_invariants it is defended at the WRITE
//   boundary ("every write stays inside .plans/ (write-confinement); path
//   traversal and symlink escape rejected") via lib/paths.js isInside /
//   store's allowedWriteTarget. So a validId-level '..' rejection over-constrains
//   beyond the frozen contract. '..' is therefore dropped from this set; the
//   invariant tests only what id_pattern actually forbids: '/', '\\', NUL.
const FORBIDDEN = ["/", "\\", "\u0000"];
module.exports = {
  id: "validId-rejects-traversal-and-nul",
  label: "validId rejects any string containing '/', '\\\\', or NUL (out-of-pattern chars)",
  category: "path-escape",
  gen(g) {
    const base = g.string(16);
    const tok = g.pick(FORBIDDEN);
    const pos = g.int(0, base.length);
    return base.slice(0, pos) + tok + base.slice(pos);
  },
  holds(sut, input) {
    // input is guaranteed to contain a forbidden (out-of-pattern) token -> must be rejected
    if (!FORBIDDEN.some((tk) => input.includes(tk))) return true; // skip if gen produced none
    let v;
    try { v = !!sut.validId(input); } catch (_) { return true; } // throwing = rejected
    return v === false;
  },
};
