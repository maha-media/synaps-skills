#!/usr/bin/env python3
"""Offline smoke test for pria-notion-tools — no network, stubs the gateway.

Verifies: initialize advertises the 3 tools, required args are enforced, and the
page_id/block_id public keys are rewritten to `id` before hitting the gateway.
"""
import notion_tools as nt

SENT = []


class FakeResp:
    def __init__(self, body): self._b = body
    def read(self): return self._b
    def close(self): pass


def fake_opener(req, timeout=30):
    import json
    SENT.append((req.full_url, json.loads(req.data.decode())))
    return FakeResp(b'{"success": true, "result": {"ok": true}}')


def client():
    return nt.GatewayClient("test-token", nt.DEFAULT_BASE, opener=fake_opener)


def expect(cond, msg):
    if not cond:
        raise SystemExit(f"FAIL: {msg}")
    print(f"ok: {msg}")


# 1. exactly 6 tools (3 read + 3 write), subjects wired.
names = [t["name"] for t in nt.TOOL_SPECS]
expect(names == ["notion_search", "notion_get_page", "notion_get_blocks", "notion_append_blocks", "notion_create_page", "notion_update_page"], f"6 tools declared: {names}")
expect(nt.TOOL_SUBJECTS == {
    "notion_search": "NOTION_SEARCH",
    "notion_get_page": "NOTION_GET_PAGE",
    "notion_get_blocks": "NOTION_GET_BLOCKS",
    "notion_append_blocks": "NOTION_APPEND_BLOCKS",
    "notion_create_page": "NOTION_CREATE_PAGE",
    "notion_update_page": "NOTION_UPDATE_PAGE",
}, "subjects mapped")

# 2. required-arg enforcement.
for name, bad in [("notion_get_page", {}), ("notion_get_blocks", {})]:
    try:
        nt.validate(name, dict(bad))
        raise SystemExit(f"FAIL: {name} accepted empty input")
    except nt.ToolError:
        print(f"ok: {name} rejects missing required arg")

# 3. search sends query/page_size verbatim.
args = nt.validate("notion_search", {"query": "roadmap", "page_size": 5})
client().call(nt.TOOL_SUBJECTS["notion_search"], args)
url, body = SENT[-1]
expect(url.endswith("/internal/agent-tool-call"), "posts to gateway endpoint")
expect(body == {"subject": "NOTION_SEARCH", "args": {"query": "roadmap", "page_size": 5}}, f"search args: {body}")

# 4. get_page: page_id -> id.
args = nt.validate("notion_get_page", {"page_id": "abc-123"})
client().call(nt.TOOL_SUBJECTS["notion_get_page"], args)
_, body = SENT[-1]
expect(body == {"subject": "NOTION_GET_PAGE", "args": {"id": "abc-123"}}, f"get_page remap: {body}")

# 5. get_blocks: block_id -> id, page_size kept.
args = nt.validate("notion_get_blocks", {"block_id": "def-456", "page_size": 50})
client().call(nt.TOOL_SUBJECTS["notion_get_blocks"], args)
_, body = SENT[-1]
expect(body == {"subject": "NOTION_GET_BLOCKS", "args": {"id": "def-456", "page_size": 50}}, f"get_blocks remap: {body}")

# writes: page_id -> id remap + dry_run passthrough
args = nt.validate("notion_append_blocks", {"page_id": "pg-1", "blocks": [{"type": "paragraph", "text": "hi"}], "dry_run": True})
client().call(nt.TOOL_SUBJECTS["notion_append_blocks"], args)
url, body = SENT[-1]
expect(body["subject"] == "NOTION_APPEND_BLOCKS" and body["args"]["id"] == "pg-1" and body["args"]["dry_run"] is True and "page_id" not in body["args"], f"append remap+dry_run: {body}")
args = nt.validate("notion_update_page", {"page_id": "pg-2", "title": "New"})
client().call(nt.TOOL_SUBJECTS["notion_update_page"], args)
url, body = SENT[-1]
expect(body["subject"] == "NOTION_UPDATE_PAGE" and body["args"]["id"] == "pg-2" and "page_id" not in body["args"], f"update remap: {body}")

print("\nall smoke checks passed")
