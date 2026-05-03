//! Compile-time build info reporting for the voice sidecar.
//!
//! Used by Synaps CLI to detect which backend the sidecar binary was
//! compiled with (cpu / cuda / metal / vulkan / openblas) and surface
//! the choice in `/settings`.

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct BuildInfo {
    pub backend: &'static str,
    pub features: Vec<&'static str>,
    pub version: &'static str,
}

/// Resolve the active backend from a set of compile-time feature flags.
///
/// Priority: cuda > metal > vulkan > openblas > cpu.
pub fn resolve_backend(cuda: bool, metal: bool, vulkan: bool, openblas: bool) -> &'static str {
    if cuda {
        "cuda"
    } else if metal {
        "metal"
    } else if vulkan {
        "vulkan"
    } else if openblas {
        "openblas"
    } else {
        "cpu"
    }
}

/// Build the high-level feature list reported to Synaps.
pub fn resolve_features(
    local_stt: bool,
    cuda: bool,
    metal: bool,
    vulkan: bool,
    openblas: bool,
) -> Vec<&'static str> {
    let mut features = Vec::new();
    if local_stt {
        features.push("local-stt");
    } else {
        features.push("mock-only");
    }
    if cuda {
        features.push("cuda");
    }
    if metal {
        features.push("metal");
    }
    if vulkan {
        features.push("vulkan");
    }
    if openblas {
        features.push("openblas");
    }
    features
}

/// Collect the [`BuildInfo`] for this binary using `cfg!` checks.
pub fn current() -> BuildInfo {
    let cuda = cfg!(feature = "cuda");
    let metal = cfg!(feature = "metal");
    let vulkan = cfg!(feature = "vulkan");
    let openblas = cfg!(feature = "openblas");
    let local_stt =
        cfg!(feature = "voice-stt-whisper") && cfg!(feature = "voice-mic");

    BuildInfo {
        backend: resolve_backend(cuda, metal, vulkan, openblas),
        features: resolve_features(local_stt, cuda, metal, vulkan, openblas),
        version: env!("CARGO_PKG_VERSION"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backend_priority_cuda_wins() {
        assert_eq!(resolve_backend(true, true, true, true), "cuda");
    }

    #[test]
    fn backend_priority_metal_over_vulkan() {
        assert_eq!(resolve_backend(false, true, true, true), "metal");
    }

    #[test]
    fn backend_priority_vulkan_over_openblas() {
        assert_eq!(resolve_backend(false, false, true, true), "vulkan");
    }

    #[test]
    fn backend_openblas() {
        assert_eq!(resolve_backend(false, false, false, true), "openblas");
    }

    #[test]
    fn backend_default_cpu() {
        assert_eq!(resolve_backend(false, false, false, false), "cpu");
    }

    #[test]
    fn features_mock_only_when_no_local_stt() {
        let f = resolve_features(false, false, false, false, false);
        assert_eq!(f, vec!["mock-only"]);
    }

    #[test]
    fn features_local_stt() {
        let f = resolve_features(true, false, false, false, false);
        assert_eq!(f, vec!["local-stt"]);
    }

    #[test]
    fn features_local_stt_with_cuda() {
        let f = resolve_features(true, true, false, false, false);
        assert_eq!(f, vec!["local-stt", "cuda"]);
    }

    #[test]
    fn features_all_accelerators_listed() {
        let f = resolve_features(true, true, true, true, true);
        assert_eq!(f, vec!["local-stt", "cuda", "metal", "vulkan", "openblas"]);
    }

    #[test]
    fn json_shape_default_cpu_mock_only() {
        let info = BuildInfo {
            backend: resolve_backend(false, false, false, false),
            features: resolve_features(false, false, false, false, false),
            version: "0.1.0",
        };
        let s = serde_json::to_string(&info).unwrap();
        assert_eq!(
            s,
            r#"{"backend":"cpu","features":["mock-only"],"version":"0.1.0"}"#
        );
    }

    #[test]
    fn json_shape_local_stt_cpu() {
        let info = BuildInfo {
            backend: resolve_backend(false, false, false, false),
            features: resolve_features(true, false, false, false, false),
            version: "0.1.0",
        };
        let s = serde_json::to_string(&info).unwrap();
        assert_eq!(
            s,
            r#"{"backend":"cpu","features":["local-stt"],"version":"0.1.0"}"#
        );
    }

    #[test]
    fn current_uses_pkg_version() {
        let info = current();
        assert_eq!(info.version, env!("CARGO_PKG_VERSION"));
    }
}
