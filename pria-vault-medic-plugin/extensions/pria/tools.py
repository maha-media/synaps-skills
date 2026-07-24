"""Tool specs + dispatch for pria-vault-medic-plugin.

Exposes four tools to the in-VM agent:
  vault_health   — grade the IP Vault (read-only)
  vault_diagnose — list problematic files classified by issue type (read-only)
  vault_repair   — apply a repair verb to a single upload (WRITE, dry_run=true by default)
  vault_regrade  — re-run vault_health to confirm improvement (read-only)

Issue classification (derived from /api/user/uploads ingestion field + status):
  error        — ingestion.phase == "error"  (broken ingestion, needs requeue/reload)
  deleted      — status == "deleted"          (file deleted, ingestion may have failed)
  never_used   — ragHitCount == 0 and file > 7d old (never retrieved by RAG)
  unscanned    — garbageScore is None/0 and ingestion never scored quality
  stale_url    — file_url is None / fileOnDisk is False (source URL gone)
  unindexed    — ingestion.phase not in (done, error) and file > 24h old
"""
import os
import time

from pria.client import (
    PriaClient,
    AuthError,
    RateLimitError,
    APIError,
    DEFAULT_BASE,
)

# ── tool name constants ───────────────────────────────────────────────────────

TOOL_VAULT_HEALTH = "vault_health"
TOOL_VAULT_DIAGNOSE = "vault_diagnose"
TOOL_VAULT_REPAIR = "vault_repair"
TOOL_VAULT_REGRADE = "vault_regrade"

_ALL_TOOLS = {TOOL_VAULT_HEALTH, TOOL_VAULT_DIAGNOSE, TOOL_VAULT_REPAIR, TOOL_VAULT_REGRADE}

# Valid repair verbs → (method name, requires source_url)
_REPAIR_VERBS = {
    "requeue": ("requeue_upload", False),
    "reload": ("reload_upload", False),
    "reingest": ("reingest_upload", True),
}

# ── tool specs ────────────────────────────────────────────────────────────────

TOOL_SPECS = [
    {
        "name": TOOL_VAULT_HEALTH,
        "description": (
            "Grade the user's Pria IP Vault health. Returns a letter grade (A–F), "
            "numeric score (0–100), and a breakdown of issue counts by category "
            "(error files, never-retrieved files, unscanned, stale-URL, unindexed). "
            "READ-ONLY — safe to call anytime. Use vault_regrade after repairs."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "vault": {
                    "type": "string",
                    "description": "Vault scope: 'personal' (default) or 'institution'.",
                    "enum": ["personal", "institution"],
                }
            },
            "required": [],
        },
    },
    {
        "name": TOOL_VAULT_DIAGNOSE,
        "description": (
            "List every problematic file in the vault, classified by issue type. "
            "Returns a prioritized triage list: error → stale_url → unindexed → "
            "unscanned → deleted → never_used. Each entry includes upload_id, "
            "filename, issue type, error message (if any), and a recommended repair "
            "verb. READ-ONLY — no mutations."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "vault": {
                    "type": "string",
                    "description": "Vault scope: 'personal' (default) or 'institution'.",
                    "enum": ["personal", "institution"],
                },
                "issue_filter": {
                    "type": "string",
                    "description": (
                        "Only return files with this issue type. "
                        "One of: error, deleted, never_used, unscanned, stale_url, unindexed. "
                        "Omit to return all issue types."
                    ),
                    "enum": [
                        "error", "deleted", "never_used",
                        "unscanned", "stale_url", "unindexed",
                    ],
                },
                "limit": {
                    "type": "integer",
                    "description": "Max files to return (default 50, max 200).",
                    "minimum": 1,
                    "maximum": 200,
                },
            },
            "required": [],
        },
    },
    {
        "name": TOOL_VAULT_REPAIR,
        "description": (
            "⚠️ WRITE TOOL — mutates the vault. Apply a repair verb to a single upload. "
            "By default dry_run=true: the tool validates the request and returns what "
            "it *would* do without making any API call. Set dry_run=false to execute.\n\n"
            "Repair verbs:\n"
            "  requeue  — re-queue the file for ingestion (fixes error/stuck files)\n"
            "  reload   — reload and re-process file content from disk\n"
            "  reingest — re-ingest from a new source URL (requires source_url param)\n\n"
            "After repair, call vault_regrade to confirm the vault score improved."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "upload_id": {
                    "type": "string",
                    "description": "The upload _id of the file to repair (from vault_diagnose).",
                },
                "verb": {
                    "type": "string",
                    "description": "Repair action: requeue | reload | reingest.",
                    "enum": ["requeue", "reload", "reingest"],
                },
                "dry_run": {
                    "type": "boolean",
                    "description": (
                        "If true (default), validate and describe the repair without "
                        "executing it. Set false to apply the repair for real."
                    ),
                },
                "source_url": {
                    "type": "string",
                    "description": "Required for verb=reingest. New URL to re-ingest from.",
                },
            },
            "required": ["upload_id", "verb"],
        },
    },
    {
        "name": TOOL_VAULT_REGRADE,
        "description": (
            "Re-run vault_health to verify that repairs improved the vault score. "
            "Returns the same shape as vault_health plus a diff vs. the prior grade "
            "if you provide the previous score. READ-ONLY."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "vault": {
                    "type": "string",
                    "description": "Vault scope: 'personal' (default) or 'institution'.",
                    "enum": ["personal", "institution"],
                },
                "previous_score": {
                    "type": "integer",
                    "description": (
                        "The numeric score from a prior vault_health call. "
                        "If provided, the response includes score_delta and "
                        "grade_changed fields."
                    ),
                    "minimum": 0,
                    "maximum": 100,
                },
            },
            "required": [],
        },
    },
]


