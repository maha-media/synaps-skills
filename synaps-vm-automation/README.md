# Synaps VM Automation

Host-side Synaps plugin for controlling libvirt/virsh VMs and submitting predictive behavior-tree plans to the resident `synaps-vm-agent` guest service.

## Development contract

Canonical schemas live in the adjacent agent repo:

```text
~/Projects/Maha-Media/synaps-vm-agent/schema/
```

Set `SYNAPS_VM_AGENT_DEV_ROOT` to override schema/example lookup in local development. This plugin declares minimum compatible agent version `0.1.0` in `.synaps-plugin/plugin.json`.

## Scripts

```bash
python scripts/vmctl.py list
python scripts/vmctl.py status windows11
python scripts/vmctl.py start windows11
python scripts/vmctl.py shutdown windows11
python scripts/vmctl.py snapshot-list windows11
python scripts/vmctl.py agent-call windows11 /health
```

Destructive operations such as snapshot revert require explicit confirmation flags and should only be used after user confirmation.
