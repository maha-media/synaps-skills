"""Unit tests for vault_diagnose — issue classification, normalization, error paths.

All HTTP mocked. Verifies triage classification logic and priority ordering.
"""
import json
import os
import sys
import unittest
import urllib.error
from io import BytesIO
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "extensions"))

from pria.tools import ToolHandler, TOOL_VAULT_DIAGNOSE, _classify_upload  # noqa: E402
from pria.client import PriaClient  # noqa: E402

JWT = "eyJfake.jwt"

# Sample uploads list response
def _make_upload(
    _id="up1",
    originalname="file.txt",
    status="selected",
    ingestion_phase="done",
    ingestion_error=None,
    file_on_disk=True,
    file_url="https://pria/uploads/file.txt",
    rag_hit_count=5,
    garbage_score=0.1,
    created="2020-01-01T00:00:00.000Z",
    mimetype="text/plain",
    **kwargs,
):
    return {
        "_id": _id,
        "originalname": originalname,
        "mimetype": mimetype,
        "status": status,
        "created": created,
        "filesize": 1024,
        "file_title": originalname,
        "file_url": file_url,
        "fileOnDisk": file_on_disk,
        "ragHitCount": rag_hit_count,
        "lastRagHitAt": None,
        "garbageScore": garbage_score,
        "ingestion": {
            "phase": ingestion_phase,
            "lastError": ingestion_error,
            "attempts": 1 if ingestion_error else 0,
            "enqueuedAt": "2020-01-01T00:00:00.000Z",
            "startedAt": "2020-01-01T00:00:01.000Z",
            "completedAt": "2020-01-01T00:01:00.000Z" if ingestion_phase == "done" else None,
        },
        **kwargs,
    }


UPLOADS_RESP = {
    "success": True,
    "data": [
        # error file
        _make_upload(_id="err1", originalname="broken.txt", ingestion_phase="error",
                     ingestion_error="Empty file — no content to process"),
        # healthy file
        _make_upload(_id="ok1", originalname="good.txt", rag_hit_count=10,
                     garbage_score=0.05, created="2025-01-01T00:00:00.000Z"),
        # never used (old file, 0 RAG hits)
        _make_upload(_id="old1", originalname="forgotten.txt", rag_hit_count=0,
                     garbage_score=0.05, created="2020-01-01T00:00:00.000Z"),
        # stale URL (file not on disk)
        _make_upload(_id="stale1", originalname="missing.pdf", file_on_disk=False,
                     rag_hit_count=0, created="2020-01-01T00:00:00.000Z"),
        # unscanned (no garbage score, non-image, phase=done)
        _make_upload(_id="unscan1", originalname="unscan.txt", garbage_score=None,
                     rag_hit_count=5, created="2025-01-01T00:00:00.000Z"),
        # deleted file
        _make_upload(_id="del1", originalname="deleted.txt", status="deleted",
                     ingestion_phase="error"),
    ],
}


class FakeResp:
    def __init__(self, body: bytes):
        self._body = body

    def read(self):
        return self._body

    def close(self):
        pass


class CallRecorder:
    def __init__(self, responses):
        self._responses = list(responses)
        self.calls = []

    def __call__(self, req, timeout=None):
        self.calls.append(req)
        resp = self._responses.pop(0)
        if isinstance(resp, Exception):
            raise resp
        return resp


def _make_handler(opener):
    h = ToolHandler({"pria_api_base": "https://pria"})
    h._client = PriaClient(api_key="pria_" + "a" * 40, base_url="https://pria", _opener=opener)
    h._client._jwt = JWT
    return h


def _http_error(status, data):
    return urllib.error.HTTPError(
        url="https://pria/", code=status, msg="err", hdrs={},
        fp=BytesIO(json.dumps(data).encode()),
    )


class TestClassifyUpload(unittest.TestCase):
    """Unit tests for the _classify_upload helper in isolation."""

    def test_error_phase_classified_as_error(self):
        item = _make_upload(ingestion_phase="error")
        self.assertEqual(_classify_upload(item), "error")

    def test_file_not_on_disk_classified_as_stale_url(self):
        item = _make_upload(file_on_disk=False, status="selected")
        self.assertEqual(_classify_upload(item), "stale_url")

    def test_deleted_status_classified_as_deleted(self):
        # deleted without error phase
        item = _make_upload(status="deleted", ingestion_phase="done")
        self.assertEqual(_classify_upload(item), "deleted")

    def test_no_garbage_score_non_image_classified_as_unscanned(self):
        item = _make_upload(garbage_score=None, mimetype="text/plain",
                            ingestion_phase="done", rag_hit_count=5,
                            created="2025-01-01T00:00:00.000Z")
        self.assertEqual(_classify_upload(item), "unscanned")

    def test_image_with_no_garbage_score_not_classified_as_unscanned(self):
        item = _make_upload(garbage_score=None, mimetype="image/png",
                            ingestion_phase="done", rag_hit_count=5,
                            created="2025-01-01T00:00:00.000Z")
        # Images are expected to have no garbageScore — should not be flagged
        result = _classify_upload(item)
        self.assertNotEqual(result, "unscanned")

    def test_old_rag_zero_file_classified_as_never_used(self):
        item = _make_upload(rag_hit_count=0, created="2020-01-01T00:00:00.000Z",
                            ingestion_phase="done", garbage_score=0.05)
        self.assertEqual(_classify_upload(item), "never_used")

    def test_recent_rag_zero_file_not_classified(self):
        """A file with 0 RAG hits but created recently (< 7d) is NOT never_used."""
        import datetime
        recent = (datetime.datetime.now(datetime.timezone.utc) -
                  datetime.timedelta(days=3)).isoformat()
        item = _make_upload(rag_hit_count=0, created=recent,
                            ingestion_phase="done", garbage_score=0.05)
        self.assertIsNone(_classify_upload(item))

    def test_healthy_file_returns_none(self):
        import datetime
        recent = (datetime.datetime.now(datetime.timezone.utc) -
                  datetime.timedelta(days=1)).isoformat()
        item = _make_upload(
            rag_hit_count=10, garbage_score=0.05, ingestion_phase="done",
            file_on_disk=True, status="selected", created=recent,
        )
        self.assertIsNone(_classify_upload(item))


