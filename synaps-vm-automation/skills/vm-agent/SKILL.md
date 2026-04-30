# vm-agent

Use the resident `synaps-vm-agent` inside the guest for fast local execution of behavior-tree plans. The canonical plan schema is `synaps-vm-agent/schema/plan-v0.schema.json`; do not invent a separate protocol.

## Plan DSL v0

Node statuses: `SUCCESS`, `FAILURE`, `RUNNING`, `TIMEOUT`, `RETRY`, `BLOCKED`.

Node types: `action`, `sequence`, `selector`, `retry`, `wait_until`, `parallel_race`, `parallel_all`, `set_blackboard`, `condition`.

Use blackboard references like `$message` in later action args.

## Strategy

Submit multi-step predictive plans when state transitions are predictable. Let the guest agent handle waits, retries, selector cascades, and trace capture locally. Re-observe only at decision boundaries or after structured failure.

Example plan lives at `synaps-vm-automation/examples/notepad-plan.json`.
