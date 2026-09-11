//! Persisted loopback port allocator for app services (VM-Sites §6 D1
//! "private allocated port").
//!
//! State lives in `{run_root}/app-services/state.json`:
//!
//! ```json
//! { "services": { "<serviceId>": { "port": 43000, "generation": 3,
//!                                   "pid": 1234, "active": true } } }
//! ```
//!
//! * `active` entries own their port: a guest-agent restart must not hand a
//!   port that an orphaned (setsid'd, still running) service holds to a new
//!   one. Allocation additionally bind-probes `127.0.0.1:<port>` so a port that
//!   is live for any other reason is skipped too.
//! * `generation` is monotonic per `serviceId` and survives restarts so Pria's
//!   generation fence never sees a reused number.
//! * Writes are atomic (tmp + rename), mirroring `desktop::ports`.
//!
//! Callers serialise access through the [`super::ServiceStore`] lock.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// One persisted service slot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Slot {
    pub port: u16,
    pub generation: u64,
    #[serde(default)]
    pub pid: Option<u32>,
    #[serde(default)]
    pub active: bool,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct StateFile {
    services: HashMap<String, Slot>,
}

#[derive(Debug)]
pub enum PortError {
    /// Every port in the configured range is owned or live.
    Exhausted,
    Io(String),
}

impl std::fmt::Display for PortError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PortError::Exhausted => write!(f, "no free port in the app-service range"),
            PortError::Io(e) => write!(f, "app-service state file I/O error: {e}"),
        }
    }
}

impl std::error::Error for PortError {}

/// Path of the state file within `run_root`.
pub fn state_file_path(run_root: &Path) -> PathBuf {
    run_root.join("app-services").join("state.json")
}

fn load(path: &Path) -> Result<StateFile, PortError> {
    match std::fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str(&raw).map_err(|e| PortError::Io(e.to_string())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(StateFile::default()),
        Err(e) => Err(PortError::Io(e.to_string())),
    }
}

fn save(path: &Path, file: &StateFile) -> Result<(), PortError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| PortError::Io(e.to_string()))?;
    }
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_vec_pretty(file).map_err(|e| PortError::Io(e.to_string()))?;
    std::fs::write(&tmp, &json).map_err(|e| PortError::Io(e.to_string()))?;
    std::fs::rename(&tmp, path).map_err(|e| PortError::Io(e.to_string()))?;
    Ok(())
}

