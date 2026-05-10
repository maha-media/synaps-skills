// bridge/core/helpers.test.js

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  parseSetModelDirective,
  truncate,
  stableStringify,
  stripAnsi,
  sleep,
  formatErrorLine,
  sessionKey,
} from "./helpers.js";

// ─── parseSetModelDirective ──────────────────────────────────────────────────

describe("parseSetModelDirective", () => {
  it("matches 'set-model: foo' on the first line", () => {
    const { model, body } = parseSetModelDirective(
      "set-model: claude-3-5-sonnet\nPlease do something.",
    );
    expect(model).toBe("claude-3-5-sonnet");
    expect(body).toBe("Please do something.");
  });

  it("matches 'set-model:foo' (no space around colon)", () => {
    const { model, body } = parseSetModelDirective(
      "set-model:gpt-4o\nHello",
    );
    expect(model).toBe("gpt-4o");
    expect(body).toBe("Hello");
  });

  it("matches 'Set-Model:  foo' (case-insensitive, extra whitespace)", () => {
    const { model, body } = parseSetModelDirective(
      "Set-Model:  claude-opus-4\nBody text",
    );
    expect(model).toBe("claude-opus-4");
    expect(body).toBe("Body text");
  });

  it("returns {model:null, body:original} when no directive is present", () => {
    const original = "Just a normal message";
    const { model, body } = parseSetModelDirective(original);
    expect(model).toBeNull();
    expect(body).toBe(original);
  });

  it("returns {model:null, body:original} when directive is on second line (not first)", () => {
    const original = "First line\nset-model: claude-haiku\nThird line";
    const { model, body } = parseSetModelDirective(original);
    expect(model).toBeNull();
    expect(body).toBe(original);
  });

  it("returns {model:null, body:original} when directive is in the middle of a message", () => {
    const original = "Some text set-model: claude-sonnet more text";
    const { model, body } = parseSetModelDirective(original);
    // The directive is not the sole content of the first line → no match.
    expect(model).toBeNull();
    expect(body).toBe(original);
  });

  it("strips exactly one leading newline from body", () => {
    const { model, body } = parseSetModelDirective("set-model: m\n\nDouble blank");
    expect(model).toBe("m");
    // The body should be the rest after the first \n.
    expect(body).toBe("\nDouble blank");
  });

  it("returns empty body when directive is the entire message", () => {
    const { model, body } = parseSetModelDirective("set-model: claude-3");
    expect(model).toBe("claude-3");
    expect(body).toBe("");
  });
});

// ─── truncate ────────────────────────────────────────────────────────────────

describe("truncate", () => {
  it("returns the input unchanged when it is short enough", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("returns the input unchanged when exactly at maxChars", () => {
    expect(truncate("hello", 5)).toBe("hello");
  });

  it("truncates at the correct boundary and appends the default ellipsis", () => {
    const result = truncate("hello world", 8);
    expect(result).toBe("hello w…");
    expect(result.length).toBe(8);
  });

  it("truncates with a custom ellipsis", () => {
    const result = truncate("abcdefgh", 6, "...");
    expect(result).toBe("abc...");
    expect(result.length).toBe(6);
  });

  it("handles maxChars shorter than ellipsis length gracefully (no negative slice)", () => {
    // cutAt = max(0, 1 - 3) = 0 → returns just the ellipsis
    const result = truncate("abc", 1, "...");
    expect(result.length).toBeGreaterThanOrEqual(0);
  });
});

// ─── stableStringify ─────────────────────────────────────────────────────────

describe("stableStringify", () => {
  it("produces the same output for an object with reordered keys", () => {
    const a = { z: 1, a: 2, m: 3 };
    const b = { m: 3, z: 1, a: 2 };
    expect(stableStringify(a)).toBe(stableStringify(b));
  });

  it("sorts nested object keys too", () => {
    const a = { outer: { z: "z", a: "a" } };
    const b = { outer: { a: "a", z: "z" } };
    expect(stableStringify(a)).toBe(stableStringify(b));
  });

  it("preserves array order (arrays are not sorted)", () => {
    expect(stableStringify([3, 1, 2])).toBe("[3,1,2]");
  });

  it("handles primitives directly", () => {
    expect(stableStringify(42)).toBe("42");
    expect(stableStringify("hi")).toBe('"hi"');
    expect(stableStringify(null)).toBe("null");
  });

  it("different values produce different output", () => {
    expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: 2 }));
  });
});

