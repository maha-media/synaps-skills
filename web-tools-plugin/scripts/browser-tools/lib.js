/**
 * Shared Playwright connection helper.
 * All scripts connect to a browser launched by browser-start.js via CDP on :9222.
 */
import { chromium } from "playwright";

const CDP_URL = process.env.BROWSER_CDP_URL || "http://localhost:9222";
const CONNECT_TIMEOUT = 5000;

/**
 * Connect to the running browser and get the active page.
 * @returns {{ browser, context, page }}
 */
export async function connect() {
  let browser;
  try {
    browser = await Promise.race([
      chromium.connectOverCDP(CDP_URL),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), CONNECT_TIMEOUT)
      ),
    ]);
  } catch (e) {
    console.error(`✗ Could not connect to browser at ${CDP_URL}: ${e.message}`);
    console.error("  Run: browser-start.js");
    process.exit(1);
  }

  const contexts = browser.contexts();
  if (contexts.length === 0) {
    console.error("✗ No browser context found");
    process.exit(1);
  }

  const context = contexts[0];
  const pages = context.pages();
  const page = pages[pages.length - 1];

  if (!page) {
    console.error("✗ No active tab found");
    process.exit(1);
  }

  return { browser, context, page };
}
