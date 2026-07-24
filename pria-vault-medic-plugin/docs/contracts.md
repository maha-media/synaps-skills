# Pria API Contracts — pria-vault-medic-plugin

Verified by live probing staging (`priastaging.praxislxp.com`) during build.
Read-only endpoints probed live. Write endpoints probed via OPTIONS only (HTTP 204).

---

## Auth: `POST /api/auth/api-key-signin`

Identical to pria-tools-plugin. See that plugin's `docs/contracts.md`.
Key sent as `x-api-key` header; JWT returned; used as `x-access-token` on data calls.

---

## 1. Vault Health Summary — `POST /api/user/uploads/vault-health-summary`

**Validated live on staging: returned grade C, score 71.**

**Request:**
```json
{ "vault": "personal" }
```

**Response 200:**
```json
{
  "success": true,
  "summary": {
    "totalCount": 5,
    "activeCount": 3,
    "usedCount": 0,
    "processingCount": 0,
    "errorCount": 2,
    "neverUsedCount": 4,
    "staleCount": 0,
    "unscannedCount": 1,
    "unoptimizedCount": 0,
    "unindexedCount": 0,
    "missingTerminalCount": 0,
    "staleBaseUrlCount": 0
  },
  "grade": {
    "letter": "C",
    "score": 71,
    "factors": [
      { "key": "errorCount", "count": 2, "impact": 20, "label": "Files in error state" },
      { "key": "neverUsedCount", "count": 4, "impact": 8, "label": "Never retrieved in RAG (>7d old)" },
      { "key": "unscannedCount", "count": 1, "impact": 1, "label": "Never scored at ingest" }
    ]
  }
}
```

**Contract notes:**
- `vault` field is required in body (omitting it returns 400).
- `grade.score` is 0–100; `grade.letter` is A–F.
- `factors` lists only the penalized dimensions (healthy dims not included).

---

## 2. Upload List — `POST /api/user/uploads`

Used by vault_diagnose to fetch all files and classify them client-side.

**Request:**
```json
{ "limit": 100, "offset": 0 }
```

**Response 200:**
```json
{
  "success": true,
  "data": [
    {
      "_id": "...",
      "filename": "...",
      "originalname": "...",
      "mimetype": "...",
      "created": "2026-04-23T08:54:19.194Z",
      "filesize": 47,
      "status": "selected|active|deleted|error",
      "file_url": "https://...|null",
      "fileOnDisk": true,
      "ragHitCount": 0,
      "lastRagHitAt": null,
      "vaultHealthScore": 0,
      "garbageScore": 0.1,
      "file_title": "...",
      "file_summary": "...",
      "ingestion": {
        "phase": "done|error|queued|processing|embedding",
        "progress": 100,
        "attempts": 1,
        "lastError": "...|null",
        "errorClass": "...|null",
        "enqueuedAt": "...",
        "startedAt": "...",
        "completedAt": "..."
      },
      "institution": "...|null",
      "account_shared": false,
      "is_private": false,
      "collection": "...|null",
      "collection_path": []
    }
  ]
}
```

**Contract surprises:**
- `ragHitCount` only present on newer uploads (not on images/old records). Treat `undefined` as `null`.
- `fileOnDisk: false` means the binary was GC'd from the host (stale source).
- `garbageScore` is `null` on images and old files never quality-scanned. NOT the same as 0.0.
- `status: "deleted"` files still appear in the list (soft delete).
- `ingestion.phase` has at least: `done`, `error`, `queued`, `processing`, `embedding`, `""`/null.
- No server-side health filtering — client must classify uploads locally.

---

## 3. Repair Verbs (WRITE — not probed live during build)

All three endpoints confirmed reachable (OPTIONS → 204) on staging.

### `POST /api/user/uploads/re-queue-an-existing-file-for-ingestion`
```json
{ "uploadId": "<_id>" }
```
Expected response: `{ "success": true, "message": "..." }`

### `POST /api/user/uploads/reload-file-content`
```json
{ "uploadId": "<_id>" }
```
Expected response: `{ "success": true, "message": "..." }`

### `POST /api/user/uploads/re-ingest-file-from-source-url`
```json
{ "uploadId": "<_id>", "sourceUrl": "https://..." }
```
Expected response: `{ "success": true, "message": "..." }`

**Safety note:** These endpoints are mutating. The plugin's `vault_repair` tool
defaults to `dry_run=true` and only calls these when `dry_run=false` is explicitly set.

---

## Issue Classification Logic

The plugin classifies uploads client-side since there is no server-side
"list unhealthy files" endpoint. Classification priority (highest first):

| Priority | Issue Type  | Condition                                                      | Recommended Verb |
|----------|-------------|----------------------------------------------------------------|-----------------|
| 1        | `error`     | `ingestion.phase == "error"`                                   | requeue          |
| 2        | `stale_url` | `fileOnDisk == false` AND `status != "deleted"`                | reingest         |
| 3        | `deleted`   | `status == "deleted"`                                          | (none)           |
| 4        | `unindexed` | `phase not in (done, error)` AND file enqueued >24h ago        | requeue          |
| 5        | `unscanned` | `garbageScore is null` AND non-image AND `phase == done`       | requeue          |
| 6        | `never_used`| `ragHitCount == 0` AND `created > 7d ago` AND `phase == done` | (none)           |

---

## Endpoint Availability Summary

| Endpoint                                            | Method | Status      | Used by        |
|-----------------------------------------------------|--------|-------------|----------------|
| `/api/user/uploads/vault-health-summary`            | POST   | ✅ LIVE     | vault_health, vault_regrade |
| `/api/user/uploads`                                 | POST   | ✅ LIVE     | vault_diagnose  |
| `/api/user/uploads/re-queue-an-existing-file-for-ingestion` | POST | ✅ 204 OPTIONS | vault_repair(requeue) |
| `/api/user/uploads/reload-file-content`             | POST   | ✅ 204 OPTIONS | vault_repair(reload) |
| `/api/user/uploads/re-ingest-file-from-source-url` | POST   | ✅ 204 OPTIONS | vault_repair(reingest) |
| `/api/user/ip-vault`                                | POST   | ⚠️ returns IP | NOT USED |
| `/api/user/uploads/scan-vault-uploads-for-content-quality` | POST | ⚠️ empty response | NOT USED |
