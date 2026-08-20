import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
PY = REPO / ".venv" / "bin" / "python"
MAIN = REPO / "main.py"


def _frame(obj):
    body = json.dumps(obj).encode()
    return f"Content-Length: {len(body)}\r\n\r\n".encode() + body


def _read_one(stream):
    headers = {}
    while True:
        line = b""
        while not line.endswith(b"\r\n"):
            c = stream.read(1)
            if not c:
                return None
            line += c
        if line == b"\r\n":
            break
        k, _, v = line[:-2].partition(b":")
        headers[k.strip().lower()] = v.strip()
    n = int(headers[b"content-length"])
    return json.loads(stream.read(n))


def _roundtrip(messages, env_extra=None):
    env = os.environ.copy()
    if env_extra:
        env.update(env_extra)
    p = subprocess.Popen([str(PY), str(MAIN)], stdin=subprocess.PIPE,
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                         env=env)
    payload = b"".join(_frame(m) for m in messages)
    p.stdin.write(payload)
    p.stdin.flush()
    results = []
    for _ in messages:
        r = _read_one(p.stdout)
        if r is None:
            break
        results.append(r)
    p.stdin.close()
    p.wait(timeout=10)
    return results


def test_protocol_initialize():
    [resp] = _roundtrip([
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
        {"jsonrpc": "2.0", "id": 2, "method": "shutdown"},
    ])[:1]
    assert resp["id"] == 1
    caps = resp["result"]["capabilities"]
    tool_names = [t["name"] for t in caps["tools"]]
    assert "research_ticker" in tool_names
    schema = next(t for t in caps["tools"] if t["name"] == "research_ticker")["input_schema"]
    assert "ticker" in schema["properties"]
    assert "question" in schema["properties"]


def test_research_ticker_stub_returns_finalized_verdict():
    results = _roundtrip([
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
        {"jsonrpc": "2.0", "id": 2, "method": "tool.call",
         "params": {"name": "research_ticker",
                    "input": {"ticker": "NVDA", "question": "Is the Q3 setup risk-on?"}}},
        {"jsonrpc": "2.0", "id": 3, "method": "shutdown"},
    ], env_extra={"XCAL_STUB": "1"})
    tool_resp = next(r for r in results if r["id"] == 2)
    body = json.loads(tool_resp["result"]["content"])
    assert body["ticker"] == "NVDA"
    assert body["findings"], "stub should include at least one finding"
    numeric = [f for f in body["findings"] if f.get("kind") == "numeric"]
    assert numeric and all(f["citations"] for f in numeric)
    call_ids = {lc["call_id"] for lc in body["lens_calls"]}
    for f in numeric:
        for c in f["citations"]:
            assert c in call_ids


def test_research_ticker_via_loop_mocked(tmp_path):
    """Protocol-level: drive the real loop with LLM + finlens fixtures
    injected via env vars. Proves wiring of skill → router → verdict → axel."""
    skills_dir = tmp_path / "skills"
    (skills_dir / "quarterly-check").mkdir(parents=True)
    seed = REPO / "skills" / "quarterly-check" / "SKILL.md"
    (skills_dir / "quarterly-check" / "SKILL.md").write_text(
        seed.read_text(encoding="utf-8"), encoding="utf-8")

    finlens_fix = tmp_path / "finlens.json"
    finlens_fix.write_text(json.dumps({
        "fundamentals": {"call_id": "finlens:fundamentals#A1",
                         "lens": "fundamentals", "ticker": "NVDA",
                         "status": "ok", "latency_ms": 1,
                         "payload": {"revenue": 60.0}},
        "technicals": {"call_id": "finlens:technicals#B2",
                       "lens": "technicals", "ticker": "NVDA",
                       "status": "ok", "latency_ms": 1,
                       "payload": {"trend": "up"}},
    }))

    llm_fix = tmp_path / "llm.json"
    llm_fix.write_text(json.dumps([
        {"stop_reason": "tool_use", "content": [
            {"type": "tool_use", "id": "t1", "name": "finlens",
             "input": {"lens": "fundamentals", "ticker": "NVDA"}}
        ]},
        {"stop_reason": "tool_use", "content": [
            {"type": "tool_use", "id": "t2", "name": "finlens",
             "input": {"lens": "technicals", "ticker": "NVDA"}}
        ]},
        {"stop_reason": "end_turn", "content": [{"type": "text", "text": json.dumps({
            "findings": [
                {"claim": "Revenue 60", "kind": "numeric", "value": 60.0,
                 "citations": ["finlens:fundamentals#A1"], "confidence": 0.8},
                {"claim": "Trend is up", "kind": "qualitative",
                 "citations": [], "confidence": 0.5},
            ],
            "synthesis": "NVDA fundamentals strong; technicals constructive.",
        })}]},
    ]))

    results = _roundtrip([
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
        {"jsonrpc": "2.0", "id": 2, "method": "tool.call",
         "params": {"name": "research_ticker",
                    "input": {"ticker": "NVDA", "question": "setup?"}}},
        {"jsonrpc": "2.0", "id": 3, "method": "shutdown"},
    ], env_extra={
        "XCAL_SKILLS_DIR": str(skills_dir),
        "XCAL_LLM_FIXTURE": str(llm_fix),
        "XCAL_FINLENS_FIXTURE": str(finlens_fix),
    })

    tool_resp = next(r for r in results if r["id"] == 2)
    assert "result" in tool_resp, tool_resp
    body = json.loads(tool_resp["result"]["content"])
    assert body["ticker"] == "NVDA"
    assert body["skill_used"] == "quarterly-check"
    assert len(body["lens_calls"]) == 2
    call_ids = {lc["call_id"] for lc in body["lens_calls"]}
    assert "finlens:fundamentals#A1" in call_ids
    numeric = [f for f in body["findings"] if f.get("kind") == "numeric"]
    assert numeric and all(f["citations"] for f in numeric)
    for f in numeric:
        for c in f["citations"]:
            assert c in call_ids
    assert body["axel_memory_id"] == "fixture-mem-id"
