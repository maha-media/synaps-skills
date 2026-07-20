//! Idempotent, bounded chat-turn capture into Axel.
//! Errors are intentionally metadata-only: payload text is never formatted.

use std::sync::{Arc, Mutex};

use anyhow::{anyhow, Result};
use axel::project_memory::{MemoryScope, Retention, Sensitivity};
use axel::AxelBrain;
use axel_memkoshi::memory::{Memory, MemoryCategory};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub const MAX_CAPTURE_BYTES: usize = 256 * 1024;
const MAX_CAPTURE_ID_BYTES: usize = 128;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Capture {
    capture_id: String,
    project_key: String,
    content: String,
    #[serde(default)]
    source_session_id: Option<String>,
    #[serde(default)]
    source_turn_id: Option<String>,
}

fn stable_memory_id(capture_id: &str) -> String {
    let digest = Sha256::digest(capture_id.as_bytes());
    format!("mem_{}", hex::encode(&digest[..8]))
}

pub fn handle_capture(brain: &Arc<Mutex<Option<AxelBrain>>>, params: &Value) -> Result<Value> {
    let encoded_len = serde_json::to_vec(params)
        .map_err(|_| anyhow!("invalid capture metadata"))?
        .len();
    if encoded_len > MAX_CAPTURE_BYTES {
        return Err(anyhow!("capture exceeds size limit"));
    }
    let capture: Capture = serde_json::from_value(params.clone())
        .map_err(|_| anyhow!("invalid capture request"))?;
    if capture.capture_id.is_empty()
        || capture.capture_id.len() > MAX_CAPTURE_ID_BYTES
        || capture.project_key.trim().is_empty()
        || capture.content.trim().is_empty()
    {
        return Err(anyhow!("invalid capture metadata"));
    }

    let id = stable_memory_id(&capture.capture_id);
    let mut guard = brain.lock().map_err(|_| anyhow!("capture store unavailable"))?;
    let brain = guard.as_mut().ok_or_else(|| anyhow!("capture store unavailable"))?;
    if brain
        .fetch_scoped(&id, &capture.project_key)
        .map_err(|_| anyhow!("capture lookup failed"))?
        .is_some()
    {
        return Ok(json!({"ok": true, "duplicate": true, "capture_id": capture.capture_id}));
    }

    let mut memory = Memory::new(
        MemoryCategory::Events,
        "episodic_turn",
        "Captured chat turn",
        capture.content,
    );
    memory.id = id.clone();
    memory.source_sessions = capture.source_session_id.into_iter().collect();
    memory.tags = capture
        .source_turn_id
        .map(|v| vec![format!("turn:{v}")])
        .unwrap_or_default();
    memory.trust_level = 0.0;
    let scope = MemoryScope {
        project_key: capture.project_key,
        sensitivity: Sensitivity::Normal,
        retention: Retention::Standard,
        provenance: "synaps:chat_capture".into(),
    };
    match brain.store_scoped(memory, &scope) {
        Ok(_) => {
            brain.flush().map_err(|_| anyhow!("capture flush failed"))?;
            Ok(json!({"ok": true, "duplicate": false, "capture_id": capture.capture_id}))
        }
        Err(_) if brain.fetch_scoped(&id, &scope.project_key).ok().flatten().is_some() => {
            Ok(json!({"ok": true, "duplicate": true, "capture_id": capture.capture_id}))
        }
        Err(_) => Err(anyhow!("capture store failed")),
    }
}
