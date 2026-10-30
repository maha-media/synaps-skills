/**
 * Argument parsing for browser-start.js, kept free of Playwright so it can be
 * tested without launching (or even installing) a browser.
 *
 * Profile dir:
 *   default                      ~/.cache/browser-tools   (unchanged)
 *   env BROWSER_TOOLS_DATA_DIR   override
 *   --data-dir <dir> / --data-dir=<dir>   override (wins over the env)
 *
 * An override is refused when it resolves (realpath) to "/", to $HOME or a
 * parent of it, or to / inside a real Chrome/Chromium profile folder. Combining
 * an override with --profile (which copies the real profile) is an error.
 *
 * --wayland runs Chrome as a native Wayland client (--ozone-platform=wayland,
 * DISPLAY/XAUTHORITY removed from its env). It is on by default when an override
 * is used and WAYLAND_DISPLAY is set (not for --headless); --no-wayland opts out.
 */
import { existsSync, realpathSync } from "node:fs";
import { homedir, platform } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

export const DATA_DIR_ENV = "BROWSER_TOOLS_DATA_DIR";

export function defaultDataDir(home = homedir()) {
  return join(home, ".cache", "browser-tools");
}

/** Real Chrome/Chromium user-data folders for this OS (whether or not they exist). */
export function realProfileDirs(home = homedir(), plat = platform(), env = process.env) {
  if (plat === "darwin") {
    const base = join(home, "Library", "Application Support");
    return [join(base, "Google", "Chrome"), join(base, "Google", "Chrome Beta"),
            join(base, "Google", "Chrome Canary"), join(base, "Chromium")];
  }
  if (plat === "win32") {
    const local = env.LOCALAPPDATA || join(home, "AppData", "Local");
    return [join(local, "Google", "Chrome", "User Data"), join(local, "Google", "Chrome Beta", "User Data"),
            join(local, "Google", "Chrome SxS", "User Data"), join(local, "Chromium", "User Data")];
  }
  const config = env.XDG_CONFIG_HOME || join(home, ".config");
  return [join(config, "google-chrome"), join(config, "google-chrome-beta"),
          join(config, "google-chrome-unstable"), join(config, "chromium"),
          join(home, "snap", "chromium", "common", "chromium"),
          join(home, ".var", "app", "com.google.Chrome", "config", "google-chrome"),
          join(home, ".var", "app", "org.chromium.Chromium", "config", "chromium")];
}

/** realpath that also works for paths that don't exist yet (resolves the nearest existing parent). */
export function resolveReal(p) {
  let cur = resolve(p);
  const rest = [];
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) break;
    rest.unshift(basename(cur));
    cur = parent;
  }
  let real = cur;
  try { real = realpathSync(cur); } catch {}
  return rest.length ? join(real, ...rest) : real;
}

function within(child, parent) {
  if (child === parent) return true;
  const p = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(p);
}

function expandHome(p, home) {
  if (p === "~") return home;
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(home, p.slice(2));
  return p;
}

/** Throws Error with a user-facing message if `dir` is not a safe dedicated profile dir. */
export function checkDataDir(dir, { home = homedir(), plat = platform(), env = process.env } = {}) {
  const real = resolveReal(dir);
  const root = resolve(sep);
  const realHome = resolveReal(home);
  if (real === root || real === resolveReal(root)) {
    throw new Error(`refusing --data-dir ${dir}: it resolves to the filesystem root`);
  }
  if (within(realHome, real)) {
    throw new Error(`refusing --data-dir ${dir}: it resolves to your home directory (or a parent of it): ${real}`);
  }
  for (const prof of realProfileDirs(home, plat, env)) {
    const realProf = resolveReal(prof);
    if (within(real, realProf) || within(real, resolve(prof))) {
      throw new Error(`refusing --data-dir ${dir}: it resolves into your real browser profile ${prof}`);
    }
  }
  return real;
}

/**
 * Parse browser-start.js arguments.
 * Returns { help, useProfile, headless, port, dataDir, dataDirSource } or throws Error.
 */
