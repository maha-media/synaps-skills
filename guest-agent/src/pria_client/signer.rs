//! Outbound request signer for Pria callbacks (spec §5.1.2 / §7).
//!
//! Produces the `X-Pria-*` header set that GA-A3 (`agenticVmHmac` middleware)
//! verifies. Reuses the exact canonical string from [`crate::hmac`] so the
//! signature is byte-compatible with the verify side.

use chrono::Utc;

use crate::hmac::{body_sha256_hex, build_canonical_string, sign, CanonicalParts};

/// Holds the per-VM signing material.
pub struct OutboundSigner {
    secret: Vec<u8>,
    key_id: String,
    account_id: String,
    vm_id: String,
}

/// A signed header set ready to attach to an outbound request.
#[derive(Debug, Clone)]
pub struct SignedHeaders {
    pub headers: Vec<(&'static str, String)>,
}

impl OutboundSigner {
    pub fn new(
        secret: Vec<u8>,
        key_id: impl Into<String>,
        account_id: impl Into<String>,
        vm_id: impl Into<String>,
    ) -> Self {
        Self {
            secret,
            key_id: key_id.into(),
            account_id: account_id.into(),
            vm_id: vm_id.into(),
        }
    }

    /// Build the signed headers for a POST to `path` with `body`.
    pub fn sign_post(&self, path: &str, body: &[u8], session_id: Option<&str>) -> SignedHeaders {
        self.sign_request("POST", path, "", body, session_id)
    }

    pub fn sign_request(
        &self,
        method: &str,
        path: &str,
        query: &str,
        body: &[u8],
        session_id: Option<&str>,
    ) -> SignedHeaders {
        let timestamp_ms = Utc::now().timestamp_millis().to_string();
        let nonce = uuid::Uuid::new_v4().to_string();
        let body_hash = body_sha256_hex(body);
        let canonical = build_canonical_string(&CanonicalParts {
            method,
            path,
            query,
            timestamp_ms: &timestamp_ms,
            nonce: &nonce,
            account_id: &self.account_id,
            vm_id: &self.vm_id,
            session_id: session_id.unwrap_or(""),
            body_sha256_hex: &body_hash,
        });
        let signature = sign(&self.secret, &canonical);

        let mut headers = vec![
            ("x-pria-account-id", self.account_id.clone()),
            ("x-pria-vm-id", self.vm_id.clone()),
            ("x-pria-timestamp-ms", timestamp_ms),
            ("x-pria-nonce", nonce),
            ("x-pria-body-sha256", body_hash),
            ("x-pria-signature", signature),
            ("x-pria-key-id", self.key_id.clone()),
        ];
        if let Some(s) = session_id {
            headers.push(("x-pria-session-id", s.to_string()));
        }
        SignedHeaders { headers }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hmac::{verify_signature, HmacVerifier};
    use axum::http::HeaderMap;

    #[test]
    fn signed_headers_verify_on_the_receive_side() {
        let signer = OutboundSigner::new(b"sekret".to_vec(), "key_1", "acct_1", "vm_1");
        let body = br#"{"a":1}"#;
        let signed = signer.sign_post("/internal/agentic-vm/heartbeat", body, None);

        // Reconstruct a HeaderMap and verify via the receive-side verifier.
        let mut hm = HeaderMap::new();
        for (k, v) in &signed.headers {
            hm.insert(*k, v.parse().unwrap());
        }
        let verifier = HmacVerifier::new(b"sekret".to_vec(), "acct_1", "vm_1", 300, 300);
        let principal = verifier
            .verify("POST", "/internal/agentic-vm/heartbeat", "", &hm, body)
            .expect("must verify");
        assert_eq!(principal.account_id, "acct_1");
        assert_eq!(principal.key_id.as_deref(), Some("key_1"));
    }

    #[test]
    fn tampered_body_fails_verification() {
        let signer = OutboundSigner::new(b"k".to_vec(), "key", "acct", "vm");
        let signed = signer.sign_post("/x", b"original", None);
        let sig = signed
            .headers
            .iter()
            .find(|(k, _)| *k == "x-pria-signature")
            .map(|(_, v)| v.clone())
            .unwrap();
        // Recompute canonical with a different body — signature must not match.
        let other_hash = body_sha256_hex(b"tampered");
        let canonical = build_canonical_string(&CanonicalParts {
            method: "POST",
            path: "/x",
            query: "",
            timestamp_ms: "0",
            nonce: "n",
            account_id: "acct",
            vm_id: "vm",
            session_id: "",
            body_sha256_hex: &other_hash,
        });
        assert!(!verify_signature(b"k", &canonical, &sig));
    }
}