class TestVaultDiagnose(unittest.TestCase):
    def setUp(self):
        os.environ["PRIA_API_KEY"] = "pria_" + "a" * 40

    def tearDown(self):
        os.environ.pop("PRIA_API_KEY", None)

    def test_normalized_shape(self):
        opener = CallRecorder([FakeResp(json.dumps(UPLOADS_RESP).encode())])
        h = _make_handler(opener)
        result = h.call(TOOL_VAULT_DIAGNOSE, {})

        self.assertIn("total_issues", result)
        self.assertIn("issue_counts", result)
        self.assertIn("triage", result)
        self.assertIn("action_summary", result)

    def test_error_files_included(self):
        opener = CallRecorder([FakeResp(json.dumps(UPLOADS_RESP).encode())])
        h = _make_handler(opener)
        result = h.call(TOOL_VAULT_DIAGNOSE, {})
        triage = result["triage"]
        ids = [e["upload_id"] for e in triage]
        self.assertIn("err1", ids)

    def test_healthy_file_excluded(self):
        opener = CallRecorder([FakeResp(json.dumps(UPLOADS_RESP).encode())])
        h = _make_handler(opener)
        result = h.call(TOOL_VAULT_DIAGNOSE, {})
        ids = [e["upload_id"] for e in result["triage"]]
        self.assertNotIn("ok1", ids)

    def test_error_files_sorted_first(self):
        opener = CallRecorder([FakeResp(json.dumps(UPLOADS_RESP).encode())])
        h = _make_handler(opener)
        result = h.call(TOOL_VAULT_DIAGNOSE, {})
        triage = result["triage"]
        self.assertGreater(len(triage), 0)
        self.assertEqual(triage[0]["issue_type"], "error")

    def test_issue_counts_aggregated(self):
        opener = CallRecorder([FakeResp(json.dumps(UPLOADS_RESP).encode())])
        h = _make_handler(opener)
        result = h.call(TOOL_VAULT_DIAGNOSE, {})
        counts = result["issue_counts"]
        self.assertGreaterEqual(counts.get("error", 0), 1)

    def test_triage_entry_shape(self):
        opener = CallRecorder([FakeResp(json.dumps(UPLOADS_RESP).encode())])
        h = _make_handler(opener)
        result = h.call(TOOL_VAULT_DIAGNOSE, {})
        entry = next(e for e in result["triage"] if e["upload_id"] == "err1")
        for field in ("upload_id", "filename", "issue_type", "ingestion_phase",
                      "ingestion_error", "recommended_verb"):
            self.assertIn(field, entry, f"missing field: {field}")

    def test_error_entry_has_recommended_verb(self):
        opener = CallRecorder([FakeResp(json.dumps(UPLOADS_RESP).encode())])
        h = _make_handler(opener)
        result = h.call(TOOL_VAULT_DIAGNOSE, {})
        entry = next(e for e in result["triage"] if e["issue_type"] == "error")
        self.assertEqual(entry["recommended_verb"], "requeue")

    def test_issue_filter_limits_results(self):
        opener = CallRecorder([FakeResp(json.dumps(UPLOADS_RESP).encode())])
        h = _make_handler(opener)
        result = h.call(TOOL_VAULT_DIAGNOSE, {"issue_filter": "error"})
        for entry in result["triage"]:
            self.assertEqual(entry["issue_type"], "error")

    def test_action_summary_mentions_error_files(self):
        opener = CallRecorder([FakeResp(json.dumps(UPLOADS_RESP).encode())])
        h = _make_handler(opener)
        result = h.call(TOOL_VAULT_DIAGNOSE, {})
        self.assertIn("requeue", result["action_summary"])

    def test_empty_vault_returns_zero_issues(self):
        opener = CallRecorder([FakeResp(json.dumps({"success": True, "data": []}).encode())])
        h = _make_handler(opener)
        result = h.call(TOOL_VAULT_DIAGNOSE, {})
        self.assertEqual(result["total_issues"], 0)
        self.assertEqual(result["triage"], [])

    def test_api_error_returns_structured_error(self):
        opener = CallRecorder([_http_error(500, {"message": "Server error"})])
        h = _make_handler(opener)
        result = h.call(TOOL_VAULT_DIAGNOSE, {})
        self.assertIn("error", result)
        self.assertNotIn("triage", result)

    def test_no_api_key_returns_structured_error(self):
        os.environ.pop("PRIA_API_KEY", None)
        h = ToolHandler({"pria_api_base": "https://pria"})
        result = h.call(TOOL_VAULT_DIAGNOSE, {})
        self.assertIn("error", result)

    def test_limit_clamped_to_200(self):
        opener = CallRecorder([FakeResp(json.dumps({"success": True, "data": []}).encode())])
        h = _make_handler(opener)
        h.call(TOOL_VAULT_DIAGNOSE, {"limit": 9999})
        body = json.loads(opener.calls[0].data.decode())
        self.assertLessEqual(body["limit"], 200)


if __name__ == "__main__":
    unittest.main()
