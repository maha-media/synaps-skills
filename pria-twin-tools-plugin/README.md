# Pria Twin Tools

A narrow, gateway-backed Synaps extension for Pria's Twin Improvement Loop.

## Tools

- `read_twin_profile` — safe Twin/vault readiness projection
- `create_twin_improvement_proposal` — persists a proposal; never changes a Twin
- `get_twin_improvement_run` — reads a proposal/evaluation/insight receipt
- `create_twin_evaluation` — creates a bounded manual evaluation matrix
- `create_conversation_insights` — returns aggregate-only metrics for an authorized date range

## Safety

All calls use the Pria capability gateway with a scoped bearer token. The extension does not receive database credentials or raw user API keys. It cannot change configuration, vault content, guardrails, or public launch state. Conversation insights never return raw conversation text.

## Test

```bash
python3 -m unittest discover -s tests -v
python3 -m py_compile main.py twin_tools.py
python3 -m json.tool .synaps-plugin/plugin.json >/dev/null
```
