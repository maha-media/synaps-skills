/**
 * @file slack-capabilities.js
 * @module bridge/sources/slack/slack-capabilities
 *
 * Frozen capability map for the Slack concrete adapter.
 *
 * Spread-extends DEFAULT_CAPABILITIES so every key from the abstract contract
 * is always present; Slack overrides only the flags it supports.
 */

import { DEFAULT_CAPABILITIES } from '../../core/abstractions/adapter.js';

/**
 * Capability flags for the Slack adapter (AI-app mode primary).
 *
 * Key flags:
 * - `streaming` + `richStreamChunks`: `chat.startStream / appendStream / stopStream`
 *    with typed chunk envelopes (markdown_text, task_update, plan_update, blocks).
 * - `buttons`: Block Kit interactive components wired through `app.action`.
 * - `files`: Slack file uploads downloaded to the local filesystem.
 * - `reactions`: `reactions.add` can be called on the incoming message.
 * - `threading`: every reply carries a `thread_ts`.
 * - `auxBlocks`: legacy fallback path — separate Block Kit messages alongside stream.
 * - `aiAppMode`: `assistant_thread_started` / `setStatus` / `setSuggestedPrompts` / `setTitle`.
 *
 * @type {Readonly<import('../../core/abstractions/adapter.js').AdapterCapabilities>}
 */
export const SLACK_CAPABILITIES = Object.freeze({
  ...DEFAULT_CAPABILITIES,
  streaming: true,
  richStreamChunks: true,
  buttons: true,
  files: true,
  reactions: true,
  threading: true,
  auxBlocks: true,
  aiAppMode: true,
});
