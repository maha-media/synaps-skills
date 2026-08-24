//! Boot-time Synaps model-inventory probe (W9 / SD D-3 guest side).
//!
//! The guest agent launches Synaps as a per-session child; the SAME binary
//! already knows its full per-provider model catalog (`get_available_models`
//! RPC → each provider's static catalog). This module probes that catalog ONCE
//! at boot and regroups it into the heartbeat `models:[{provider, models:[…]}]`
//! shape Pria's W9 projection consumes.
//!
//! NEVER forks the catalog: the inventory is read live from the Synaps binary
//! the guest actually runs, so a Synaps upgrade automatically surfaces its new
//! models (the static-seed `gpt-5.5`-only trap is structurally impossible).
//!
//! FAIL-OPEN by design (mirrors `Versions::detect`): any failure — missing
//! binary, RPC error, timeout, malformed frame — yields an EMPTY inventory, so
//! a probe failure never blocks the heartbeat (Pria then honestly falls back to
//! its curated list).

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use serde::Serialize;

/// One provider's model inventory, as reported by Synaps. `provider` is the
/// Synaps `provider_key` (already Pria's cred slug, e.g. `xai-auth` /
/// `openai-codex`); `models` is the provider's model-id slugs.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ProviderModels {
    pub provider: String,
    pub models: Vec<String>,
}

/// Slug law shared with Pria's `heartbeatUpdateFields` W9 projection: model
/// ids are provider slugs — no spaces, no path chars, bounded length. A slug
/// that fails this never becomes a route id on the Pria side, so it is dropped
/// here at the source rather than relayed and discarded downstream.
fn is_valid_model_slug(s: &str) -> bool {
    if s.is_empty() || s.len() > 100 {
        return false;
    }
    let mut chars = s.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphanumeric() => {}
        _ => return false,
    }
    s.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
}

/// Regroup Synaps's flat `[{provider, model_id, …}]` response into the
/// per-provider `{ provider, models:[slug] }` heartbeat shape: valid slugs
/// only, deduped, sorted, providers sorted. Pure + unit-testable.
fn regroup(flat: &[serde_json::Value]) -> Vec<ProviderModels> {
    let mut by_provider: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for entry in flat {
        let provider = entry.get("provider").and_then(|p| p.as_str()).unwrap_or("");
        let model_id = entry.get("model_id").and_then(|m| m.as_str()).unwrap_or("");
        // Provider slug law (mirrors Pria's projection): lowercase dns-ish.
        let provider_ok = !provider.is_empty()
            && provider.len() <= 64
            && provider
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
            && provider
                .chars()
                .next()
                .map(|c| c.is_ascii_alphanumeric())
                .unwrap_or(false);
        if !provider_ok || !is_valid_model_slug(model_id) {
            continue;
        }
        let models = by_provider.entry(provider.to_string()).or_default();
        if !models.iter().any(|m| m == model_id) {
            models.push(model_id.to_string());
        }
    }
    by_provider
        .into_iter()
        .map(|(provider, mut models)| {
            models.sort();
            ProviderModels { provider, models }
        })
        .collect()
}

/// The RPC frames we care about, parsed loosely (forward-compat: unknown frame
/// types are ignored). We never strongly-type the whole protocol.
fn frame_type(v: &serde_json::Value) -> &str {
    v.get("type").and_then(|t| t.as_str()).unwrap_or("")
}