export function parseStartArgs(argv, env = process.env, opts = {}) {
  const home = opts.home || homedir();
  const plat = opts.platform || platform();
  const args = [...argv];
  let flagDir = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--data-dir") {
      const v = args[i + 1];
      if (v === undefined || v === "" || v.startsWith("--")) throw new Error("--data-dir needs a directory");
      flagDir = v;
      i++;
    } else if (a.startsWith("--data-dir=")) {
      flagDir = a.slice("--data-dir=".length);
      if (!flagDir) throw new Error("--data-dir needs a directory");
    }
  }
  const useProfile = args.includes("--profile");
  const headless = args.includes("--headless");
  const wantWayland = args.includes("--wayland");
  const noWayland = args.includes("--no-wayland");
  if (wantWayland && noWayland) throw new Error("--wayland and --no-wayland are mutually exclusive");
  const help = args.includes("--help") || args.includes("-h");
  const port = parseInt(args.find((a) => a.startsWith("--port="))?.split("=")[1] || "9222", 10);

  let dataDir = defaultDataDir(home);
  let dataDirSource = "default";
  const envDir = env[DATA_DIR_ENV];
  if (flagDir !== null) {
    dataDir = flagDir;
    dataDirSource = "flag";
  } else if (envDir) {
    dataDir = envDir;
    dataDirSource = "env";
  }
  if (dataDirSource !== "default") {
    if (useProfile) {
      throw new Error(`--profile cannot be combined with --data-dir/${DATA_DIR_ENV}: --profile copies your real ` +
                      "Chrome profile (cookies, logins) into the data dir");
    }
    dataDir = expandHome(dataDir, home);
    if (!isAbsolute(dataDir)) dataDir = resolve(dataDir);
    checkDataDir(dataDir, { home, plat, env });
  }
  // Native Wayland: explicit --wayland, or automatic for a dedicated --data-dir when
  // WAYLAND_DISPLAY is set (a Wayland client cannot read or inject into other windows).
  // Plain default runs are unchanged.
  let wayland = false;
  let waylandSource = "off";
  if (wantWayland) {
    if (!env.WAYLAND_DISPLAY) throw new Error("--wayland needs WAYLAND_DISPLAY to be set");
    wayland = true;
    waylandSource = "flag";
  } else if (!noWayland && dataDirSource !== "default" && env.WAYLAND_DISPLAY && !headless) {
    wayland = true;
    waylandSource = "auto";
  }
  return { help, useProfile, headless, port, dataDir, dataDirSource, wayland, waylandSource };
}

/** Extra Chrome flags for the parsed options (Chrome >= ~M110 needs no UseOzonePlatform feature). */
export function chromeExtraArgs(parsed) {
  return parsed.wayland ? ["--ozone-platform=wayland"] : [];
}

/**
 * Environment for the Chrome child.
 * - Plain default runs: unchanged (the same env object).
 * - Wayland mode: drop DISPLAY/XAUTHORITY so Chrome can't fall back to X.
 * - --data-dir or Wayland mode: if DBUS_SESSION_BUS_ADDRESS is unset and the user's
 *   session bus socket ($XDG_RUNTIME_DIR/bus, else /run/user/<uid>/bus) exists, point
 *   Chrome at it (quiets Chrome's dbus errors; the user's own bus, no other session's).
 */
export function chromeEnv(parsed, env = process.env, { exists = existsSync, uid = process.getuid?.() } = {}) {
  const custom = parsed.dataDirSource && parsed.dataDirSource !== "default";
  if (!parsed.wayland && !custom) return env;
  const out = { ...env };
  if (parsed.wayland) {
    delete out.DISPLAY;
    delete out.XAUTHORITY;
  }
  if (!out.DBUS_SESSION_BUS_ADDRESS) {
    const runtime = out.XDG_RUNTIME_DIR || (uid !== undefined ? `/run/user/${uid}` : null);
    const bus = runtime ? join(runtime, "bus") : null;
    if (bus && exists(bus)) out.DBUS_SESSION_BUS_ADDRESS = `unix:path=${bus}`;
  }
  return out;
}
