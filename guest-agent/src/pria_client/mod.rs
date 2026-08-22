//! Pria callback client (spec §7).
//!
//! Signs every callback (GA-B2 signer) and POSTs to
//! `/internal/agentic-vm/{heartbeat,audit,session-event,credential-request}`.
//! When Pria is unreachable, audit events are spooled to
//! `paths.audit_spool_dir` (spec §9.4) so nothing is lost and the hot path
//! never crashes.

pub mod payloads;
pub mod signer;

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value;

pub use payloads::{
    kinds, AuditEventBuilder, CredentialRequestPayload, FleetCallbackPayload, HeartbeatPayload,
    HeartbeatVnc, SessionEventPayload, UsageEvent, UsagePayload, VncSessionEntry,
};
pub use signer::OutboundSigner;

use crate::config::Config;

/// Callback failure (non-fatal — callers spool/log and continue).
#[derive(Debug)]
pub enum CallbackError {
    Network(String),
    Status(u16),
}

impl std::fmt::Display for CallbackError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CallbackError::Network(e) => write!(f, "network error: {e}"),
            CallbackError::Status(s) => write!(f, "non-2xx status: {s}"),
        }
    }
}

impl std::error::Error for CallbackError {}

/// The Pria callback surface. Abstracted so handler tests can inject a fake
/// (spec §13.2).
#[async_trait]
pub trait PriaCallbackClient: Send + Sync {
    async fn heartbeat(&self, p: &HeartbeatPayload) -> Result<(), CallbackError>;
    /// Forward a batch of audit events; spools on failure (never errors out of
    /// the hot path for the HTTP impl).
    async fn audit(&self, events: Vec<Value>) -> Result<(), CallbackError>;
    async fn session_event(&self, p: &SessionEventPayload) -> Result<(), CallbackError>;
    /// Report a fleet task lifecycle event (W3.7-G, guest half of F6). Signed +
    /// POSTed to `/internal/agentic-vm/fleet-callback`, mirroring
    /// `session_event`; `kind` is `ack` / `heartbeat` / `result`.
    async fn fleet_callback(
        &self,
        session_id: &str,
        handle_id: &str,
        generation: u64,
        kind: &str,
        payload: Value,
    ) -> Result<(), CallbackError>;
    /// Forward a batch of raw-usage events (spec §6.2). Signed + POSTed to
    /// `/internal/agentic-vm/usage`; spools on failure (never crashes the hot
    /// path for the HTTP impl). This is the RPC-boundary fallback/cross-check
    /// (HS-U6) and must remain even after `on_usage` ships.
    async fn usage(&self, p: &UsagePayload) -> Result<(), CallbackError>;
    async fn credential_request(
        &self,
        p: &CredentialRequestPayload,
    ) -> Result<Value, CallbackError>;
    /// Forward a synaps rpc reply frame (message_update / response / agent_end)
    /// so the user-facing SSE chat stream can surface it (seam #3). Best-effort.
    /// Default is a no-op so non-HTTP impls (test fakes) need no changes.
    async fn session_output(&self, _session_id: &str, _event: &Value) -> Result<(), CallbackError> {
        Ok(())
    }
    /// F7 (guest git legs): fetch the base bundle for a workspace-bound job.
    /// Signed GET with the signed query + EMPTY body + x-pria-session-id header.
    /// `Ok(GitFetch::Refused)` is the typed delegate answer (a 200 JSON
    /// refusal), NOT an error — the caller runs workspace-less and reports
    /// honestly. Network/5xx ride `Err`.
    async fn fleet_git_fetch(
        &self,
        handle_id: &str,
        generation: u64,
        session_id: &str,
    ) -> Result<GitFetch, CallbackError>;
    /// F7: push the result bundle. Signed POST with the signed query (incl.
    /// `ref`), the RAW bundle body (HMAC over the raw bytes), and the header
    /// session id. `Ok(GitPush::Refused)` is the typed delegate answer.
    async fn fleet_git_push(
        &self,
        handle_id: &str,
        generation: u64,
        ref_name: &str,
        session_id: &str,
        bundle: &[u8],
    ) -> Result<GitPush, CallbackError>;
}

