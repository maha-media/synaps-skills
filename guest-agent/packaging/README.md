# Pria guest-agent packaging (spec §7.1–§7.3, §11)

These are the **runtime/systemd contract artifacts** the Track A image build
(`agentic-vm:image:build`) installs into a guest image so that `doctor --deep`
and the local-virsh E2E can prove the guest-agent, fsmon, and KasmVNC actually
run inside the VM. They are authored here in `synaps-skills` because Track B
(the Rust guest-agent) owns in-VM process supervision and KasmVNC lifecycle
(spec §5 "Repository responsibilities").

## Contents

| Path | Purpose | Spec |
|------|---------|------|
| `systemd/pria-guest-agent.service` | supervises `/usr/local/sbin/pria-guest-agent` | §7.2 |
| `systemd/synaps-fsmon.service` | supervises the fsmon daemon | §7.2 |
| `systemd/kasmvnc@.service` | per-user KasmVNC desktop template | §7.2 |
| `bin/pria-kasm-setpw` | sets the KasmVNC Basic-auth password (env/file only, never argv) | §7.3 |
| `install.sh` | installs the units + helper into a guest rootfs | §11.2 |

## Security invariants (frozen — see `tests/packaging_tests.rs`)

These are asserted by `tests/packaging_tests.rs` so they cannot silently
regress (HS-G1):

1. `kasmvnc@.service` reads its env via `EnvironmentFile=/run/pria/kasmvnc/%i.env`
   and **never** carries the VNC password on the `ExecStart` argv. Only the
   non-secret `KASM_DISPLAY`, `KASM_GEOMETRY`, `KASM_WS_PORT` are interpolated.
2. The password is delivered to `kasmvncpasswd`/`vncpasswd` over **stdin**, never
   as a command-line argument.
3. `pria-kasm-setpw` never echoes the password value to stdout/stderr.
4. `pria-guest-agent.service` is gated on `/etc/pria/guest-agent.yaml` and
   `/etc/pria/guest-agent.hmac` so it cannot start without its bootstrap.

## What is NOT in this image layer

Per spec §11.2/§11.3 and HS-P2, the per-VM HMAC secret
(`/etc/pria/guest-agent.hmac`, mode 0600) and any OAuth credential material
(`~/.synaps-cli/auth.json` for the `openai-codex` provider) are injected only via
the per-VM NoCloud seed / runtime bootstrap — **never baked into the base
image**. `virt-sysprep` runs after `install.sh` to guarantee this.

## OAuth credential contract (spec §11.3, §8 G8)

The real Synaps usage call uses the OpenAI **Codex / GPT-5.5** OAuth path that
SynapsCLI already implements (`crates/agent-core/src/core/auth/openai_codex.rs`,
provider key `openai-codex`, model shorthand `openai-codex/gpt-5.5`). The
bootstrap delivers an `auth.json` containing the `openai-codex` credential to the
per-user SynapsCLI base dir; the guest-agent launches `synaps` with
`SYNAPS_BASE_DIR` (or `HOME`) pointing at that per-user dir so SynapsCLI's
`resolve_read_path("auth.json")` finds it. **Anthropic OAuth must not be used**
(spec §2.13). No SynapsCLI change is required for this path.
