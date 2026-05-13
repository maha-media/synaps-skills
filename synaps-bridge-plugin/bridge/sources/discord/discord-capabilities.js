/**
 * @file discord-capabilities.js
 * @module bridge/sources/discord/discord-capabilities
 *
 * Frozen capability map for the Discord concrete adapter.
 *
 * Spread-extends DEFAULT_CAPABILITIES so every key from the abstract contract
 * is always present; Discord overrides only the flags it supports.
 */

import { DEFAULT_CAPABILITIES } from '../../core/abstractions/adapter.js';

/**
 * Capability flags for the Discord adapter.
 *
 * Key flags:
 * - `buttons`: Discord message components (buttons, select menus).
 * - `files`: Discord file attachments.
 * - `reactions`: Emoji reactions on messages.
 * - `threading`: Discord thread channels.
 * - `auxBlocks`: Embed objects posted alongside main content.
 * - `streaming` / `richStreamChunks` / `aiAppMode`: not supported.
 *
 * @type {Readonly<import('../../core/abstractions/adapter.js').AdapterCapabilities>}
 */
export const DISCORD_CAPABILITIES = Object.freeze({
  ...DEFAULT_CAPABILITIES,
  streaming: false,
  richStreamChunks: false,
  buttons: true,
  files: true,
  reactions: true,
  threading: true,
  auxBlocks: true,
  aiAppMode: false,
});
