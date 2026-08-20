# Pria API Contracts — pria-tools-plugin

Verified by reading OpenAPI schemas at `docs.praxis-ai.com` during build.
No live API calls made.

---

## 1. Auth: `POST /api/auth/api-key-signin`

**Request:**
```
Header: x-api-key: pria_<40 hex chars>
Body:   (empty — no JSON body required)
```

**Response 200:**
```json
{ "token": "<JWT>", "profile": { "_id", "email", "fname", "lname", "accountType", "plan", "status", "credits", "creditsUsed", "institution" } }
```

**Key contract surprises:**
- The API key is NOT a Bearer token. You cannot use it as `Authorization: Bearer pria_...` — that returns `jwt malformed`.
- Must send as `x-api-key` header, not `Authorization`.
- The exchange has no JSON request body (just the header).
- Format enforced: `/^pria_[0-9a-f]{40}$/` — malformed key → 401, not 400.
- Only `admin` or `super` accountType users can exchange keys.

**Subsequent auth:** Use JWT as `x-access-token: <jwt>` (or `Authorization: Bearer <jwt>`) on all data endpoints.

---

## 2. Vault Search: `POST /api/user/files/search-content`

**Request body:**
```json
{
  "query": "string (required, max 500 chars)",
  "limit": 50,           // optional, 1–100, default 50
  "minScore": 0.1,       // optional, 0–1, default 0.1; ignored for KAG-fused
  "selectedUploadIds": [] // optional; intersected with user's scope
}
```

**Response 200:**
```json
{
  "success": true,
  "query": "...",
  "results": [
    {
      "uploadId": "...",
      "chunkId": "...",
      "chunkIndex": 3,
      "snippet": "~200 char snippet",
      "content": "full chunk text",
      "matchedEntities": ["entity1"],     // KAG hits only
      "trace": [{"list": "dense", "rank": 1}],  // RRF provenance
      "score": 0.87,
      "source": "rag|kag|fused|lexical",
      "upload": {
        "_id": "...", "originalname": "...", "file_title": "...",
        "mimetype": "...", "filesize": 0,
        "institution": "...|null",
        "account_shared": false,
        "is_private": false,
        "confidential": false
      }
    }
  ],
  "totalScanned": 50,
  "uploadCount": 12,
  "tookMs": 83,
  "searchPerf": { "legs": { "dense": {}, "graph": {}, "lexical": {} }, "fused": 0, "totalMs": 0, "k": 60 }
}
```

**Contract surprises:**
- `source` has a 4th enum value `lexical` (BM25/keyword) not in the original task description — normalizer handles it.
- Confidential files return `🔒 Private content matched — open the file to view` as snippet/content instead of the real text.
- `minScore` is ignored for KAG-fused results (RRF scores are ~0–0.05, much lower than dense scores).
- Rate limit: **20 req/min per user** (user-level, not IP-level).

---

## 3. History: `POST /api/user/histories`

**Request body:**
```json
{
  "limit": 100,             // optional, default 100
  "search": "string",       // optional, free-text against input/output fields
  "allInstitutions": false, // optional; cross-twin search
  "institution": "...",     // optional ObjectId
  "course_id": 0,           // optional
  "before": 1723019070274,  // optional epoch ms
  "after": 1723019070274,   // optional epoch ms
  "historyId": "...",       // optional specific record fetch
  "tools": false            // optional; true = full tool response data
}
```

**Response 200:**
```json
{
  "success": true,
  "data": [
    {
      "id": "...",
      "created": "2025-07-01T12:00:00.000Z",
      "credits": 1, "usage": 150,
      "institution": "...",
      "user": "...",
      "favorite": false, "forgotten": false,
      "conversation_model": "gpt-4o",
      "success": true,
      "in": { "input": "user text (trimmed 200 chars)" },
      "out": { "outputs": ["AI response (trimmed 200 chars)"] },
      "assistant": { "_id": "...", "name": "...", "liked_count": 0, "picture_url": "..." }
    }
  ]
}
```

**Contract surprises:**
- Results are sorted **oldest-first** before returning (the API reverses newest-first db order).
- `in.input` and `out.outputs` are **trimmed to 200 chars** server-side (unless `tools: true`).
- `allInstitutions: true` also returns `matched` and `total` counts plus populates `institution` as an object with `{personal: true}` for personal records.
- `assistant` can be `null` for personal (non-institution) conversations.

---

## 4. `POST /api/user/searchRag` (semantic RAG only, not used as primary)

Simpler endpoint: body `{ "search": "string", "assistantId": "optional" }`. Returns `{ success, data: string, message }` — the `data` field is a plain text string, not structured chunks. No citations, no scores. **Not used** — `search-content` is richer; `searchRag` is legacy/simplified.
