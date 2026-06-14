//! Shared test helpers (compiled for in-crate tests and the `test-fakes`
//! feature for integration tests).

use std::path::PathBuf;
use std::sync::Arc;

use crate::api::AppState;
use crate::config::Config;
use crate::hmac::HmacVerifier;
use crate::os::{FakeUserManager, OsUserManager};
use crate::pria_client::PriaCallbackClient;
use crate::runtime::RuntimeState;
use crate::sessions::SessionStore;
use crate::synaps::launcher::{FakeLauncher, SynapsLauncher};
use crate::versions::Versions;

pub const TEST_CONFIG: &str = r#"
mode: local-virsh
account_id: acct_123
vm_id: vm_456
replica_id: replica_0
pria:
  base_url: http://127.0.0.1:1
  hmac_key_id: key_123
  hmac_secret_file: /tmp/does-not-exist
paths:
  efs_root: /efs/accounts/acct_123
  run_root: /run/pria
  policy_dir: /efs/accounts/acct_123/policy
  audit_spool_dir: /tmp/ga-test-spool
synaps:
  binary: /bin/true
fsmon:
  socket: /run/pria/fsmon.sock
"#;

/// Build a test `AppState` with HMAC disabled and the given Pria client.
pub fn test_state_with_pria(pria: Arc<dyn PriaCallbackClient>) -> AppState {
    test_state_full(pria, Arc::new(FakeUserManager::default()))
}

/// Build a test `AppState` with HMAC disabled and explicit Pria + OS layers.
pub fn test_state_full(pria: Arc<dyn PriaCallbackClient>, os: Arc<dyn OsUserManager>) -> AppState {
    test_state_sessions(pria, os, Arc::new(FakeLauncher::default()))
}

/// Build a full test `AppState` with an explicit launcher (paths point at the
/// spec defaults; use [`test_env`] when the handler needs writable dirs).
pub fn test_state_sessions(
    pria: Arc<dyn PriaCallbackClient>,
    os: Arc<dyn OsUserManager>,
    synaps: Arc<dyn SynapsLauncher>,
) -> AppState {
    let cfg = Config::from_yaml(TEST_CONFIG).unwrap();
    assemble(cfg, pria, os, synaps)
}

/// A test `AppState` with `efs_root`/`run_root`/`audit_spool_dir` pointed at
/// fresh temp dirs so session handlers that create directories succeed.
pub struct TestEnv {
    pub state: AppState,
    pub efs_root: PathBuf,
    pub run_root: PathBuf,
}

/// Build a [`TestEnv`] with writable temp roots.
pub fn test_env(
    pria: Arc<dyn PriaCallbackClient>,
    os: Arc<dyn OsUserManager>,
    synaps: Arc<dyn SynapsLauncher>,
) -> TestEnv {
    let base = std::env::temp_dir().join(format!("ga-env-{}", uuid::Uuid::new_v4()));
    let efs_root = base.join("efs");
    let run_root = base.join("run");
    let spool = base.join("spool");
    std::fs::create_dir_all(&efs_root).unwrap();
    std::fs::create_dir_all(&run_root).unwrap();

    let mut cfg = Config::from_yaml(TEST_CONFIG).unwrap();
    cfg.paths.efs_root = efs_root.clone();
    cfg.paths.run_root = run_root.clone();
    cfg.paths.audit_spool_dir = spool;
    cfg.paths.policy_dir = efs_root.join("policy");
    let state = assemble(cfg, pria, os, synaps);
    TestEnv {
        state,
        efs_root,
        run_root,
    }
}

fn assemble(
    cfg: Config,
    pria: Arc<dyn PriaCallbackClient>,
    os: Arc<dyn OsUserManager>,
    synaps: Arc<dyn SynapsLauncher>,
) -> AppState {
    let versions = Arc::new(Versions::detect(&cfg));
    let runtime = Arc::new(RuntimeState::new());
    let sessions = Arc::new(SessionStore::new(runtime.clone()));
    AppState {
        config: Arc::new(cfg),
        hmac: Arc::new(HmacVerifier::disabled("acct_123", "vm_456")),
        runtime,
        versions,
        pria,
        os,
        synaps,
        sessions,
        fsmon: Arc::new(crate::fsmon::client::FakeFsmonControl::healthy()),
    }
}
