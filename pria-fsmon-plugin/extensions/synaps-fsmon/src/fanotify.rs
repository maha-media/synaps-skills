//! fanotify integration — the synchronous permission hot path (spec §4.7).
//!
//! Uses `FAN_OPEN_PERM` / `FAN_ACCESS_PERM` so the monitor returns ALLOW/DENY
//! *before* the operation commits (pure inotify cannot block). Each event is
//! resolved to `(uid, path, op)` and answered inline from the L1 policy cache —
//! no synchronous network call on the hot path.
//!
//! Backend note: classic fanotify does not expose the open flags, so an
//! `FAN_OPEN_PERM` is treated conservatively as a write-equivalent containment
//! check (`Op::OpenWrite`); this also enforces cross-instance/home read privacy
//! (spec §3.3). Precise read/write separation needs the eBPF-LSM backend
//! (future work). `FAN_ACCESS_PERM` maps to `Op::Access`.
//!
//! Requires `CAP_SYS_ADMIN` (fanotify) at runtime; runs under the narrow
//! `synaps_fsmon` principal, never root-with-everything.

use crate::daemon::Daemon;
use crate::policy::{Decision, Op};

/// Error returned when the fanotify backend cannot initialise; the caller
/// should switch the daemon to degraded (fail-closed) posture.
#[derive(Debug)]
pub struct FanotifyError(pub String);

impl std::fmt::Display for FanotifyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "fanotify: {}", self.0)
    }
}

impl std::error::Error for FanotifyError {}

