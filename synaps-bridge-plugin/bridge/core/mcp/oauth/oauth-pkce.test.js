/**
 * @file bridge/core/mcp/oauth/oauth-pkce.test.js
 *
 * Tests for the PKCE verification utility (oauth-pkce.js).
 *
 * Spec reference: Phase 9 brief § Track 3 — PKCE utility; 6 tests.
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { verifyChallenge } from './oauth-pkce.js';

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Compute the S256 code_challenge for a given verifier.
 * This is the same formula the client would use.
 */
function makeChallenge(verifier) {
  return createHash('sha256')
    .update(verifier, 'ascii')
    .digest()
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('verifyChallenge()', () => {
  it('returns true for a correct verifier / challenge pair', () => {
    const verifier   = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const challenge  = makeChallenge(verifier);
    expect(verifyChallenge({ code_verifier: verifier, code_challenge: challenge })).toBe(true);
  });

  it('returns false when the verifier is wrong', () => {
    const verifier   = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const challenge  = makeChallenge(verifier);
    const badVerifier = 'THIS_IS_WRONG_verifier_value_that_wont_match_0';
    // same length as original verifier to keep comparison path identical
    expect(verifyChallenge({ code_verifier: badVerifier, code_challenge: challenge })).toBe(false);
  });

  it('returns false when challenge has wrong length (timingSafeEqual safety)', () => {
    const verifier   = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    // Provide a challenge that is definitely the wrong length
    const shortChallenge = 'tooshort';
    expect(verifyChallenge({ code_verifier: verifier, code_challenge: shortChallenge })).toBe(false);
  });

  it('throws for unsupported code_challenge_method', () => {
    const verifier   = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const challenge  = makeChallenge(verifier);
    expect(() =>
      verifyChallenge({
        code_verifier: verifier,
        code_challenge: challenge,
        code_challenge_method: 'plain',
      }),
    ).toThrow(/unsupported code_challenge_method/);
  });

  it('throws when code_verifier is empty', () => {
    expect(() =>
      verifyChallenge({ code_verifier: '', code_challenge: 'anything' }),
    ).toThrow(/code_verifier/);
  });

  it('uses correct base64url alphabet — no +, /, or = characters in challenge output', () => {
    // Run 50 random-ish verifiers and assert the generated challenge is valid base64url.
    const base64urlPattern = /^[A-Za-z0-9\-_]+$/;
    for (let i = 0; i < 50; i++) {
      const verifier  = `test-verifier-${i}-${'x'.repeat(40)}`;
      const challenge = makeChallenge(verifier);
      // Verify our helper produces a correct base64url string
      expect(challenge).toMatch(base64urlPattern);
      // And verifyChallenge correctly validates it
      expect(verifyChallenge({ code_verifier: verifier, code_challenge: challenge })).toBe(true);
    }
  });
});