/// Endpoint paths (configurable prefix defaults to `/internal/agentic-vm`).
const HEARTBEAT_PATH: &str = "/internal/agentic-vm/heartbeat";
const AUDIT_PATH: &str = "/internal/agentic-vm/audit";
const SESSION_EVENT_PATH: &str = "/internal/agentic-vm/session-event";
const FLEET_CALLBACK_PATH: &str = "/internal/agentic-vm/fleet-callback";
const FLEET_GIT_FETCH_PATH: &str = "/internal/agentic-vm/fleet-git-fetch";
const FLEET_GIT_PUSH_PATH: &str = "/internal/agentic-vm/fleet-git-push";
const USAGE_PATH: &str = "/internal/agentic-vm/usage";
const CREDENTIAL_PATH: &str = "/internal/agentic-vm/credential-request";
const SESSION_OUTPUT_PATH: &str = "/internal/agentic-vm/session-output";

/// The fleet-git-fetch answer (F7). `Bundle` carries the base-bundle bytes on
/// a 200 octet-stream; `Refused` carries the typed reason on a 200 JSON
/// `{ok:false, reason}` (the delegate shape — never an oracle, never a throw).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GitFetch {
    Bundle(Vec<u8>),
    Refused(String),
}

/// The fleet-git-push answer (F7). `Accepted` on `{accepted:true}`; `Refused`
/// carries the typed reason on `{accepted:false, reason}`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GitPush {
    Accepted,
    Refused(String),
}

/// RFC-3986 unreserved percent-encoding for a query value (the slug/ref
/// charsets are already conservative, but the `ref` value carries `/` which
/// must be encoded so the HMAC canonical query matches byte-for-byte).
fn query_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for b in value.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// The production HTTP client using reqwest + the outbound signer.
pub struct HttpPriaClient {
    base_url: String,
    signer: OutboundSigner,
    http: reqwest::Client,
    audit_spool_dir: PathBuf,
}

impl HttpPriaClient {
    pub fn new(config: &Config, secret: Vec<u8>) -> Self {
        let signer = OutboundSigner::new(
            secret,
            config.pria.hmac_key_id.clone(),
            config.account_id.to_string(),
            config.vm_id.to_string(),
        );
        Self {
            base_url: config.pria.base_url.trim_end_matches('/').to_string(),
            signer,
            http: reqwest::Client::new(),
            audit_spool_dir: config.paths.audit_spool_dir.clone(),
        }
    }

    async fn post_signed(
        &self,
        path: &str,
        body: &[u8],
        session_id: Option<&str>,
    ) -> Result<Value, CallbackError> {
        let signed = self.signer.sign_post(path, body, session_id);
        let mut req = self
            .http
            .post(format!("{}{}", self.base_url, path))
            .header("content-type", "application/json")
            .body(body.to_vec());
        for (k, v) in &signed.headers {
            req = req.header(*k, v);
        }
        let resp = req
            .send()
            .await
            .map_err(|e| CallbackError::Network(e.to_string()))?;
        let status = resp.status();
        if !status.is_success() {
            return Err(CallbackError::Status(status.as_u16()));
        }
        let value = resp.json::<Value>().await.unwrap_or(Value::Null);
        Ok(value)
    }

    /// Append events to the durable spool (one JSON object per line).
    fn spool(&self, events: &[Value]) {
        use std::io::Write;
        if std::fs::create_dir_all(&self.audit_spool_dir).is_err() {
            return;
        }
        let path = self.audit_spool_dir.join("guest-agent-audit.jsonl");
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        {
            for ev in events {
                if let Ok(line) = serde_json::to_string(ev) {
                    let _ = writeln!(f, "{line}");
                }
            }
        }
    }

    /// Append a usage envelope to a dedicated durable spool (one JSON object per
    /// line). Separate file from audit so a later drain can re-POST to the usage
    /// endpoint specifically.
    fn spool_usage(&self, payload: &UsagePayload) {
        use std::io::Write;
        if std::fs::create_dir_all(&self.audit_spool_dir).is_err() {
            return;
        }
        let path = self.audit_spool_dir.join("guest-agent-usage.jsonl");
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        {
            if let Ok(line) = serde_json::to_string(payload) {
                let _ = writeln!(f, "{line}");
            }
        }
    }
}