/// Run the probe against `binary`. Synchronous; the caller wraps it in a
/// thread with a timeout (see `probe_with_timeout`).
fn run_probe(binary: &Path) -> Result<Vec<ProviderModels>, String> {
    let mut child = Command::new(binary)
        .arg("rpc")
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("spawn failed: {e}"))?;

    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let mut reader = BufReader::new(stdout);

    // Issue `get_available_models` with a fixed correlation id.
    let cmd = serde_json::json!({ "type": "get_available_models", "id": "boot-models-1" });
    writeln!(stdin, "{}", cmd).map_err(|e| format!("stdin write failed: {e}"))?;
    stdin
        .flush()
        .map_err(|e| format!("stdin flush failed: {e}"))?;

    // Read frames until the matching response arrives (ready + any interleaved
    // frames are skipped; the catalog response is matched on command + id).
    let mut line = String::new();
    let result = loop {
        line.clear();
        let n = reader
            .read_line(&mut line)
            .map_err(|e| format!("stdout read failed: {e}"))?;
        if n == 0 {
            break Err("stdout closed before response".to_string());
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(frame) = serde_json::from_str::<serde_json::Value>(trimmed) else {
            continue; // not JSON — skip
        };
        match frame_type(&frame) {
            "response" => {
                let is_models = frame.get("command").and_then(|c| c.as_str())
                    == Some("get_available_models")
                    && frame.get("id").and_then(|i| i.as_str()) == Some("boot-models-1");
                if is_models {
                    let flat = frame
                        .get("models")
                        .and_then(|m| m.as_array())
                        .cloned()
                        .unwrap_or_default();
                    break Ok(regroup(&flat));
                }
                // a response to something else — keep reading
            }
            "error" => break Err(format!("rpc error frame: {trimmed}")),
            _ => {} // ready / events / anything else — keep reading
        }
    };

    // Best-effort teardown; the result is already decided.
    let _ = child.kill();
    let _ = child.wait();
    result
}

/// Probe the Synaps binary's model inventory, bounded by `timeout`. NEVER
/// panics; any failure → empty vec.
pub fn probe_with_timeout(binary: &Path, timeout: Duration) -> Vec<ProviderModels> {
    let binary = binary.to_path_buf();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(run_probe(&binary));
    });
    match rx.recv_timeout(timeout) {
        Ok(Ok(models)) => models,
        Ok(Err(err)) => {
            tracing::debug!(error = %err, "synaps model probe failed (empty inventory)");
            Vec::new()
        }
        Err(_) => {
            tracing::debug!("synaps model probe timed out (empty inventory)");
            Vec::new()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn regroup_groups_valid_slugs_per_provider_sorted_deduped() {
        let flat = serde_json::json!([
            { "provider": "xai-auth", "model_id": "grok-4.4", "model_name": "Grok 4.4" },
            { "provider": "openai-codex", "model_id": "gpt-5.5", "model_name": "GPT-5.5" },
            { "provider": "xai-auth", "model_id": "grok-4.3", "model_name": "Grok 4.3" },
            { "provider": "xai-auth", "model_id": "grok-4.4", "model_name": "dup" },
        ]);
        let flat = flat.as_array().unwrap();
        let out = regroup(flat);
        assert_eq!(
            out,
            vec![
                ProviderModels {
                    provider: "openai-codex".into(),
                    models: vec!["gpt-5.5".into()]
                },
                ProviderModels {
                    provider: "xai-auth".into(),
                    models: vec!["grok-4.3".into(), "grok-4.4".into()]
                },
            ]
        );
    }

    #[test]
    fn regroup_drops_invalid_slugs_and_providers() {
        let flat = serde_json::json!([
            { "provider": "xai-auth", "model_id": "../../etc/passwd" },
            { "provider": "xai-auth", "model_id": "grok 4.4" },
            { "provider": "xai-auth", "model_id": "" },
            { "provider": "BAD PROVIDER", "model_id": "grok-4.4" },
            { "provider": "xai-auth", "model_id": "grok-4.4" },
        ]);
        let out = regroup(flat.as_array().unwrap());
        assert_eq!(
            out,
            vec![ProviderModels {
                provider: "xai-auth".into(),
                models: vec!["grok-4.4".into()]
            }]
        );
    }

    #[test]
    fn probe_with_timeout_on_missing_binary_is_empty_not_panic() {
        let out = probe_with_timeout(Path::new("/nonexistent/synaps"), Duration::from_millis(500));
        assert!(out.is_empty());
    }
}
