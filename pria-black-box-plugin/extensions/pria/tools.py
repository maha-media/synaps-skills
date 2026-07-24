"""Tool specs + dispatch for pria-black-box-plugin.

Three tools:
  trace_answer          — full provenance record for one history turn
  list_traceable_answers — recent history rows with observability flags
  answer_confidence     — compact grounding summary from a trace

Design rules:
  - Never surface raw confidential chunk text; preserve the redaction placeholder.
  - Reasoning (thinking) is opt-in and treated as sensitive telemetry.
  - Source-health overlay is best-effort: missing = no issue data available.
  - Structured tool errors on 4xx/5xx/network — never crash the RPC loop.
"""
import os
from typing import Any

from pria.client import (
    PriaClient,
    AuthError,
    RateLimitError,
    APIError,
    DEFAULT_BASE,
)

# ── tool name constants ───────────────────────────────────────────────────────

TOOL_TRACE_ANSWER = "trace_answer"
TOOL_LIST_TRACEABLE = "list_traceable_answers"
TOOL_ANSWER_CONFIDENCE = "answer_confidence"

# ── tool specs ────────────────────────────────────────────────────────────────

TOOL_SPECS = [
    {
        "name": TOOL_TRACE_ANSWER,
        "description": (
            "Reconstruct a Pria history turn as an auditable execution trace / provenance record. "
            "Returns: the answering digital twin, every RAG/KAG evidence chunk used (text, score, "
            "source label, mode, confidentiality flag), optional reasoning telemetry (thinking "
            "rounds + timing), and a source-health note (whether cited sources are still "
            "indexed). Confidential chunks arrive pre-redacted by Pria — this tool preserves "
            "that placeholder exactly and never attempts to reconstruct hidden text. "
            "Use `history_id` for a specific turn or omit it to trace the most recent answer."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "history_id": {
                    "type": "string",
                    "description": (
                        "ObjectId of the specific history record to trace. "
                        "Omit to trace the most recent answer."
                    ),
                },
                "include_reasoning": {
                    "type": "boolean",
                    "description": (
                        "When true, fetch and include the full thinking/reasoning array "
                        "(may be bulky; opt-in only). Default: false."
                    ),
                },
                "vault": {
                    "type": "string",
                    "enum": ["personal", "instance", "account"],
                    "description": (
                        "Vault scope for source-health check. Default: 'personal'."
                    ),
                },
            },
            "required": [],
        },
    },
    {
        "name": TOOL_LIST_TRACEABLE,
        "description": (
            "List recent Pria history rows with their observability flags: hasRagSearch, "
            "ragSearchCount, ragSearchMode, hasThinking, thinkingCount, cached tokens, "
            "credits, latencyMs, ragDurationMs, model, and answering twin. "
            "Use this to discover which answers are inspectable before calling trace_answer."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "limit": {
                    "type": "integer",
                    "description": "Maximum number of history records to return (1–100, default 20).",
                    "minimum": 1,
                    "maximum": 100,
                },
                "search": {
                    "type": "string",
                    "description": "Optional free-text filter matched against conversation text.",
                },
                "all_institutions": {
                    "type": "boolean",
                    "description": "When true, include histories across all enrolled institutions.",
                },
            },
            "required": [],
        },
    },
    {
        "name": TOOL_ANSWER_CONFIDENCE,
        "description": (
            "Compact provenance-coverage summary for a Pria history turn. "
            "Reports: source count, average retrieval score, any confidential-truncated chunks, "
            "and whether any cited source is now unhealthy/unindexed. "
            "Faster than trace_answer — skips full chunk text and reasoning. "
            "Useful for quick triage before a full trace."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "history_id": {
                    "type": "string",
                    "description": (
                        "ObjectId of the history record to summarise. "
                        "Omit to use the most recent answer."
                    ),
                },
                "vault": {
                    "type": "string",
                    "enum": ["personal", "instance", "account"],
                    "description": "Vault scope for source-health check. Default: 'personal'.",
                },
            },
            "required": [],
        },
    },
]

# ── normalizers ───────────────────────────────────────────────────────────────

_CONFIDENTIAL_MARKER = "(rest is confidential)"


def _is_confidential(chunk: dict) -> bool:
    """True if Pria pre-redacted this chunk."""
    if chunk.get("confidential"):
        return True
    text = chunk.get("chunkText") or ""
    return _CONFIDENTIAL_MARKER in text