#[async_trait]
impl PriaCallbackClient for HttpPriaClient {
    async fn heartbeat(&self, p: &HeartbeatPayload) -> Result<(), CallbackError> {
        let body = serde_json::to_vec(p).map_err(|e| CallbackError::Network(e.to_string()))?;
        self.post_signed(HEARTBEAT_PATH, &body, None).await?;
        Ok(())
    }

    async fn audit(&self, events: Vec<Value>) -> Result<(), CallbackError> {
        if events.is_empty() {
            return Ok(());
        }
        let envelope = serde_json::json!({ "source": "guest-agent", "events": events });
        let body = match serde_json::to_vec(&envelope) {
            Ok(b) => b,
            Err(e) => return Err(CallbackError::Network(e.to_string())),
        };
        match self.post_signed(AUDIT_PATH, &body, None).await {
            Ok(_) => Ok(()),
            Err(e) => {
                // Spool and swallow — audit must never crash the hot path (§9.4).
                tracing::warn!(error = %e, "audit POST failed; spooling");
                self.spool(&events);
                Ok(())
            }
        }
    }

    async fn session_event(&self, p: &SessionEventPayload) -> Result<(), CallbackError> {
        let body = serde_json::to_vec(p).map_err(|e| CallbackError::Network(e.to_string()))?;
        self.post_signed(SESSION_EVENT_PATH, &body, Some(&p.session_id))
            .await?;
        Ok(())
    }

    async fn session_output(&self, session_id: &str, event: &Value) -> Result<(), CallbackError> {
        let body =
            serde_json::to_vec(&serde_json::json!({ "session_id": session_id, "event": event }))
                .map_err(|e| CallbackError::Network(e.to_string()))?;
        self.post_signed(SESSION_OUTPUT_PATH, &body, Some(session_id))
            .await?;
        Ok(())
    }

    async fn fleet_callback(
        &self,
        session_id: &str,
        handle_id: &str,
        generation: u64,
        kind: &str,
        payload: Value,
    ) -> Result<(), CallbackError> {
        let p = FleetCallbackPayload {
            handle_id: handle_id.to_string(),
            generation,
            kind: kind.to_string(),
            payload,
        };
        let body = serde_json::to_vec(&p).map_err(|e| CallbackError::Network(e.to_string()))?;
        self.post_signed(FLEET_CALLBACK_PATH, &body, Some(session_id))
            .await?;
        Ok(())
    }

