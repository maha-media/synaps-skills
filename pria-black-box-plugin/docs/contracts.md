# pria-black-box-plugin: API contracts and surprises

## Confirmed endpoint contracts

### POST /api/user/histories
- Request: `{ limit, historyId?, search?, allInstitutions?, ... }`
- Returns `{ data: HistoryRecord[] }` — sorted oldest-first after server reversal
- Observability fields on HistoryRecord:
  - `hasRagSearch: bool` — true if retrieval ran and produced ≥1 segment
  - `ragSearchCount: int` — segment count summary
  - `ragSearchMode: "RAG" | "KAG"` — retrieval mode used
  - `hasThinking: bool` — true if reasoning rounds exist
  - `thinkingCount: int` — number of reasoning rounds
  - `latencyMs: int` — end-to-end response latency
  - `ragDurationMs: int` — vector search duration
  - `credits: int` — credits consumed
  - `cached: int` — cached tokens used
  - `conversation_model: string` — model identifier

### GET /api/user/history/{id}/ragSearch
- Returns `{ success: bool, ragSearch: Segment[] }`
- Segment fields: `uploadId, originalname, chunkIndex, score, length, mode, chunkText, confidential`
- **Confidential behaviour**: when original chunk exceeds the preview cap, Pria
  returns `≤100 chars + "(rest is confidential)"` suffix AND `confidential: true`.
  Agents MUST NOT attempt to reconstruct the hidden text.
- `mode` is `"RAG"` or `"KAG"` per-segment (not global to the turn).
- `length` is the pre-redaction original chunk length in chars.

### GET /api/user/history/{id}/thinking
- Returns `{ success: bool, thinking: ThinkingRound[] }`
- Round fields: `id, round, text, signature, model, durationMs`

### POST /api/user/uploads/files-with-issues
- Request: `{ vault: "personal"|"instance"|"account", institution? }`
- Returns `{ success: bool, files: FileIssue[] }`
- Issue classification (first match wins):
  `missing_terminal > missing_file > unindexed > stale_base_url > unoptimized > error > never_used > stale`
- Used as source-health overlay: match on `_id` (= uploadId in ragSearch segments)

## Contract surprises / deviations from spec

1. **No `hasThinking` field in the public /api/user/histories schema doc** —
   the field appears in the admin histories schema but is used by the user endpoint
   as well (confirmed by the admin lazy-fetch docs referencing the same flag).
   We treat it as optional (defaults to False) if absent.

2. **`ragSearchMode` is per-turn, not per-segment** in the summary flags, but
   per-segment mode is also available in the lazy-fetch response. Both are preserved.

3. **GET (not POST) for lazy-fetch endpoints** — `/ragSearch` and `/thinking` use
   GET with path param `{id}`, while most Pria endpoints use POST. The client
   includes a dedicated `_get()` method with the same JWT/re-auth logic.

4. **Vault scope for files-with-issues** — must supply `vault` (required field).
   The black box defaults to `"personal"` which covers the user's own uploads.
   Institution-shared sources are under `"instance"` — agents checking shared-vault
   citations should pass `vault="instance"`.

5. **Empty history on `historyId` filter** — when `historyId` is supplied and the
   record doesn't exist (or isn't owned by the user), the API returns `data: []`
   (200 OK, empty array) rather than 404. The client normalises this to a structured
   `not_found` error.

6. **`hasRagSearch=False` does not skip all lazy fetches** — the thinking endpoint
   is independent of RAG. A turn can have thinking but no RAG (e.g. pure reasoning
   response). Both flags are checked independently.

7. **Source-health check on zero segments** — if `rag_segments` is empty (either
   because `has_rag_search=False` or because the lazy fetch failed), no health
   check is issued. The health call is only made when there are segments to annotate.
