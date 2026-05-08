//! Plugin-side runtime settings for axel-memory-manager.
//!
//! The host writes plugin configuration as plain `key = value` lines to
//! `$SYNAPS_BASE_DIR/plugins/<plugin-id>/config` (see
//! `SynapsCLI/src/extensions/config_store.rs::parse_config_file`). Values are
//! unquoted strings, but we tolerate quoted forms (`key = "value"`) so the
//! settings file can be hand-edited as TOML if a user prefers.
//!
//! This module owns:
//!   * the `Settings` struct (current runtime values)
//!   * a single-pass parser (`apply_toml_str`) that mirrors the host's parser
//!   * `load_or_default()` which reads the on-disk file at startup
//!   * `config_path()` which mirrors the host's `plugin_config_path` so the
//!     plugin reads from the exact same file the host writes.
//!
//! Logging convention: this module is invoked from a background watcher thread,
//! so all log output goes to **stderr** (`eprintln!`). stdout is the JSON-RPC
//! channel and must never be polluted.

use std::path::PathBuf;
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::timer::TimerCmd;

/// Allowed values for the `consolidate_interval_secs` picker / cycler.
/// Mirrors the `options` array declared in `plugin.json`.
pub const ALLOWED_INTERVALS: &[u64] = &[0, 60, 300, 900, 3600];

/// Default plugin id used when computing the on-disk config path. Must match
/// the manifest `name` field in `.synaps-plugin/plugin.json`.
pub const PLUGIN_ID: &str = "axel-memory-manager";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Settings {
    /// Minimum byte length of an `on_message_complete` payload before we
    /// persist it via `brain.remember(...)`. Must be `>= 1`.
    pub min_consolidate_len: usize,
    /// Background-timer interval in seconds (Phase 2 consumer). `0` disables.
    /// Must be one of `ALLOWED_INTERVALS`.
    pub consolidate_interval_secs: u64,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            min_consolidate_len: 40,
            consolidate_interval_secs: 0,
        }
    }
}

impl Settings {
    /// Resolve the on-disk config path the host writes to. Mirrors
    /// `SynapsCLI/src/extensions/config_store.rs::plugin_config_path` and
    /// `SynapsCLI/src/core/config.rs::base_dir` so they always agree.
    pub fn config_path() -> PathBuf {
        if let Some(p) = std::env::var_os("AXEL_SETTINGS_PATH") {
            return PathBuf::from(p);
        }
        let base = std::env::var_os("SYNAPS_BASE_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                let home = std::env::var_os("HOME")
                    .or_else(|| std::env::var_os("USERPROFILE"))
                    .map(PathBuf::from)
                    .unwrap_or_else(|| PathBuf::from("."));
                home.join(".synaps-cli")
            });
        base.join("plugins").join(PLUGIN_ID).join("config")
    }

    /// Read the on-disk config (if any) and apply it on top of defaults.
    /// Missing file => defaults. Parse errors are logged to stderr and
    /// individual fields are skipped; never panics.
    pub fn load_or_default() -> Self {
        let mut s = Settings::default();
        let path = Self::config_path();
        match std::fs::read_to_string(&path) {
            Ok(content) => {
                s.apply_toml_str(&content);
                eprintln!(
                    "axel: settings loaded from {} \
                     (min_consolidate_len={} consolidate_interval_secs={})",
                    path.display(),
                    s.min_consolidate_len,
                    s.consolidate_interval_secs
                );
            }
            Err(_) => {
                eprintln!(
                    "axel: no settings file at {} — using defaults \
                     (min_consolidate_len={} consolidate_interval_secs={})",
                    path.display(),
                    s.min_consolidate_len,
                    s.consolidate_interval_secs
                );
            }
        }
        s
    }

    /// Parse a `key = value` block (one pair per line) and apply each
    /// recognised key. Invalid values keep the previous value and log a warning;
    /// unknown keys are silently ignored (mirrors host tolerance).
    pub fn apply_toml_str(&mut self, content: &str) {
        for raw in content.lines() {
            let line = raw.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let Some((k, v)) = line.split_once('=') else {
                continue;
            };
            let key = k.trim();
            let value = strip_quotes(v.trim());
            self.apply_kv(key, value);
        }
    }

    /// Apply one `(key, value)` pair. Public so the dispatch loop can also
    /// route a hypothetical `config.update` JSON-RPC notification through it
    /// (currently unused — the host stub does not emit such notifications).
    pub fn apply_kv(&mut self, key: &str, value: &str) {
        match key {
            "min_consolidate_len" => match value.parse::<usize>() {
                Ok(n) if n >= 1 => self.min_consolidate_len = n,
                Ok(n) => eprintln!(
                    "axel: WARN min_consolidate_len={n} rejected (must be >= 1); keeping {}",
                    self.min_consolidate_len
                ),
                Err(e) => eprintln!(
                    "axel: WARN min_consolidate_len={value:?} not a usize ({e}); keeping {}",
                    self.min_consolidate_len
                ),
            },
            "consolidate_interval_secs" => match value.parse::<u64>() {
                Ok(n) if ALLOWED_INTERVALS.contains(&n) => self.consolidate_interval_secs = n,
                Ok(n) => eprintln!(
                    "axel: WARN consolidate_interval_secs={n} not in {:?}; keeping {}",
                    ALLOWED_INTERVALS, self.consolidate_interval_secs
                ),
                Err(e) => eprintln!(
                    "axel: WARN consolidate_interval_secs={value:?} not a u64 ({e}); keeping {}",
                    self.consolidate_interval_secs
                ),
            },
            other => {
                // Unknown keys are tolerated (forward-compat with future
                // settings written by a newer host). Log at debug verbosity.
                eprintln!("axel: ignoring unknown setting key {other:?}");
            }
        }
    }
}

