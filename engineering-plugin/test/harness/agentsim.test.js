"use strict";
const { test } = require("node:test");
const { SCENARIOS } = require("./scenarios.js");
for (const s of ["S1", "S2", "S3", "S5", "S11"]) {
  test("H-3/" + s + ": " + SCENARIOS[s].desc, async () => {
    if (SCENARIOS[s].prove) { let red=false; try{await SCENARIOS[s].fn({control:true});}catch(_){red=true;} if(!red) throw new Error("no teeth"); }
    await SCENARIOS[s].fn({ control: false });
  });
}
