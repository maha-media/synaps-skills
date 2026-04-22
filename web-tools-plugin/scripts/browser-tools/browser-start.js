#!/usr/bin/env node
/**
 * Launch a Chromium browser with remote debugging.
 * Cross-platform — uses Playwright's bundled Chromium, system Chrome, or Chromium.
 */
import { chromium } from "playwright";
import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";

const args = process.argv.slice(2);
const useProfile = args.includes("--profile");
const headless = args.includes("--headless");
const port = parseInt(args.find((a) => a.startsWith("--port="))?.split("=")[1] || "9222", 10);

if (args.includes("--help") || args.includes("-h")) {
  console.log("Usage: browser-start.js [options]");
  console.log("");
  console.log("Options:");
  console.log("  --profile   Copy your default Chrome profile (cookies, logins)");
  console.log("  --headless  Run in headless mode");
  console.log("  --port=N    Remote debugging port (default: 9222)");
  process.exit(0);
}

const DATA_DIR = join(homedir(), ".cache", "browser-tools");

// Check if already running
try {
  const browser = await chromium.connectOverCDP(`http://localhost:${port}`);
  await browser.close();
  console.log(`✓ Browser already running on :${port}`);
  process.exit(0);
} catch {}

// Setup data directory
mkdirSync(DATA_DIR, { recursive: true });

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

// Find browser executable: prefer system Chrome, fall back to Playwright's bundled Chromium
function findBrowser() {
  const os = platform();

  // System Chrome paths
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

  // Fall back to Playwright's bundled Chromium
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

if (headless) {
  launchArgs.push("--headless=new");
}

// Launch browser
const child = spawn(execPath, launchArgs, {
  detached: true,
  stdio: "ignore",
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
  console.error("✗ Failed to connect to browser");
  console.error("  If Playwright browsers aren't installed, run: npx playwright install chromium");
  process.exit(1);
}

console.log(`✓ Browser started on :${port}${useProfile ? " with your profile" : ""}${headless ? " (headless)" : ""}`);
