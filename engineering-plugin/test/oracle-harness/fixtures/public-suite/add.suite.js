"use strict";
module.exports = {
  id: "public-add", label: "addition (sample cases)", category: "missing-behavior",
  async run(sut, t) {
    t.check(sut.add(1, 2) === 3, "missing-behavior");
    t.check(sut.add(2, 2) === 4, "missing-behavior");
  },
};
