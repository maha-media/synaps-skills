---
name: browser-tools
description: Browser automation via Playwright CLI scripts. Start a browser, navigate pages, execute JavaScript, take screenshots, pick DOM elements, extract content as markdown, and manage cookies. Connect via Chrome DevTools Protocol on :9222.
---

# Browser Tools (CLI Scripts)

Standalone browser automation scripts using Playwright. These connect via Chrome DevTools Protocol on `:9222`.

## Setup

### 1. Install dependencies

```bash
cd ${CLAUDE_PLUGIN_ROOT}/scripts/browser-tools
npm install
```

### 2. Install browser (if no system Chrome/Chromium)

```bash
cd ${CLAUDE_PLUGIN_ROOT}/scripts/browser-tools && npx playwright install chromium
```

This step is **optional** if Chrome or Chromium is already installed. The start script auto-detects system browsers and falls back to Playwright's bundled Chromium.

## Start Browser

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/browser-tools/browser-start.js                # Launch with fresh profile
${CLAUDE_PLUGIN_ROOT}/scripts/browser-tools/browser-start.js --profile      # Copy user's Chrome profile (cookies, logins)
${CLAUDE_PLUGIN_ROOT}/scripts/browser-tools/browser-start.js --headless     # Headless mode (no visible window)
${CLAUDE_PLUGIN_ROOT}/scripts/browser-tools/browser-start.js --port=9333    # Custom debugging port
```

Launch a browser with remote debugging. Use `--profile` to preserve authentication state. Use `--headless` for CI or servers without a display.

The script checks these locations for a browser (in order):
- **macOS**: `/Applications/Google Chrome.app`
- **Linux/WSL**: `/usr/bin/google-chrome`, `/usr/bin/chromium`, `/snap/bin/chromium`
- **Windows**: `Program Files/Google/Chrome`, `AppData/Local/Google/Chrome`
- **Fallback**: Playwright's bundled Chromium (`npx playwright install chromium`)

## Navigate

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/browser-tools/browser-nav.js https://example.com
${CLAUDE_PLUGIN_ROOT}/scripts/browser-tools/browser-nav.js https://example.com --new
```

Navigate to URLs. Use `--new` to open in a new tab instead of reusing current tab.

## Evaluate JavaScript

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/browser-tools/browser-eval.js 'document.title'
${CLAUDE_PLUGIN_ROOT}/scripts/browser-tools/browser-eval.js 'document.querySelectorAll("a").length'
```

Execute JavaScript in the active tab. Code runs in async context.

## Screenshot

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/browser-tools/browser-screenshot.js                    # Viewport screenshot to temp file
${CLAUDE_PLUGIN_ROOT}/scripts/browser-tools/browser-screenshot.js --full             # Full page screenshot
${CLAUDE_PLUGIN_ROOT}/scripts/browser-tools/browser-screenshot.js ./output.png       # Save to specific path
```

Capture current viewport and return the file path.

## Pick Elements

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/browser-tools/browser-pick.js "Click the submit button"
```

**IMPORTANT**: Use this when the user wants to select specific DOM elements. Launches an interactive picker where the user clicks elements to select them. Supports multi-select (Cmd/Ctrl+Click) and returns CSS selectors for the selected elements.

## Cookies

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/browser-tools/browser-cookies.js
```

Display all cookies for the current context including domain, path, httpOnly, and secure flags.

## Extract Page Content

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/browser-tools/browser-content.js https://example.com
```

Navigate to a URL and extract readable content as markdown. Uses Readability for article extraction and Turndown for HTML-to-markdown conversion. Waits for page to fully load (including JS content).

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BROWSER_CDP_URL` | `http://localhost:9222` | Override CDP endpoint for all scripts |

## When NOT to Use

Do **not** use browser tools for direct file URLs — use `curl` instead. This includes:

- **File hosting sites**: `files.catbox.moe`, `raw.githubusercontent.com`, `pastebin.com/raw/`, `gist.githubusercontent.com`, etc.
- **Raw file extensions**: `.md`, `.txt`, `.json`, `.csv`, `.xml`, `.yaml`, `.yml`, `.log`, `.sh`, `.py`, `.js`, `.ts`, `.html`, `.css`, etc.
- **Any URL that serves a plain file** rather than a rendered web page

```bash
# Correct — just fetch the file
curl -sL https://files.catbox.moe/abc123.md

# Wrong — don't launch a browser for a raw file
browser-content.js https://files.catbox.moe/abc123.md
```

Only use browser tools when the page requires JavaScript rendering, interactive elements, or a real browser session.

## When to Use

- Testing frontend code in a real browser
- Interacting with pages that require JavaScript
- When user needs to visually see or interact with a page
- Debugging authentication or session issues
- Scraping dynamic content that requires JS execution

---

## Efficiency Guide

### DOM Inspection Over Screenshots

**Don't** take screenshots to see page state. **Do** parse the DOM directly:

```javascript
// Get page structure
document.body.innerHTML.slice(0, 5000)

// Find interactive elements
Array.from(document.querySelectorAll('button, input, [role="button"]')).map(e => ({
  id: e.id,
  text: e.textContent.trim(),
  class: e.className
}))
```

### Complex Scripts in Single Calls

Wrap everything in an IIFE to run multi-statement code:

```javascript
(function() {
  const data = document.querySelector('#target').textContent;
  const buttons = document.querySelectorAll('button');
  buttons[0].click();
  return JSON.stringify({ data, buttonCount: buttons.length });
})()
```

### Batch Interactions

**Don't** make separate calls for each click. **Do** batch them:

```javascript
(function() {
  ["btn1", "btn2", "btn3"].forEach(id => document.getElementById(id).click());
  return "Done";
})()
```

### Waiting for Updates

If DOM updates after actions, add a small delay:

```bash
sleep 0.5 && ${CLAUDE_PLUGIN_ROOT}/scripts/browser-tools/browser-eval.js '...'
```

### Investigate Before Interacting

Always start by understanding the page structure:

```javascript
(function() {
  return {
    title: document.title,
    forms: document.forms.length,
    buttons: document.querySelectorAll('button').length,
    inputs: document.querySelectorAll('input').length,
    mainContent: document.body.innerHTML.slice(0, 3000)
  };
})()
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `Could not connect to browser` | Run `browser-start.js` first |
| `No browser found` | Run `npx playwright install chromium` |
| `Cannot open display` (Linux/WSL) | Use `--headless`, or install a display server |
| `Browser already running on :9222` | Already started — scripts will connect |
| Scripts hang | Check if browser crashed; restart with `browser-start.js` |
