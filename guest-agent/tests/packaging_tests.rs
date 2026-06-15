//! Packaging / runtime systemd contract tests (spec §7.2, §7.3, §11.2).
//!
//! These freeze the install/systemd artifacts under `packaging/` so the
//! `doctor --deep` + local-virsh E2E can rely on a stable in-guest contract and
//! so the VNC-password no-leak invariants (HS-G1) cannot silently regress.
//!
//! No systemd, KVM, or root required — these are pure text/contract assertions.

use std::path::PathBuf;

fn packaging_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("packaging")
}

fn read(rel: &str) -> String {
    let path = packaging_dir().join(rel);
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("missing packaging artifact {}: {e}", path.display()))
}

// ── systemd units exist and carry the spec §7.2 shape ────────────────────────

#[test]
fn guest_agent_unit_gated_on_bootstrap() {
    let unit = read("systemd/pria-guest-agent.service");
    // Must not start without the bootstrap config + HMAC secret (HS-P2).
    assert!(unit.contains("ConditionPathExists=/etc/pria/guest-agent.yaml"));
    assert!(unit.contains("ConditionPathExists=/etc/pria/guest-agent.hmac"));
    assert!(unit.contains(
        "ExecStart=/usr/local/sbin/pria-guest-agent --config /etc/pria/guest-agent.yaml"
    ));
    assert!(unit.contains("Restart=on-failure"));
    assert!(unit.contains("WantedBy=multi-user.target"));
}

#[test]
fn fsmon_unit_present_and_ordered_after_agent() {
    let unit = read("systemd/synaps-fsmon.service");
    assert!(unit.contains("ExecStart=/usr/local/sbin/synaps_fsmon --socket /run/pria/fsmon.sock"));
    assert!(unit.contains("After=pria-guest-agent.service"));
    assert!(unit.contains("Restart=on-failure"));
}

#[test]
fn kasmvnc_template_unit_uses_environment_file() {
    let unit = read("systemd/kasmvnc@.service");
    // Per-user template (spec §7.2).
    assert!(unit.contains("Description=KasmVNC desktop for %i"));
    assert!(unit.contains("User=%i"));
    // The env file carries the secret out-of-band of argv (spec §7.3).
    assert!(unit.contains("EnvironmentFile=/run/pria/kasmvnc/%i.env"));
    // The password is configured by the ExecStartPre helper, not the server argv.
    // The leading '+' keeps only this helper privileged (ssl-cert group, /run
    // setup) while ExecStart still runs unprivileged as %i (spec §7.2/§7.3).
    assert!(unit.contains("ExecStartPre=+/usr/local/sbin/pria-kasm-setpw %i"));
}

/// HS-G1: the KasmVNC password must NEVER appear on the server process argv.
/// The `ExecStart` line may only interpolate the non-secret env vars.
#[test]
fn kasmvnc_execstart_never_carries_password() {
    let unit = read("systemd/kasmvnc@.service");
    let execstart: Vec<&str> = unit
        .lines()
        .filter(|l| {
            l.trim_start().starts_with("ExecStart=") || l.trim_start().starts_with("ExecStop=")
        })
        .collect();
    assert!(!execstart.is_empty(), "kasmvnc@ must declare ExecStart");
    for line in execstart {
        assert!(
            !line.contains("KASM_VNC_PASSWORD") && !line.to_lowercase().contains("password"),
            "VNC password must never appear on argv: {line}"
        );
    }
    // Sanity: the non-secret env vars are the ones interpolated.
    let exec = unit
        .lines()
        .find(|l| l.trim_start().starts_with("ExecStart="))
        .unwrap();
    assert!(exec.contains("${KASM_DISPLAY}"));
    assert!(exec.contains("${KASM_GEOMETRY}"));
    assert!(exec.contains("${KASM_WS_PORT}"));
}

// ── pria-kasm-setpw security contract (spec §7.3, HS-G1) ─────────────────────

#[test]
fn setpw_helper_exists_and_is_executable() {
    let path = packaging_dir().join("bin/pria-kasm-setpw");
    assert!(path.exists(), "pria-kasm-setpw must exist");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert!(mode & 0o111 != 0, "pria-kasm-setpw must be executable");
    }
}

#[test]
fn setpw_feeds_password_via_stdin_not_argv() {
    let script = read("bin/pria-kasm-setpw");
    // The password must be piped to kasmvncpasswd / vncpasswd over stdin.
    assert!(
        script.contains("| kasmvncpasswd") || script.contains("| vncpasswd"),
        "password must be piped over stdin to the passwd tool"
    );
    // It must NOT be passed as a positional/flag argument to the passwd tool.
    for bad in [
        "kasmvncpasswd ${pw}",
        "kasmvncpasswd \"${pw}\"",
        "vncpasswd ${pw}",
        "-p ${pw}",
        "--password",
    ] {
        assert!(
            !script.contains(bad),
            "password must never be passed on argv (found pattern: {bad})"
        );
    }
}

#[test]
fn setpw_reads_only_from_env_or_env_file() {
    let script = read("bin/pria-kasm-setpw");
    // Source of truth is KASM_VNC_PASSWORD (env, populated by EnvironmentFile)
    // or the env file directly — never an argv-supplied secret.
    assert!(script.contains("KASM_VNC_PASSWORD"));
    assert!(script.contains("/kasmvnc/") && script.contains(".env"));
}

#[test]
fn setpw_never_echoes_the_password() {
    let script = read("bin/pria-kasm-setpw");
    for line in script.lines() {
        let t = line.trim_start();
        if t.starts_with("echo ") || t.starts_with("printf ") {
            // printf is allowed only when piped into the passwd tool (stdin feed),
            // never when writing to stdout/stderr as a bare echo of the value.
            if t.starts_with("echo ") {
                // Flag only actual *value expansions* — mentioning the variable
                // NAME in a diagnostic (e.g. "KASM_VNC_PASSWORD is empty") is fine.
                assert!(
                    !line.contains("${pw}")
                        && !line.contains("$pw")
                        && !line.contains("${KASM_VNC_PASSWORD}")
                        && !line.contains("$KASM_VNC_PASSWORD"),
                    "password value must never be echoed: {line}"
                );
            }
        }
    }
    // The success log line must explicitly mark the value as redacted.
    assert!(script.contains("(redacted)"));
}

#[test]
fn setpw_writes_restrictive_permissions() {
    let script = read("bin/pria-kasm-setpw");
    assert!(script.contains("umask 077") || script.contains("chmod 0600"));
}

// ── install script contract (spec §11.2) ─────────────────────────────────────

#[test]
fn install_script_installs_all_units_and_helper() {
    let install = read("install.sh");
    for unit in [
        "pria-guest-agent.service",
        "synaps-fsmon.service",
        "kasmvnc@.service",
    ] {
        assert!(install.contains(unit), "install.sh must install {unit}");
    }
    assert!(install.contains("pria-kasm-setpw"));
    // Must not bake a per-VM secret into the base image (HS-P2 / §11.2).
    assert!(
        !install.contains("guest-agent.hmac") || install.contains("inject"),
        "install.sh must not write the per-VM HMAC secret into the base image"
    );
}
