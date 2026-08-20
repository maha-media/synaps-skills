//! Integration tests that drive the compiled `memory-manager` binary over its
//! real JSON-RPC stdio wire protocol (LSP-style Content-Length framing).
//!
//! T32–T36 battery: exact capability-schema matching against the manifest's
//! passive declarations, first-turn "no memory body" guarantee, no-network /
//! no-model-download default, memory tool round-trips, cross-project
//! fail-closed, secret sentinels, legacy `.r8` migration, kill-9
//! crash/reopen durability, and result bounds.
//!
//! Tests use a temp-dir brain so they never touch the real
//! `~/.config/axel/axel.r8`, and a temp XDG_CACHE_HOME so they can assert no
//! model download happens.

use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Command, Stdio};

use serde_json::{json, Value};
use tempfile::TempDir;

// ── wire helpers ──────────────────────────────────────────────────────────────

/// Encode a JSON value as a Content-Length-framed LSP message (matches
/// `write_frame` in src/main.rs).
fn frame(value: &Value) -> Vec<u8> {
    let body = serde_json::to_vec(value).expect("serialize frame");
    let mut out = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
    out.extend_from_slice(&body);
    out
}

/// Consume one Content-Length-framed JSON-RPC message.
fn read_frame(reader: &mut impl BufRead) -> Value {
    let mut content_length: Option<usize> = None;
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).expect("read header line");
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break;
        }
        if let Some((name, val)) = trimmed.split_once(':') {
            if name.trim().eq_ignore_ascii_case("content-length") {
                content_length = val.trim().parse().ok();
            }
        }
    }
    let len = content_length.expect("missing Content-Length header");
    let mut body = vec![0u8; len];
    std::io::Read::read_exact(reader, &mut body).expect("read body");
    serde_json::from_slice(&body).expect("parse JSON response")
}

/// Read frames until we see a JSON-RPC *response* (`result`/`error`, no
/// `method`). Plugin-originated requests (config.subscribe) are skipped.
fn read_response(reader: &mut impl BufRead) -> Value {
    loop {
        let frame = read_frame(reader);
        if frame.get("method").is_some() {
            continue;
        }
        return frame;
    }
}

fn bin_path() -> String {
    env!("CARGO_BIN_EXE_memory-manager").to_string()
}

// ── harness ───────────────────────────────────────────────────────────────────

struct Ext {
    stdin: std::process::ChildStdin,
    reader: BufReader<std::process::ChildStdout>,
    child: std::process::Child,
    next_id: u64,
}

impl Ext {
    /// Spawn with an isolated brain, cache dir, and (optionally) a trusted
    /// project root. Does NOT send initialize.
    fn spawn(brain: &Path, cache: &Path, project_root: Option<&Path>) -> Self {
        let mut cmd = Command::new(bin_path());
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .env("AXEL_BRAIN", brain)
            .env("XDG_CACHE_HOME", cache)
            // Isolate from any real user settings file.
            .env("AXEL_SETTINGS_PATH", brain.with_extension("settings"));
        cmd.env_remove("SYNAPS_PROJECT_ROOT");
        match project_root {
            Some(p) => {
                cmd.env("AXEL_PROJECT_ROOT", p);
            }
            None => {
                cmd.env_remove("AXEL_PROJECT_ROOT");
            }
        }
        let mut child = cmd.spawn().expect("spawn memory-manager binary");
        let stdin = child.stdin.take().expect("stdin");
        let stdout = child.stdout.take().expect("stdout");
        Ext {
            stdin,
            reader: BufReader::new(stdout),
            child,
            next_id: 0,
        }
    }

    fn send_request(&mut self, method: &str, params: Value) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        self.stdin
            .write_all(&frame(&json!({
                "jsonrpc": "2.0", "id": id, "method": method, "params": params
            })))
            .expect("write frame");
        self.stdin.flush().expect("flush");
        id
    }

    fn request(&mut self, method: &str, params: Value) -> Value {
        let _id = self.send_request(method, params);
        read_response(&mut self.reader)
    }

    fn initialize(&mut self) -> Value {
        let resp = self.request("initialize", json!({}));
        assert_eq!(resp["result"]["name"], "memory-manager", "bad initialize: {resp}");
        resp
    }

    fn tool(&mut self, name: &str, input: Value) -> Value {
        self.request("tool.call", json!({ "name": name, "input": input }))
    }

    fn kill(mut self) {
        self.child.kill().expect("kill extension");
        let _ = self.child.wait();
    }

    fn shutdown(mut self) {
        let _ = self.request("shutdown", json!({}));
        let _ = self.child.wait();
    }
}

fn long_content(tag: &str) -> String {
    format!(
        "{tag}: this memory body is deliberately padded so it satisfies the \
         fifty character axel content validation minimum with room to spare."
    )
}

fn capture_params(capture_id: &str, project_key: &str, content: &str, session: &str) -> Value {
    json!({
        "capture_id": capture_id,
        "project_key": project_key,
        "content": content,
        "source_session_id": session,
        "source_turn_id": "turn-c5"
    })
}

