"use strict";
// HIDDEN — CLI exit codes. contract.exit_codes: 0=success, 2=usage error for
// new|open|list|serve|reconcile. A usage error (missing/invalid args) must exit
// 2; a valid command must exit 0 (success), never hang or exit non-zero.
module.exports = {
  id: "cli-exit-codes",
  label: "CLI exit codes: usage error -> 2, valid command -> 0",
  category: "bad-request",
  async run(sut, t) {
    // ---- usage errors -> exit 2 ----
    const usageCases = [
      ["new"],                 // missing args
      ["open"],                // missing slug
      ["reconcile"],           // missing slug
      [],                      // no subcommand
      ["bogus-subcommand"],    // unknown subcommand
    ];
    for (const args of usageCases) {
      const r = sut.runCli(args);
      t.check(r && r.status === 2, "bad-request");
    }

    // ---- valid TERMINATING command -> exit 0 ----
    // contract.exit_codes."0" = "success". `list` is a terminating success
    // path (it prints and returns), so a clean exit 0 is the correct invariant.
    const list = sut.runCli(["list"]);
    t.check(list && list.status === 0, "missing-behavior");

    // ---- serving commands: success is NOT asserted via captured exit code ----
    // Per contract.exit_codes ("0"="success", "2"="usage error (missing/invalid
    // args for new|open|list|serve|reconcile)"): success exit-0 is validated on
    // TERMINATING commands (here, `list` above). `new`/`open`/`serve` are SERVING
    // commands — on success they scaffold then call startServer()->listen() and
    // never exit (they serve), so a captured spawnSync never yields a clean
    // exit 0 (it blocks until timeout/kill and can leak server processes).
    // Therefore their success is NOT asserted here via a captured exit code.
    // The usage-error->2 invariant IS still asserted for `new` (missing args)
    // and the others above, preserving the exit-code-2-to-0 mutant catch.
  },
};
