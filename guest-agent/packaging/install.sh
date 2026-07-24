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

# Install the versioned Pria extension bundles into the base image.  These must
# be baked during image construction: a session only stages links to this path,
# so patching a running VM cannot repair a process that already rejected a
# manifest.  Refuse a mismatched protocol rather than baking a latent failure.
PLUGIN_SOURCE="${PRIA_EXTENSION_BUNDLE_DIR:-/tmp/pria-extension-bundles}"
PLUGIN_DEST="${DESTDIR}/opt/synaps/plugins"
if [ "${PRIA_SKIP_EXTENSION_BUNDLES:-0}" != "1" ]; then
for plugin in pria-tools-plugin pria-vault-medic-plugin; do
  src="${PLUGIN_SOURCE}/${plugin}"
  dest_name="${plugin%-plugin}"
  manifest="${src}/.synaps-plugin/plugin.json"
  [ -f "${manifest}" ] || { echo "[pria] missing extension manifest: ${manifest}" >&2; exit 1; }
  protocol="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["extension"]["protocol_version"])' "${manifest}")"
  [ "${protocol}" = "1" ] || { echo "[pria] refusing extension ${plugin}: protocol_version=${protocol}, Synaps supports 1" >&2; exit 1; }
  rm -rf "${PLUGIN_DEST:?}/${dest_name}"
  install -d -m 0755 "${PLUGIN_DEST}"
  cp -a "${src}" "${PLUGIN_DEST}/${dest_name}"
  echo "[pria]   extension ${dest_name} protocol=v${protocol}"
done
else
  echo "[pria]   extension bundles installed by image builder"
fi

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
