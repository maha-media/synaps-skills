//! Structured, audit-friendly error model (spec §15).
//!
//! Every error maps to a stable string `code`, an HTTP status, and a
//! `retryable` flag. The wire shape matches spec §15:
//!
//! ```json
//! { "error": { "code": "principal_disabled", "message": "...",
//!              "request_id": "req_...", "retryable": false } }
//! ```

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;

/// The canonical error codes from spec §15.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    UnauthorizedHmacMissing,
    UnauthorizedHmacInvalid,
    UnauthorizedReplayDetected,
    ForbiddenAccountVmMismatch,
    InvalidRequest,
    InvalidPolicy,
    PrincipalNotFound,
    PrincipalDisabled,
    SessionNotFound,
    SessionAlreadyRunning,
    /// F6.3: a fleet set_task was refused because the session carries a live
    /// binding for another handle (or a stale generation of the same handle).
    BindingConflict,
    SynapsLaunchFailed,
    FsmonUnavailable,
    PolicyApplyFailed,
    /// VM-Sites app services (`/services/*`): unknown `serviceId`.
    ServiceNotFound,
    /// A `stop` carried a `generation` that is not the live one (fenced;
    /// the caller holds a stale record and must re-read status first).
    ServiceGenerationStale,
    /// The service is mid-transition (e.g. `stopping`) and cannot accept the
    /// requested operation yet — retry after the transition settles.
    ServiceBusy,
    /// The configured concurrent-service cap is reached.
    ServiceLimitExceeded,
    /// The child process could not be spawned (executable missing, exec
    /// refused, privilege drop failed…).
    ServiceStartFailed,
    /// `/artifacts/seal`: the output tree exceeds the requested/configured
    /// file-count or byte bounds.
    ArtifactBoundsExceeded,
    InternalError,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::UnauthorizedHmacMissing => "unauthorized_hmac_missing",
            ErrorCode::UnauthorizedHmacInvalid => "unauthorized_hmac_invalid",
            ErrorCode::UnauthorizedReplayDetected => "unauthorized_replay_detected",
            ErrorCode::ForbiddenAccountVmMismatch => "forbidden_account_vm_mismatch",
            ErrorCode::InvalidRequest => "invalid_request",
            ErrorCode::InvalidPolicy => "invalid_policy",
            ErrorCode::PrincipalNotFound => "principal_not_found",
            ErrorCode::PrincipalDisabled => "principal_disabled",
            ErrorCode::SessionNotFound => "session_not_found",
            ErrorCode::SessionAlreadyRunning => "session_already_running",
            ErrorCode::BindingConflict => "binding_conflict",
            ErrorCode::SynapsLaunchFailed => "synaps_launch_failed",
            ErrorCode::FsmonUnavailable => "fsmon_unavailable",
            ErrorCode::PolicyApplyFailed => "policy_apply_failed",
            ErrorCode::ServiceNotFound => "service_not_found",
            ErrorCode::ServiceGenerationStale => "service_generation_stale",
            ErrorCode::ServiceBusy => "service_busy",
            ErrorCode::ServiceLimitExceeded => "service_limit_exceeded",
            ErrorCode::ServiceStartFailed => "service_start_failed",
            ErrorCode::ArtifactBoundsExceeded => "artifact_bounds_exceeded",
            ErrorCode::InternalError => "internal_error",
        }
    }

    pub fn status(self) -> StatusCode {
        match self {
            ErrorCode::UnauthorizedHmacMissing
            | ErrorCode::UnauthorizedHmacInvalid
            | ErrorCode::UnauthorizedReplayDetected => StatusCode::UNAUTHORIZED,
            ErrorCode::ForbiddenAccountVmMismatch | ErrorCode::PrincipalDisabled => {
                StatusCode::FORBIDDEN
            }
            ErrorCode::InvalidRequest | ErrorCode::InvalidPolicy => StatusCode::BAD_REQUEST,
            ErrorCode::PrincipalNotFound
            | ErrorCode::SessionNotFound
            | ErrorCode::ServiceNotFound => StatusCode::NOT_FOUND,
            ErrorCode::SessionAlreadyRunning
            | ErrorCode::BindingConflict
            | ErrorCode::ServiceGenerationStale
            | ErrorCode::ServiceBusy => StatusCode::CONFLICT,
            ErrorCode::ServiceLimitExceeded => StatusCode::TOO_MANY_REQUESTS,
            ErrorCode::ArtifactBoundsExceeded => StatusCode::PAYLOAD_TOO_LARGE,
            ErrorCode::FsmonUnavailable => StatusCode::SERVICE_UNAVAILABLE,
            ErrorCode::SynapsLaunchFailed
            | ErrorCode::PolicyApplyFailed
            | ErrorCode::ServiceStartFailed
            | ErrorCode::InternalError => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    /// Whether the caller may safely retry the same request.
    /// `BindingConflict` is retryable BY DESIGN: the dispatch leg fails
    /// closed, the job row stays queued server-side, and the same directive
    /// may succeed once the live binding clears (result or teardown).
    /// `ServiceBusy` is retryable for the same reason: the transition it
    /// collided with (a stop draining) settles on its own.
    pub fn retryable(self) -> bool {
        matches!(
            self,
            ErrorCode::FsmonUnavailable
                | ErrorCode::InternalError
                | ErrorCode::BindingConflict
                | ErrorCode::ServiceBusy
        )
    }
}

/// A structured guest-agent error.
#[derive(Debug, Clone)]
pub struct GuestAgentError {
    pub code: ErrorCode,
    pub message: String,
    pub request_id: Option<String>,
}

impl GuestAgentError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            request_id: None,
        }
    }

    pub fn with_request_id(mut self, request_id: Option<String>) -> Self {
        self.request_id = request_id;
        self
    }

    pub fn invalid_request(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidRequest, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::InternalError, message)
    }
}

