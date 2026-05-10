# synaps-workspace — Ubuntu 22.04 desktop container
# Ubuntu 22.04 + Xvfb + Openbox + Chromium + KasmVNC + (optional) synaps Rust binary
#
# Build args:
#   KASMVNC_VERSION   — KasmVNC release tag (default: 1.3.2)
#   SYNAPS_BIN_URL    — URL to a prebuilt linux-x64 synaps tarball (optional)
#                       If unset a placeholder /usr/local/bin/synaps is installed.
#
# Spec: docs/plans/PLATFORM.SPEC.md §3.4, §5

ARG KASMVNC_VERSION=1.3.2

# ---------------------------------------------------------------------------
# Stage: base system
# ---------------------------------------------------------------------------
FROM ubuntu:22.04 AS base

ENV DEBIAN_FRONTEND=noninteractive \
    TZ=Etc/UTC

# System packages — ordered for layer-cache efficiency
# hadolint ignore=DL3008
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      dbus-x11 \
      fonts-dejavu-core \
      libnss3 \
      openbox \
      openssl \
      sudo \
      unzip \
      xterm \
      xvfb \
      chromium-browser \
 && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Stage: KasmVNC install
# ---------------------------------------------------------------------------
FROM base AS kasmvnc

ARG KASMVNC_VERSION

# Download the official KasmVNC .deb for Ubuntu 22.04 (jammy) amd64 and install
# dpkg -i will exit non-zero on missing deps; apt-get install -fy resolves them.
RUN KASM_DEB="kasmvncserver_jammy_${KASMVNC_VERSION}_amd64.deb" \
 && KASM_URL="https://github.com/kasmtech/KasmVNC/releases/download/v${KASMVNC_VERSION}/${KASM_DEB}" \
 && echo "Downloading KasmVNC ${KASMVNC_VERSION} from ${KASM_URL}" \
 && curl -fsSL "${KASM_URL}" -o "/tmp/${KASM_DEB}" \
 && dpkg -i "/tmp/${KASM_DEB}" || apt-get install -fy --no-install-recommends \
 && rm -f "/tmp/${KASM_DEB}" \
 && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Stage: synaps binary (optional)
# ---------------------------------------------------------------------------
FROM kasmvnc AS synaps_bin

ARG SYNAPS_BIN_URL

# If SYNAPS_BIN_URL is provided, download and extract the tarball.
# Expects a .tar.gz containing a `synaps` ELF binary at the archive root or
# in a top-level `bin/` directory; both locations are checked.
# If SYNAPS_BIN_URL is empty, a placeholder script is installed instead.
# The placeholder exits 1 so that an unintentional `docker exec … synaps rpc`
# surfaces a clear error rather than silently hanging.
RUN if [ -n "${SYNAPS_BIN_URL}" ]; then \
      echo "Downloading synaps binary from ${SYNAPS_BIN_URL}" ; \
      curl -fsSL "${SYNAPS_BIN_URL}" -o /tmp/synaps.tar.gz ; \
      mkdir -p /tmp/synaps_extract ; \
      tar -xzf /tmp/synaps.tar.gz -C /tmp/synaps_extract ; \
      if [ -f /tmp/synaps_extract/synaps ]; then \
        install -m 0755 /tmp/synaps_extract/synaps /usr/local/bin/synaps ; \
      elif [ -f /tmp/synaps_extract/bin/synaps ]; then \
        install -m 0755 /tmp/synaps_extract/bin/synaps /usr/local/bin/synaps ; \
      else \
        echo "ERROR: synaps binary not found in tarball" >&2 ; exit 1 ; \
      fi ; \
      rm -rf /tmp/synaps.tar.gz /tmp/synaps_extract ; \
    else \
      printf '#!/usr/bin/env bash\necho "synaps binary not installed at build time" >&2\nexit 1\n' \
        > /usr/local/bin/synaps ; \
      chmod 0755 /usr/local/bin/synaps ; \
    fi

# ---------------------------------------------------------------------------
# Stage: final image
# ---------------------------------------------------------------------------
FROM synaps_bin AS final

# Copy the entrypoint script (written as a separate file; ensure +x via git)
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh

# Non-root user
RUN useradd -m -s /bin/bash agent \
 && echo "agent ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/agent \
 && chmod 0440 /etc/sudoers.d/agent

# KasmVNC needs a user config directory to write its session files
RUN mkdir -p /home/agent/.vnc \
 && chown -R agent:agent /home/agent

WORKDIR /home/agent
USER agent

EXPOSE 6901

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