fn recall_params(project_key: &str, session: &str, query: &str) -> Value {
    json!({
        "schema": "recall/1",
        "lease_id": format!("lease-{session}"),
        "project_id": project_key,
        "session_id": session,
        "turn_id": format!("turn-{session}"),
        "query": query,
        "recent_context_digest": "00".repeat(32),
        "budget": { "max_records": 8, "max_rendered_tokens": 4096 },
        "permitted_classes": ["model_visible"]
    })
}

fn project_key(project: &Path) -> String {
    use sha2::Digest;
    let canonical = std::fs::canonicalize(project).unwrap();
    let digest = sha2::Sha256::digest(canonical.to_string_lossy().as_bytes());
    format!("proj_{}", hex::encode(&digest[..8]))
}

fn capture_count(brain: &Path, project_key: &str) -> Option<i64> {
    if !brain.exists() {
        return None;
    }
    let uri = format!("file:{}?mode=ro", brain.display());
    let conn = rusqlite::Connection::open_with_flags(
        uri,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    )
    .ok()?;
    conn.query_row(
        "SELECT COUNT(*) FROM memories WHERE project_key=?1 AND provenance='synaps:chat_capture'",
        [project_key],
        |row| row.get(0),
    )
    .ok()
}

// ── capture wire contract ─────────────────────────────────────────────────────

#[test]
fn duplicate_capture_id_stores_exactly_one_record_over_framed_rpc() {
    let tmp = TempDir::new().unwrap();
    let cache = TempDir::new().unwrap();
    let brain = tmp.path().join("capture.r8");
    let mut ext = Ext::spawn(&brain, cache.path(), None);
    let params = capture_params(
        "capture-stable-1",
        "proj_wire",
        &long_content("CAPTURE-WIRE-SENTINEL"),
        "session-1",
    );
    let absent = ext.request(
        "context_provider.capture",
        json!({"operation": "query", "capture_id": "capture-stable-1"}),
    );
    assert_eq!(absent["result"]["committed"], false, "{absent}");
    let first = ext.request("context_provider.capture", params.clone());
    let committed = ext.request(
        "context_provider.capture",
        json!({"operation": "query", "capture_id": "capture-stable-1"}),
    );
    let second = ext.request("context_provider.capture", params);
    assert_eq!(first["result"]["duplicate"], false, "{first}");
    assert_eq!(committed["result"]["committed"], true, "{committed}");
    assert_eq!(second["result"]["duplicate"], true, "{second}");
    ext.shutdown();

    assert_eq!(capture_count(&brain, "proj_wire"), Some(1));
}