// ─── stripAnsi ───────────────────────────────────────────────────────────────

describe("stripAnsi", () => {
  it("removes color codes from a sample colored string", () => {
    // eslint-disable-next-line no-control-regex
    const colored = "\u001B[32mSuccess\u001B[0m";
    expect(stripAnsi(colored)).toBe("Success");
  });

  it("removes bold escape sequence", () => {
    const bold = "\u001B[1mBold text\u001B[22m";
    expect(stripAnsi(bold)).toBe("Bold text");
  });

  it("removes multiple sequences in one string", () => {
    const s = "\u001B[31mError\u001B[0m: \u001B[33mwarning\u001B[0m";
    expect(stripAnsi(s)).toBe("Error: warning");
  });

  it("leaves plain text unchanged", () => {
    expect(stripAnsi("plain text")).toBe("plain text");
  });

  it("handles empty string", () => {
    expect(stripAnsi("")).toBe("");
  });
});

// ─── sleep ───────────────────────────────────────────────────────────────────

describe("sleep", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves after the requested ms", async () => {
    let resolved = false;
    const p = sleep(200).then(() => {
      resolved = true;
    });

    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(199);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(resolved).toBe(true);
  });

  it("resolves immediately for 0 ms", async () => {
    const p = sleep(0);
    await vi.runAllTimersAsync();
    await p; // should not hang
  });
});

// ─── formatErrorLine ─────────────────────────────────────────────────────────

describe("formatErrorLine", () => {
  it("includes the error message", () => {
    const line = formatErrorLine(new Error("something went wrong"));
    expect(line).toContain("something went wrong");
  });

  it("does not include the stack trace", () => {
    const err = new Error("boom");
    const line = formatErrorLine(err);
    expect(line).not.toContain("at ");
  });

  it("includes the .code property when present", () => {
    const err = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    const line = formatErrorLine(err);
    expect(line).toContain("ENOENT");
    expect(line).toContain("code=ENOENT");
  });

  it("does not add '(code=...)' when .code is absent", () => {
    const line = formatErrorLine(new Error("plain"));
    expect(line).not.toContain("code=");
  });

  it("handles non-Error values by stringifying them", () => {
    expect(formatErrorLine("oops")).toBe("oops");
    expect(formatErrorLine(42)).toBe("42");
  });
});

// ─── sessionKey ──────────────────────────────────────────────────────────────

describe("sessionKey", () => {
  it("produces a deterministic string for the same inputs", () => {
    const k1 = sessionKey({ source: "slack", conversation: "C123", thread: "T456" });
    const k2 = sessionKey({ source: "slack", conversation: "C123", thread: "T456" });
    expect(k1).toBe(k2);
  });

  it("different threads produce different keys", () => {
    const k1 = sessionKey({ source: "slack", conversation: "C123", thread: "T001" });
    const k2 = sessionKey({ source: "slack", conversation: "C123", thread: "T002" });
    expect(k1).not.toBe(k2);
  });

  it("different conversations produce different keys", () => {
    const k1 = sessionKey({ source: "slack", conversation: "C001", thread: "T999" });
    const k2 = sessionKey({ source: "slack", conversation: "C002", thread: "T999" });
    expect(k1).not.toBe(k2);
  });

  it("different sources produce different keys", () => {
    const k1 = sessionKey({ source: "slack",   conversation: "C1", thread: "T1" });
    const k2 = sessionKey({ source: "discord", conversation: "C1", thread: "T1" });
    expect(k1).not.toBe(k2);
  });

  it("returns a non-empty string", () => {
    const k = sessionKey({ source: "x", conversation: "y", thread: "z" });
    expect(typeof k).toBe("string");
    expect(k.length).toBeGreaterThan(0);
  });
});
