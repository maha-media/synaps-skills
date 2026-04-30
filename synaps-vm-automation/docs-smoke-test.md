# Windows VM end-to-end smoke test

Use this checklist from the host. Record actual outputs in the task notes.

1. Start from known baseline:
   ```bash
   python synaps-vm-automation/scripts/vmctl.py snapshot-list <vm>
   ```
   If a clean baseline snapshot exists, revert only after explicit confirmation. If not, record that no baseline exists.

2. Verify/start VM:
   ```bash
   python synaps-vm-automation/scripts/vmctl.py status <vm>
   python synaps-vm-automation/scripts/vmctl.py start <vm>
   ```

3. Verify QEMU guest agent and resident agent health:
   ```bash
   python synaps-vm-automation/scripts/vmctl.py status <vm>
   python synaps-vm-automation/scripts/vmctl.py agent-call <vm> /health
   ```

4. Create a pre-test snapshot:
   ```bash
   python synaps-vm-automation/scripts/vmctl.py snapshot-create <vm> pre-synaps-smoke --description "Before Synaps VM automation smoke"
   ```

5. Security checks:
   - Confirm default agent bind is localhost in the guest config.
   - From unintended hosts/interfaces, verify the agent is not reachable.
   - Verify unauthorized protected request fails:
     ```bash
     curl -i http://<guest-ip>:8765/capabilities
     ```
   - Verify token-authenticated request succeeds:
     ```bash
     curl -i -H "Authorization: Bearer $SYNAPS_VM_AGENT_TOKEN" http://<guest-ip>:8765/capabilities
     ```

6. Run Notepad plan:
   ```bash
   python synaps-vm-automation/scripts/vmctl.py agent-call <vm> /plan/run --method POST --body "$(cat synaps-vm-automation/examples/notepad-plan.json)"
   python synaps-vm-automation/scripts/vmctl.py agent-call <vm> /plan/status/<plan-id>
   python synaps-vm-automation/scripts/vmctl.py agent-call <vm> /plan/trace/<plan-id>
   ```

7. Commit memory note:
   ```bash
   python synaps-vm-automation/scripts/memory.py commit --kind lesson --text "Smoke test result: ... include security checks and trace summary."
   ```

8. Cleanup/revert if needed:
   ```bash
   python synaps-vm-automation/scripts/vmctl.py shutdown <vm>
   # or confirmed revert:
   python synaps-vm-automation/scripts/vmctl.py snapshot-revert <vm> pre-synaps-smoke --yes
   ```
