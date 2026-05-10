/**
 * @file bridge/core/mcp/oauth/oauth-pkce.js
 *
 * PKCE (RFC 7636) verification utility.
 *
 * Only S256 is supported — `code_challenge_method = 'plain'` and all other
 * methods are rejected, as required by OAuth 2.1 (§4.1.1).
 *
 * Algorithm:
 *   base64url(sha256(ascii(code_verifier))) === code_challenge
 *
 * The comparison is performed with `crypto.timingSafeEqual` to prevent
 * timing-oracle attacks on the challenge value.
 *
 * base64url encoding
 *   Standard base64 with:
 *     +  →  -
 *     /  →  _
 *     =  stripped (no padding)
 *
 * No I/O, no external dependencies beyond `node:crypto`.
 *
 * Spec reference: Phase 9 brief § Track 3 — OAuth 2.1 + PKCE; Wave C C1.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

// ── base64url ─────────────────────────────────────────────────────────────────

/**
 * Encode a Buffer as base64url (no padding, URL-safe alphabet).
 *
 * @param {Buffer} buf
 * @returns {string}
 */
function toBase64Url(buf) {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// ── verifyChallenge ───────────────────────────────────────────────────────────

/**
 * Verify a PKCE code_verifier against a previously-stored code_challenge.
 *
 * @param {object} opts
 * @param {string} opts.code_verifier          - The verifier submitted at /token.
 * @param {string} opts.code_challenge         - The challenge stored with the auth code.
 * @param {string} [opts.code_challenge_method='S256'] - Only 'S256' is accepted.
 * @returns {boolean}  true if the verifier is correct, false otherwise.
 * @throws {TypeError} If any required input is missing/empty, or if
 *                     code_challenge_method is not 'S256'.
 */
export function verifyChallenge({
  code_verifier,
  code_challenge,
  code_challenge_method = 'S256',
} = {}) {
  // ── Guard: non-empty strings ──────────────────────────────────────────────
  if (typeof code_verifier !== 'string' || code_verifier.length === 0) {
    throw new TypeError('verifyChallenge: code_verifier must be a non-empty string');
  }
  if (typeof code_challenge !== 'string' || code_challenge.length === 0) {
    throw new TypeError('verifyChallenge: code_challenge must be a non-empty string');
  }

  // ── Guard: method ─────────────────────────────────────────────────────────
  if (code_challenge_method !== 'S256') {
    throw new TypeError(
      `verifyChallenge: unsupported code_challenge_method "${code_challenge_method}" — only S256 is allowed`,
    );
  }

  // ── Compute expected challenge ────────────────────────────────────────────
  const digest   = createHash('sha256').update(code_verifier, 'ascii').digest();
  const expected = toBase64Url(digest);

  // ── Constant-time compare ─────────────────────────────────────────────────
  // timingSafeEqual requires equal-length buffers.  If lengths differ the
  // challenge is definitely wrong, but we still run a dummy comparison on
  // same-length buffers to avoid leaking length information via timing.
  const bufExpected = Buffer.from(expected, 'utf8');
  const bufActual   = Buffer.from(code_challenge, 'utf8');

  if (bufExpected.length !== bufActual.length) {
    // Dummy comparison to consume constant time regardless of length mismatch.
    const dummy = Buffer.alloc(bufExpected.length, 0);
    timingSafeEqual(bufExpected, dummy); // result discarded
    return false;
  }

  return timingSafeEqual(bufExpected, bufActual);
}
