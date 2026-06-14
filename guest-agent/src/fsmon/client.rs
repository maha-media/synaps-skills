//! fsmon control client (spec §6.6/§6.7). Peer of the fsmon control socket.
//!
//! HS-5 (CONFIRMED): fsmon is a sibling daemon, not a Synaps-managed sidecar
//! (`sidecar/spawn.rs` is a plugin-arg RPC, not a daemon supervisor). The guest
//! agent talks to it over a local UDS with newline-delimited JSON.

use async_trait::async_trait;

use super::types::{ControlRequest, ControlResponse, PolicyDoc};

/// fsmon control error.
#[derive(Debug)]
pub enum FsmonError {
    Unavailable(String),
    Protocol(String),
    Rejected(String),
}

impl std::fmt::Display for FsmonError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FsmonError::Unavailable(e) => write!(f, "fsmon unavailable: {e}"),
            FsmonError::Protocol(e) => write!(f, "fsmon protocol error: {e}"),
            FsmonError::Rejected(e) => write!(f, "fsmon rejected request: {e}"),
        }
    }
}

impl std::error::Error for FsmonError {}

/// Outcome of a successful control round-trip.
#[derive(Debug, Clone, Default)]
pub struct FsmonStats {
    pub cache_len: Option<usize>,
    pub principals: Option<usize>,
    pub degraded: Option<bool>,
}

/// The fsmon control surface (abstracted so handler tests inject a fake).
#[async_trait]
pub trait FsmonControl: Send + Sync {
    async fn apply_policy(&self, doc: &PolicyDoc) -> Result<FsmonStats, FsmonError>;
    async fn ping(&self) -> Result<(), FsmonError>;
    async fn stats(&self) -> Result<FsmonStats, FsmonError>;
}

/// UDS-backed control client.
pub struct UdsFsmonControl {
    socket_path: std::path::PathBuf,
}

impl UdsFsmonControl {
    pub fn new(socket_path: impl Into<std::path::PathBuf>) -> Self {
        Self {
            socket_path: socket_path.into(),
        }
    }

    async fn round_trip(&self, req: &ControlRequest) -> Result<FsmonStats, FsmonError> {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        use tokio::net::UnixStream;

        let stream = UnixStream::connect(&self.socket_path)
            .await
            .map_err(|e| FsmonError::Unavailable(e.to_string()))?;
        let (read_half, mut write_half) = stream.into_split();
        let line = serde_json::to_string(req).map_err(|e| FsmonError::Protocol(e.to_string()))?;
        write_half
            .write_all(format!("{line}\n").as_bytes())
            .await
            .map_err(|e| FsmonError::Unavailable(e.to_string()))?;
        write_half
            .flush()
            .await
            .map_err(|e| FsmonError::Unavailable(e.to_string()))?;

        let mut reader = BufReader::new(read_half);
        let mut resp_line = String::new();
        reader
            .read_line(&mut resp_line)
            .await
            .map_err(|e| FsmonError::Protocol(e.to_string()))?;
        let resp: ControlResponse = serde_json::from_str(resp_line.trim())
            .map_err(|e| FsmonError::Protocol(e.to_string()))?;
        match resp {
            ControlResponse::Ok {
                cache_len,
                principals,
                degraded,
            } => Ok(FsmonStats {
                cache_len,
                principals,
                degraded,
            }),
            ControlResponse::Error { message } => Err(FsmonError::Rejected(message)),
        }
    }
}

#[async_trait]
impl FsmonControl for UdsFsmonControl {
    async fn apply_policy(&self, doc: &PolicyDoc) -> Result<FsmonStats, FsmonError> {
        self.round_trip(&ControlRequest::PolicyApply {
            policy: doc.clone(),
        })
        .await
    }

    async fn ping(&self) -> Result<(), FsmonError> {
        self.round_trip(&ControlRequest::Ping).await.map(|_| ())
    }

    async fn stats(&self) -> Result<FsmonStats, FsmonError> {
        self.round_trip(&ControlRequest::Stats).await
    }
}

// ── test fake ────────────────────────────────────────────────────────────────

#[cfg(any(test, feature = "test-fakes"))]
pub use fake::FakeFsmonControl;

#[cfg(any(test, feature = "test-fakes"))]
mod fake {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    pub struct FakeFsmonControl {
        pub applied: Mutex<Vec<PolicyDoc>>,
        pub available: Mutex<bool>,
    }

    impl FakeFsmonControl {
        pub fn healthy() -> Self {
            Self {
                applied: Mutex::new(Vec::new()),
                available: Mutex::new(true),
            }
        }
        pub fn unavailable() -> Self {
            Self {
                applied: Mutex::new(Vec::new()),
                available: Mutex::new(false),
            }
        }
    }

    #[async_trait]
    impl FsmonControl for FakeFsmonControl {
        async fn apply_policy(&self, doc: &PolicyDoc) -> Result<FsmonStats, FsmonError> {
            if !*self.available.lock().unwrap() {
                return Err(FsmonError::Unavailable("socket closed".into()));
            }
            self.applied.lock().unwrap().push(doc.clone());
            Ok(FsmonStats {
                cache_len: Some(0),
                principals: Some(doc.principals.len()),
                degraded: Some(false),
            })
        }
        async fn ping(&self) -> Result<(), FsmonError> {
            if *self.available.lock().unwrap() {
                Ok(())
            } else {
                Err(FsmonError::Unavailable("down".into()))
            }
        }
        async fn stats(&self) -> Result<FsmonStats, FsmonError> {
            if *self.available.lock().unwrap() {
                Ok(FsmonStats::default())
            } else {
                Err(FsmonError::Unavailable("down".into()))
            }
        }
    }
}
