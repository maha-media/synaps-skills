//! Request validation for `/services/start` (VM-Sites §5 "server-resolved IDs
//! and operation keys, not … arbitrary shell strings").
//!
//! * `serviceId` — `[A-Za-z0-9_-]{8,64}`.
//! * `workdir` — absolute, traversal-free (lexical, [`crate::paths`]), an
//!   existing directory, AND its canonical (symlink-resolved) form under the
//!   canonical workspace root — a symlink inside the root pointing outside is
//!   refused.
//! * `command[0]` — a bare name (no `/`) from the configured allowlist; the
//!   executable is resolved by this module (PATH search + optional
//!   `<workdir>/node_modules/.bin`), never by a shell. Args are passed verbatim
//!   except the literal tokens `${PORT}` / `${HOST}`, which the supervisor
//!   substitutes with the allocated endpoint.
//! * `env` — allowlist `PATH, HOME, NODE_ENV, PORT, HOST, REVISION_BASE, CI,
//!   VITE_*`; everything else is dropped (never an error, so an over-broad
//!   caller map cannot leak). `PORT`/`HOST` are always overwritten by the
//!   supervisor.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::paths::{ensure_under, is_under};

/// Maximum accepted length of a single env value / arg (bytes).
pub const MAX_ENV_VALUE_BYTES: usize = 4096;
pub const MAX_ARG_BYTES: usize = 4096;
pub const MAX_ARGS: usize = 64;
pub const MAX_ENV_ENTRIES: usize = 64;

const ENV_ALLOWLIST: &[&str] = &[
    "PATH",
    "HOME",
    "NODE_ENV",
    "PORT",
    "HOST",
    "REVISION_BASE",
    "CI",
];

/// `[A-Za-z0-9_-]{8,64}`.
pub fn validate_service_id(id: &str) -> Result<(), String> {
    let len = id.len();
    if !(8..=64).contains(&len) {
        return Err(format!("serviceId must be 8..64 chars (got {len})"));
    }
    if !id
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err("serviceId must match [A-Za-z0-9_-]{8,64}".into());
    }
    Ok(())
}

/// Validate `workdir` against `root` and return its canonical form.
pub fn validate_workdir(root: &Path, workdir: &Path) -> Result<PathBuf, String> {
    ensure_under(root, workdir)?;
    let canon_root = std::fs::canonicalize(root)
        .map_err(|e| format!("workspace root {} unavailable: {e}", root.display()))?;
    let canon = std::fs::canonicalize(workdir)
        .map_err(|e| format!("workdir {} unavailable: {e}", workdir.display()))?;
    if !canon.is_dir() {
        return Err(format!("workdir {} is not a directory", workdir.display()));
    }
    if !is_under(&canon_root, &canon) {
        return Err(format!(
            "workdir {} resolves outside the workspace root (symlink escape)",
            workdir.display()
        ));
    }
    Ok(canon)
}

/// Validate `command` and resolve `command[0]` to an absolute executable.
/// Returns `(executable, args)`; args still carry the `${PORT}`/`${HOST}`
/// placeholders (substituted at spawn).
pub fn validate_command(
    allowlist: &[String],
    command: &[String],
    search_path: &str,
    workdir: &Path,
) -> Result<(PathBuf, Vec<String>), String> {
    let Some(name) = command.first() else {
        return Err("command must not be empty".into());
    };
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains('\0') {
        return Err("command[0] must be a bare executable name from the allowlist".into());
    }
    if !allowlist.iter().any(|a| a == name) {
        return Err(format!(
            "command[0] '{name}' is not in the allowlist [{}]",
            allowlist.join(", ")
        ));
    }
    if command.len() > MAX_ARGS + 1 {
        return Err(format!("command has more than {MAX_ARGS} arguments"));
    }
    for arg in &command[1..] {
        if arg.len() > MAX_ARG_BYTES {
            return Err(format!("argument exceeds {MAX_ARG_BYTES} bytes"));
        }
        if arg.contains('\0') {
            return Err("argument contains NUL".into());
        }
    }
    let exe = resolve_executable(name, search_path, workdir)
        .ok_or_else(|| format!("command[0] '{name}' was not found on PATH"))?;
    Ok((exe, command[1..].to_vec()))
}

