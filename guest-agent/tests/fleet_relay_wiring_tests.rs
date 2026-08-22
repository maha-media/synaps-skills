//! Relay→FleetBindings wiring proof (real child) — sanctioned new-fence
//! infrastructure for W3.7-G, added at implementation time per the Designer's
//! seam-fit finding recorded in the W3.7-G fence's SEAM HONESTY NOTE
//! (tests/fleet_callback_tests.rs module doc): the stdout relay
//! (`relay_agent_end_usage`, src/synaps/launcher.rs) is NOT drivable through
//! router tests because `FakeProcess::take_stdout()` returns `None`, so the
//! start handler never spawns the relay under `FakeLauncher`. The fence pins
//! the state-machine seams (`FleetBindings::{on_agent_end, on_session_eof}`);
//! THIS row pins that the relay actually calls them, with a real child
//! mirroring `relay_meters_agent_end_frames_from_real_stdout`
//! (src/synaps/launcher.rs unit tests).

use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;

use pria_guest_agent::fleet::{FleetBindings, FleetDirective};
use pria_guest_agent::pria_client::fake::FakePriaClient;
use pria_guest_agent::pria_client::PriaCallbackClient;
use pria_guest_agent::synaps::launcher::{relay_agent_end_usage, UsageIdentity};

fn identity() -> UsageIdentity {
    UsageIdentity {
        account_id: "acct_1".into(),
        instance_id: "inst_2".into(),
        user_id: "user_3".into(),
        vm_id: "vm_4".into(),
        replica_id: "r0".into(),
        session_id: "sess_relay".into(),
        ephemeral_task_id: None,
    }
}

fn fleet_cbs(pria: &FakePriaClient) -> Vec<Value> {
    pria.fleet_callbacks.lock().unwrap().clone()
}

/// Spawn a real `sh -c` child (mirroring the launcher unit-test idiom) and
/// hand back its piped stdout for the relay.
fn child_stdout(script: &str) -> tokio::process::ChildStdout {
    let mut child = tokio::process::Command::new("sh")
        .arg("-c")
        .arg(script)
        .stdout(Stdio::piped())
        .spawn()
        .expect("spawn test child");
    child.stdout.take().expect("child stdout")
}

/// The relay's `agent_end` arm must call `FleetBindings::on_agent_end` (a
/// Running binding completes with `result {ok:true}`), and its EOF arm must
/// call `FleetBindings::on_session_eof` (a still-bound task dies with
/// `result {ok:false, error.code=="session_exited"}`). Usage metering through
/// the same relay is unchanged.
#[tokio::test]
async fn relay_wiring_drives_fleet_result_on_agent_end_and_session_exited_on_eof() {
    let pria = Arc::new(FakePriaClient::default());
    let fleet = Arc::new(FleetBindings::new(
        pria.clone() as Arc<dyn PriaCallbackClient>,
        Duration::from_secs(30),
    ));

    // Turn 1: bound + Running, the child emits one agent_end frame then exits.
    fleet
        .bind(
            "sess_relay",
            FleetDirective {
                handle_id: "fj-relay".into(),
                generation: 4,
                workspace: None,
            },
        )
        .await
        .expect("bind on a fresh session accepted");
    fleet.mark_running("sess_relay");
    // F6.1 turn fence: bind() owes the directive turn's own agent_end
    // (skip_ends=1). Deliver it here — the relay's single frame below is then
    // the RUNNING turn's end, the one that may mint (SD invariant 5).
    fleet.on_agent_end("sess_relay").await;
    let agent_end =
        r#"{"type":"agent_end","usage":{"input_tokens":10,"output_tokens":5}}"#;
    let stdout = child_stdout(&format!("echo 'not json'; echo '{agent_end}'"));
    relay_agent_end_usage(stdout, identity(), pria.clone(), fleet.clone(), None, None).await;

    let cbs = fleet_cbs(&pria);
    // ack + result{ok:true}; the EOF AFTER the clear must be silent.
    assert_eq!(cbs.len(), 2, "ack + result, post-clear EOF silent: {cbs:?}");
    assert_eq!(cbs[1]["kind"], "result");
    assert_eq!(cbs[1]["session_id"], "sess_relay");
    assert_eq!(cbs[1]["handle_id"], "fj-relay");
    assert_eq!(cbs[1]["generation"], 4);
    assert_eq!(cbs[1]["payload"]["ok"], true);
    assert!(fleet.binding("sess_relay").is_none(), "cleared");
    assert_eq!(
        pria.usages.lock().unwrap().len(),
        1,
        "usage metering through the relay is unchanged"
    );

    // Turn 2: bound + Running, the child dies without an agent_end → the EOF
    // arm reports session_exited.
    fleet
        .bind(
            "sess_relay",
            FleetDirective {
                handle_id: "fj-relay2".into(),
                generation: 5,
                workspace: None,
            },
        )
        .await
        .expect("rebind after clear accepted");
    fleet.mark_running("sess_relay");
    let stdout = child_stdout("true");
    relay_agent_end_usage(stdout, identity(), pria.clone(), fleet.clone(), None, None).await;

    let cbs = fleet_cbs(&pria);
    let last = cbs.last().expect("callbacks recorded");
    assert_eq!(last["kind"], "result");
    assert_eq!(last["handle_id"], "fj-relay2");
    assert_eq!(last["generation"], 5);
    assert_eq!(last["payload"]["ok"], false);
    assert_eq!(last["payload"]["error"]["code"], "session_exited");
    assert!(fleet.binding("sess_relay").is_none(), "cleared on EOF");
}
