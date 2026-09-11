//! Execution primitive, NOT sourceBuildV1: callers must first establish an
//! immutable trusted input and provision a scoped UID. No HTTP caller controls
//! mounts, environment, sandbox executable or host toolchain paths.
use std::{path::Path, time::Duration};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PhaseReceipt {
    pub command: Vec<String>,
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}
async fn capture(mut stream: impl tokio::io::AsyncRead + Unpin) -> String {
    use tokio::io::AsyncReadExt;
    let mut kept = Vec::new();
    let mut buf = [0u8; 4096];
    while let Ok(n) = stream.read(&mut buf).await {
        if n == 0 {
            break;
        }
        let count = n.min(16384usize.saturating_sub(kept.len()));
        kept.extend_from_slice(&buf[..count]);
    }
    String::from_utf8_lossy(&kept)
        .lines()
        .map(|line| {
            let lower = line.to_ascii_lowercase();
            if [
                "token",
                "secret",
                "password",
                "credential",
                "private key",
                "authorization",
                "v3d.",
                "v3p.",
                "x-pria-",
                "capability",
                "bearer",
            ]
            .iter()
            .any(|v| lower.contains(v))
            {
                "[redacted]".to_owned()
            } else {
                line.chars()
                    .filter(|c| !c.is_control() || *c == '\t')
                    .collect::<String>()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Run one argv in a network/PID/mount-isolated unprivileged process. Source
/// and dependencies must be guest-owned immutable snapshots, not a live task
/// directory. Only output is writable on the host. Does not attest provenance.
pub async fn run(
    source: &Path,
    dependencies: &Path,
    output: &Path,
    argv: &[String],
    timeout: Duration,
) -> Result<(), String> {
    run_scoped(source, dependencies, output, argv, timeout, None, None)
        .await
        .map(|_| ())
}

pub async fn run_scoped(
    source: &Path,
    dependencies: &Path,
    output: &Path,
    argv: &[String],
    timeout: Duration,
    identity: Option<super::RunAs>,
    cgroup_root: Option<&Path>,
) -> Result<PhaseReceipt, String> {
    if unsafe { libc::geteuid() } == 0 && identity.is_none() {
        return Err("build sandbox requires scoped non-root executor".into());
    }
    if argv.is_empty() || argv.len() > 65 || argv.iter().any(|a| a.len() > 4096 || a.contains('\0'))
    {
        return Err("invalid bounded build argv".into());
    }
    let roots = [source, dependencies, output];
    for p in roots {
        if !p.is_absolute()
            || !p.is_dir()
            || std::fs::canonicalize(p).map_err(|e| e.to_string())? != p
        {
            return Err("sandbox roots must be canonical directories".into());
        }
    }
    for (i, a) in roots.iter().enumerate() {
        for (j, b) in roots.iter().enumerate() {
            if i != j && a.starts_with(b) {
                return Err("overlapping sandbox roots".into());
            }
        }
    }
    let cgroup = cgroup_root
        .map(super::build_cgroup::BuildCgroup::create)
        .transpose()?;
    let procs = cgroup.as_ref().map(|c| c.procs()).transpose()?;
    let mut cmd = tokio::process::Command::new("/usr/bin/bwrap");
    cmd.env_clear()
        .args([
            "--unshare-all",
            "--die-with-parent",
            "--new-session",
            "--cap-drop",
            "ALL",
            "--ro-bind",
            "/usr",
            "/usr",
            "--ro-bind",
            "/lib",
            "/lib",
            "--ro-bind",
            "/lib64",
            "/lib64",
            "--proc",
            "/proc",
            "--dev",
            "/dev",
            "--tmpfs",
            "/tmp",
            "--dir",
            "/home",
            "--dir",
            "/home/build",
            "--setenv",
            "HOME",
            "/home/build",
            "--setenv",
            "PATH",
            "/usr/bin",
            "--setenv",
            "CI",
            "true",
            // Host CPU discovery can exceed the private pids=64 budget. These
            // are trusted profile constants, never caller environment values.
            "--setenv",
            "RAYON_NUM_THREADS",
            "2",
            "--setenv",
            "UV_THREADPOOL_SIZE",
            "2",
            "--setenv",
            "ROLLDOWN_WORKER_THREADS",
            "2",
            "--setenv",
            "ROLLDOWN_MAX_BLOCKING_THREADS",
            "2",
            "--setenv",
            "TOKIO_WORKER_THREADS",
            "2",
            "--ro-bind",
        ])
        .arg(source)
        .arg("/source")
        .arg("--ro-bind")
        .arg(dependencies)
        .arg("/source/node_modules")
        .arg("--bind")
        .arg(output)
        .arg("/output")
        .args([
            "--chdir",
            "/source",
            "--",
            "/usr/bin/prlimit",
            "--cpu=60",
            "--fsize=67108864",
            "--nofile=256",
            "--core=0",
            "--",
        ])
        .args(argv)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    // No UID-wide NPROC limit: that could deny peer workloads. PID namespace
    // teardown kills descendants; aggregate PID/memory limits still need a
    // delegated per-executor cgroup before production sourceBuildV1 enablement.
    unsafe {
        cmd.pre_exec(move || {
            if let Some(ref file) = procs {
                use std::os::fd::AsRawFd;
                // Writing 0 joins only this child before any workload executes.
                if libc::write(file.as_raw_fd(), b"0".as_ptr().cast(), 1) != 1 {
                    return Err(std::io::Error::last_os_error());
                }
            }
            if let Some(ref identity) = identity {
                if identity.uid == 0 || identity.gid == 0 {
                    return Err(std::io::Error::from_raw_os_error(libc::EPERM));
                }
                // No supplementary authority needed by the isolated builder.
                if libc::setgroups(0, std::ptr::null()) != 0
                    || libc::setgid(identity.gid) != 0
                    || libc::setuid(identity.uid) != 0
                {
                    return Err(std::io::Error::last_os_error());
                }
            }
            if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("sandbox unavailable: {e}"))?;
    let out = tokio::spawn(capture(child.stdout.take().unwrap()));
    let err = tokio::spawn(capture(child.stderr.take().unwrap()));
    let result = tokio::time::timeout(timeout.min(Duration::from_secs(120)), child.wait()).await;
    // Closing the private cgroup kills descendants holding log descriptors.
    drop(cgroup);
    let stdout = tokio::time::timeout(Duration::from_secs(1), out)
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or_default();
    let stderr = tokio::time::timeout(Duration::from_secs(1), err)
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or_default();
    match result {
        Ok(Ok(status)) if status.success() => Ok(PhaseReceipt {
            command: argv.to_vec(),
            exit_code: 0,
            stdout,
            stderr,
        }),
        Ok(Ok(status)) => Err(format!(
            "build phase failed [program={}, status={status}]; stderr: {}; stdout: {}",
            match argv.first().map(String::as_str) {
                Some("npm") if argv.get(1).map(String::as_str) == Some("test") => "npm-test",
                Some("npm") if argv.get(1).map(String::as_str) == Some("run") => "npm-build",
                _ => "sandbox-command",
            },
            stderr.chars().take(4096).collect::<String>(),
            stdout.chars().take(2048).collect::<String>()
        )),
        Ok(Err(e)) => Err(e.to_string()),
        Err(_) => {
            let _ = child.kill().await;
            Err("build timeout".into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn failed_phase_reports_bounded_redacted_stderr() {
        let root = std::env::temp_dir().join(format!("sandbox-failure-{}", uuid::Uuid::new_v4()));
        for dir in ["source/node_modules", "deps", "output"] {
            std::fs::create_dir_all(root.join(dir)).unwrap();
        }
        let error=run(&root.join("source"),&root.join("deps"),&root.join("output"), &["/usr/bin/python3".into(),"-c".into(),"import sys; print('missing adapter sibling',file=sys.stderr); print('token=private',file=sys.stderr); sys.exit(1)".into()],Duration::from_secs(3)).await.unwrap_err();
        assert!(error.contains("missing adapter sibling"), "{error}");
        assert!(error.contains("build phase failed [program=sandbox-command, status="));
        assert!(error.contains("[redacted]"));
        assert!(!error.contains("token=private"));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn real_unprivileged_sandbox_denies_source_host_and_network() {
        let root = std::env::temp_dir().join(format!("sandbox-{}", uuid::Uuid::new_v4()));
        for name in ["source/node_modules", "deps", "output"] {
            std::fs::create_dir_all(root.join(name)).unwrap();
        }
        std::fs::write(root.join("secret"), "host secret").unwrap();
        std::fs::write(root.join("source/input"), "immutable").unwrap();
        let script = format!(
            r#"import os,socket
assert not os.path.exists({secret:?})
assert os.environ['HOME']=='/home/build'
assert os.environ['RAYON_NUM_THREADS']=='2'
assert os.environ['UV_THREADPOOL_SIZE']=='2'
assert os.environ['ROLLDOWN_WORKER_THREADS']=='2'
assert os.environ['ROLLDOWN_MAX_BLOCKING_THREADS']=='2'
assert os.environ['TOKIO_WORKER_THREADS']=='2'
assert open('/source/input').read()=='immutable'
try:
 open('/source/input','w').write('bad')
 raise AssertionError('source writable')
except OSError: pass
s=socket.socket();s.settimeout(.1)
try:
 s.connect(('127.0.0.1',1))
 raise AssertionError('network reachable')
except OSError: pass
assert len(os.listdir('/sys/class/net'))==0 if os.path.exists('/sys/class/net') else True
open('/output/result','w').write('built')
"#,
            secret = root.join("secret").to_string_lossy()
        );
        let call = |args: Vec<String>| run_owned(root.clone(), args);
        call(vec!["/usr/bin/python3".into(), "-c".into(), script])
            .await
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("output/result")).unwrap(),
            "built"
        );
        assert!(call(vec!["/usr/bin/false".into()]).await.is_err());
        assert_eq!(
            std::fs::read_to_string(root.join("source/input")).unwrap(),
            "immutable"
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    async fn run_owned(root: std::path::PathBuf, args: Vec<String>) -> Result<(), String> {
        run(
            &root.join("source"),
            &root.join("deps"),
            &root.join("output"),
            &args,
            Duration::from_secs(3),
        )
        .await
    }
}
