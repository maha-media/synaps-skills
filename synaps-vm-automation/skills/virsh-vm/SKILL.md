# virsh-vm

Use `synaps-vm-automation/scripts/vmctl.py` for host-side VM lifecycle and discovery. Prefer JSON output from the script over raw `virsh` parsing.

## Common commands

```bash
python synaps-vm-automation/scripts/vmctl.py list
python synaps-vm-automation/scripts/vmctl.py status <vm>
python synaps-vm-automation/scripts/vmctl.py start <vm>
python synaps-vm-automation/scripts/vmctl.py shutdown <vm>
python synaps-vm-automation/scripts/vmctl.py reboot <vm>
python synaps-vm-automation/scripts/vmctl.py snapshot-list <vm>
python synaps-vm-automation/scripts/vmctl.py agent-call <vm> /health
```

`status <vm>` reports plugin version, minimum compatible guest-agent version, domain state, IP candidates, QEMU guest-agent ping, display URI, and resident agent health/version when reachable.

## Safety rules

Require explicit user confirmation before destructive operations:

- hard poweroff / `virsh destroy`
- reset
- snapshot delete
- disk mutation
- snapshot revert when data loss is possible

Use graceful `shutdown --mode=agent` and `reboot --mode=agent` first. Batch predictable agent operations into a plan instead of doing observe/click loops.