/// Resolve a bare executable name: `<workdir>/node_modules/.bin/<name>` first
/// (project-local toolchain such as `vite`/`serve`), then each `PATH` entry.
/// Only regular files with an execute bit qualify.
pub fn resolve_executable(name: &str, search_path: &str, workdir: &Path) -> Option<PathBuf> {
    let local = workdir.join("node_modules").join(".bin").join(name);
    if is_executable_file(&local) {
        return Some(local);
    }
    for dir in search_path.split(':').filter(|d| !d.is_empty()) {
        let candidate = Path::new(dir).join(name);
        if is_executable_file(&candidate) {
            return Some(candidate);
        }
    }
    None
}

fn is_executable_file(p: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(p)
            .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        p.is_file()
    }
}

/// True when `key` is an allowlisted env name.
pub fn env_key_allowed(key: &str) -> bool {
    if ENV_ALLOWLIST.contains(&key) {
        return true;
    }
    key.strip_prefix("VITE_")
        .map(|rest| {
            !rest.is_empty()
                && rest
                    .bytes()
                    .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
        })
        .unwrap_or(false)
}

/// Filter the caller's env map down to the allowlist. Values that are too
/// long or contain NUL are rejected (typed error) rather than silently cut.
pub fn filter_env(env: &BTreeMap<String, String>) -> Result<BTreeMap<String, String>, String> {
    if env.len() > MAX_ENV_ENTRIES {
        return Err(format!("env has more than {MAX_ENV_ENTRIES} entries"));
    }
    let mut out = BTreeMap::new();
    for (k, v) in env {
        if !env_key_allowed(k) {
            continue;
        }
        if v.len() > MAX_ENV_VALUE_BYTES {
            return Err(format!("env {k} exceeds {MAX_ENV_VALUE_BYTES} bytes"));
        }
        if v.contains('\0') || v.contains('\n') {
            return Err(format!("env {k} contains a control character"));
        }
        out.insert(k.clone(), v.clone());
    }
    Ok(out)
}

