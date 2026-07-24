# pria-vault-medic-plugin

Self-healing IP Vault triage loop for Pria in-VM agents.

## What it does

Implements the **VAULT MEDIC** sense → diagnose → repair → verify loop:

1. **`vault_health`** — grade the vault (letter A–F, 0–100 score, factor breakdown)
2. **`vault_diagnose`** — list every broken/unhealthy file, classified by issue type, with recommended repair verbs
3. **`vault_repair`** — apply a repair verb (requeue|reload|reingest) with **dry_run=true by default**
4. **`vault_regrade`** — re-run vault_health post-repair to confirm improvement

## Issue types detected

| Type | Description | Recommended Fix |
|------|-------------|-----------------|
| `error` | Ingestion failed | requeue |
| `stale_url` | File missing from disk / source URL gone | reingest |
| `unindexed` | Ingestion started but stuck >24h | requeue |
| `unscanned` | Never quality-scored (garbageScore=null) | requeue |
| `deleted` | Soft-deleted file | Manual removal |
| `never_used` | 0 RAG hits after 7 days | Manual review |

## Auth

Identical to pria-tools-plugin: `PRIA_API_KEY` env var → `POST /api/auth/api-key-signin` → JWT cached per session.

```bash
export PRIA_API_KEY="pria_..."
```

## Running tests

```bash
bash scripts/test.sh
```

## Live smoke test (read-only)

```bash
PRIA_API_KEY=pria_... python3 scripts/smoke.py --base https://priastaging.praxislxp.com
```

## Live smoke with repair (⚠️ staging only)

```bash
PRIA_API_KEY=pria_... python3 scripts/smoke.py \
  --base https://priastaging.praxislxp.com \
  --allow-repair \
  --upload-id <upload_id_from_diagnose> \
  --verb requeue
```

## Safety

- `vault_repair` defaults to `dry_run=true` — no mutations without explicit opt-in
- All HTTP mocked in tests — no live calls during `test.sh`
- API key never logged, printed, or committed
- No pip dependencies — stdlib urllib only