impl std::fmt::Display for GuestAgentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for GuestAgentError {}

#[derive(Serialize)]
struct ErrorBodyInner<'a> {
    code: &'a str,
    message: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    request_id: Option<&'a str>,
    retryable: bool,
}

#[derive(Serialize)]
struct ErrorBody<'a> {
    error: ErrorBodyInner<'a>,
}

impl IntoResponse for GuestAgentError {
    fn into_response(self) -> Response {
        let body = ErrorBody {
            error: ErrorBodyInner {
                code: self.code.as_str(),
                message: &self.message,
                request_id: self.request_id.as_deref(),
                retryable: self.code.retryable(),
            },
        };
        (self.code.status(), Json(body)).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_map_to_expected_status() {
        assert_eq!(ErrorCode::PrincipalDisabled.status(), StatusCode::FORBIDDEN);
        assert_eq!(
            ErrorCode::UnauthorizedReplayDetected.status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            ErrorCode::FsmonUnavailable.status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
    }

    #[test]
    fn fsmon_unavailable_is_retryable() {
        assert!(ErrorCode::FsmonUnavailable.retryable());
        assert!(!ErrorCode::InvalidPolicy.retryable());
    }

    #[test]
    fn service_codes_map_to_expected_status() {
        assert_eq!(ErrorCode::ServiceNotFound.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            ErrorCode::ServiceGenerationStale.status(),
            StatusCode::CONFLICT
        );
        assert_eq!(ErrorCode::ServiceBusy.status(), StatusCode::CONFLICT);
        assert_eq!(
            ErrorCode::ServiceLimitExceeded.status(),
            StatusCode::TOO_MANY_REQUESTS
        );
        assert_eq!(
            ErrorCode::ArtifactBoundsExceeded.status(),
            StatusCode::PAYLOAD_TOO_LARGE
        );
        assert_eq!(
            ErrorCode::ServiceStartFailed.status(),
            StatusCode::INTERNAL_SERVER_ERROR
        );
        assert!(ErrorCode::ServiceBusy.retryable());
        assert!(!ErrorCode::ServiceGenerationStale.retryable());
        assert_eq!(
            ErrorCode::ServiceGenerationStale.as_str(),
            "service_generation_stale"
        );
    }
}
