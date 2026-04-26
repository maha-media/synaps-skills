/**
 * Shared Playwright connection helper.
 * All scripts connect to a browser launched by browser-start.js via CDP on :9222.
 *
 * Also re-exports the self-healing hook helpers so scripts can wire PRE/POST
 * memory hooks without their own boilerplate import.
 */
import { chromium } from "playwright";
import {
  extractHost, classifyError, recallAndEmit, failAndExit, memory,
} from "../_lib/hooks.mjs";

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
    failAndExit({
      host: null,
      op: "browser",
      err: new Error(
        `Could not connect to browser at ${CDP_URL}: ${e.message}. Run: browser-start.js`
      ),
      err_class: "no_browser",
      cmd: "connectOverCDP",
    });
  }

  const contexts = browser.contexts();
  if (contexts.length === 0) {
    failAndExit({
      host: null, op: "browser",
      err: new Error("No browser context found"),
      err_class: "no_browser",
    });
  }

  const context = contexts[0];
  const pages = context.pages();
  const page = pages[pages.length - 1];

  if (!page) {
    failAndExit({
      host: null, op: "browser",
      err: new Error("No active tab found"),
      err_class: "no_browser",
    });
  }

  return { browser, context, page };
}

// Re-export hook helpers so scripts only need one import
export { extractHost, classifyError, recallAndEmit, failAndExit, memory };
