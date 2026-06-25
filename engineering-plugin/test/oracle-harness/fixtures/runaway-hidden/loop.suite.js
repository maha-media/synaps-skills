"use strict";
module.exports = {
  id: "runaway", label: "runaway", category: "crash",
  async run(sut, t) { while (true) { /* spin — must be killed by sandbox timeout */ } },
};