# ── issue classification ───────────────────────────────────────────────────────

# Priority order for triage (lower index = higher priority)
_ISSUE_PRIORITY = ["error", "stale_url", "unindexed", "unscanned", "deleted", "never_used"]

# Recommended repair verb per issue type
_REPAIR_RECOMMENDATION = {
    "error": "requeue",
    "stale_url": "reingest",
    "unindexed": "requeue",
    "unscanned": "requeue",
    "deleted": None,          # deleted files can't be repaired via API
    "never_used": None,       # informational — consider pruning manually
}

_SEVEN_DAYS_S = 7 * 24 * 3600
_ONE_DAY_S = 24 * 3600


def _classify_upload(item: dict) -> str | None:
    """Return the highest-priority issue type for an upload, or None if healthy."""
    status = item.get("status", "")
    ingestion = item.get("ingestion") or {}
    phase = ingestion.get("phase", "")

    # 1. Ingestion error
    if phase == "error":
        return "error"

    # 2. File missing from disk / stale URL
    if not item.get("fileOnDisk") or item.get("file_url") is None:
        # Only flag active files (deleted is its own category)
        if status not in ("deleted",):
            return "stale_url"

    # 3. Deleted (but may still show in vault)
    if status == "deleted":
        return "deleted"

    # 4. Stuck / unindexed (ingestion started but never completed, >24h)
    if phase not in ("done", "error", "") and phase is not None:
        enqueued_at = ingestion.get("enqueuedAt") or ingestion.get("startedAt")
        if enqueued_at:
            try:
                import datetime
                enq = datetime.datetime.fromisoformat(
                    enqueued_at.replace("Z", "+00:00")
                )
                age_s = (datetime.datetime.now(datetime.timezone.utc) - enq).total_seconds()
                if age_s > _ONE_DAY_S:
                    return "unindexed"
            except Exception:
                pass

    # 5. Never quality-scanned (garbageScore missing/None for non-images)
    mimetype = item.get("mimetype", "")
    garbage_score = item.get("garbageScore")
    if (
        garbage_score is None
        and not mimetype.startswith("image/")
        and phase == "done"
        and status not in ("deleted",)
    ):
        return "unscanned"

    # 6. Never retrieved by RAG (>7 days old, 0 hits)
    rag_hit_count = item.get("ragHitCount")
    created = item.get("created")
    if rag_hit_count is not None and rag_hit_count == 0 and created and phase == "done":
        try:
            import datetime
            cr = datetime.datetime.fromisoformat(created.replace("Z", "+00:00"))
            age_s = (datetime.datetime.now(datetime.timezone.utc) - cr).total_seconds()
            if age_s > _SEVEN_DAYS_S:
                return "never_used"
        except Exception:
            pass

    return None


def _upload_to_triage_entry(item: dict, issue_type: str) -> dict:
    """Normalize an upload record into a triage entry."""
    ingestion = item.get("ingestion") or {}
    return {
        "upload_id": item.get("_id", ""),
        "filename": item.get("originalname") or item.get("filename") or "",
        "file_title": item.get("file_title") or "",
        "mimetype": item.get("mimetype") or "",
        "filesize": item.get("filesize"),
        "status": item.get("status", ""),
        "created": item.get("created"),
        "issue_type": issue_type,
        "ingestion_phase": ingestion.get("phase"),
        "ingestion_error": ingestion.get("lastError"),
        "ingestion_attempts": ingestion.get("attempts", 0),
        "rag_hit_count": item.get("ragHitCount"),
        "last_rag_hit": item.get("lastRagHitAt"),
        "file_on_disk": item.get("fileOnDisk"),
        "garbage_score": item.get("garbageScore"),
        "recommended_verb": _REPAIR_RECOMMENDATION.get(issue_type),
    }


# ── normalizers ───────────────────────────────────────────────────────────────

