//! Shared test helpers (compiled for in-crate tests and the `test-fakes`
//! feature for integration tests).

use std::sync::Arc;

use crate::api::AppState;
use crate::config::Config;
use crate::hmac::HmacVerifier;
use crate::os::{FakeUserManager, OsUserManager};
use crate::pria_client::PriaCallbackClient;
use crate::runtime::RuntimeState;
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
    let cfg = Config::from_yaml(TEST_CONFIG).unwrap();
    let versions = Versions::detect(&cfg);
    AppState {
        config: Arc::new(cfg),
        hmac: Arc::new(HmacVerifier::disabled("acct_123", "vm_456")),
        runtime: Arc::new(RuntimeState::new()),
        versions: Arc::new(versions),
        pria,
        os,
    }
}
