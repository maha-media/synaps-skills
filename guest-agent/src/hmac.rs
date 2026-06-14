//! HMAC-SHA256 request authentication (spec §5) + replay protection.
//!
//! This is the Rust peer of `pria-ui-v22` `routes/services/agenticVmHmac.js`
//! (GA-A1) and must produce byte-identical signatures for the frozen golden
//! vector (`docs/contract.md` §1.2, `tests/hmac_tests.rs`).
//!
//! The canonical string is the nine `\n`-joined fields of spec §5.2:
//! `METHOD, PATH, QUERY_CANONICAL, TS_MS, NONCE, ACCOUNT_ID, VM_ID,
//! SESSION_ID_OR_EMPTY, BODY_SHA256_HEX`.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::body::Bytes;
use axum::extract::{FromRequest, Request};
use axum::http::HeaderMap;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use crate::error::{ErrorCode, GuestAgentError};

type HmacSha256 = Hmac<Sha256>;

// ── canonical-string + signing primitives ──────────────────────────────────

/// Lower-case hex SHA-256 of a byte slice.
pub fn body_sha256_hex(body: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(body);
    hex::encode(hasher.finalize())
}

/// Canonicalise a raw query string: split into `k=v` pairs, sort by key, rejoin
/// with `&`. Empty input yields an empty string.
pub fn canonical_query(raw: &str) -> String {
    if raw.is_empty() {
        return String::new();
    }
    let mut pairs: Vec<&str> = raw.split('&').filter(|s| !s.is_empty()).collect();
    pairs.sort_by(|a, b| {
        let ka = a.split('=').next().unwrap_or(a);
        let kb = b.split('=').next().unwrap_or(b);
        ka.cmp(kb).then_with(|| a.cmp(b))
    });
    pairs.join("&")
}

/// The fields covered by the signature.
#[derive(Debug, Clone)]
pub struct CanonicalParts<'a> {
    pub method: &'a str,
    pub path: &'a str,
    pub query: &'a str,
    pub timestamp_ms: &'a str,
    pub nonce: &'a str,
    pub account_id: &'a str,
    pub vm_id: &'a str,
    pub session_id: &'a str,
    pub body_sha256_hex: &'a str,
}

/// Build the spec §5.2 canonical string.
pub fn build_canonical_string(parts: &CanonicalParts<'_>) -> String {
    format!(
        "{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}",
        parts.method.to_uppercase(),
        parts.path,
        canonical_query(parts.query),
        parts.timestamp_ms,
        parts.nonce,
        parts.account_id,
        parts.vm_id,
        parts.session_id,
        parts.body_sha256_hex,
    )
}