    async fn fleet_git_fetch(
        &self,
        handle_id: &str,
        generation: u64,
        session_id: &str,
    ) -> Result<GitFetch, CallbackError> {
        // Signed GET: the query rides the HMAC canonical string; the body is
        // EMPTY (there is nothing to POST). x-pria-session-id is the header.
        let query = format!("handle_id={}&generation={}", query_encode(handle_id), generation);
        let signed = self
            .signer
            .sign_request("GET", FLEET_GIT_FETCH_PATH, &query, b"", Some(session_id));
        let mut req = self
            .http
            .get(format!("{}{}?{}", self.base_url, FLEET_GIT_FETCH_PATH, query));
        for (k, v) in &signed.headers {
            req = req.header(*k, v);
        }
        let resp = req
            .send()
            .await
            .map_err(|e| CallbackError::Network(e.to_string()))?;
        let status = resp.status();
        if !status.is_success() {
            // W5 staging finding: a 401/403 here was undebuggable because the
            // reason code rides the response BODY (`{error:{code}}`) and the
            // guest discarded it. Capture it (bounded) so a refused fetch is
            // self-diagnosing. Never log a 2xx body — that can be a bundle.
            let body = resp.text().await.unwrap_or_default();
            let body = body.chars().take(300).collect::<String>();
            tracing::warn!(status = status.as_u16(), body = %body, "fleet-git fetch rejected");
            return Err(CallbackError::Status(status.as_u16()));
        }
        let content_type = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| CallbackError::Network(e.to_string()))?;
        if content_type.contains("application/json") {
            // Typed refusal: {ok:false, reason} (the delegate shape).
            let v: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
            let reason = v
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_string();
            return Ok(GitFetch::Refused(reason));
        }
        Ok(GitFetch::Bundle(bytes.to_vec()))
    }

    async fn fleet_git_push(
        &self,
        handle_id: &str,
        generation: u64,
        ref_name: &str,
        session_id: &str,
        bundle: &[u8],
    ) -> Result<GitPush, CallbackError> {
        // Signed POST: the RAW bundle body rides the HMAC (the signer hashes
        // the raw bytes); the query carries handle_id/generation/ref.
        let query = format!(
            "handle_id={}&generation={}&ref={}",
            query_encode(handle_id),
            generation,
            query_encode(ref_name)
        );
        let signed =
            self.signer
                .sign_request("POST", FLEET_GIT_PUSH_PATH, &query, bundle, Some(session_id));
        let mut req = self
            .http
            .post(format!("{}{}?{}", self.base_url, FLEET_GIT_PUSH_PATH, query))
            .header("content-type", "application/octet-stream")
            .body(bundle.to_vec());
        for (k, v) in &signed.headers {
            req = req.header(*k, v);
        }
        let resp = req
            .send()
            .await
            .map_err(|e| CallbackError::Network(e.to_string()))?;
        let status = resp.status();
        if !status.is_success() {
            // Capture the rejection reason code (bounded) — see the fetch twin.
            let body = resp.text().await.unwrap_or_default();
            let body = body.chars().take(300).collect::<String>();
            tracing::warn!(status = status.as_u16(), body = %body, "fleet-git push rejected");
            return Err(CallbackError::Status(status.as_u16()));
        }
        let v: Value = resp.json::<Value>().await.unwrap_or(Value::Null);
        let accepted = v.get("accepted").and_then(Value::as_bool).unwrap_or(false);
        if accepted {
            Ok(GitPush::Accepted)
        } else {
            let reason = v
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_string();
            Ok(GitPush::Refused(reason))
        }
    }

    async fn usage(&self, p: &UsagePayload) -> Result<(), CallbackError> {
        if p.events.is_empty() {
            return Ok(());
        }
        let body = serde_json::to_vec(p).map_err(|e| CallbackError::Network(e.to_string()))?;
        match self
            .post_signed(USAGE_PATH, &body, Some(&p.session_id))
            .await
        {
            Ok(_) => Ok(()),
            Err(e) => {
                // Spool and swallow — usage must never crash the hot path. The
                // RPC fallback is a cross-check; transient failure is tolerated
                // (plan Q11: spool + retry, not a hard stop).
                tracing::warn!(error = %e, "usage POST failed; spooling");
                self.spool_usage(p);
                Ok(())
            }
        }
    }

    async fn credential_request(
        &self,
        p: &CredentialRequestPayload,
    ) -> Result<Value, CallbackError> {
        let body = serde_json::to_vec(p).map_err(|e| CallbackError::Network(e.to_string()))?;
        self.post_signed(CREDENTIAL_PATH, &body, Some(&p.session_id))
            .await
    }
}

/// Build the dynamic client used in `AppState`.
pub fn http_client(config: &Config, secret: Vec<u8>) -> Arc<dyn PriaCallbackClient> {
    Arc::new(HttpPriaClient::new(config, secret))
}

// ── test fake ───────────────────────────────────────────────────────────────

/// A recording fake used by handler/integration tests (spec §13.2).
#[cfg(any(test, feature = "test-fakes"))]
pub mod fake {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    pub struct FakePriaClient {
        pub heartbeats: Mutex<Vec<HeartbeatPayload>>,
        pub audits: Mutex<Vec<Value>>,
        pub session_events: Mutex<Vec<SessionEventPayload>>,
        pub usages: Mutex<Vec<UsagePayload>>,
        pub credential_requests: Mutex<Vec<CredentialRequestPayload>>,
        pub credential_response: Mutex<Value>,
        /// W3.7-G fence recorder (fleet callback protocol, guest half of F6).
        ///
        /// Contract: the (not-yet-existing) `PriaCallbackClient::fleet_callback
        /// (session_id, handle_id, generation, kind, payload)` trait method —
        /// mirroring `session_event` above — must push one JSON object per call:
        /// `{"session_id", "handle_id", "generation", "kind", "payload"}`.
        /// Recorded as `Value` so the fence does not pin a payload struct that
        /// does not exist yet. Until the trait method lands, nothing writes
        /// here — that emptiness IS the born-RED for the detection rows.
        pub fleet_callbacks: Mutex<Vec<Value>>,
        /// F7 git-leg recorders + programmable answers (the workspace lifecycle
        /// fences assert these — recording as Values so the fence pins the wire
        /// shape, not a struct).
        pub fleet_git_fetches: Mutex<Vec<Value>>,
        pub fleet_git_pushes: Mutex<Vec<Value>>,
        pub fleet_git_fetch_answer: Mutex<Option<GitFetch>>,
        pub fleet_git_push_answer: Mutex<Option<GitPush>>,
    }

