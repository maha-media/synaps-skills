//! Loopback-only hermetic control endpoint; never uses real OS/Pria/Synaps adapters.
use pria_guest_agent::{
    api::build_router,
    hmac::HmacVerifier,
    pria_client::fake::FakePriaClient,
    services::ServiceStore,
    test_support::{seed_fixture_session, test_state_with_pria},
};
use std::{path::PathBuf, sync::Arc};
#[tokio::main]
async fn main() {
    let root = PathBuf::from(std::env::args().nth(1).expect("fixture root required"))
        .canonicalize()
        .expect("existing fixture root");
    let port: u16 = std::env::args()
        .nth(2)
        .unwrap_or("9091".into())
        .parse()
        .unwrap();
    // Only explicit fixture-owned configuration; never infer dependency paths
    // from HOME or a caller's build command. Same production source build path.
    let dependencies = std::env::args_os().nth(3).map(|path| {
        let path = PathBuf::from(path)
            .canonicalize()
            .expect("existing fixture dependencies");
        assert!(path.is_dir(), "dependencies must be directory");
        path
    });
    let cgroup = std::env::args_os()
        .nth(4)
        .or_else(|| std::env::var_os("PRIA_FIXTURE_CGROUP_ROOT"))
        .map(|path| {
            let path = PathBuf::from(path);
            assert!(path.is_absolute(), "cgroup parent must be absolute");
            assert_eq!(
                path.canonicalize().expect("existing cgroup parent"),
                path,
                "canonical cgroup parent required"
            );
            let controllers = std::fs::read_to_string(path.join("cgroup.subtree_control"))
                .expect("delegated cgroup v2 parent required");
            assert!(
                ["cpu", "memory", "pids"]
                    .iter()
                    .all(|c| controllers.split_whitespace().any(|v| v == *c)),
                "missing predelegated controllers"
            );
            path
        });
    let mut state = test_state_with_pria(Arc::new(FakePriaClient::default()));
    let mut cfg = (*state.config).clone();
    let installed_pack = std::fs::canonicalize(
        std::env::args_os()
            .nth(5)
            .or_else(|| std::env::var_os("PRIA_FIXTURE_SKILL_PACK_ROOT"))
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../pria-app-builder-plugin")
            }),
    )
    .expect("fixture trusted skill pack root");
    let private_pack = root.join("trusted-skill-pack");
    if !private_pack.exists() {
        pria_guest_agent::services::skill_pack::fixture_copy(&installed_pack, &private_pack)
            .expect("private verified fixture pack copy");
    }
    pria_guest_agent::services::skill_pack::verify(Some(&private_pack))
        .expect("verified fixture pack");
    cfg.app_services.skill_pack_root = Some(private_pack);
    cfg.app_services.source_build_dependencies = dependencies;
    cfg.app_services.source_build_cgroup_root = cgroup;
    cfg.paths.run_root = root.join("control");
    cfg.app_services.retained_root = root.join("retained");
    cfg.paths.efs_root = root.join("workspace");
    cfg.app_services.workspace_root = Some(cfg.paths.efs_root.clone());
    std::fs::create_dir_all(&cfg.paths.run_root).unwrap();
    std::fs::create_dir_all(&cfg.paths.efs_root).unwrap();
    state.services = Arc::new(ServiceStore::new(
        &cfg.paths.run_root,
        cfg.app_services.clone(),
        state.pria.clone(),
    ));
    state.hmac = Arc::new(
        HmacVerifier::new(
            b"test-secret".to_vec(),
            cfg.account_id.to_string(),
            cfg.vm_id.to_string(),
            300,
            600,
        )
        .with_key_id("key_123"),
    );
    state.config = Arc::new(cfg);
    seed_fixture_session(&state, state.config.paths.efs_root.clone());
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))
        .await
        .unwrap();
    eprintln!(
        "fixture control listening on {} (synthetic account acct_123 / vm_456)",
        listener.local_addr().unwrap()
    );
    axum::serve(listener, build_router(state)).await.unwrap();
}
