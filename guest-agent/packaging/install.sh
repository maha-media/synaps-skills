#!/usr/bin/env bash
# install.sh — install the Pria guest-agent runtime contract artifacts into a
# guest image (spec §7.1, §7.2, §11.2). Idempotent; safe to re-run.
#
# This is invoked by the Track A image build (`agentic-vm:image:build`) inside
# the guest rootfs (e.g. via virt-customize / chroot). It installs:
#   * systemd units: pria-guest-agent.service, synaps-fsmon.service,
#     kasmvnc@.service
#   * the pria-kasm-setpw helper
#   * the /etc/pria and /run/pria directory contract
#
# It does NOT inject any per-VM HMAC secret or OAuth credential — those are
# delivered only via the per-VM NoCloud seed / runtime bootstrap (spec §11.2,
# §11.3). virt-sysprep must run after this to guarantee the base image is clean.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESTDIR="${DESTDIR:-}"
SBIN_DIR="${DESTDIR}/usr/local/sbin"
UNIT_DIR="${DESTDIR}/etc/systemd/system"
ETC_PRIA="${DESTDIR}/etc/pria"

echo "[pria] installing guest-agent runtime contract -> ${DESTDIR:-/}"

install -d -m 0755 "${SBIN_DIR}" "${UNIT_DIR}" "${ETC_PRIA}"

# systemd units (spec §7.2).
for unit in pria-guest-agent.service synaps-fsmon.service kasmvnc@.service; do
  install -m 0644 "${SCRIPT_DIR}/systemd/${unit}" "${UNIT_DIR}/${unit}"
  echo "[pria]   unit  ${unit}"
done

# helper binaries (spec §7.2 ExecStartPre + §11.2).
install -m 0755 "${SCRIPT_DIR}/bin/pria-kasm-setpw" "${SBIN_DIR}/pria-kasm-setpw"
echo "[pria]   sbin  pria-kasm-setpw"

# The guest-agent binary itself is built by the image build and copied to
# /usr/local/sbin/pria-guest-agent; we only assert the destination dir exists.
# /run/pria is a tmpfs path created at boot by the units' RuntimeDirectory or by
# the guest-agent; /etc/pria holds the per-VM bootstrap (config + hmac), 0700.
chmod 0755 "${ETC_PRIA}"

# Enable the persistent units. synaps-fsmon.service is intentionally NOT enabled:
# fsmon runs on demand (the guest-agent spawns it over the narrow account EFS
# mount via ensure_running) — a boot-time whole-`/` fanotify mark deadlocks the
# guest. The kasmvnc@ template is also started on demand.
if command -v systemctl >/dev/null 2>&1 && [ -z "${DESTDIR}" ]; then
  systemctl daemon-reload || true
  systemctl enable pria-guest-agent.service || true
fi

echo "[pria] guest-agent runtime contract installed"