/// True when nothing is listening on `127.0.0.1:port` (a transient bind
/// succeeds). Conservative: any bind failure counts as "in use".
pub fn port_is_free(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

/// True when a process with `pid` exists (signal 0 probe).
#[cfg(unix)]
pub fn pid_alive(pid: u32) -> bool {
    // SAFETY: kill(pid, 0) performs no action beyond the existence/permission
    // check; no memory is touched.
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

#[cfg(not(unix))]
pub fn pid_alive(_pid: u32) -> bool {
    false
}

/// The allocator over one state file + one port range.
#[derive(Debug, Clone)]
pub struct PortAllocator {
    path: PathBuf,
    range_start: u16,
    range_end: u16,
}

/// What [`PortAllocator::allocate`] hands back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Allocation {
    pub port: u16,
    /// The generation this start owns (previous + 1, or 1 for a new id).
    pub generation: u64,
}

impl PortAllocator {
    pub fn new(run_root: &Path, range_start: u16, range_end: u16) -> Self {
        Self {
            path: state_file_path(run_root),
            range_start: range_start.min(range_end),
            range_end: range_end.max(range_start),
        }
    }

    /// Persisted slot for `service_id`, if any.
    pub fn slot(&self, service_id: &str) -> Result<Option<Slot>, PortError> {
        Ok(load(&self.path)?.services.get(service_id).cloned())
    }

    /// Allocate a port + the next generation for `service_id` and persist the
    /// slot as `active` (pid recorded by [`Self::set_pid`] once spawned).
    ///
    /// Port choice: the id's previous port when it is free (stable endpoints
    /// across restarts), else the lowest port in range that no other active
    /// slot owns AND that bind-probes free.
    pub fn allocate(&self, service_id: &str) -> Result<Allocation, PortError> {
        let mut file = load(&self.path)?;
        let previous = file.services.get(service_id).cloned();
        let generation = previous.as_ref().map(|s| s.generation).unwrap_or(0) + 1;
        let owned: std::collections::HashSet<u16> = file
            .services
            .iter()
            .filter(|(id, s)| s.active && id.as_str() != service_id)
            .map(|(_, s)| s.port)
            .collect();
        let candidate = previous
            .as_ref()
            .map(|s| s.port)
            .filter(|p| {
                (self.range_start..=self.range_end).contains(p)
                    && !owned.contains(p)
                    && port_is_free(*p)
            })
            .or_else(|| {
                (self.range_start..=self.range_end).find(|p| !owned.contains(p) && port_is_free(*p))
            })
            .ok_or(PortError::Exhausted)?;
        file.services.insert(
            service_id.to_string(),
            Slot {
                port: candidate,
                generation,
                pid: None,
                active: true,
            },
        );
        save(&self.path, &file)?;
        Ok(Allocation {
            port: candidate,
            generation,
        })
    }

    /// Record the spawned pid on the active slot.
    pub fn set_pid(&self, service_id: &str, pid: u32) -> Result<(), PortError> {
        let mut file = load(&self.path)?;
        if let Some(slot) = file.services.get_mut(service_id) {
            slot.pid = Some(pid);
            save(&self.path, &file)?;
        }
        Ok(())
    }

    /// Reclaim the port (slot stays for generation monotonicity, `active` off).
    pub fn release(&self, service_id: &str) -> Result<(), PortError> {
        let mut file = load(&self.path)?;
        if let Some(slot) = file.services.get_mut(service_id) {
            slot.active = false;
            slot.pid = None;
            save(&self.path, &file)?;
        }
        Ok(())
    }

    /// Startup reconciliation: any `active` slot whose recorded pid is gone is
    /// released (its port is free again). Slots with a live pid stay owned —
    /// that orphan is superseded on the next start of the same id. Returns
    /// `(released, still_live)`.
    pub fn rehydrate(&self) -> Result<(usize, usize), PortError> {
        let mut file = load(&self.path)?;
        let mut released = 0;
        let mut live = 0;
        for slot in file.services.values_mut().filter(|s| s.active) {
            match slot.pid {
                Some(pid) if pid_alive(pid) => live += 1,
                _ => {
                    slot.active = false;
                    slot.pid = None;
                    released += 1;
                }
            }
        }
        if released > 0 {
            save(&self.path, &file)?;
        }
        Ok((released, live))
    }

    /// Snapshot (heartbeat/debug use).
    pub fn snapshot(&self) -> HashMap<String, Slot> {
        load(&self.path).map(|f| f.services).unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_root() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ga-svc-ports-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Pick a private range BELOW the Linux ephemeral range (32768–60999) so
    /// a transient hold here can never collide with a sibling test that
    /// expects a kernel-assigned ephemeral port to be closed. Every test gets
    /// its OWN base: cargo runs tests in parallel threads and the bind probe
    /// transiently holds ports, so a shared range races on "port reusable".
    fn alloc_at(root: &Path, base: u16) -> PortAllocator {
        PortAllocator::new(root, base, base + 10)
    }

    #[test]
    fn first_allocation_is_generation_one_lowest_free_port() {
        let root = tmp_root();
        let a = alloc_at(&root, 24100).allocate("svc_aaaaaaaa").unwrap();
        assert_eq!(a.generation, 1);
        assert!((24100..=24110).contains(&a.port));
    }

    #[test]
    fn distinct_ids_get_distinct_ports_and_release_reclaims() {
        let root = tmp_root();
        let pa = alloc_at(&root, 24140);
        let a = pa.allocate("svc_a").unwrap();
        let b = pa.allocate("svc_b").unwrap();
        assert_ne!(a.port, b.port);
        pa.release("svc_a").unwrap();
        let c = pa.allocate("svc_c").unwrap();
        assert_eq!(c.port, a.port, "released port is reusable");
    }

    #[test]
    fn generation_is_monotonic_across_reallocation_and_reload() {
        let root = tmp_root();
        let pa = alloc_at(&root, 24160);
        let a1 = pa.allocate("svc_a").unwrap();
        pa.release("svc_a").unwrap();
        // "Restart": a fresh allocator over the same file.
        let a2 = alloc_at(&root, 24160).allocate("svc_a").unwrap();
        assert_eq!(a2.generation, a1.generation + 1);
        assert_eq!(a2.port, a1.port, "stable endpoint when still free");
    }

    #[test]
    fn active_slot_port_is_not_handed_to_another_id() {
        let root = tmp_root();
        let pa = alloc_at(&root, 24180);
        let a = pa.allocate("svc_a").unwrap();
        // Simulate a guest restart with the slot still active (orphan alive).
        let b = alloc_at(&root, 24180).allocate("svc_b").unwrap();
        assert_ne!(a.port, b.port);
    }

    #[test]
    fn live_port_is_skipped_by_bind_probe() {
        let root = tmp_root();
        let pa = PortAllocator::new(&root, 24120, 24122);
        // Hold 24120 so the allocator must skip it.
        let hold = std::net::TcpListener::bind(("127.0.0.1", 24120)).unwrap();
        let a = pa.allocate("svc_a").unwrap();
        assert_ne!(a.port, 24120);
        drop(hold);
    }

    #[test]
    fn range_exhaustion_is_typed() {
        let root = tmp_root();
        let pa = PortAllocator::new(&root, 24130, 24131);
        // Two ports in range → the third distinct id must be refused (earlier
        // if the host happens to hold one of them).
        let outcomes: Vec<bool> = ["svc_a", "svc_b", "svc_c"]
            .iter()
            .map(|id| matches!(pa.allocate(id), Err(PortError::Exhausted)))
            .collect();
        assert!(
            outcomes[2],
            "third allocation must be Exhausted: {outcomes:?}"
        );
    }

    #[test]
    fn rehydrate_releases_dead_pids_and_keeps_live_ones() {
        let root = tmp_root();
        let pa = alloc_at(&root, 24200);
        pa.allocate("svc_dead").unwrap();
        pa.set_pid("svc_dead", 4_000_000).unwrap(); // beyond pid_max → dead
        pa.allocate("svc_live").unwrap();
        pa.set_pid("svc_live", std::process::id()).unwrap();
        pa.allocate("svc_nopid").unwrap();
        let (released, live) = pa.rehydrate().unwrap();
        assert_eq!(released, 2);
        assert_eq!(live, 1);
        let snap = pa.snapshot();
        assert!(!snap["svc_dead"].active);
        assert!(!snap["svc_nopid"].active);
        assert!(snap["svc_live"].active);
    }
}
