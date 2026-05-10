/**
 * @file slack-bot-gate.js
 * @module bridge/sources/slack/slack-bot-gate
 *
 * Slack-specific BotGate.
 *
 * In AI-app mode (user explicitly opened an Agents & AI Apps chat with the
 * assistant bot) every turn is inherently intentional — the gate short-circuits
 * to `{ allowed: true }` regardless of the recorded turn counter.
 *
 * In legacy mode (`aiAppMode: false`) the gate delegates to the base
 * `BotGate.evaluate()` which enforces the `maxTurnsPerThread` ceiling.
 */

import { BotGate } from '../../core/abstractions/bot-gate.js';

export class SlackBotGate extends BotGate {
  /**
   * @param {object}  [opts]
   * @param {boolean} [opts.aiAppMode=true]      - `true` → always allow; `false` → base logic.
   * @param {number}  [opts.maxTurnsPerThread=Infinity] - Forwarded to BotGate base.
   * @param {object}  [opts.logger=console]      - Injected logger.
   */
  constructor({ aiAppMode = true, ...opts } = {}) {
    super(opts);

    /** @type {boolean} */
    this.aiAppMode = aiAppMode;
  }

  /**
   * Evaluate whether the incoming turn should proceed.
   *
   * @param {object} ctx
   * @param {string} ctx.source
   * @param {string} ctx.conversation
   * @param {string} ctx.thread
   * @param {string} [ctx.sender]
   * @param {string} [ctx.text]
   * @returns {import('../../core/abstractions/bot-gate.js').GateResult}
   */
  evaluate(ctx) {
    if (this.aiAppMode) return { allowed: true };
    return super.evaluate(ctx);
  }
}
