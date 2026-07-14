"""Tool specs + dispatch for pria-tools-plugin.

Exposes two tools to the in-VM agent:
  search_knowledge — vault RAG/KAG search (primary)
  search_history   — conversation history search

Results are normalized to a consistent shape so the agent can cite sources
without knowing the underlying Pria API shape.
"""
import os

from pria.client import (
    PriaClient,
    AuthError,
    RateLimitError,
    APIError,
    DEFAULT_BASE,
)

# ── tool specs (name/description/input_schema) ────────────────────────────────

TOOL_SEARCH_KNOWLEDGE = "search_knowledge"
TOOL_SEARCH_HISTORY = "search_history"

TOOL_SPECS = [
    {
        "name": TOOL_SEARCH_KNOWLEDGE,
        "description": (
            "Search the user's Pria IP Vault (personal documents, uploaded files, "
            "and shared institution knowledge) using RAG/KAG hybrid retrieval. "
            "Returns scored, citable snippets with source labels (rag|kag|fused|lexical). "
            "Use this to ground answers in the user's own knowledge base."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Natural-language search query (max 500 chars).",
                },
                "max_results": {
                    "type": "integer",
                    "description": "Maximum number of results to return (1–100, default 10).",
                    "minimum": 1,
                    "maximum": 100,
                },
            },
            "required": ["query"],
        },
    },
    {
        "name": TOOL_SEARCH_HISTORY,
        "description": (
            "Search the user's Pria conversation history. Returns recent dialogue "
            "snippets matching the query, sorted oldest-first. Useful for recalling "
            "prior context or decisions from past sessions."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Free-text search string matched against conversation inputs/outputs.",
                },
                "limit": {
                    "type": "integer",
                    "description": "Maximum number of history records to return (default 20).",
                    "minimum": 1,
                    "maximum": 100,
                },
            },
            "required": ["query"],
        },
    },
]


# ── normalizers ───────────────────────────────────────────────────────────────

def _normalize_content_results(raw: dict) -> dict:
    """Map /api/user/files/search-content response → { results, count }."""
    items = raw.get("results") or []
    out = []
    for item in items:
        upload = item.get("upload") or {}
        citation = (
            upload.get("file_title")
            or upload.get("originalname")
            or upload.get("_id")
            or ""
        )
        out.append({
            "text": item.get("snippet") or item.get("content") or "",
            "score": item.get("score"),
            "source": item.get("source") or "rag",
            "citation": citation,
            "upload_id": upload.get("_id") or item.get("uploadId"),
            "matched_entities": item.get("matchedEntities") or [],
            "chunk_index": item.get("chunkIndex"),
        })
    return {"results": out, "count": len(out)}


def _normalize_history_results(raw: dict) -> dict:
    """Map /api/user/histories response → { results, count }."""
    items = raw.get("data") or []
    out = []
    for item in items:
        in_data = item.get("in") or {}
        out_data = item.get("out") or {}
        # inputs/outputs may be lists or strings (API trims to 200 chars)
        user_text = in_data.get("input") or in_data.get("inputs") or ""
        if isinstance(user_text, list):
            user_text = " ".join(str(x) for x in user_text)
        ai_outputs = out_data.get("outputs") or out_data.get("output") or []
        if isinstance(ai_outputs, str):
            ai_outputs = [ai_outputs]
        ai_text = " ".join(str(x) for x in ai_outputs)
        assistant = item.get("assistant") or {}
        out.append({
            "id": item.get("id"),
            "created": item.get("created"),
            "user_input": user_text,
            "ai_output": ai_text,
            "assistant_name": assistant.get("name") or "",
            "model": item.get("conversation_model") or "",
        })
    return {"results": out, "count": len(out)}


# ── tool dispatcher ───────────────────────────────────────────────────────────

def _tool_error(error: str, detail: str = "") -> dict:
    return {"error": error, "detail": detail}


class ToolHandler:
    """Resolves config/env, creates PriaClient lazily, dispatches tool.call."""

    def __init__(self, config: dict):
        self.config = config
        self._client: PriaClient | None = None

    def _api_key(self) -> str:
        # env takes precedence over plugin config
        return (os.environ.get("PRIA_API_KEY") or "").strip() or (
            self.config.get("pria_api_key") or ""
        ).strip()

    def _base_url(self) -> str:
        return (self.config.get("pria_api_base") or DEFAULT_BASE).rstrip("/")

    def _client_or_error(self):
        """Return (client, None) or (None, error_dict)."""
        if self._client is not None:
            return self._client, None
        key = self._api_key()
        if not key:
            return None, _tool_error(
                "pria_api_key not configured",
                "Set PRIA_API_KEY env var or pria_api_key in plugin config.",
            )
        try:
            self._client = PriaClient(api_key=key, base_url=self._base_url())
        except ValueError as exc:
            return None, _tool_error("client init error", str(exc))
        return self._client, None

    # called by App on any tool.call — resets cached client on auth failure
    def _reset_client(self):
        self._client = None

    def call(self, name: str, tool_input: dict) -> dict:
        if name == TOOL_SEARCH_KNOWLEDGE:
            return self._search_knowledge(tool_input)
        if name == TOOL_SEARCH_HISTORY:
            return self._search_history(tool_input)
        return _tool_error(f"unknown tool: {name}")

    def _search_knowledge(self, inp: dict) -> dict:
        query = (inp.get("query") or "").strip()
        if not query:
            return _tool_error("query is required")
        max_results = min(max(int(inp.get("max_results") or 10), 1), 100)

        client, err = self._client_or_error()
        if err:
            return err
        try:
            raw = client.search_content(query=query, limit=max_results)
        except AuthError as exc:
            self._reset_client()
            return _tool_error("authentication failed", str(exc))
        except RateLimitError as exc:
            return _tool_error("rate_limit", str(exc))
        except APIError as exc:
            return _tool_error(f"api_error (HTTP {exc.status})", str(exc))
        except (OSError, Exception) as exc:  # noqa: BLE001
            return _tool_error("network_error", str(exc))
        return _normalize_content_results(raw)

    def _search_history(self, inp: dict) -> dict:
        query = (inp.get("query") or "").strip()
        if not query:
            return _tool_error("query is required")
        limit = min(max(int(inp.get("limit") or 20), 1), 100)

        client, err = self._client_or_error()
        if err:
            return err
        try:
            raw = client.search_histories(search=query, limit=limit)
        except AuthError as exc:
            self._reset_client()
            return _tool_error("authentication failed", str(exc))
        except RateLimitError as exc:
            return _tool_error("rate_limit", str(exc))
        except APIError as exc:
            return _tool_error(f"api_error (HTTP {exc.status})", str(exc))
        except (OSError, Exception) as exc:  # noqa: BLE001
            return _tool_error("network_error", str(exc))
        return _normalize_history_results(raw)