#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use std::os::fd::RawFd;

    // fanotify constants (from linux/fanotify.h) not always in libc.
    const FAN_CLOEXEC: libc::c_uint = 0x0000_0001;
    const FAN_CLASS_CONTENT: libc::c_uint = 0x0000_0004;
    const FAN_OPEN_PERM: u64 = 0x0001_0000;
    const FAN_ACCESS_PERM: u64 = 0x0002_0000;
    const FAN_ALLOW: u32 = 0x01;
    const FAN_DENY: u32 = 0x02;
    const FAN_MARK_ADD: libc::c_uint = 0x0000_0001;
    const FAN_MARK_MOUNT: libc::c_uint = 0x0000_0010;
    const METADATA_VERSION: u8 = 3;

    #[repr(C)]
    struct FanotifyEventMetadata {
        event_len: u32,
        vers: u8,
        reserved: u8,
        metadata_len: u16,
        mask: u64,
        fd: i32,
        pid: i32,
    }

    #[repr(C)]
    struct FanotifyResponse {
        fd: i32,
        response: u32,
    }

    extern "C" {
        fn fanotify_init(flags: libc::c_uint, event_f_flags: libc::c_uint) -> libc::c_int;
        fn fanotify_mark(
            fanotify_fd: libc::c_int,
            flags: libc::c_uint,
            mask: u64,
            dirfd: libc::c_int,
            pathname: *const libc::c_char,
        ) -> libc::c_int;
    }

    /// Resolve the uid that triggered an event from its pid (/proc/<pid>).
    fn uid_for_pid(pid: i32) -> Option<u32> {
        use std::os::unix::fs::MetadataExt;
        std::fs::metadata(format!("/proc/{pid}")).ok().map(|m| m.uid())
    }

    /// Resolve the absolute path behind an event fd via /proc/self/fd.
    fn path_for_fd(fd: RawFd) -> Option<String> {
        std::fs::read_link(format!("/proc/self/fd/{fd}"))
            .ok()
            .and_then(|p| p.to_str().map(|s| s.to_string()))
    }

    fn classify(mask: u64) -> Option<Op> {
        if mask & FAN_OPEN_PERM != 0 {
            Some(Op::OpenWrite)
        } else if mask & FAN_ACCESS_PERM != 0 {
            Some(Op::Access)
        } else {
            None
        }
    }

    pub fn run(daemon: &Daemon, mount_path: &str) -> Result<(), FanotifyError> {
        // SAFETY: simple libc FFI; flags are valid constants.
        let fan_fd = unsafe {
            fanotify_init(
                FAN_CLOEXEC | FAN_CLASS_CONTENT,
                (libc::O_RDONLY | libc::O_LARGEFILE) as libc::c_uint,
            )
        };
        if fan_fd < 0 {
            return Err(FanotifyError(format!(
                "fanotify_init failed: {}",
                std::io::Error::last_os_error()
            )));
        }
        let c_path = std::ffi::CString::new(mount_path)
            .map_err(|e| FanotifyError(format!("bad mount path: {e}")))?;
        // SAFETY: fan_fd is valid; c_path is NUL-terminated.
        let rc = unsafe {
            fanotify_mark(
                fan_fd,
                FAN_MARK_ADD | FAN_MARK_MOUNT,
                FAN_OPEN_PERM | FAN_ACCESS_PERM,
                libc::AT_FDCWD,
                c_path.as_ptr(),
            )
        };
        if rc < 0 {
            // SAFETY: closing a valid fd.
            unsafe { libc::close(fan_fd) };
            return Err(FanotifyError(format!(
                "fanotify_mark failed: {}",
                std::io::Error::last_os_error()
            )));
        }

        let mut buf = [0u8; 4096];
        loop {
            // SAFETY: reading into a local buffer.
            let len = unsafe {
                libc::read(
                    fan_fd,
                    buf.as_mut_ptr() as *mut libc::c_void,
                    buf.len(),
                )
            };
            if len <= 0 {
                if len < 0 {
                    let err = std::io::Error::last_os_error();
                    if err.kind() == std::io::ErrorKind::Interrupted {
                        continue;
                    }
                    return Err(FanotifyError(format!("read failed: {err}")));
                }
                continue;
            }
            let mut offset = 0usize;
            while offset + std::mem::size_of::<FanotifyEventMetadata>() <= len as usize {
                // SAFETY: offset bounds checked against the read length.
                let meta = unsafe {
                    &*(buf.as_ptr().add(offset) as *const FanotifyEventMetadata)
                };
                if meta.vers != METADATA_VERSION {
                    break;
                }
                handle_event(daemon, fan_fd, meta);
                if meta.event_len == 0 {
                    break;
                }
                offset += meta.event_len as usize;
            }
        }
    }

    fn handle_event(daemon: &Daemon, fan_fd: RawFd, meta: &FanotifyEventMetadata) {
        if meta.fd < 0 {
            return;
        }
        let op = match classify(meta.mask) {
            Some(op) => op,
            None => {
                close_fd(meta.fd);
                return;
            }
        };
        let uid = uid_for_pid(meta.pid).unwrap_or(u32::MAX);
        let path = path_for_fd(meta.fd).unwrap_or_default();

        // Fail-closed: if we cannot resolve the path for a write-class op, deny.
        let verdict = if path.is_empty() && op.is_write() {
            crate::policy::Verdict::deny(crate::policy::Reason::MonitorDegraded)
        } else {
            daemon.decide_and_audit(uid, &path, op)
        };

        let response = match verdict.decision {
            Decision::Allow => FAN_ALLOW,
            Decision::Deny => FAN_DENY,
        };
        write_response(fan_fd, meta.fd, response);
        close_fd(meta.fd);
    }

    fn write_response(fan_fd: RawFd, event_fd: i32, response: u32) {
        let resp = FanotifyResponse {
            fd: event_fd,
            response,
        };
        // SAFETY: writing a fixed-size response struct back to the fanotify fd.
        unsafe {
            libc::write(
                fan_fd,
                &resp as *const FanotifyResponse as *const libc::c_void,
                std::mem::size_of::<FanotifyResponse>(),
            );
        }
    }

    fn close_fd(fd: i32) {
        // SAFETY: closing the event fd handed to us by the kernel.
        unsafe {
            libc::close(fd);
        }
    }
}

/// Run the fanotify permission loop over `mount_path` (blocks forever).
#[cfg(target_os = "linux")]
pub fn run(daemon: &Daemon, mount_path: &str) -> Result<(), FanotifyError> {
    linux::run(daemon, mount_path)
}

/// Non-Linux stub: fanotify is Linux-only.
#[cfg(not(target_os = "linux"))]
pub fn run(_daemon: &Daemon, _mount_path: &str) -> Result<(), FanotifyError> {
    Err(FanotifyError(
        "fanotify is only available on Linux".to_string(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_displays() {
        let e = FanotifyError("boom".into());
        assert_eq!(e.to_string(), "fanotify: boom");
    }

    #[cfg(not(target_os = "linux"))]
    #[test]
    fn non_linux_run_errors() {
        let daemon = crate::daemon::Daemon::new(
            crate::policy::Policy::empty(),
            crate::audit::AuditSpool::new("/tmp/none.jsonl"),
            Box::new(crate::daemon::NullForwarder),
        );
        assert!(run(&daemon, "/").is_err());
    }
}
