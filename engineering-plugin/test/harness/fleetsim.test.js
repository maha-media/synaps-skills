"use strict";
const { test } = require("node:test");
const { SCENARIOS } = require("./scenarios.js");
for (const s of ["S16", "S17", "S18", "S19", "S20", "S21"]) {
  test("H-7/" + s + ": " + SCENARIOS[s].desc, async () => { await SCENARIOS[s].fn({ control: false }); });
}