def _normalize_health(raw: dict) -> dict:
    """Map /api/user/uploads/vault-health-summary → clean agent-friendly shape."""
    summary = raw.get("summary") or {}
    grade = raw.get("grade") or {}
    factors = grade.get("factors") or []

    return {
        "grade": grade.get("letter", "?"),
        "score": grade.get("score"),
        "summary": {
            "total_files": summary.get("totalCount", 0),
            "active_files": summary.get("activeCount", 0),
            "used_files": summary.get("usedCount", 0),
            "error_files": summary.get("errorCount", 0),
            "never_used_files": summary.get("neverUsedCount", 0),
            "processing_files": summary.get("processingCount", 0),
            "stale_files": summary.get("staleCount", 0),
            "unscanned_files": summary.get("unscannedCount", 0),
            "unoptimized_files": summary.get("unoptimizedCount", 0),
            "unindexed_files": summary.get("unindexedCount", 0),
            "stale_url_files": summary.get("staleBaseUrlCount", 0),
        },
        "factors": [
            {
                "key": f.get("key"),
                "count": f.get("count"),
                "impact": f.get("impact"),
                "label": f.get("label"),
            }
            for f in factors
        ],
        "interpretation": _grade_interpretation(grade.get("letter", "?")),
    }


def _grade_interpretation(letter: str) -> str:
    return {
        "A": "Vault is healthy. RAG retrieval should be optimal.",
        "B": "Vault is mostly healthy. Minor issues worth checking.",
        "C": "Vault has notable issues affecting RAG quality. Run vault_diagnose.",
        "D": "Vault health is poor. Multiple broken files. Immediate triage recommended.",
        "F": "Vault is critically degraded. Most files cannot be retrieved.",
    }.get(letter, "Unknown grade.")


def _normalize_diagnose(items: list[dict], issue_filter: str | None) -> dict:
    """Classify all uploads and return a prioritized triage list."""
    triage: list[dict] = []

    for item in items:
        issue_type = _classify_upload(item)
        if issue_type is None:
            continue
        if issue_filter and issue_type != issue_filter:
            continue
        triage.append(_upload_to_triage_entry(item, issue_type))

    # Sort by priority order
    priority_map = {k: i for i, k in enumerate(_ISSUE_PRIORITY)}
    triage.sort(key=lambda e: priority_map.get(e["issue_type"], 99))

    # Issue type counts
    counts: dict[str, int] = {}
    for entry in triage:
        counts[entry["issue_type"]] = counts.get(entry["issue_type"], 0) + 1

    return {
        "total_issues": len(triage),
        "issue_counts": counts,
        "triage": triage,
        "action_summary": _action_summary(counts),
    }


def _action_summary(counts: dict[str, int]) -> str:
    parts = []
    if counts.get("error", 0):
        n = counts["error"]
        parts.append(f"{n} file(s) in error state → run vault_repair(verb='requeue')")
    if counts.get("stale_url", 0):
        n = counts["stale_url"]
        parts.append(f"{n} file(s) with missing source → run vault_repair(verb='reingest', source_url=...)")
    if counts.get("unindexed", 0):
        n = counts["unindexed"]
        parts.append(f"{n} file(s) stuck in ingestion → run vault_repair(verb='requeue')")
    if counts.get("unscanned", 0):
        n = counts["unscanned"]
        parts.append(f"{n} file(s) never quality-scanned → run vault_repair(verb='requeue')")
    if counts.get("deleted", 0):
        n = counts["deleted"]
        parts.append(f"{n} deleted file(s) showing in vault → no repair available; remove manually")
    if counts.get("never_used", 0):
        n = counts["never_used"]
        parts.append(f"{n} file(s) never retrieved by RAG → consider removing unused files")
    if not parts:
        return "No actionable issues found."
    return " | ".join(parts)