#[test]
fn kill_after_commit_reopen_recovers_capture_without_duplicate() {
    let tmp = TempDir::new().unwrap();
    let cache = TempDir::new().unwrap();
    let brain = tmp.path().join("kill-after-commit.r8");
    let params = capture_params(
        "capture-kill-commit-c5",
        "proj_kill",
        &long_content("KILL-AFTER-COMMIT-C5"),
        "session-before-kill",
    );

    let mut first = Ext::spawn(&brain, cache.path(), None);
    let _request_id = first.send_request("context_provider.capture", params.clone());
    let committed_deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while capture_count(&brain, "proj_kill") != Some(1)
        && std::time::Instant::now() < committed_deadline
    {
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    assert_eq!(
        capture_count(&brain, "proj_kill"),
        Some(1),
        "harness must observe the durable commit before kill, without consuming the reply"
    );
    first.kill();

    let mut reopened = Ext::spawn(&brain, cache.path(), None);
    let replay = reopened.request("context_provider.capture", params);
    assert_eq!(replay["result"]["duplicate"], true, "{replay}");
    reopened.shutdown();
    assert_eq!(capture_count(&brain, "proj_kill"), Some(1));
}

#[test]
fn cross_session_recall_finds_capture_after_kill_and_reopen() {
    let tmp = TempDir::new().unwrap();
    let cache = TempDir::new().unwrap();
    let project = TempDir::new().unwrap();
    let key = project_key(project.path());
    let brain = tmp.path().join("cross-session.r8");
    let needle = "C5-CROSS-SESSION-ZEBRAFISH";

    let mut first = Ext::spawn(&brain, cache.path(), Some(project.path()));
    let _request_id = first.send_request(
        "context_provider.capture",
        capture_params(
            "capture-cross-session-c5",
            &key,
            &long_content(needle),
            "old-session",
        ),
    );
    let committed_deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while capture_count(&brain, &key) != Some(1) && std::time::Instant::now() < committed_deadline {
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    assert_eq!(
        capture_count(&brain, &key),
        Some(1),
        "capture must commit before kill"
    );
    first.kill();

    let mut reopened = Ext::spawn(&brain, cache.path(), Some(project.path()));
    let recalled = reopened.request(
        "context_provider.recall",
        recall_params(&key, "new-session", needle),
    );
    let result = recalled
        .get("result")
        .unwrap_or_else(|| panic!("recall must succeed after reopen: {recalled}"));
    assert!(
        result["records"]
            .as_array()
            .is_some_and(|records| !records.is_empty()),
        "new session must recall the prior capture: {recalled}"
    );
    assert!(
        result.to_string().contains(needle),
        "recalled contribution must contain the stored capture needle: {recalled}"
    );
    reopened.shutdown();
}

#[test]
fn one_gib_synthetic_capture_is_rejected_at_fixed_frame_bound_and_process_exits() {
    const SYNTHETIC_CAPTURE_BYTES: u64 = 1 << 30;
    let tmp = TempDir::new().unwrap();
    let cache = TempDir::new().unwrap();
    let brain = tmp.path().join("one-gib.r8");
    let mut ext = Ext::spawn(&brain, cache.path(), None);

    // Advertise the synthetic 1 GiB capture at the framing boundary. The
    // plugin must reject before allocating or reading that body, close its
    // consumer, and leave the producer free to observe the closed pipe.
    ext.stdin
        .write_all(format!("Content-Length: {SYNTHETIC_CAPTURE_BYTES}\r\n\r\n").as_bytes())
        .unwrap();
    ext.stdin.flush().unwrap();
    drop(ext.stdin);
    let status = ext.child.wait().unwrap();
    assert!(
        status.success(),
        "oversized capture must close cleanly: {status}"
    );
    assert!(
        !brain.exists() || std::fs::metadata(&brain).unwrap().len() < 16 * 1024 * 1024,
        "synthetic 1 GiB capture must not be retained on disk"
    );
}

#[test]
fn malformed_capture_fails_closed_without_echoing_content() {
    let tmp = TempDir::new().unwrap();
    let cache = TempDir::new().unwrap();
    let mut ext = Ext::spawn(&tmp.path().join("bad.r8"), cache.path(), None);
    let sentinel = "PRIVATE-TURN-CONTENT-MUST-NOT-LEAK";
    let response = ext.request(
        "context_provider.capture",
        json!({"capture_id":"bad", "content": sentinel}),
    );
    assert!(response.get("error").is_some(), "{response}");
    assert!(!response.to_string().contains(sentinel), "{response}");

    // Malformed JSON is discarded; a subsequent valid framed request proves
    // the process failed closed without dispatching the malformed capture.
    let bad = b"Content-Length: 1\r\n\r\n{";
    ext.stdin.write_all(bad).unwrap();
    ext.stdin.flush().unwrap();
    let alive = ext.request("initialize", json!({}));
    assert_eq!(alive["result"]["name"], "memory-manager");
    ext.shutdown();
}

#[test]
fn oversized_frame_fails_closed_before_body_allocation() {
    let tmp = TempDir::new().unwrap();
    let cache = TempDir::new().unwrap();
    let mut ext = Ext::spawn(&tmp.path().join("large.r8"), cache.path(), None);
    ext.stdin
        .write_all(b"Content-Length: 999999999\r\n\r\n")
        .unwrap();
    ext.stdin.flush().unwrap();
    drop(ext.stdin);
    let status = ext.child.wait().unwrap();
    assert!(status.success(), "oversized frame must close cleanly: {status}");
}

// ── initialize contract ───────────────────────────────────────────────────────

/// The initialize response's capabilities.tools must match the manifest's
/// passive extension.tools declarations byte-for-byte (JSON-structurally),
/// and the first response must carry no stored memory content.
#[test]
fn initialize_capabilities_match_manifest_and_carry_no_memory_bodies() {
    let tmp = TempDir::new().unwrap();
    let cache = TempDir::new().unwrap();
    let project = TempDir::new().unwrap();

    // Seed a brain that already contains a memory with a sentinel body.
    let sentinel = "FIRST-TURN-SENTINEL-0f9e8d";
    {
        let mut ext = Ext::spawn(&tmp.path().join("b.r8"), cache.path(), Some(project.path()));
        let init = ext.initialize();
        let key = store_and_get_key(&mut ext, &long_content(sentinel));
        assert!(key.starts_with("proj_"));
        drop(init);
        ext.shutdown();
    }

    // Fresh process over the same brain: initialize must NOT contain the body.
    let mut ext = Ext::spawn(&tmp.path().join("b.r8"), cache.path(), Some(project.path()));
    let init = ext.initialize();
    let raw = serde_json::to_string(&init).unwrap();
    assert!(
        !raw.contains(sentinel),
        "initialize response must not carry stored memory bodies"
    );

    // Exact schema match with the manifest passive declarations (native
    // extension.deferred.tools since 0.2).
    let manifest_path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../.synaps-plugin/plugin.json");
    let manifest: Value =
        serde_json::from_str(&std::fs::read_to_string(manifest_path).unwrap()).unwrap();
    assert_eq!(
        manifest.pointer("/extension/deferred/tools").expect("manifest extension.deferred.tools"),
        init.pointer("/result/capabilities/tools").expect("live capabilities.tools"),
        "manifest passive tool declarations must equal live initialize schemas"
    );
    // Tool-only hardened manifest (T32): tools.register requested, native
    // deferred block present, NO legacy activation alias, NO hooks, NO
    // hook permissions — and the live runtime registers zero hooks.
    let perms = manifest.pointer("/extension/permissions").unwrap().as_array().unwrap();
    assert!(perms.iter().any(|p| p == "tools.register"));
    for hook_perm in ["tools.intercept", "privacy.llm_content", "session.lifecycle"] {
        assert!(
            !perms.iter().any(|p| p == hook_perm),
            "tool-only manifest must not request hook permission {hook_perm}"
        );
    }
    assert!(manifest.pointer("/extension/activation").is_none());
    assert!(manifest.pointer("/extension/hooks").is_none());
    assert_eq!(
        init.pointer("/result/capabilities/hooks").expect("hooks capability"),
        &json!([]),
        "live initialize must register zero hooks"
    );
    // Host-context project_root config declaration present.
    assert_eq!(
        manifest.pointer("/extension/config/0/key").unwrap(),
        "project_root"
    );
    assert_eq!(
        manifest.pointer("/extension/config/0/host_context").unwrap(),
        "project_root"
    );
    ext.shutdown();
}

/// The host injects its trusted project root at initialize via
/// `params.config` (reserved host_context source). With NO project env
/// vars at all, the applied config must produce the trusted scope every
/// memory tool uses.
#[test]
fn initialize_config_project_root_establishes_trusted_scope() {
    let tmp = TempDir::new().unwrap();
    let cache = TempDir::new().unwrap();
    let project = TempDir::new().unwrap();
    // No AXEL_PROJECT_ROOT / SYNAPS_PROJECT_ROOT: env plays no part.
    let mut ext = Ext::spawn(&tmp.path().join("b.r8"), cache.path(), None);
    let resp = ext.request(
        "initialize",
        json!({ "config": { "project_root": project.path().display().to_string() } }),
    );
    assert_eq!(resp["result"]["name"], "memory-manager", "{resp}");

    // Store + search work against the host-provided scope.
    let key = store_and_get_key(&mut ext, &long_content("host context scope"));
    let expected = {
        use sha2::Digest;
        let canonical = std::fs::canonicalize(project.path()).unwrap();
        let digest = sha2::Sha256::digest(canonical.to_string_lossy().as_bytes());
        format!("proj_{}", hex::encode(&digest[..8]))
    };
    assert_eq!(key, expected, "scope key must derive from the host-injected root");
    let resp = ext.tool("memory_search", json!({ "query": "scope", "project": key }));
    assert_eq!(resp["result"]["count"], 1, "{resp}");
    ext.shutdown();

    // Without host config AND without env, tools fail closed.
    let mut ext = Ext::spawn(&tmp.path().join("c.r8"), cache.path(), None);
    ext.initialize();
    let err = ext.tool("memory_store", json!({ "content": long_content("unscoped") }));
    assert!(err["error"]["message"].as_str().unwrap().contains("project"), "{err}");
    ext.shutdown();
}

/// Default configuration must not download or even initialise any model:
/// after initialize + store + search, the temp cache dir has no model dirs.
#[test]
fn no_network_no_model_download_by_default() {
    let tmp = TempDir::new().unwrap();
    let cache = TempDir::new().unwrap();
    let project = TempDir::new().unwrap();
    let mut ext = Ext::spawn(&tmp.path().join("b.r8"), cache.path(), Some(project.path()));
    let t0 = std::time::Instant::now();
    ext.initialize();
    assert!(
        t0.elapsed() < std::time::Duration::from_secs(30),
        "initialize must not block on model download (finished in {:?})",
        t0.elapsed()
    );
    let _ = store_and_get_key(&mut ext, &long_content("offline"));
    let resp = ext.tool("memory_search", json!({ "query": "offline" }));
    assert_eq!(resp["result"]["count"], 1, "{resp}");
    ext.shutdown();

    for forbidden in ["velocirag", "axel"] {
        let dir = cache.path().join(forbidden);
        assert!(
            !dir.exists(),
            "default run must not create model/cache dir {dir:?}"
        );
    }
}

// ── tool round-trips ──────────────────────────────────────────────────────────

/// Store requires explicit project confirmation; the error tells the caller
/// the canonical key (derived from the trusted root, never from the model).
fn store_and_get_key(ext: &mut Ext, content: &str) -> String {
    // First store without confirmation → error carrying the canonical key.
    let err = ext.tool("memory_store", json!({ "content": content }));
    let msg = err["error"]["message"].as_str().expect("confirmation error");
    let key = msg
        .split("proj_")
        .nth(1)
        .map(|s| format!("proj_{}", &s[..16]))
        .expect("error must contain the canonical project key");
    let resp = ext.tool("memory_store", json!({ "content": content, "project": key }));
    assert_eq!(resp["result"]["stored"], true, "{resp}");
    key
}

#[test]
fn store_search_fetch_forget_roundtrip() {
    let tmp = TempDir::new().unwrap();
    let cache = TempDir::new().unwrap();
    let project = TempDir::new().unwrap();
    let mut ext = Ext::spawn(&tmp.path().join("b.r8"), cache.path(), Some(project.path()));
    ext.initialize();

    let key = store_and_get_key(&mut ext, &long_content("roundtrip alpha needle"));

    // Search: banner + bounded descriptor with stable id.
    let resp = ext.tool("memory_search", json!({ "query": "needle", "project": key }));
    let result = &resp["result"];
    assert!(result["banner"].as_str().unwrap().to_lowercase().contains("lower-authority"));
    assert_eq!(result["count"], 1);
    let id = result["results"][0]["id"].as_str().unwrap().to_string();
    assert!(id.starts_with("mem_"));
    assert_eq!(result["results"][0]["provenance"], "synaps:memory_store");

    // Fetch by exact id.
    let resp = ext.tool("memory_fetch", json!({ "id": id }));
    assert_eq!(resp["result"]["found"], true);
    assert!(resp["result"]["body"].as_str().unwrap().contains("roundtrip alpha needle"));
    assert_eq!(resp["result"]["signature_verified"], true);

    // Forget: tombstone + excluded from subsequent search/fetch.
    let resp = ext.tool("memory_forget", json!({ "id": id }));
    assert_eq!(resp["result"]["forgotten"], true);
    let resp = ext.tool("memory_search", json!({ "query": "needle" }));
    assert_eq!(resp["result"]["count"], 0, "forgotten memory must not re-surface");
    let resp = ext.tool("memory_fetch", json!({ "id": id }));
    assert_eq!(resp["result"]["found"], false);
    ext.shutdown();
}

/// Without any trusted project source, every tool fails closed with an
/// explicit host-surfaced error.
#[test]
fn tools_fail_closed_without_trusted_project_scope() {
    let tmp = TempDir::new().unwrap();
    let cache = TempDir::new().unwrap();
    let mut ext = Ext::spawn(&tmp.path().join("b.r8"), cache.path(), None);
    ext.initialize();
    for (tool, input) in [
        ("memory_search", json!({ "query": "x" })),
        ("memory_fetch", json!({ "id": "mem_x" })),
        ("memory_store", json!({ "content": long_content("x"), "project": "proj_x" })),
        ("memory_forget", json!({ "id": "mem_x" })),
    ] {
        let resp = ext.tool(tool, input);
        let msg = resp["error"]["message"].as_str().unwrap_or_default();
        assert!(
            msg.contains("no trusted project scope"),
            "{tool} must fail closed; got {resp}"
        );
    }
    ext.shutdown();
}

/// Memories stored under project A are invisible to a session scoped to
/// project B, over the same .r8 file. Model-supplied keys can't cross over.
#[test]
fn cross_project_isolation_is_fail_closed() {
    let tmp = TempDir::new().unwrap();
    let cache = TempDir::new().unwrap();
    let brain = tmp.path().join("b.r8");
    let proj_a = TempDir::new().unwrap();
    let proj_b = TempDir::new().unwrap();

    let (key_a, id_a) = {
        let mut ext = Ext::spawn(&brain, cache.path(), Some(proj_a.path()));
        ext.initialize();
        let key = store_and_get_key(&mut ext, &long_content("alpha isolation"));
        let resp = ext.tool("memory_search", json!({ "query": "isolation" }));
        let id = resp["result"]["results"][0]["id"].as_str().unwrap().to_string();
        ext.shutdown();
        (key, id)
    };

    let mut ext = Ext::spawn(&brain, cache.path(), Some(proj_b.path()));
    ext.initialize();
    // Search in B finds nothing.
    let resp = ext.tool("memory_search", json!({ "query": "isolation" }));
    assert_eq!(resp["result"]["count"], 0, "project B must not see project A rows");
    // Fetch of A's id from B scope: not found.
    let resp = ext.tool("memory_fetch", json!({ "id": id_a }));
    assert_eq!(resp["result"]["found"], false);
    // Supplying A's key from B's session is a hard error (model can't widen).
    let resp = ext.tool("memory_search", json!({ "query": "isolation", "project": key_a }));
    assert!(
        resp["error"]["message"].as_str().unwrap().contains("project mismatch"),
        "{resp}"
    );
    // Forget of A's id from B: refused (fail closed).
    let resp = ext.tool("memory_forget", json!({ "id": id_a }));
    assert_eq!(resp["result"]["forgotten"], false);
    ext.shutdown();
}

/// Secret bodies never leak through search or fetch (sentinel check on the
/// raw wire JSON), and never_persist bodies never reach the .r8 file.
#[test]
fn secret_and_never_persist_sentinels_never_leak() {
    let tmp = TempDir::new().unwrap();
    let cache = TempDir::new().unwrap();
    let project = TempDir::new().unwrap();
    let brain = tmp.path().join("b.r8");
    let mut ext = Ext::spawn(&brain, cache.path(), Some(project.path()));
    ext.initialize();

    let key = store_and_get_key(&mut ext, &long_content("prime the key"));

    // Secret memory.
    let secret_sentinel = "WIRE-SECRET-SENTINEL-4b5a69";
    let resp = ext.tool(
        "memory_store",
        json!({
            "content": long_content(secret_sentinel),
            "title": "Secret credential note",
            "sensitivity": "secret",
            "project": key,
        }),
    );
    assert_eq!(resp["result"]["stored"], true, "{resp}");

    // never_persist is refused outright.
    let np_sentinel = "WIRE-NEVERPERSIST-SENTINEL-77aa";
    let resp = ext.tool(
        "memory_store",
        json!({
            "content": long_content(np_sentinel),
            "retention": "never_persist",
            "project": key,
        }),
    );
    assert!(resp["error"]["message"].as_str().unwrap().contains("never_persist"), "{resp}");

    // Search + fetch: secret body must not appear anywhere on the wire.
    let search = ext.tool("memory_search", json!({ "query": "Secret credential" }));
    let raw = serde_json::to_string(&search).unwrap();
    assert!(!raw.contains(secret_sentinel), "secret body leaked via search: {raw}");
    let id = search["result"]["results"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["title"].as_str().unwrap().contains("Secret"))
        .and_then(|r| r["id"].as_str())
        .expect("secret descriptor listed")
        .to_string();
    let fetch = ext.tool("memory_fetch", json!({ "id": id }));
    let raw = serde_json::to_string(&fetch).unwrap();
    assert!(!raw.contains(secret_sentinel), "secret body leaked via fetch: {raw}");
    assert!(fetch["result"]["body"].is_null());
    assert!(fetch["result"]["body_withheld_reason"].as_str().unwrap().contains("secret"));
    ext.shutdown();

    // File-level: the never_persist sentinel must not be in the .r8 bytes.
    let bytes = std::fs::read(&brain).unwrap();
    assert!(
        !bytes.windows(np_sentinel.len()).any(|w| w == np_sentinel.as_bytes()),
        "never_persist body reached the .r8 file"
    );
}

/// Result counts respect the requested limit and the hard cap.
#[test]
fn search_results_are_bounded_by_limit_and_cap() {
    let tmp = TempDir::new().unwrap();
    let cache = TempDir::new().unwrap();
    let project = TempDir::new().unwrap();
    let mut ext = Ext::spawn(&tmp.path().join("b.r8"), cache.path(), Some(project.path()));
    ext.initialize();
    let key = store_and_get_key(&mut ext, &long_content("bounded corpus entry 0"));
    for i in 1..30 {
        let resp = ext.tool(
            "memory_store",
            json!({ "content": long_content(&format!("bounded corpus entry {i}")), "project": key }),
        );
        assert_eq!(resp["result"]["stored"], true, "{resp}");
    }
    let resp = ext.tool("memory_search", json!({ "query": "bounded corpus", "limit": 5 }));
    assert_eq!(resp["result"]["count"], 5);
    // Oversized limit clamps to the hard cap (25).
    let resp = ext.tool("memory_search", json!({ "query": "bounded corpus", "limit": 10000 }));
    assert!(resp["result"]["count"].as_u64().unwrap() <= 25);
    ext.shutdown();
}

/// Hooks are quiet by default (T36): before_message and on_session_start
/// must return `continue` with no injected content out of the box.
#[test]
fn boot_and_recall_injection_are_off_by_default() {
    let tmp = TempDir::new().unwrap();
    let cache = TempDir::new().unwrap();
    let project = TempDir::new().unwrap();
    let mut ext = Ext::spawn(&tmp.path().join("b.r8"), cache.path(), Some(project.path()));
    ext.initialize();
    let _ = store_and_get_key(&mut ext, &long_content("hook silence needle"));

    for kind in ["on_session_start", "before_message"] {
        let resp = ext.request(
            "hook.handle",
            json!({ "kind": kind, "message": "tell me about the hook silence needle", "data": null }),
        );
        assert_eq!(
            resp["result"]["action"], "continue",
            "{kind} must not inject by default: {resp}"
        );
        assert!(resp["result"].get("content").is_none());
    }
    ext.shutdown();
}

/// With auto_recall=on, before_message injects a bounded, project-scoped,
/// lower-authority block (offline lexical — no model needed).
#[test]
fn opt_in_recall_injects_bounded_lower_authority_block() {
    let tmp = TempDir::new().unwrap();
    let cache = TempDir::new().unwrap();
    let project = TempDir::new().unwrap();
    let brain = tmp.path().join("b.r8");
    let settings_path = brain.with_extension("settings");
    std::fs::write(&settings_path, "auto_recall = on\n").unwrap();

    let mut ext = Ext::spawn(&brain, cache.path(), Some(project.path()));
    ext.initialize();
    let _ = store_and_get_key(&mut ext, &long_content("optin recall needle"));

    let resp = ext.request(
        "hook.handle",
        json!({ "kind": "before_message", "message": "what do we know about the optin recall needle?", "data": null }),
    );
    assert_eq!(resp["result"]["action"], "inject", "{resp}");
    let content = resp["result"]["content"].as_str().unwrap();
    assert!(content.contains("lower authority"), "{content}");
    assert!(content.contains("proj_"), "recall block must state the project scope");
    ext.shutdown();
}

// ── durability ────────────────────────────────────────────────────────────────

/// kill -9 right after a store: the memory must survive reopen (crash-safe
/// transactional append).
#[test]
fn kill_nine_after_store_survives_reopen() {
    let tmp = TempDir::new().unwrap();
    let cache = TempDir::new().unwrap();
    let project = TempDir::new().unwrap();
    let brain = tmp.path().join("b.r8");

    let mut ext = Ext::spawn(&brain, cache.path(), Some(project.path()));
    ext.initialize();
    let _ = store_and_get_key(&mut ext, &long_content("crash durability needle"));
    // Hard kill — no shutdown, no flush.
    ext.child.kill().expect("kill -9");
    let _ = ext.child.wait();

    let mut ext = Ext::spawn(&brain, cache.path(), Some(project.path()));
    ext.initialize();
    let resp = ext.tool("memory_search", json!({ "query": "durability needle" }));
    assert_eq!(resp["result"]["count"], 1, "stored memory lost after kill -9: {resp}");
    ext.shutdown();
}

/// A legacy .r8 (created without the project-memory schema) opens, migrates,
/// and its legacy rows never leak into the trusted project scope.
#[test]
fn legacy_r8_migrates_and_stays_out_of_scope() {
    let tmp = TempDir::new().unwrap();
    let cache = TempDir::new().unwrap();
    let project = TempDir::new().unwrap();
    let brain = tmp.path().join("legacy.r8");

    // Build a legacy-shaped brain directly with SQLite (pre-migration column
    // set, as created by older axel releases).
    {
        let conn = rusqlite::Connection::open(&brain).unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE brain_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE memories (
                id TEXT PRIMARY KEY, category TEXT NOT NULL, topic TEXT NOT NULL,
                title TEXT NOT NULL, abstract_text TEXT, content TEXT NOT NULL,
                confidence TEXT DEFAULT 'medium', importance REAL DEFAULT 0.5,
                source_sessions TEXT DEFAULT '[]', tags TEXT DEFAULT '[]',
                related_topics TEXT DEFAULT '[]', created TEXT NOT NULL,
                updated TEXT, trust_level REAL DEFAULT 1.0, signature TEXT
            );
            CREATE TABLE staged_memories (
                id TEXT PRIMARY KEY, category TEXT NOT NULL, topic TEXT NOT NULL,
                title TEXT NOT NULL, abstract_text TEXT, content TEXT NOT NULL,
                confidence TEXT DEFAULT 'medium', importance REAL DEFAULT 0.5,
                source_sessions TEXT DEFAULT '[]', tags TEXT DEFAULT '[]',
                related_topics TEXT DEFAULT '[]', created TEXT NOT NULL,
                updated TEXT, trust_level REAL DEFAULT 1.0, signature TEXT,
                review_status TEXT DEFAULT 'pending', reviewer_notes TEXT,
                staged_at TEXT NOT NULL
            );
            CREATE TABLE memory_access (
                id INTEGER PRIMARY KEY AUTOINCREMENT, memory_id TEXT NOT NULL,
                access_type TEXT NOT NULL, timestamp TEXT NOT NULL
            );
            CREATE TABLE events (
                id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL,
                target_id TEXT, query TEXT, metadata TEXT, timestamp TEXT NOT NULL
            );
            CREATE TABLE context_data (
                key TEXT NOT NULL, layer TEXT NOT NULL, value TEXT NOT NULL,
                updated TEXT NOT NULL, PRIMARY KEY (key, layer)
            );
            CREATE TABLE sessions (
                session_id TEXT PRIMARY KEY, processed_at TEXT NOT NULL,
                memory_count INTEGER DEFAULT 0
            );
            CREATE TABLE patterns (
                id TEXT PRIMARY KEY, pattern_type TEXT NOT NULL,
                description TEXT, confidence REAL DEFAULT 0.5,
                occurrences INTEGER DEFAULT 1, first_seen TEXT, last_seen TEXT
            );
            INSERT INTO memories (id, category, topic, title, content, created)
            VALUES ('mem_legacy01', 'events', 'legacy', 'Legacy row title',
                    'legacy content body from before project scoping existed',
                    '2024-01-01T00:00:00+00:00');
            "#,
        )
        .unwrap();
        conn.execute(
            "INSERT INTO brain_meta (key, value) VALUES ('meta', ?1)",
            [format!(
                r#"{{"schema_version":1,"embedder_model":"all-MiniLM-L6-v2","embedding_dim":384,"agent_name":"legacy","created":"2024-01-01T00:00:00+00:00","last_modified":"2024-01-01T00:00:00+00:00","document_count":0,"memory_count":1,"signing_key":"{}"}}"#,
                "00".repeat(32)
            )],
        )
        .unwrap();
    }

    let mut ext = Ext::spawn(&brain, cache.path(), Some(project.path()));
    ext.initialize();
    // Legacy row is invisible in the project scope.
    let resp = ext.tool("memory_search", json!({ "query": "legacy" }));
    assert_eq!(resp["result"]["count"], 0, "legacy rows must not enter project scope: {resp}");
    let resp = ext.tool("memory_fetch", json!({ "id": "mem_legacy01" }));
    assert_eq!(resp["result"]["found"], false);
    // And new scoped writes work on the migrated file.
    let _ = store_and_get_key(&mut ext, &long_content("post migration write"));
    let resp = ext.tool("memory_search", json!({ "query": "migration" }));
    assert_eq!(resp["result"]["count"], 1);
    ext.shutdown();
}

// ── task B3: context-provider declaration + recall over the real wire ────────

/// The live initialize response's `capabilities.context_providers` must
/// literally equal the manifest's passive
/// `extension.deferred.context_providers` declarations (task A3 host-side
/// exact-match validation), and the manifest must request the
/// `context_providers.register` permission that gates them.
#[test]
fn initialize_context_providers_literally_match_manifest_declarations() {
    let tmp = TempDir::new().unwrap();
    let cache = TempDir::new().unwrap();
    let project = TempDir::new().unwrap();

    let mut ext = Ext::spawn(&tmp.path().join("b.r8"), cache.path(), Some(project.path()));
    let init = ext.initialize();

    let manifest_path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../.synaps-plugin/plugin.json");
    let manifest: Value =
        serde_json::from_str(&std::fs::read_to_string(manifest_path).unwrap()).unwrap();
    assert_eq!(
        manifest
            .pointer("/extension/deferred/context_providers")
            .expect("manifest extension.deferred.context_providers"),
        init.pointer("/result/capabilities/context_providers")
            .expect("live capabilities.context_providers"),
        "manifest passive context-provider declarations must equal the live initialize \
         capabilities exactly"
    );
    let perms = manifest.pointer("/extension/permissions").unwrap().as_array().unwrap();
    assert!(perms.iter().any(|p| p == "context_providers.register"));
    ext.shutdown();
}

/// `context_provider.recall` over the real stdio wire: a well-formed
/// request returns a bounded contribution; a malformed one fails closed
/// with a static error that never echoes the raw input.
#[test]
fn context_provider_recall_round_trip_and_fail_closed_over_the_wire() {
    let tmp = TempDir::new().unwrap();
    let cache = TempDir::new().unwrap();
    let project = TempDir::new().unwrap();

    let mut ext = Ext::spawn(&tmp.path().join("b.r8"), cache.path(), Some(project.path()));
    ext.initialize();
    let key = store_and_get_key(&mut ext, &long_content("wire recall zebrafish decision"));

    // Well-formed request.
    let resp = ext.request(
        "context_provider.recall",
        json!({
            "schema": "recall/1",
            "lease_id": "memctx-lease-wire",
            "project_id": key,
            "session_id": "sess-wire",
            "turn_id": "turn-1",
            "query": "zebrafish",
            "recent_context_digest": "ab".repeat(32),
            "budget": { "max_records": 8, "max_rendered_tokens": 4096 },
            "permitted_classes": ["model_visible"]
        }),
    );
    let result = resp.get("result").unwrap_or_else(|| panic!("recall must succeed: {resp}"));
    assert_eq!(result["schema"], "contribution/1");
    assert_eq!(result["project_id"], key);
    let records = result["records"].as_array().expect("records array");
    assert!(!records.is_empty(), "stored record must be recallable: {resp}");
    assert!(records.len() <= 8);
    for r in records {
        assert!(!r["rank_reason"].as_array().unwrap().is_empty());
        assert_eq!(r["sensitivity"], "model_visible");
    }
    assert!(result["rendered"].as_str().unwrap().len() <= 4096 * 4);

    // Malformed request: static fail-closed error, no echo.
    let marker = "WIRE-INJECT-77aa-NEVER-ECHO";
    let resp = ext.request("context_provider.recall", json!({ "surprise": marker }));
    let err = resp.pointer("/error/message").and_then(Value::as_str).expect("error reply");
    assert_eq!(err, "context_provider.recall: malformed params (fail closed)");
    assert!(!serde_json::to_string(&resp).unwrap().contains(marker));

    // Wrong project: static mismatch error with no existence leakage.
    let resp = ext.request(
        "context_provider.recall",
        json!({
            "schema": "recall/1",
            "lease_id": "memctx-lease-wire",
            "project_id": "proj_ffffffffffffffff",
            "session_id": "sess-wire",
            "turn_id": "turn-2",
            "query": "zebrafish",
            "recent_context_digest": "ab".repeat(32),
            "budget": { "max_records": 8, "max_rendered_tokens": 4096 },
            "permitted_classes": ["model_visible"]
        }),
    );
    let err = resp.pointer("/error/message").and_then(Value::as_str).expect("error reply");
    assert_eq!(err, "context_provider.recall: project scope mismatch (fail closed)");
    assert!(!err.contains("proj_ffffffffffffffff"));
    ext.shutdown();
}
