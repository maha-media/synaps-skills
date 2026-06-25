"use strict";
// HIDDEN — POST /api/notes oversized body. contract.endpoints POST /api/notes
// errors:[400,413] + desc "413 on cap/too-large". A body exceeding
// store_limits.maxBodyBytes (262144) must be rejected with 413, never written.
module.exports = {
  id: "notes-too-large",
  label: "POST /api/notes rejects an oversized body with 413",
  category: "cap-exceeded",
  async run(sut, t) {
    const { request } = await sut.startServer({});

    // valid small note must be accepted (200)
    const ok = await request("POST", "/api/notes?plan=demo",
      { plan_id: "demo", section_id: "s1", type: "comment", actor: "human", text: "hello" });
    t.check(ok.status === 200, "missing-behavior");

    // oversized body (> maxBodyBytes) must be rejected with 413
    const big = "x".repeat(262144 * 2);
    const huge = await request("POST", "/api/notes?plan=demo",
      { plan_id: "demo", section_id: "s1", type: "comment", actor: "human", text: big });
    t.check(huge.status === 413, "cap-exceeded");
    // never a 5xx / silent 200 accept for an over-cap body
    t.check(huge.status !== 200, "cap-exceeded");
    t.check(huge.status < 500, "internal-error");
  },
};