# ── error helpers ─────────────────────────────────────────────────────────────

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

    def _reset_client(self):
        self._client = None

    def call(self, name: str, tool_input: dict) -> dict:
        if name == TOOL_VAULT_HEALTH:
            return self._vault_health(tool_input)
        if name == TOOL_VAULT_DIAGNOSE:
            return self._vault_diagnose(tool_input)
        if name == TOOL_VAULT_REPAIR:
            return self._vault_repair(tool_input)
        if name == TOOL_VAULT_REGRADE:
            return self._vault_regrade(tool_input)
        return _tool_error(f"unknown tool: {name}")

    # ── vault_health ──────────────────────────────────────────────────────────

    def _vault_health(self, inp: dict) -> dict:
        vault = inp.get("vault") or "personal"
        client, err = self._client_or_error()
        if err:
            return err
        try:
            raw = client.vault_health_summary(vault=vault)
        except AuthError as exc:
            self._reset_client()
            return _tool_error("authentication failed", str(exc))
        except RateLimitError as exc:
            return _tool_error("rate_limit", str(exc))
        except APIError as exc:
            return _tool_error(f"api_error (HTTP {exc.status})", str(exc))
        except Exception as exc:  # noqa: BLE001
            return _tool_error("network_error", str(exc))
        return _normalize_health(raw)

    # ── vault_diagnose ────────────────────────────────────────────────────────

    def _vault_diagnose(self, inp: dict) -> dict:
        vault = inp.get("vault") or "personal"
        issue_filter = inp.get("issue_filter") or None
        limit = min(max(int(inp.get("limit") or 50), 1), 200)

        client, err = self._client_or_error()
        if err:
            return err
        try:
            raw = client.list_uploads(limit=limit)
        except AuthError as exc:
            self._reset_client()
            return _tool_error("authentication failed", str(exc))
        except RateLimitError as exc:
            return _tool_error("rate_limit", str(exc))
        except APIError as exc:
            return _tool_error(f"api_error (HTTP {exc.status})", str(exc))
        except Exception as exc:  # noqa: BLE001
            return _tool_error("network_error", str(exc))

        items = raw.get("data") or []
        return _normalize_diagnose(items, issue_filter)

    # ── vault_repair ──────────────────────────────────────────────────────────

    def _vault_repair(self, inp: dict) -> dict:
        upload_id = (inp.get("upload_id") or "").strip()
        verb = (inp.get("verb") or "").strip().lower()
        dry_run = inp.get("dry_run", True)  # default TRUE — safe by default
        source_url = (inp.get("source_url") or "").strip()

        # --- validation ---
        if not upload_id:
            return _tool_error("upload_id is required")
        if verb not in _REPAIR_VERBS:
            return _tool_error(
                f"invalid verb: {verb!r}",
                f"Must be one of: {', '.join(sorted(_REPAIR_VERBS))}",
            )
        _, requires_url = _REPAIR_VERBS[verb]
        if requires_url and not source_url:
            return _tool_error(
                "source_url is required for verb='reingest'",
                "Provide the new URL to re-ingest the file from.",
            )

        # dry_run: describe the action without executing
        if dry_run:
            action_desc = {
                "requeue": f"Re-queue upload {upload_id} for ingestion",
                "reload": f"Reload and re-process content of upload {upload_id} from disk",
                "reingest": f"Re-ingest upload {upload_id} from source URL: {source_url!r}",
            }[verb]
            return {
                "dry_run": True,
                "upload_id": upload_id,
                "verb": verb,
                "action": action_desc,
                "message": (
                    "Dry run — no changes made. "
                    "Set dry_run=false to apply the repair for real."
                ),
            }

        # --- live mutation ---
        client, err = self._client_or_error()
        if err:
            return err
        try:
            if verb == "requeue":
                raw = client.requeue_upload(upload_id)
            elif verb == "reload":
                raw = client.reload_upload(upload_id)
            else:  # reingest
                raw = client.reingest_upload(upload_id, source_url)
        except AuthError as exc:
            self._reset_client()
            return _tool_error("authentication failed", str(exc))
        except RateLimitError as exc:
            return _tool_error("rate_limit", str(exc))
        except APIError as exc:
            return _tool_error(f"api_error (HTTP {exc.status})", str(exc))
        except Exception as exc:  # noqa: BLE001
            return _tool_error("network_error", str(exc))

        return {
            "dry_run": False,
            "upload_id": upload_id,
            "verb": verb,
            "success": raw.get("success", False),
            "message": raw.get("message") or "Repair dispatched.",
            "raw": raw,
        }

    # ── vault_regrade ─────────────────────────────────────────────────────────

    def _vault_regrade(self, inp: dict) -> dict:
        vault = inp.get("vault") or "personal"
        previous_score = inp.get("previous_score")

        client, err = self._client_or_error()
        if err:
            return err
        try:
            raw = client.vault_health_summary(vault=vault)
        except AuthError as exc:
            self._reset_client()
            return _tool_error("authentication failed", str(exc))
        except RateLimitError as exc:
            return _tool_error("rate_limit", str(exc))
        except APIError as exc:
            return _tool_error(f"api_error (HTTP {exc.status})", str(exc))
        except Exception as exc:  # noqa: BLE001
            return _tool_error("network_error", str(exc))

        result = _normalize_health(raw)

        # Attach diff if previous score provided
        if previous_score is not None:
            current_score = result.get("score")
            if current_score is not None:
                delta = current_score - int(previous_score)
                result["score_delta"] = delta
                result["grade_changed"] = result["grade"] != inp.get("_prev_grade", result["grade"])
                result["improvement_message"] = (
                    f"Score improved by {delta} points."
                    if delta > 0
                    else f"Score unchanged ({delta:+d})."
                    if delta == 0
                    else f"Score decreased by {abs(delta)} points."
                )

        return result
