//! Persisted display/port allocator (spec §5.2, §17.3).
//!
//! Each desktop session requires a unique X11 display number (`:1`, `:2`, …) and
//! a corresponding KasmVNC WebSocket port (`6901`, `6902`, …). The allocations
//! are persisted to `{run_root}/kasmvnc/allocations.json` so they survive guest-
//! agent restarts, preventing port/display collisions.
//!
//! ## Design
//!
//! * Allocations are stored as a JSON map: `{ "linux_username": { "display": 1,
//!   "port": 6901 } }`.
//! * Allocating for a username that already has an allocation is idempotent (same
//!   slot returned).
//! * The allocator scans used display/port numbers and picks the smallest free
//!   slot starting at `BASE_DISPLAY` / `BASE_PORT`.
//! * The slot file is written atomically (write tmp + rename) to prevent
//!   corruption on crash.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// First display number (`:1`). Display `:0` is reserved for the physical
/// console; we start at 1 (spec §5.2 example: user A → `:1`).
pub const BASE_DISPLAY: u32 = 1;

/// First WebSocket port (spec §5.2: user A → `6901`).
pub const BASE_PORT: u16 = 6901;

/// Upper bound on concurrent desktop sessions (resource guard).
pub const MAX_SESSIONS: u32 = 99;

/// A single per-user display allocation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Allocation {
    /// X11 display number (1 = `:1`).
    pub display: u32,
    /// KasmVNC WebSocket port.
    pub port: u16,
}

impl Allocation {
    /// X11 display string, e.g. `":1"`.
    pub fn display_str(&self) -> String {
        format!(":{}", self.display)
    }
}

/// Persisted allocation map.
#[derive(Debug, Default, Serialize, Deserialize)]
struct AllocationFile {
    /// `linux_username → Allocation`
    allocations: HashMap<String, Allocation>,
}

/// Errors from the allocator.
#[derive(Debug)]
pub enum AllocError {
    /// No free display/port slot within `[BASE_DISPLAY, BASE_DISPLAY + MAX_SESSIONS)`.
    Exhausted,
    /// I/O error reading/writing the allocation file.
    Io(String),
}

impl std::fmt::Display for AllocError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AllocError::Exhausted => {
                write!(f, "no free desktop display/port slots (max {MAX_SESSIONS})")
            }
            AllocError::Io(e) => write!(f, "allocation file I/O error: {e}"),
        }
    }
}

impl std::error::Error for AllocError {}

/// Reads the persisted allocation file, returning a default empty map if the
/// file does not yet exist.
fn load(path: &Path) -> Result<AllocationFile, AllocError> {
    match std::fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str(&raw).map_err(|e| AllocError::Io(e.to_string())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(AllocationFile::default()),
        Err(e) => Err(AllocError::Io(e.to_string())),
    }
}

/// Writes the allocation file atomically (write to `<path>.tmp` then rename).
fn save(path: &Path, file: &AllocationFile) -> Result<(), AllocError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| AllocError::Io(e.to_string()))?;
    }
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_vec_pretty(file).map_err(|e| AllocError::Io(e.to_string()))?;
    std::fs::write(&tmp, &json).map_err(|e| AllocError::Io(e.to_string()))?;
    std::fs::rename(&tmp, path).map_err(|e| AllocError::Io(e.to_string()))?;
    Ok(())
}

/// Path of the allocation file within `run_root`.
pub fn allocation_file_path(run_root: &Path) -> PathBuf {
    run_root.join("kasmvnc").join("allocations.json")
}

