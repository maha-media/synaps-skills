#!/usr/bin/env node
/**
 * Tests for browser/start-args.mjs: browser-start.js argument parsing and the
 * --data-dir / BROWSER_TOOLS_DATA_DIR safety checks. Never launches a browser
 * and does not need Playwright installed.
 *
 * Run:  node web-tools-plugin/scripts/browser/start-args.test.mjs
 *
 * Exits 0 on all-pass, 1 on any failure.
 */

import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseStartArgs, defaultDataDir, DATA_DIR_ENV, chromeExtraArgs, chromeEnv } from "./start-args.mjs";

let pass = 0, fail = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    pass++;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (e) {
    fail++;
    failures.push({ name, err: e });
    process.stdout.write(`  ✗ ${name}\n    ${e.message}\n`);
  }
}

function eq(a, b, msg = "") {
  if (a !== b) throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

function throws(fn, re, msg = "") {
  try {
    fn();
  } catch (e) {
    if (re && !re.test(e.message)) throw new Error(`${msg} wrong error: ${e.message}`);
    return;
  }
  throw new Error(`${msg} expected an error`);
}

// A fake home with a fake real-Chrome profile, so nothing real is touched.
const root = mkdtempSync(join(tmpdir(), "start-args-test-"));
const home = join(root, "home");
const chrome = join(home, ".config", "google-chrome");
mkdirSync(chrome, { recursive: true });
mkdirSync(join(home, ".config", "chromium"), { recursive: true });
symlinkSync(chrome, join(root, "chrome-link"));
const opts = { home, platform: "linux" };
const noEnv = {};

console.log("start-args");

test("default dir is unchanged", () => {
  const r = parseStartArgs([], noEnv, opts);
  eq(r.dataDir, join(home, ".cache", "browser-tools"));
  eq(r.dataDir, defaultDataDir(home));
  eq(r.dataDirSource, "default");
  eq(r.port, 9222);
  eq(r.useProfile, false);
  eq(r.headless, false);
});

test("existing flags parse as before", () => {
  const r = parseStartArgs(["--headless", "--port=9333", "--profile"], noEnv, opts);
  eq(r.headless, true);
  eq(r.port, 9333);
  eq(r.useProfile, true);
  eq(r.dataDirSource, "default");
  eq(parseStartArgs(["-h"], noEnv, opts).help, true);
});

test("--data-dir <dir>", () => {
  const d = join(home, ".cache", "browser-tools-shared");
  const r = parseStartArgs(["--data-dir", d, "--port=9223"], noEnv, opts);
  eq(r.dataDir, d);
  eq(r.dataDirSource, "flag");
  eq(r.port, 9223);
});

test("--data-dir=<dir> and ~ expansion", () => {
  const r = parseStartArgs(["--data-dir=~/.cache/browser-tools-shared"], noEnv, opts);
  eq(r.dataDir, join(home, ".cache", "browser-tools-shared"));
});

test(`env ${DATA_DIR_ENV}`, () => {
  const d = join(root, "env-dir");
  const r = parseStartArgs([], { [DATA_DIR_ENV]: d }, opts);
  eq(r.dataDir, d);
  eq(r.dataDirSource, "env");
});

test("flag wins over env", () => {
  const f = join(root, "flag-dir");
  const r = parseStartArgs(["--data-dir", f], { [DATA_DIR_ENV]: join(root, "env-dir") }, opts);
  eq(r.dataDir, f);
  eq(r.dataDirSource, "flag");
});

test("empty env is ignored", () => {
  eq(parseStartArgs([], { [DATA_DIR_ENV]: "" }, opts).dataDirSource, "default");
});

test("missing --data-dir value is an error", () => {
  throws(() => parseStartArgs(["--data-dir"], noEnv, opts), /needs a directory/);
  throws(() => parseStartArgs(["--data-dir", "--headless"], noEnv, opts), /needs a directory/);
  throws(() => parseStartArgs(["--data-dir="], noEnv, opts), /needs a directory/);
});

test("--profile with --data-dir is an error", () => {
  throws(() => parseStartArgs(["--profile", "--data-dir", join(root, "x")], noEnv, opts), /--profile cannot be combined/);
});

test("--profile with env override is an error", () => {
  throws(() => parseStartArgs(["--profile"], { [DATA_DIR_ENV]: join(root, "x") }, opts), /--profile cannot be combined/);
});

test("refuses the real Chrome profile and paths inside it", () => {
  throws(() => parseStartArgs(["--data-dir", chrome], noEnv, opts), /real browser profile/);
  throws(() => parseStartArgs(["--data-dir", join(chrome, "Default")], noEnv, opts), /real browser profile/);
  throws(() => parseStartArgs(["--data-dir", join(home, ".config", "chromium")], noEnv, opts), /real browser profile/);
  throws(() => parseStartArgs([], { [DATA_DIR_ENV]: chrome }, opts), /real browser profile/);
});

test("refuses a symlink that resolves to the real profile", () => {
  throws(() => parseStartArgs(["--data-dir", join(root, "chrome-link")], noEnv, opts), /real browser profile/);
  throws(() => parseStartArgs(["--data-dir", join(root, "chrome-link", "new")], noEnv, opts), /real browser profile/);
});

test("refuses $HOME, its parents and /", () => {
  throws(() => parseStartArgs(["--data-dir", home], noEnv, opts), /home directory/);
  throws(() => parseStartArgs(["--data-dir", home + "/"], noEnv, opts), /home directory/);
  throws(() => parseStartArgs(["--data-dir", "~"], noEnv, opts), /home directory/);
  throws(() => parseStartArgs(["--data-dir", root], noEnv, opts), /home directory/);
  throws(() => parseStartArgs(["--data-dir", "/"], noEnv, opts), /root/);
});

test("macOS and Windows real profiles are refused", () => {
  const mac = join(home, "Library", "Application Support", "Google", "Chrome");
  throws(() => parseStartArgs(["--data-dir", mac], noEnv, { home, platform: "darwin" }), /real browser profile/);
  const win = join(root, "Local", "Google", "Chrome", "User Data");
  throws(() => parseStartArgs(["--data-dir", win], { LOCALAPPDATA: join(root, "Local") }, { home, platform: "win32" }),
         /real browser profile/);
});

rmSync(root, { recursive: true, force: true });

console.log("wayland");
const wl = { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0", XAUTHORITY: "/x" };
const shared = join(home, ".cache", "browser-tools-shared");

test("plain default run: no wayland even with WAYLAND_DISPLAY", () => {
  const r = parseStartArgs([], wl, opts);
  eq(r.wayland, false);
  eq(chromeExtraArgs(r).length, 0);
  eq(chromeEnv(r, wl), wl, "env passed through untouched");
});

test("--data-dir + WAYLAND_DISPLAY turns wayland on", () => {
  const r = parseStartArgs(["--data-dir", shared], wl, opts);
  eq(r.wayland, true);
  eq(r.waylandSource, "auto");
  eq(chromeExtraArgs(r).join(" "), "--ozone-platform=wayland");
  const e = chromeEnv(r, wl);
  eq(e.DISPLAY, undefined);
  eq(e.XAUTHORITY, undefined);
  eq(e.WAYLAND_DISPLAY, "wayland-0");
  eq(wl.DISPLAY, ":0", "caller env not mutated");
});

test("env override also turns wayland on", () => {
  eq(parseStartArgs([], { ...wl, [DATA_DIR_ENV]: shared }, opts).wayland, true);
});

test("--data-dir without WAYLAND_DISPLAY stays X/default", () => {
  eq(parseStartArgs(["--data-dir", shared], { DISPLAY: ":0" }, opts).wayland, false);
});

test("--no-wayland opts out; --headless is not auto-wayland", () => {
  eq(parseStartArgs(["--data-dir", shared, "--no-wayland"], wl, opts).wayland, false);
  eq(parseStartArgs(["--data-dir", shared, "--headless"], wl, opts).wayland, false);
});

console.log("dbus");
const yes = { exists: (p) => p === "/run/user/1000/bus", uid: 1000 };
const no = { exists: () => false, uid: 1000 };

test("dbus: --data-dir/--wayland path sets the session bus when unset and socket exists", () => {
  const r = parseStartArgs(["--data-dir", shared], wl, opts);
  eq(chromeEnv(r, wl, yes).DBUS_SESSION_BUS_ADDRESS, "unix:path=/run/user/1000/bus");
  const x = parseStartArgs(["--data-dir", shared], { DISPLAY: ":0" }, opts);   // X path, custom dir
  eq(chromeEnv(x, { DISPLAY: ":0" }, yes).DBUS_SESSION_BUS_ADDRESS, "unix:path=/run/user/1000/bus");
  eq(chromeEnv(x, { DISPLAY: ":0" }, yes).DISPLAY, ":0", "X path keeps DISPLAY");
});

test("dbus: uses XDG_RUNTIME_DIR when set", () => {
  const env = { ...wl, XDG_RUNTIME_DIR: "/run/user/1234" };
  const r = parseStartArgs(["--data-dir", shared], env, opts);
  eq(chromeEnv(r, env, { exists: (p) => p === "/run/user/1234/bus", uid: 1000 }).DBUS_SESSION_BUS_ADDRESS,
     "unix:path=/run/user/1234/bus");
});

test("dbus: existing address kept; missing socket leaves it unset", () => {
  const env = { ...wl, DBUS_SESSION_BUS_ADDRESS: "unix:path=/custom" };
  const r = parseStartArgs(["--data-dir", shared], env, opts);
  eq(chromeEnv(r, env, yes).DBUS_SESSION_BUS_ADDRESS, "unix:path=/custom");
  eq(chromeEnv(r, wl, no).DBUS_SESSION_BUS_ADDRESS, undefined);
});

test("dbus: plain default run untouched", () => {
  const r = parseStartArgs([], wl, opts);
  eq(chromeEnv(r, wl, yes), wl);
  eq(wl.DBUS_SESSION_BUS_ADDRESS, undefined);
});

test("explicit --wayland", () => {
  const r = parseStartArgs(["--wayland"], wl, opts);
  eq(r.wayland, true);
  eq(r.waylandSource, "flag");
  throws(() => parseStartArgs(["--wayland"], { DISPLAY: ":0" }, opts), /needs WAYLAND_DISPLAY/);
  throws(() => parseStartArgs(["--wayland", "--no-wayland"], wl, opts), /mutually exclusive/);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  for (const f of failures) console.error(`FAIL ${f.name}: ${f.err.stack}`);
  process.exit(1);
}
