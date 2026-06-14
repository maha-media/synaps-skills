# pria-session-context-plugin

In-VM Synaps integration for **Pria account-owned agentic VMs** (Track B of the
2026-06-14 account-instance-agentic-vm spec). A SynapsCLI **process extension**
that:

- loads the control-plane **session context** delivered as a *file keyed by
  `session_id`* (never via env var — see HS-2 in `docs/contract.md`),
- **tags** every audit/policy/credential record it emits with
  `account_id / instance_id / user_id / vm_id / session_id / linux_uid / roles`,
- **gates tool calls** (`before_tool_call`) — shell, subagent, file-write tools,
  credential tools — with `Block` / `Confirm` / `Modify`,
- forwards a **multi-sink audit** stream (local JSONL spool + Pria ingest POST),
- requests credentials through the **Pria credential broker** (no static secrets),
- propagates a `tool_call_id` for **plugin-owned** network tools (egress
  correlation, partial — see HS-4).

> **No SynapsCLI core changes.** This plugin uses only the existing closed
> `HookKind` set (`before_tool_call`, `after_tool_call`, `before_message`,
> `on_session_start`, `on_session_end`) and existing permissions
> (`tools.intercept`, `session.lifecycle`, `privacy.llm_content`,
> `tools.register`). The Rust file-write monitor ships separately as a **sibling
> daemon** (`pria-fsmon-plugin`), not a Synaps-managed sidecar.

## Layout

```
.synaps-plugin/plugin.json      manifest (extension block)
extensions/context.py           entry point (JSON-RPC stdio loop)
extensions/pria/                package: runtime, app, sessionctx, audit, policy, credential
docs/contract.md                frozen B0 session-context + audit contract
docs/*.schema.json              JSON schemas
scripts/test.sh                 validate + unit tests + stdio smoke
tests/                          python unittest suite
```

## Build / verify

```bash
bash scripts/test.sh
# or from the repo root:
bash install.sh --check
```

## Configuration

The plugin resolves runtime settings from the **session context file** first,
then plugin **config** (`plugin.json` `config[]` / user config):

| Setting | Context field | Config key | Purpose |
|---------|---------------|------------|---------|
| Ingest endpoint | `ingest_url` | `ingest_url` | Pria audit ingest POST |
| Ingest token | `ingest_token` | `ingest_token` (`PRIA_INGEST_TOKEN`) | bearer auth |
| Credential broker | `credential_broker_url` | `credential_broker_url` | token issue/revoke |
| Audit spool | — | `audit_spool_file` | local JSONL spool path |

See `docs/contract.md` for the authoritative schemas.
