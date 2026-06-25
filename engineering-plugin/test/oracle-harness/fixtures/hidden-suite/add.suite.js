"use strict";
module.exports = {
  id: "hidden-add", label: "addition (held-out cases)", category: "missing-behavior",
  async run(sut, t) {
    t.check(sut.add(100, 50) === 150, "missing-behavior");
    t.check(sut.add(7, 8) === 15, "missing-behavior");
  },
};
