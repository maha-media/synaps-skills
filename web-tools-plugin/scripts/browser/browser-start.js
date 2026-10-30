#!/usr/bin/env node
/**
 * Launch a Chromium browser with remote debugging.
 * Cross-platform — uses Playwright's bundled Chromium, system Chrome, or Chromium.
 */
import { chromium } from "playwright";
import { execSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { recallAndEmit, failAndExit } from "../_lib/hooks.mjs";
import { parseStartArgs, DATA_DIR_ENV, chromeExtraArgs, chromeEnv } from "./start-args.mjs";

let parsed;
try {
  parsed = parseStartArgs(process.argv.slice(2), process.env);
} catch (e) {
  console.error(`browser-start.js: ${e.message}`);
  process.exit(2);
}
const { useProfile, headless, port, dataDirSource } = parsed;

if (parsed.help) {
  console.log("Usage: browser-start.js [options]");
  console.log("");
  console.log("Options:");
  console.log("  --profile   Copy your default Chrome profile (cookies, logins)");
  console.log("  --headless  Run in headless mode");
  console.log("  --port=N    Remote debugging port (default: 9222)");
  console.log("  --data-dir DIR  Use a dedicated profile dir instead of ~/.cache/browser-tools");
  console.log(`              (or env ${DATA_DIR_ENV}; the flag wins; not allowed with --profile)`);
  console.log("  --wayland   Native Wayland window (--ozone-platform=wayland, no X); default with --data-dir");
  console.log("              when WAYLAND_DISPLAY is set. --no-wayland opts out.");
  process.exit(0);
}

const OP = "browser-start";
recallAndEmit(`browser launch ${headless ? "headless" : ""}`.trim(), { op: OP });

const DATA_DIR = parsed.dataDir; // default: ~/.cache/browser-tools
const customDir = dataDirSource !== "default";

// Check if already running
let alreadyRunning = false;
try {
  const browser = await chromium.connectOverCDP(`http://localhost:${port}`);
  await browser.close();
  alreadyRunning = true;
} catch {}
if (alreadyRunning) {
  if (customDir) {
    // The running browser may use a different profile; never hand it out as the dedicated one.
    console.error(`browser-start.js: a browser is already running on :${port} and its profile may not be ${DATA_DIR}. ` +
                  "Close it, or use another --port.");
    process.exit(1);
  }
  console.log(`✓ Browser already running on :${port}`);
  process.exit(0);
}

try {
  // Setup data directory (a dedicated --data-dir is private to the user)
  if (customDir) {
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    chmodSync(DATA_DIR, 0o700);
  } else {
    mkdirSync(DATA_DIR, { recursive: true });
  }

  // Clean stale lock files
  for (const lock of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    const p = join(DATA_DIR, lock);
    try { rmSync(p, { force: true }); } catch {}
  }

  // Sync user profile if requested
  if (useProfile) {
    const os = platform();
    let profileSrc;

    if (os === "darwin") {
      profileSrc = join(homedir(), "Library", "Application Support", "Google", "Chrome");
    } else if (os === "win32") {
      profileSrc = join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "Google", "Chrome", "User Data");
    } else {
      profileSrc = join(homedir(), ".config", "google-chrome");
    }

    if (existsSync(profileSrc)) {
      console.log(`Syncing profile from ${profileSrc}...`);
      try {
        if (os === "win32") {
          execSync(`robocopy "${profileSrc}" "${DATA_DIR}" /E /XF SingletonLock SingletonSocket SingletonCookie /XD Sessions`, { stdio: "pipe" });
        } else {
          execSync(`rsync -a --delete --exclude='SingletonLock' --exclude='SingletonSocket' --exclude='SingletonCookie' --exclude='*/Sessions/*' --exclude='*/Current Session' --exclude='*/Current Tabs' "${profileSrc}/" "${DATA_DIR}/"`, { stdio: "pipe" });
        }
      } catch (e) {
        console.error("Warning: Profile sync failed:", e.message);
      }
    } else {
      console.error(`Warning: Chrome profile not found at ${profileSrc}`);
    }
  }

  // Find browser executable
  function findBrowser() {
    const os = platform();
    const chromePaths = {
      darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
      win32: [
        join(process.env["PROGRAMFILES"] || "", "Google", "Chrome", "Application", "chrome.exe"),
        join(process.env["PROGRAMFILES(X86)"] || "", "Google", "Chrome", "Application", "chrome.exe"),
        join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
      ],
      linux: [
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/snap/bin/chromium",
      ],
    };
    const paths = chromePaths[os] || chromePaths.linux;
    for (const p of paths) {
      if (existsSync(p)) return p;
    }
    return chromium.executablePath();
  }

  const execPath = findBrowser();
  console.log(`Using: ${execPath}`);

  const launchArgs = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${DATA_DIR}`,
    "--no-first-run",
    "--no-default-browser-check",
  ];

  if (headless) launchArgs.push("--headless=new");
  launchArgs.push(...chromeExtraArgs(parsed));

  const child = spawn(execPath, launchArgs, {
    detached: true,
    stdio: "ignore",
    env: chromeEnv(parsed, process.env),
  });
  child.unref();

  // Wait for browser to be ready
  let connected = false;
  for (let i = 0; i < 30; i++) {
    try {
      const browser = await chromium.connectOverCDP(`http://localhost:${port}`);
      await browser.close();
      connected = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  if (!connected) {
    failAndExit({
      host: null, op: OP,
      err: new Error("Failed to connect to browser. If Playwright browsers aren't installed, run: npx playwright install chromium"),
      err_class: "no_browser",
      cmd: `browser-start.js port=${port}`,
      args: { port, headless, useProfile },
    });
  }

  console.log(`✓ Browser started on :${port}${useProfile ? " with your profile" : ""}${headless ? " (headless)" : ""}${customDir ? ` (profile dir ${DATA_DIR})` : ""}${parsed.wayland ? " (native Wayland)" : ""}`);
  if (customDir) console.log(`  pid ${child.pid}`);
} catch (e) {
  failAndExit({
    host: null, op: OP,
    err: e,
    cmd: `browser-start.js port=${port}`,
    args: { port, headless, useProfile },
  });
}