/// Substitute the literal `${PORT}` / `${HOST}` tokens in one argument.
pub fn substitute_arg(arg: &str, port: u16, host: &str) -> String {
    arg.replace("${PORT}", &port.to_string())
        .replace("${HOST}", host)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn service_id_matrix() {
        assert!(validate_service_id("svc_12345678").is_ok());
        assert!(validate_service_id("a-b_C-1234").is_ok());
        assert!(validate_service_id("short").is_err());
        assert!(validate_service_id(&"x".repeat(65)).is_err());
        assert!(validate_service_id("has space!!").is_err());
        assert!(validate_service_id("dots.are.bad").is_err());
        assert!(validate_service_id("../../etc/pw").is_err());
    }

    #[test]
    fn env_allowlist_matrix() {
        for k in [
            "PATH",
            "HOME",
            "NODE_ENV",
            "PORT",
            "HOST",
            "REVISION_BASE",
            "CI",
        ] {
            assert!(env_key_allowed(k), "{k}");
        }
        assert!(env_key_allowed("VITE_API_BASE"));
        assert!(env_key_allowed("VITE_X1"));
        assert!(!env_key_allowed("VITE_"));
        assert!(!env_key_allowed("VITE_lower"));
        assert!(!env_key_allowed("AWS_SECRET_ACCESS_KEY"));
        assert!(!env_key_allowed("LD_PRELOAD"));
        assert!(!env_key_allowed("NODE_OPTIONS"));
        assert!(!env_key_allowed("path"));
    }

    #[test]
    fn filter_env_drops_unknown_and_rejects_control_chars() {
        let mut env = BTreeMap::new();
        env.insert("NODE_ENV".to_string(), "development".to_string());
        env.insert("LD_PRELOAD".to_string(), "/evil.so".to_string());
        env.insert("VITE_FLAG".to_string(), "1".to_string());
        let out = filter_env(&env).unwrap();
        assert_eq!(out.len(), 2);
        assert!(out.contains_key("NODE_ENV"));
        assert!(out.contains_key("VITE_FLAG"));
        env.insert("HOME".to_string(), "a\nb".to_string());
        assert!(filter_env(&env).is_err());
    }

    #[test]
    fn command_matrix() {
        let allow: Vec<String> = ["node", "sleep"].iter().map(|s| s.to_string()).collect();
        let wd = std::env::temp_dir();
        let path = "/usr/local/bin:/usr/bin:/bin";
        assert!(validate_command(&allow, &[], path, &wd).is_err());
        assert!(validate_command(&allow, &["bash".into()], path, &wd).is_err());
        assert!(validate_command(&allow, &["/bin/sleep".into()], path, &wd).is_err());
        assert!(validate_command(&allow, &["../sleep".into()], path, &wd).is_err());
        let (exe, args) =
            validate_command(&allow, &["sleep".into(), "${PORT}".into()], path, &wd).unwrap();
        assert!(exe.is_absolute());
        assert!(exe.ends_with("sleep"));
        assert_eq!(args, vec!["${PORT}"]);
        // Allowlisted but absent on PATH → typed refusal, never a shell lookup.
        let allow2: Vec<String> = vec!["definitely-not-a-binary-xyz".into()];
        assert!(
            validate_command(&allow2, &["definitely-not-a-binary-xyz".into()], path, &wd).is_err()
        );
    }

    #[test]
    fn node_modules_bin_is_preferred() {
        let wd = std::env::temp_dir().join(format!("ga-val-{}", uuid::Uuid::new_v4()));
        let bin = wd.join("node_modules/.bin");
        std::fs::create_dir_all(&bin).unwrap();
        let tool = bin.join("sleep");
        std::fs::write(&tool, "#!/bin/sh\nexec /bin/sleep \"$@\"\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o755)).unwrap();
        let resolved = resolve_executable("sleep", "/bin:/usr/bin", &wd).unwrap();
        assert_eq!(resolved, tool);
        // A non-executable local file is skipped in favour of PATH.
        std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o644)).unwrap();
        let resolved = resolve_executable("sleep", "/bin:/usr/bin", &wd).unwrap();
        assert_ne!(resolved, tool);
        std::fs::remove_dir_all(&wd).ok();
    }

    #[test]
    fn workdir_symlink_escape_is_refused() {
        let base = std::env::temp_dir().join(format!("ga-wd-{}", uuid::Uuid::new_v4()));
        let root = base.join("root");
        let outside = base.join("outside");
        std::fs::create_dir_all(root.join("ok")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, root.join("escape")).unwrap();

        assert!(validate_workdir(&root, &root.join("ok")).is_ok());
        assert!(validate_workdir(&root, &root.join("missing")).is_err());
        assert!(validate_workdir(&root, &outside).is_err());
        assert!(validate_workdir(&root, &root.join("ok/../../outside")).is_err());
        assert!(validate_workdir(&root, Path::new("relative/x")).is_err());
        #[cfg(unix)]
        assert!(
            validate_workdir(&root, &root.join("escape")).is_err(),
            "symlink under root pointing outside must be refused"
        );
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn placeholders_are_literal_tokens_only() {
        assert_eq!(
            substitute_arg("--port=${PORT}", 43001, "127.0.0.1"),
            "--port=43001"
        );
        assert_eq!(
            substitute_arg("${HOST}:${PORT}", 5, "127.0.0.1"),
            "127.0.0.1:5"
        );
        assert_eq!(substitute_arg("$PORT", 5, "h"), "$PORT");
        assert_eq!(substitute_arg("$(id)", 5, "h"), "$(id)");
    }
}
