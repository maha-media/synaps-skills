# pria-workflow-tools

Workflow control for Pria agents, over the Capability Gateway.

The Workflows page is the human render of the Twin's tool surface: every button
a person can press there is a subject here. An agent holding this plugin can
manage **saved jobs** — list them, read their run receipts, create, edit, delete
and start them.

## Deliberate boundaries

- **Workflow control only.** No knowledge search, no vault access, no Twin
  reconfiguration. Those belong to the specialist agents a workflow *spawns*,
  not to the thing that starts them.
- **No tenancy in any schema.** Institution and user come from the machine
  principal server-side. The caller chooses *which of its own* workflows to
  operate on, never *whose*.
- **`delete_workflow` requires `confirm: true` and a `reason`.** The
  agent-native equivalent of a confirm modal — deletion has to be an explicit
  act, not a plausible next token. The reason lands in the audit row.
- **`run_workflow` is its own subject.** It spawns a session and spends
  credits, so an agent can hold the whole read+edit surface and still be unable
  to start anything. Withhold it in the allowlist when that is what you want.

## Honest reporting

- `run_workflow` may return `outcome: "reused"` — the agent was already
  running, so the saved instruction was **not** delivered. That is intentional:
  sending into a live session would be a mid-turn prompt injection.
- `list_workflow_runs` returns receipts exactly as persisted. An empty
  `terminalState` means *not yet observed*, not *still running*.
- `list_workflows` annotates rather than filters. A workflow whose agent has
  become unavailable is still listed and marked broken — an agent that cannot
  see a broken job cannot explain why it stopped running.

## Tools

| Tool | Subject | Notes |
|---|---|---|
| `list_workflows` | `WORKFLOW_LIST` | availability-annotated |
| `get_workflow` | `WORKFLOW_GET` | |
| `list_workflow_runs` | `WORKFLOW_LIST_RUNS` | read-only, no reconciliation write |
| `create_workflow` | `WORKFLOW_CREATE` | |
| `update_workflow` | `WORKFLOW_UPDATE` | partial; omitted fields retained |
| `delete_workflow` | `WORKFLOW_DELETE` | destructive, gated |
| `run_workflow` | `WORKFLOW_RUN` | spawns a session, spends credits |

## Config

| Key | Env | Default |
|---|---|---|
| `pria_api_base` | — | `https://pria.praxislxp.com` |
| `pria_agent_tool_token` | `PRIA_AGENT_TOOL_TOKEN` | — |

## Tests

```
python3 -m unittest discover -s tests
```
