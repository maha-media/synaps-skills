// bridge/core/done-check.test.js

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isTurnDone, waitForDone, DONE_CHECK_POLL_MS } from "./done-check.js";

// ─── isTurnDone ──────────────────────────────────────────────────────────────

describe("isTurnDone", () => {
  it("returns not-done / in_progress when streamingActive is true (nothing else set)", () => {
    const result = isTurnDone({
      streamingActive: true,
      agentEndSeen: false,
      pendingSubagents: 0,
      bufferedTextChars: 0,
      msSinceLastDelta: 0,
    });
    expect(result).toEqual({ done: false, reason: "in_progress" });
  });

  it("returns not-done / in_progress when streamingActive and everything else set", () => {
    // streamingActive wins — nothing else matters.
    const result = isTurnDone({
      streamingActive: true,
      agentEndSeen: true,
      pendingSubagents: 0,
      bufferedTextChars: 0,
      msSinceLastDelta: 500,
    });
    expect(result).toEqual({ done: false, reason: "in_progress" });
  });

  it("returns done / complete when agent_end seen, no subagents, nothing buffered", () => {
    const result = isTurnDone({
      streamingActive: false,
      agentEndSeen: true,
      pendingSubagents: 0,
      bufferedTextChars: 0,
      msSinceLastDelta: 1000,
    });
    expect(result).toEqual({ done: true, reason: "complete" });
  });

  it("returns not-done / awaiting_subagents when agent_end seen but 2 subagents pending", () => {
    const result = isTurnDone({
      streamingActive: false,
      agentEndSeen: true,
      pendingSubagents: 2,
      bufferedTextChars: 0,
      msSinceLastDelta: 200,
    });
    expect(result).toEqual({ done: false, reason: "awaiting_subagents" });
  });

  it("returns not-done / awaiting_flush when agent_end seen, 0 subagents, but buffer non-empty", () => {
    const result = isTurnDone({
      streamingActive: false,
      agentEndSeen: true,
      pendingSubagents: 0,
      bufferedTextChars: 47,
      msSinceLastDelta: 50,
    });
    expect(result).toEqual({ done: false, reason: "awaiting_flush" });
  });

  it("returns not-done / in_progress when everything is zero and never streamed", () => {
    // Neither streaming nor agent_end — idle / pre-prompt state.
    const result = isTurnDone({
      streamingActive: false,
      agentEndSeen: false,
      pendingSubagents: 0,
      bufferedTextChars: 0,
      msSinceLastDelta: 0,
    });
    expect(result).toEqual({ done: false, reason: "in_progress" });
  });

  it("awaiting_subagents takes priority over awaiting_flush when both pending", () => {
    const result = isTurnDone({
      streamingActive: false,
      agentEndSeen: true,
      pendingSubagents: 1,
      bufferedTextChars: 100,
      msSinceLastDelta: 300,
    });
    expect(result).toEqual({ done: false, reason: "awaiting_subagents" });
  });
});

// ─── waitForDone ─────────────────────────────────────────────────────────────

describe("waitForDone", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Helper: a TurnState that is already done. */
  const doneState = () => ({
    streamingActive: false,
    agentEndSeen: true,
    pendingSubagents: 0,
    bufferedTextChars: 0,
    msSinceLastDelta: 500,
  });

  /** Helper: a TurnState that is not done. */
  const notDoneState = () => ({
    streamingActive: true,
    agentEndSeen: false,
    pendingSubagents: 0,
    bufferedTextChars: 0,
    msSinceLastDelta: 0,
  });

  it("resolves immediately when state is already done", async () => {
    const promise = waitForDone(doneState, { timeoutMs: 1000, intervalMs: 100 });
    // Tick past the first poll interval so the first await resolves.
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result).toEqual({ done: true, reason: "complete", timedOut: false });
  });

  it("polls until state transitions to done", async () => {
    let calls = 0;
    const getState = () => {
      calls++;
      // Become done after 3 calls.
      if (calls >= 3) return doneState();
      return notDoneState();
    };

    const promise = waitForDone(getState, { timeoutMs: 5000, intervalMs: 100 });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.done).toBe(true);
    expect(result.reason).toBe("complete");
    expect(result.timedOut).toBe(false);
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it("returns timedOut:true after timeoutMs elapses", async () => {
    // State never becomes done.
    const promise = waitForDone(notDoneState, {
      timeoutMs: 300,
      intervalMs: 100,
    });

    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.timedOut).toBe(true);
    expect(result.done).toBe(false);
  });

  it("exports DONE_CHECK_POLL_MS with the expected default value", () => {
    expect(typeof DONE_CHECK_POLL_MS).toBe("number");
    expect(DONE_CHECK_POLL_MS).toBe(100);
  });

  it("uses intervalMs as the poll frequency", async () => {
    let calls = 0;
    const getState = () => {
      calls++;
      // Never done — we are testing call count vs time elapsed.
      return notDoneState();
    };

    // 4 intervals of 50 ms before 250 ms timeout.
    const promise = waitForDone(getState, { timeoutMs: 250, intervalMs: 50 });
    await vi.runAllTimersAsync();
    await promise;

    // Should have been called ≥ 4 times (once before each sleep).
    expect(calls).toBeGreaterThanOrEqual(4);
  });
});