/// Strip a single matching pair of surrounding ASCII double-quotes so that
/// hand-written TOML (`key = "value"`) parses identically to the host's
/// unquoted form (`key = value`).
fn strip_quotes(s: &str) -> &str {
    let bytes = s.as_bytes();
    if bytes.len() >= 2 && bytes[0] == b'"' && bytes[bytes.len() - 1] == b'"' {
        &s[1..s.len() - 1]
    } else {
        s
    }
}

/// Debounce window for file-watch events. The host write path uses a tmp →
/// rename pattern that often produces two events in quick succession; this
/// window collapses them so we re-parse the file at most once per burst.
const WATCH_DEBOUNCE: Duration = Duration::from_millis(150);

/// Spawn a background thread that watches the on-disk config file for changes
/// and applies them onto `shared`. Returns the `JoinHandle` and the watcher
/// (which must be kept alive — dropping it stops the watch).
///
/// All log output goes to **stderr**; stdout is the JSON-RPC channel.
///
/// On error (notify backend init failure, etc.) returns `None` and logs to
/// stderr — the plugin continues to run with whatever settings were loaded
/// at startup.
pub fn spawn_watcher(
    shared: Arc<Mutex<Settings>>,
    timer_tx: Option<Sender<TimerCmd>>,
) -> Option<(JoinHandle<()>, notify::RecommendedWatcher)> {
    use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};

    let path = Settings::config_path();
    // Watch the parent directory: the file may not exist yet at startup, and
    // the host's atomic-rename write replaces the inode so a direct file
    // watch would miss subsequent updates.
    let parent = path.parent().map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."));
    if let Err(e) = std::fs::create_dir_all(&parent) {
        eprintln!(
            "axel: WARN cannot create settings dir {}: {e} — live reload disabled",
            parent.display()
        );
        return None;
    }

    let (tx, rx) = std::sync::mpsc::channel::<notify::Result<notify::Event>>();
    let mut watcher: RecommendedWatcher = match notify::recommended_watcher(move |res| {
        let _ = tx.send(res);
    }) {
        Ok(w) => w,
        Err(e) => {
            eprintln!("axel: WARN notify init failed: {e} — live reload disabled");
            return None;
        }
    };
    if let Err(e) = watcher.watch(&parent, RecursiveMode::NonRecursive) {
        eprintln!(
            "axel: WARN watch({}) failed: {e} — live reload disabled",
            parent.display()
        );
        return None;
    }
    eprintln!("axel: watching {} for live setting updates", path.display());

    let watch_path = path.clone();
    let handle = std::thread::Builder::new()
        .name("axel-settings-watcher".into())
        .spawn(move || {
            let mut last_apply: Option<Instant> = None;
            while let Ok(res) = rx.recv() {
                let event = match res {
                    Ok(ev) => ev,
                    Err(e) => {
                        eprintln!("axel: WARN watcher event error: {e}");
                        continue;
                    }
                };
                // Only react to events that touch our config file.
                let touches_us = event.paths.iter().any(|p| {
                    // Compare canonicalised file names; the parent watch may
                    // emit events for sibling files we don't care about.
                    p == &watch_path
                        || p.file_name() == watch_path.file_name()
                            && p.parent() == watch_path.parent()
                });
                if !touches_us {
                    continue;
                }
                match event.kind {
                    EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_) => {}
                    _ => continue,
                }
                // Debounce.
                let now = Instant::now();
                if let Some(prev) = last_apply {
                    if now.duration_since(prev) < WATCH_DEBOUNCE {
                        std::thread::sleep(WATCH_DEBOUNCE);
                    }
                }
                last_apply = Some(Instant::now());

                let mut new_settings = Settings::default();
                if let Ok(content) = std::fs::read_to_string(&watch_path) {
                    new_settings.apply_toml_str(&content);
                }
                let mut g = shared.lock().expect("settings lock poisoned");
                if *g != new_settings {
                    *g = new_settings.clone();
                    eprintln!(
                        "axel: INFO settings reloaded: min_consolidate_len={} \
                         consolidate_interval_secs={}",
                        new_settings.min_consolidate_len,
                        new_settings.consolidate_interval_secs,
                    );
                    drop(g);
                    // Re-arm the background consolidation timer so an
                    // interval change takes effect on the next tick rather
                    // than after the previous interval finishes elapsing.
                    if let Some(tx) = timer_tx.as_ref() {
                        if let Err(e) = tx.send(TimerCmd::Rearm(new_settings.consolidate_interval_secs)) {
                            eprintln!("axel: WARN timer rearm send failed: {e}");
                        }
                    }
                }
            }
        })
        .ok()?;

    Some((handle, watcher))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_values() {
        let s = Settings::default();
        assert_eq!(s.min_consolidate_len, 40);
        assert_eq!(s.consolidate_interval_secs, 0);
    }

    #[test]
    fn apply_toml_str_updates_min_consolidate_len_quoted() {
        let mut s = Settings::default();
        s.apply_toml_str("min_consolidate_len = \"10\"\n");
        assert_eq!(s.min_consolidate_len, 10);
    }

    #[test]
    fn apply_toml_str_updates_min_consolidate_len_unquoted() {
        // Matches host's actual on-disk format (no quotes).
        let mut s = Settings::default();
        s.apply_toml_str("min_consolidate_len = 10\n");
        assert_eq!(s.min_consolidate_len, 10);
    }

    #[test]
    fn apply_toml_str_rejects_zero_min_consolidate_len() {
        let mut s = Settings::default();
        s.apply_toml_str("min_consolidate_len = \"0\"\n");
        assert_eq!(s.min_consolidate_len, 40, "must keep previous value");
    }

    #[test]
    fn apply_toml_str_rejects_non_numeric_min_consolidate_len() {
        let mut s = Settings::default();
        s.apply_toml_str("min_consolidate_len = \"abc\"\n");
        assert_eq!(s.min_consolidate_len, 40, "must keep previous value");
    }

    #[test]
    fn apply_toml_str_rejects_out_of_set_interval() {
        let mut s = Settings::default();
        s.apply_toml_str("consolidate_interval_secs = \"123\"\n");
        assert_eq!(s.consolidate_interval_secs, 0, "must keep previous value");
    }

    #[test]
    fn apply_toml_str_accepts_allowed_interval() {
        let mut s = Settings::default();
        s.apply_toml_str("consolidate_interval_secs = \"300\"\n");
        assert_eq!(s.consolidate_interval_secs, 300);
    }

    #[test]
    fn apply_toml_str_ignores_unknown_keys() {
        let mut s = Settings::default();
        s.apply_toml_str("future_knob = \"hi\"\nmin_consolidate_len = \"7\"\n");
        assert_eq!(s.min_consolidate_len, 7);
    }

    #[test]
    fn apply_toml_str_ignores_blank_and_comment_lines() {
        let mut s = Settings::default();
        s.apply_toml_str("# leading comment\n\nmin_consolidate_len = 5\n# trailing\n");
        assert_eq!(s.min_consolidate_len, 5);
    }
}
