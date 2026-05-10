# docker-bake.hcl — synaps-workspace image build targets
#
# Usage:
#   docker buildx bake             # builds default target (tagged 0.1.0 + latest)
#   docker buildx bake dev         # builds dev target (tagged :dev)
#   docker buildx bake --push      # builds + pushes to registry
#
# Set KASMVNC_VERSION to override the pinned release, e.g.:
#   KASMVNC_VERSION=1.3.3 docker buildx bake
#
# Set SYNAPS_BIN_URL to inject a prebuilt synaps Rust binary tarball:
#   SYNAPS_BIN_URL=https://… docker buildx bake dev
#
# Spec: docs/plans/PLATFORM.SPEC.md §3.4, §5

variable "KASMVNC_VERSION" {
  default = "1.3.2"
}

variable "SYNAPS_BIN_URL" {
  default = ""
}

# ---------------------------------------------------------------------------
# Default target — production image
# ---------------------------------------------------------------------------
target "default" {
  dockerfile = "Dockerfile"
  context    = "."
  platforms  = ["linux/amd64"]
  # arm64 deferred: KasmVNC arm64 .deb naming differs and needs validation
  tags = [
    "synaps/workspace:0.1.0",
    "synaps/workspace:latest",
  ]
  args = {
    KASMVNC_VERSION = KASMVNC_VERSION
    SYNAPS_BIN_URL  = SYNAPS_BIN_URL
  }
  labels = {
    "org.opencontainers.image.title"       = "synaps-workspace"
    "org.opencontainers.image.description" = "Ubuntu 22.04 desktop workspace for Synaps agents (KasmVNC)"
    "org.opencontainers.image.version"     = "0.1.0"
    "org.opencontainers.image.source"      = "https://github.com/maha-media/synaps-skills"
  }
}

# ---------------------------------------------------------------------------
# Dev target — inherits default, tagged :dev for local iteration
# ---------------------------------------------------------------------------
target "dev" {
  inherits = ["default"]
  tags = [
    "synaps/workspace:dev",
  ]
}