    #[async_trait]
    impl PriaCallbackClient for FakePriaClient {
        async fn heartbeat(&self, p: &HeartbeatPayload) -> Result<(), CallbackError> {
            self.heartbeats.lock().unwrap().push(p.clone());
            Ok(())
        }
        async fn audit(&self, events: Vec<Value>) -> Result<(), CallbackError> {
            self.audits.lock().unwrap().extend(events);
            Ok(())
        }
        async fn session_event(&self, p: &SessionEventPayload) -> Result<(), CallbackError> {
            self.session_events.lock().unwrap().push(p.clone());
            Ok(())
        }
        async fn fleet_callback(
            &self,
            session_id: &str,
            handle_id: &str,
            generation: u64,
            kind: &str,
            payload: Value,
        ) -> Result<(), CallbackError> {
            self.fleet_callbacks.lock().unwrap().push(serde_json::json!({
                "session_id": session_id,
                "handle_id": handle_id,
                "generation": generation,
                "kind": kind,
                "payload": payload,
            }));
            Ok(())
        }
        async fn usage(&self, p: &UsagePayload) -> Result<(), CallbackError> {
            self.usages.lock().unwrap().push(p.clone());
            Ok(())
        }
        async fn credential_request(
            &self,
            p: &CredentialRequestPayload,
        ) -> Result<Value, CallbackError> {
            self.credential_requests.lock().unwrap().push(p.clone());
            Ok(self.credential_response.lock().unwrap().clone())
        }
        async fn fleet_git_fetch(
            &self,
            handle_id: &str,
            generation: u64,
            session_id: &str,
        ) -> Result<GitFetch, CallbackError> {
            self.fleet_git_fetches.lock().unwrap().push(serde_json::json!({
                "handle_id": handle_id,
                "generation": generation,
                "session_id": session_id,
            }));
            Ok(self
                .fleet_git_fetch_answer
                .lock()
                .unwrap()
                .clone()
                .unwrap_or(GitFetch::Refused("no_answer_programmed".into())))
        }
        async fn fleet_git_push(
            &self,
            handle_id: &str,
            generation: u64,
            ref_name: &str,
            session_id: &str,
            bundle: &[u8],
        ) -> Result<GitPush, CallbackError> {
            self.fleet_git_pushes.lock().unwrap().push(serde_json::json!({
                "handle_id": handle_id,
                "generation": generation,
                "ref": ref_name,
                "session_id": session_id,
                "bundle_bytes": bundle.len(),
            }));
            Ok(self
                .fleet_git_push_answer
                .lock()
                .unwrap()
                .clone()
                .unwrap_or(GitPush::Accepted))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;

    fn cfg() -> Config {
        Config::from_yaml(
            r#"
mode: local-virsh
account_id: acct_1
vm_id: vm_1
replica_id: r0
pria:
  base_url: http://127.0.0.1:1/
  hmac_key_id: k
  hmac_secret_file: /tmp/s
paths:
  efs_root: /efs
  run_root: /run/pria
  policy_dir: /efs/policy
  audit_spool_dir: /tmp/ga-spool-test
synaps:
  binary: /bin/true
fsmon:
  socket: /run/fsmon.sock
"#,
        )
        .unwrap()
    }

    #[tokio::test]
    async fn audit_spools_when_pria_unreachable() {
        let spool = std::env::temp_dir().join(format!("ga-spool-{}", uuid::Uuid::new_v4()));
        let mut config = cfg();
        config.paths.audit_spool_dir = spool.clone();
        let client = HttpPriaClient::new(&config, b"secret".to_vec());
        // base_url points at a closed port -> network error -> spool, no panic.
        let ev = AuditEventBuilder::new(kinds::SESSION_STARTED)
            .str_field("session_id", "sess_1")
            .build();
        client.audit(vec![ev]).await.unwrap();
        let spooled = std::fs::read_to_string(spool.join("guest-agent-audit.jsonl")).unwrap();
        assert!(spooled.contains("session.started"));
        std::fs::remove_dir_all(&spool).ok();
    }
}
