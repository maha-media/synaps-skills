"use strict";
// HIDDEN — id validity. contract.data_schemas.engplan/1.plan.id_pattern =
//   ^[A-Za-z0-9][A-Za-z0-9_.-]*$ , id_max_len=200. validId must reject any id
// containing path-traversal, separators, or control chars and accept only
// pattern-conforming ids.
module.exports = {
  id: "id-validity",
  label: "validId rejects traversal/control ids and accepts the contract pattern",
  category: "path-escape",
  async run(sut, t) {
    const re = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

    const bad = [
      "../etc", "..", ".", "a/b", "a\\b", "/abs", "abs/", "a/../b",
      "a b", "a\tb", "a\nb", "a\u0000b", "\u0000", "-leading", ".leading",
      "_leading", "a?b", "a*b", "a:b", "a;b", "a|b", "a%2fb", "héllo",
      "", "a/", "/", "\\", "a\u0007b", "$(x)", "a<b>c", "x".repeat(201),
    ];
    for (const id of bad) {
      let v;
      try { v = !!sut.validId(id); } catch (_) { v = "threw"; }
      // a traversal/control id must NEVER be accepted
      t.check(v === false, "path-escape");
    }

    const good = [
      "a", "A", "0", "demo", "my-slug", "my_slug", "my.slug",
      "Plan.1-2_3", "abc123", "Z9", "x".repeat(200),
    ];
    for (const id of good) {
      // sanity that our reference pattern accepts these
      t.check(re.test(id) && id.length <= 200, "internal-error");
      let v;
      try { v = !!sut.validId(id); } catch (_) { v = "threw"; }
      t.check(v === true, "validation-error");
    }
  },
};