def _normalize_history_row(row: dict) -> dict:
    """Map a single /api/user/histories record to an observability-flag summary."""
    in_data = row.get("in") or {}
    out_data = row.get("out") or {}

    user_text = in_data.get("input") or in_data.get("inputs") or ""
    if isinstance(user_text, list):
        user_text = " ".join(str(x) for x in user_text)

    ai_outputs = out_data.get("outputs") or out_data.get("output") or []
    if isinstance(ai_outputs, str):
        ai_outputs = [ai_outputs]
    ai_text = " ".join(str(x) for x in ai_outputs)

    assistant = row.get("assistant") or {}

    return {
        "id": row.get("id"),
        "created": row.get("created"),
        "model": row.get("conversation_model") or "",
        "assistant_id": assistant.get("_id") or "",
        "assistant_name": assistant.get("name") or "",
        # observability flags
        "has_rag_search": bool(row.get("hasRagSearch")),
        "rag_search_count": row.get("ragSearchCount") or 0,
        "rag_search_mode": row.get("ragSearchMode") or "",
        "has_thinking": bool(row.get("hasThinking")),
        "thinking_count": row.get("thinkingCount") or 0,
        # performance telemetry
        "credits": row.get("credits"),
        "cached_tokens": row.get("cached"),
        "latency_ms": row.get("latencyMs"),
        "rag_duration_ms": row.get("ragDurationMs"),
        # content (trimmed — API caps at 200 chars in list view)
        "user_input_preview": user_text,
        "ai_output_preview": ai_text,
    }


def _normalize_rag_segment(seg: dict) -> dict:
    """Map one ragSearch segment to a clean provenance chunk."""
    confidential = _is_confidential(seg)
    return {
        "upload_id": seg.get("uploadId") or "",
        "filename": seg.get("originalname") or "",
        "chunk_index": seg.get("chunkIndex"),
        "score": seg.get("score"),
        "mode": seg.get("mode") or "",          # "RAG" | "KAG"
        "length": seg.get("length"),             # original pre-redaction length
        "confidential": confidential,
        # Preserve placeholder exactly — never attempt to expand redacted text.
        "chunk_text": seg.get("chunkText") or "",
    }


def _normalize_thinking_round(t: dict) -> dict:
    """Map one thinking round to telemetry shape."""
    return {
        "id": t.get("id") or "",
        "round": t.get("round"),
        "model": t.get("model") or "",
        "duration_ms": t.get("durationMs"),
        # text may be bulky; include only if caller opted in (always True here
        # since we only call this when include_reasoning=True)
        "text": t.get("text") or "",
    }


def _build_source_health_index(files_resp: dict) -> dict[str, str]:
    """Build { upload_id → issue_type } from files-with-issues response."""
    index: dict[str, str] = {}
    for f in (files_resp.get("files") or []):
        fid = f.get("_id") or ""
        issue = f.get("issue") or "unknown"
        if fid:
            index[fid] = issue
    return index


def _tool_error(error: str, detail: str = "") -> dict:
    return {"error": error, "detail": detail}


# ── tool dispatcher ───────────────────────────────────────────────────────────

