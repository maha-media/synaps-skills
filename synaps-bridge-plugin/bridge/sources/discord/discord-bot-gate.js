/**
 * @file discord-bot-gate.js
 * @module bridge/sources/discord/discord-bot-gate
 *
 * Discord-specific BotGate.
 *
 * Discord has no AI-app mode equivalent — the base BotGate.evaluate() logic
 * (maxTurnsPerThread ceiling) applies as-is.  This subclass exists so the
 * Discord adapter can be extended with platform-specific rules in the future
 * without touching core code.
 */

import { BotGate } from '../../core/abstractions/bot-gate.js';

export class DiscordBotGate extends BotGate {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxTurnsPerThread=Infinity] - Forwarded to BotGate base.
   * @param {object} [opts.logger=console]             - Injected logger.
   */
  constructor({ maxTurnsPerThread = Infinity, logger = console } = {}) {
    super({ maxTurnsPerThread, logger });
  }
}