/// Compute the lower-case hex HMAC-SHA256 signature for a canonical string.
pub fn sign(secret: &[u8], canonical: &str) -> String {
    let mut mac = HmacSha256::new_from_slice(secret).expect("HMAC accepts any key length");
    mac.update(canonical.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

/// Timing-safe comparison of two hex signatures.
pub fn verify_signature(secret: &[u8], canonical: &str, provided_hex: &str) -> bool {
    let expected = sign(secret, canonical);
    // Compare raw bytes of the hex strings in constant time. Length mismatch is
    // an immediate (still constant within equal-length) reject.
    expected.as_bytes().ct_eq(provided_hex.as_bytes()).into()
}

// ── replay / nonce cache ────────────────────────────────────────────────────

/// Bounded nonce cache: a nonce seen within `window_seconds` is a replay.
pub struct NonceCache {
    seen: HashMap<String, u64>,
    window_seconds: u64,
}

impl NonceCache {
    pub fn new(window_seconds: u64) -> Self {
        Self {
            seen: HashMap::new(),
            window_seconds,
        }
    }

    /// Record a nonce at `now_secs`. Returns `false` if it was already seen
    /// within the window (a replay). Evicts expired entries opportunistically.
    pub fn check_and_record(&mut self, nonce: &str, now_secs: u64) -> bool {
        let cutoff = now_secs.saturating_sub(self.window_seconds);
        self.seen.retain(|_, &mut ts| ts >= cutoff);
        if let Some(&ts) = self.seen.get(nonce) {
            if ts >= cutoff {
                return false;
            }
        }
        self.seen.insert(nonce.to_string(), now_secs);
        true
    }

    pub fn len(&self) -> usize {
        self.seen.len()
    }

    pub fn is_empty(&self) -> bool {
        self.seen.is_empty()
    }
}

// ── verifier ────────────────────────────────────────────────────────────────

/// The verified principal bound to a request (set after successful HMAC check).
#[derive(Debug, Clone)]
pub struct VerifiedPrincipal {
    pub account_id: String,
    pub vm_id: String,
    pub session_id: Option<String>,
    pub key_id: Option<String>,
}

/// Holds the secret + expected binding + nonce cache. Shared via `AppState`.
pub struct HmacVerifier {
    secret: Vec<u8>,
    account_id: String,
    vm_id: String,
    max_skew_seconds: u64,
    nonce_cache: Mutex<NonceCache>,
    /// When false (test-only), verification is bypassed. Never set in prod.
    enabled: bool,
}

impl HmacVerifier {
    pub fn new(
        secret: Vec<u8>,
        account_id: impl Into<String>,
        vm_id: impl Into<String>,
        max_skew_seconds: u64,
        nonce_cache_seconds: u64,
    ) -> Self {
        Self {
            secret,
            account_id: account_id.into(),
            vm_id: vm_id.into(),
            max_skew_seconds,
            nonce_cache: Mutex::new(NonceCache::new(nonce_cache_seconds)),
            enabled: true,
        }
    }

    /// Construct a verifier with checks disabled (handler tests only).
    pub fn disabled(account_id: impl Into<String>, vm_id: impl Into<String>) -> Self {
        let mut v = Self::new(Vec::new(), account_id, vm_id, 300, 300);
        v.enabled = false;
        v
    }

    fn now_ms() -> u128 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    }

    /// Verify a request's headers + body against the canonical string.
    pub fn verify(
        &self,
        method: &str,
        path: &str,
        query: &str,
        headers: &HeaderMap,
        body: &[u8],
    ) -> Result<VerifiedPrincipal, GuestAgentError> {
        // Bypass for handler tests, but still surface the binding.
        if !self.enabled {
            return Ok(VerifiedPrincipal {
                account_id: self.account_id.clone(),
                vm_id: self.vm_id.clone(),
                session_id: header(headers, "x-pria-session-id"),
                key_id: header(headers, "x-pria-key-id"),
            });
        }

        let account_id = require(headers, "x-pria-account-id")?;
        let vm_id = require(headers, "x-pria-vm-id")?;
        let timestamp_ms = require(headers, "x-pria-timestamp-ms")?;
        let nonce = require(headers, "x-pria-nonce")?;
        let body_hash = require(headers, "x-pria-body-sha256")?;
        let signature = require(headers, "x-pria-signature")?;
        let session_id = header(headers, "x-pria-session-id");
        let key_id = header(headers, "x-pria-key-id");

        // 1. Body hash must match.
        let actual_body_hash = body_sha256_hex(body);
        if !bool::from(actual_body_hash.as_bytes().ct_eq(body_hash.as_bytes())) {
            return Err(GuestAgentError::new(
                ErrorCode::UnauthorizedHmacInvalid,
                "body hash mismatch",
            ));
        }

        // 2. Account/VM binding must match the agent's configured identity.
        if account_id != self.account_id || vm_id != self.vm_id {
            return Err(GuestAgentError::new(
                ErrorCode::ForbiddenAccountVmMismatch,
                "account/vm binding does not match this VM",
            ));
        }

        // 3. Timestamp skew.
        let ts: u128 = timestamp_ms.parse().map_err(|_| {
            GuestAgentError::new(ErrorCode::UnauthorizedHmacInvalid, "invalid timestamp")
        })?;
        let now = Self::now_ms();
        let skew_ms = (self.max_skew_seconds as u128) * 1000;
        let diff = now.abs_diff(ts);
        if diff > skew_ms {
            return Err(GuestAgentError::new(
                ErrorCode::UnauthorizedHmacInvalid,
                "timestamp outside allowed skew",
            ));
        }

        // 4. Signature.
        let canonical = build_canonical_string(&CanonicalParts {
            method,
            path,
            query,
            timestamp_ms: &timestamp_ms,
            nonce: &nonce,
            account_id: &account_id,
            vm_id: &vm_id,
            session_id: session_id.as_deref().unwrap_or(""),
            body_sha256_hex: &body_hash,
        });
        if !verify_signature(&self.secret, &canonical, &signature) {
            return Err(GuestAgentError::new(
                ErrorCode::UnauthorizedHmacInvalid,
                "signature mismatch",
            ));
        }

        // 5. Replay (checked last so a forged signature can't pollute the cache).
        let now_secs = (now / 1000) as u64;
        let mut cache = self.nonce_cache.lock().expect("nonce cache poisoned");
        if !cache.check_and_record(&nonce, now_secs) {
            return Err(GuestAgentError::new(
                ErrorCode::UnauthorizedReplayDetected,
                "nonce replay detected",
            ));
        }

        Ok(VerifiedPrincipal {
            account_id,
            vm_id,
            session_id,
            key_id,
        })
    }
}

fn header(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
}

fn require(headers: &HeaderMap, name: &str) -> Result<String, GuestAgentError> {
    header(headers, name).ok_or_else(|| {
        GuestAgentError::new(
            ErrorCode::UnauthorizedHmacMissing,
            format!("missing required header {name}"),
        )
    })
}

// ── SignedJson extractor ────────────────────────────────────────────────────

/// An axum extractor that verifies the HMAC signature (spec §5) before
/// deserialising the JSON body into `T`. Also exposes the verified principal.
pub struct SignedJson<T> {
    pub value: T,
    pub principal: VerifiedPrincipal,
}

impl<S, T> FromRequest<S> for SignedJson<T>
where
    S: Send + Sync,
    crate::api::AppState: axum::extract::FromRef<S>,
    T: serde::de::DeserializeOwned,
{
    type Rejection = GuestAgentError;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        use axum::extract::FromRef;
        let app_state = crate::api::AppState::from_ref(state);

        let method = req.method().as_str().to_string();
        let path = req.uri().path().to_string();
        let query = req.uri().query().unwrap_or("").to_string();
        let headers = req.headers().clone();

        let body = Bytes::from_request(req, state)
            .await
            .map_err(|_| GuestAgentError::invalid_request("failed to read request body"))?;

        let principal = app_state
            .hmac
            .verify(&method, &path, &query, &headers, &body)?;

        let value: T = serde_json::from_slice(&body)
            .map_err(|e| GuestAgentError::invalid_request(format!("invalid json body: {e}")))?;

        Ok(SignedJson { value, principal })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_query_sorts_pairs() {
        assert_eq!(canonical_query(""), "");
        assert_eq!(canonical_query("b=2&a=1"), "a=1&b=2");
        assert_eq!(canonical_query("z=1&z=0"), "z=0&z=1");
    }

    #[test]
    fn body_hash_of_empty_is_known() {
        assert_eq!(
            body_sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn sign_then_verify_roundtrips() {
        let secret = b"s3cr3t";
        let canonical = "POST\n/x\n\n1\nn\nacct\nvm\n\nhash";
        let sig = sign(secret, canonical);
        assert!(verify_signature(secret, canonical, &sig));
        assert!(!verify_signature(secret, canonical, "deadbeef"));
        assert!(!verify_signature(b"other", canonical, &sig));
    }

    #[test]
    fn nonce_cache_detects_replay_and_evicts() {
        let mut c = NonceCache::new(300);
        assert!(c.check_and_record("n1", 1000));
        assert!(!c.check_and_record("n1", 1000)); // replay
        assert!(c.check_and_record("n2", 1000));
        // After the window passes, the old nonce is evicted and accepted again.
        assert!(c.check_and_record("n1", 2000));
        assert_eq!(c.len(), 1);
    }
}