class ToolHandler:
    """Resolves config/env, creates PriaClient lazily, dispatches tool.call."""

    def __init__(self, config: dict):
        self.config = config
        self._client: PriaClient | None = None

    def _api_key(self) -> str:
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

    def _reset_client(self) -> None:
        self._client = None

    def call(self, name: str, tool_input: dict) -> dict:
        if name == TOOL_TRACE_ANSWER:
            return self._trace_answer(tool_input)
        if name == TOOL_LIST_TRACEABLE:
            return self._list_traceable(tool_input)
        if name == TOOL_ANSWER_CONFIDENCE:
            return self._answer_confidence(tool_input)
        return _tool_error(f"unknown tool: {name}")

    # ── _resolve_history_row ──────────────────────────────────────────────────

    def _resolve_history_row(self, client: PriaClient,
                             history_id: str | None) -> tuple[dict | None, dict | None]:
        """
        Fetch one history row (by id or most-recent).
        Returns (row_dict, None) on success, (None, error_dict) on failure.
        """
        try:
            raw = client.list_histories(limit=1, history_id=history_id)
        except AuthError as exc:
            self._reset_client()
            return None, _tool_error("authentication failed", str(exc))
        except RateLimitError as exc:
            return None, _tool_error("rate_limit", str(exc))
        except APIError as exc:
            return None, _tool_error(f"api_error (HTTP {exc.status})", str(exc))
        except Exception as exc:  # noqa: BLE001
            return None, _tool_error("network_error", str(exc))

        rows = raw.get("data") or []
        if not rows:
            label = history_id or "most recent"
            return None, _tool_error("not_found", f"No history record found ({label}).")
        return rows[-1], None

    # ── trace_answer ──────────────────────────────────────────────────────────

    def _trace_answer(self, inp: dict) -> dict:
        history_id: str | None = (inp.get("history_id") or "").strip() or None
        include_reasoning: bool = bool(inp.get("include_reasoning", False))
        vault: str = (inp.get("vault") or "personal").strip()

        client, err = self._client_or_error()
        if err:
            return err

        # 1. Resolve the history row (observability flags + twin info)
        row, err = self._resolve_history_row(client, history_id)
        if err:
            return err

        resolved_id: str = row.get("id") or history_id or ""
        history_summary = _normalize_history_row(row)

        # 2. Lazy-fetch RAG/KAG segments (if any)
        rag_segments: list[dict] = []
        rag_error: str | None = None
        if history_summary["has_rag_search"] and resolved_id:
            try:
                rag_raw = client.get_rag_search(resolved_id)
                for seg in (rag_raw.get("ragSearch") or []):
                    rag_segments.append(_normalize_rag_segment(seg))
            except AuthError as exc:
                self._reset_client()
                rag_error = f"authentication failed: {exc}"
            except RateLimitError:
                rag_error = "rate_limit fetching RAG segments"
            except APIError as exc:
                rag_error = f"api_error (HTTP {exc.status}) fetching RAG segments"
            except Exception as exc:  # noqa: BLE001
                rag_error = f"network_error fetching RAG segments: {exc}"

        # 3. Optional reasoning telemetry
        thinking_rounds: list[dict] = []
        thinking_error: str | None = None
        if include_reasoning and history_summary["has_thinking"] and resolved_id:
            try:
                think_raw = client.get_thinking(resolved_id)
                for t in (think_raw.get("thinking") or []):
                    thinking_rounds.append(_normalize_thinking_round(t))
            except AuthError as exc:
                self._reset_client()
                thinking_error = f"authentication failed: {exc}"
            except RateLimitError:
                thinking_error = "rate_limit fetching thinking"
            except APIError as exc:
                thinking_error = f"api_error (HTTP {exc.status}) fetching thinking"
            except Exception as exc:  # noqa: BLE001
                thinking_error = f"network_error fetching thinking: {exc}"

        # 4. Source-health overlay (best-effort)
        health_index: dict[str, str] = {}
        health_error: str | None = None
        if rag_segments:
            try:
                issues_raw = client.files_with_issues(vault=vault)
                health_index = _build_source_health_index(issues_raw)
            except (AuthError, RateLimitError, APIError, Exception):  # noqa: BLE001
                health_error = "source-health check unavailable"

        # 5. Annotate each segment with current health status
        for seg in rag_segments:
            uid = seg.get("upload_id") or ""
            seg["source_health"] = health_index.get(uid, "ok")

        # 6. Compute confidentiality summary
        confidential_count = sum(1 for s in rag_segments if s.get("confidential"))
        unhealthy_count = sum(
            1 for s in rag_segments
            if s.get("source_health") not in ("ok", "")
        )

        # 7. Assemble the TracePacket
        trace: dict[str, Any] = {
            "history_id": resolved_id,
            "twin": {
                "assistant_id": history_summary["assistant_id"],
                "assistant_name": history_summary["assistant_name"],
                "model": history_summary["model"],
            },
            "turn": {
                "created": history_summary["created"],
                "user_input_preview": history_summary["user_input_preview"],
                "ai_output_preview": history_summary["ai_output_preview"],
                "credits": history_summary["credits"],
                "cached_tokens": history_summary["cached_tokens"],
                "latency_ms": history_summary["latency_ms"],
                "rag_duration_ms": history_summary["rag_duration_ms"],
            },
            "retrieval": {
                "has_rag_search": history_summary["has_rag_search"],
                "rag_search_count": history_summary["rag_search_count"],
                "rag_search_mode": history_summary["rag_search_mode"],
                "segments": rag_segments,
                "confidential_segment_count": confidential_count,
                "unhealthy_source_count": unhealthy_count,
            },
            "reasoning": {
                "has_thinking": history_summary["has_thinking"],
                "thinking_count": history_summary["thinking_count"],
                "rounds": thinking_rounds if include_reasoning else None,
                "included": include_reasoning,
            },
            "source_health_vault": vault,
        }

        # Attach non-fatal fetch warnings if any
        warnings = []
        if rag_error:
            warnings.append(f"rag_fetch_warning: {rag_error}")
        if thinking_error:
            warnings.append(f"thinking_fetch_warning: {thinking_error}")
        if health_error:
            warnings.append(f"health_check_warning: {health_error}")
        if warnings:
            trace["warnings"] = warnings

        return trace

    # ── list_traceable_answers ────────────────────────────────────────────────

    def _list_traceable(self, inp: dict) -> dict:
        limit = min(max(int(inp.get("limit") or 20), 1), 100)
        search: str | None = (inp.get("search") or "").strip() or None
        all_institutions: bool = bool(inp.get("all_institutions", False))

        client, err = self._client_or_error()
        if err:
            return err

        try:
            raw = client.list_histories(
                limit=limit, search=search, all_institutions=all_institutions
            )
        except AuthError as exc:
            self._reset_client()
            return _tool_error("authentication failed", str(exc))
        except RateLimitError as exc:
            return _tool_error("rate_limit", str(exc))
        except APIError as exc:
            return _tool_error(f"api_error (HTTP {exc.status})", str(exc))
        except Exception as exc:  # noqa: BLE001
            return _tool_error("network_error", str(exc))

        rows = raw.get("data") or []
        results = [_normalize_history_row(r) for r in rows]
        return {"results": results, "count": len(results)}

    # ── answer_confidence ─────────────────────────────────────────────────────

    def _answer_confidence(self, inp: dict) -> dict:
        history_id: str | None = (inp.get("history_id") or "").strip() or None
        vault: str = (inp.get("vault") or "personal").strip()

        client, err = self._client_or_error()
        if err:
            return err

        # Resolve row
        row, err = self._resolve_history_row(client, history_id)
        if err:
            return err

        resolved_id: str = row.get("id") or history_id or ""
        summary = _normalize_history_row(row)

        if not summary["has_rag_search"]:
            return {
                "history_id": resolved_id,
                "has_rag_search": False,
                "rag_search_mode": summary["rag_search_mode"],
                "source_count": 0,
                "avg_score": None,
                "confidential_chunks": 0,
                "unhealthy_sources": 0,
                "note": "This answer had no RAG/KAG retrieval — no evidence provenance available.",
                "model": summary["model"],
                "assistant_name": summary["assistant_name"],
            }

        # Lazy-fetch segments
        rag_segments: list[dict] = []
        rag_error: str | None = None
        try:
            rag_raw = client.get_rag_search(resolved_id)
            for seg in (rag_raw.get("ragSearch") or []):
                rag_segments.append(_normalize_rag_segment(seg))
        except (AuthError, RateLimitError, APIError, Exception) as exc:  # noqa: BLE001
            rag_error = str(exc)

        # Source-health overlay
        health_index: dict[str, str] = {}
        try:
            issues_raw = client.files_with_issues(vault=vault)
            health_index = _build_source_health_index(issues_raw)
        except Exception:  # noqa: BLE001
            pass

        scores = [s.get("score") for s in rag_segments if s.get("score") is not None]
        avg_score = (sum(scores) / len(scores)) if scores else None
        confidential_count = sum(1 for s in rag_segments if _is_confidential(s))
        unique_sources = {s.get("upload_id") for s in rag_segments if s.get("upload_id")}
        unhealthy = sum(
            1 for uid in unique_sources
            if health_index.get(uid, "ok") not in ("ok", "")
        )

        result: dict[str, Any] = {
            "history_id": resolved_id,
            "has_rag_search": True,
            "rag_search_mode": summary["rag_search_mode"],
            "source_count": len(unique_sources),
            "chunk_count": len(rag_segments),
            "avg_score": round(avg_score, 4) if avg_score is not None else None,
            "min_score": round(min(scores), 4) if scores else None,
            "max_score": round(max(scores), 4) if scores else None,
            "confidential_chunks": confidential_count,
            "unhealthy_sources": unhealthy,
            "model": summary["model"],
            "assistant_name": summary["assistant_name"],
            "credits": summary["credits"],
            "latency_ms": summary["latency_ms"],
        }
        if rag_error:
            result["rag_fetch_warning"] = rag_error
        return result