/// Allocate (or retrieve the existing) display/port for `linux_username`.
///
/// Idempotent: a second call for the same username returns the same slot.
/// Thread-safety: callers must hold an external `Mutex` (the allocations file is
/// shared state). In practice the guest-agent serialises desktop operations
/// through the `DesktopStore` which holds a `Mutex<()>` allocation lock.
pub fn allocate(run_root: &Path, linux_username: &str) -> Result<Allocation, AllocError> {
    let path = allocation_file_path(run_root);
    let mut file = load(&path)?;

    // Idempotent: return existing slot.
    if let Some(existing) = file.allocations.get(linux_username) {
        return Ok(existing.clone());
    }

    // Find the smallest free display/port.
    let used_displays: std::collections::HashSet<u32> =
        file.allocations.values().map(|a| a.display).collect();
    let slot = (0..MAX_SESSIONS)
        .find(|i| !used_displays.contains(&(BASE_DISPLAY + i)))
        .ok_or(AllocError::Exhausted)?;

    let alloc = Allocation {
        display: BASE_DISPLAY + slot,
        port: BASE_PORT + slot as u16,
    };
    file.allocations
        .insert(linux_username.to_string(), alloc.clone());
    save(&path, &file)?;
    Ok(alloc)
}

/// Release the allocation for `linux_username` (call on desktop stop/cleanup).
pub fn release(run_root: &Path, linux_username: &str) -> Result<(), AllocError> {
    let path = allocation_file_path(run_root);
    let mut file = load(&path)?;
    file.allocations.remove(linux_username);
    save(&path, &file)?;
    Ok(())
}

/// Snapshot of all current allocations (for heartbeat reporting, spec §8.2).
pub fn snapshot(run_root: &Path) -> HashMap<String, Allocation> {
    let path = allocation_file_path(run_root);
    load(&path).map(|f| f.allocations).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_run_root() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ga-ports-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn allocate_first_user_gets_slot_1_port_6901() {
        let root = tmp_run_root();
        let alloc = allocate(&root, "pria_u_a").unwrap();
        assert_eq!(alloc.display, 1);
        assert_eq!(alloc.port, 6901);
        assert_eq!(alloc.display_str(), ":1");
    }

    #[test]
    fn allocate_is_idempotent() {
        let root = tmp_run_root();
        let a1 = allocate(&root, "pria_u_a").unwrap();
        let a2 = allocate(&root, "pria_u_a").unwrap();
        assert_eq!(a1, a2);
    }

    #[test]
    fn second_user_gets_next_slot() {
        let root = tmp_run_root();
        let a = allocate(&root, "pria_u_a").unwrap();
        let b = allocate(&root, "pria_u_b").unwrap();
        assert_ne!(a.display, b.display);
        assert_ne!(a.port, b.port);
        assert_eq!(b.display, 2);
        assert_eq!(b.port, 6902);
    }

    #[test]
    fn release_frees_slot_for_reuse() {
        let root = tmp_run_root();
        allocate(&root, "pria_u_a").unwrap();
        release(&root, "pria_u_a").unwrap();
        // New user gets slot 1 again.
        let c = allocate(&root, "pria_u_c").unwrap();
        assert_eq!(c.display, 1);
    }

    #[test]
    fn allocations_persist_across_reload() {
        let root = tmp_run_root();
        let a1 = allocate(&root, "pria_u_a").unwrap();
        // Simulate restart: allocate again in a fresh load.
        let a2 = allocate(&root, "pria_u_a").unwrap();
        assert_eq!(a1, a2, "allocation must survive reload");
    }

    #[test]
    fn gap_filling_after_middle_release() {
        let root = tmp_run_root();
        allocate(&root, "pria_u_a").unwrap(); // slot 1
        allocate(&root, "pria_u_b").unwrap(); // slot 2
        allocate(&root, "pria_u_c").unwrap(); // slot 3
        release(&root, "pria_u_b").unwrap(); // free slot 2
        let d = allocate(&root, "pria_u_d").unwrap(); // should get slot 2
        assert_eq!(d.display, 2);
    }

    #[test]
    fn snapshot_returns_current_allocations() {
        let root = tmp_run_root();
        allocate(&root, "user_x").unwrap();
        allocate(&root, "user_y").unwrap();
        let snap = snapshot(&root);
        assert_eq!(snap.len(), 2);
        assert!(snap.contains_key("user_x"));
        assert!(snap.contains_key("user_y"));
    }

    #[test]
    fn release_nonexistent_is_ok() {
        let root = tmp_run_root();
        assert!(release(&root, "nobody").is_ok());
    }
}
