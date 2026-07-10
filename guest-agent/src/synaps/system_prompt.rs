//! System-prompt file writer for per-session `--system` argument.
//!
//! The prompt is written to `<session_dir>/system.md` at mode 0600, owned by
//! the session user. The synaps child receives its path via `--system <path>`,
//! which the runtime resolves as a file (agent-runtime contract §Q1).
//!
//! Size cap: 64 KiB — a prompt larger than this is almost certainly a bug or
//! an injection attempt; refuse before touching the filesystem.

use std::path::{Path, PathBuf};

use crate::error::{ErrorCode, GuestAgentError};

/// Maximum allowed system-prompt size (64 KiB).
const MAX_PROMPT_BYTES: usize = 64 * 1024;

/// Write `prompt` to `<session_dir>/system.md`, chown to `uid`, mode 0600.
///
/// Returns the absolute path to the written file on success.
pub fn write_system_prompt(
    prompt: &str,
    session_dir: &Path,
    uid: u32,
) -> Result<PathBuf, GuestAgentError> {
    let bytes = prompt.as_bytes();
    if bytes.len() > MAX_PROMPT_BYTES {
        return Err(GuestAgentError::new(
            ErrorCode::InvalidRequest,
            format!(
                "system_prompt exceeds 64 KiB limit ({} bytes)",
                bytes.len()
            ),
        ));
    }

    let path = session_dir.join("system.md");

    std::fs::write(&path, bytes).map_err(|e| {
        GuestAgentError::internal(format!(
            "failed to write system prompt {}: {e}",
            path.display()
        ))
    })?;

    // 0600 — session user read/write only; no group or other access.
    set_mode_0600(&path);

    // chown to uid; gid u32::MAX == (gid_t)-1 → unchanged (keep inherited gid).
    // SAFETY: valid NUL-terminated path; gid u32::MAX == (gid_t)-1 = unchanged.
    let c_path = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()).map_err(|e| {
        GuestAgentError::internal(format!("system prompt path contains NUL byte: {e}"))
    })?;
    let _ = unsafe { libc::chown(c_path.as_ptr(), uid, u32::MAX) };

    Ok(path)
}

fn set_mode_0600(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}
