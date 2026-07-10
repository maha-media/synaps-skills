#!/usr/bin/env python3
"""misfire Synaps extension — misconception diagnoser.

Protocol: Content-Length-framed JSON-RPC over stdio (mirrors finlens).
  initialize  → advertise tools
  tool.call   → run misfire_diagnose, return {"content": text}
  shutdown    → ack

Tool:
  misfire_diagnose — given a question + student's wrong answer, return a NAMED
    misconception, the reconstructed reasoning that produced the wrong answer,
    the exact break point, and a remediation move (contrast case + probe
    question). Uses groq (llama-3.3-70b-versatile) with JSON-mode + a
    self-verification pass that confirms the named misconception actually
    reproduces the student's answer.
"""
import sys
import os
import json
import re
import ssl
import urllib.request
import urllib.error

# ── config ─────────────────────────────────────────────────────────────────
CONFIG_PATH = os.path.expanduser("~/.synaps-cli/config")
GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
GROQ_MODEL = "llama-3.3-70b-versatile"


def _load_groq_key() -> str:
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            for line in f:
                m = re.match(r"\s*provider\.groq\s*=\s*(\S+)", line)
                if m:
                    return m.group(1).strip()
    except Exception as e:  # noqa: BLE001
        _log(f"config read failed: {e}")
    return ""


# ── tool registration ─────────────────────────────────────────────────────
TOOLS = [
    {
        "name": "misfire_diagnose",
        "description": (
            "Diagnose the misconception behind a student's wrong answer. Returns a NAMED "
            "misconception, the reconstructed reasoning that produced the wrong answer "
            "('why they think it'), the correct principle, and a concrete remediation move "
            "(contrast case + probe question) — not just 'incorrect'. Uses an LLM to "
            "reverse-engineer the student's broken mental model and self-verifies that the "
            "diagnosis actually reproduces their answer."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "question": {"type": "string", "description": "The problem/question as posed."},
                "student_answer": {"type": "string", "description": "The student's verbatim wrong answer."},
                "expected_answer": {"type": "string", "description": "The correct answer / rubric (optional but helpful)."},
                "subject": {"type": "string", "description": "Domain e.g. 'orgchem', 'calc1', 'stats' — selects taxonomy."},
                "student_work": {"type": "string", "description": "Any shown steps (optional)."}
            },
            "required": ["question", "student_answer"]
        }
    }
]


# ── JSON-RPC framing (byte-for-byte from finlens) ─────────────────────────
def _read_message():
    headers = {}
    while True:
        line = b""
        while not line.endswith(b"\r\n"):
            ch = sys.stdin.buffer.read(1)
            if not ch:
                return None
            line += ch
        line = line[:-2]
        if line == b"":
            break
        if b":" in line:
            k, _, v = line.partition(b":")
            headers[k.strip().lower()] = v.strip()
    length = int(headers.get(b"content-length", b"0"))
    if length <= 0:
        return None
    body = sys.stdin.buffer.read(length)
    return json.loads(body.decode("utf-8"))


def _send_message(obj):
    body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    header = f"Content-Length: {len(body)}\r\n\r\n".encode("utf-8")
    sys.stdout.buffer.write(header + body)
    sys.stdout.buffer.flush()


def _log(msg):
    print(f"[misfire] {msg}", file=sys.stderr, flush=True)


def _ok(req_id, result):
    _send_message({"jsonrpc": "2.0", "id": req_id, "result": result})


def _err(req_id, code, message):
    _send_message({"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}})


# ── groq call ─────────────────────────────────────────────────────────────
def _groq_chat(api_key: str, system: str, user: str, timeout: int = 45) -> dict:
    payload = {
        "model": GROQ_MODEL,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "response_format": {"type": "json_object"},
        "temperature": 0.2,
    }
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        GROQ_URL,
        data=body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "misfire-synaps-ext/0.1 (+python-urllib)",
        },
        method="POST",
    )
    ctx = ssl.create_default_context()
    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
        raw = resp.read().decode("utf-8")
    data = json.loads(raw)
    content = data["choices"][0]["message"]["content"]
    return json.loads(content)


# ── diagnostic pipeline ──────────────────────────────────────────────────
DIAGNOSE_SYSTEM = """You are an expert cognitive tutor and diagnostician of student misconceptions.
Your job is NOT to say the answer is wrong. Your job is to REVERSE-ENGINEER the (broken but internally consistent) reasoning that made this wrong answer feel right to the student, then NAME the underlying misconception using terminology real education researchers use for that domain when possible.

Return a JSON object with EXACTLY these keys:
{
  "misconception_name": "short label — a real named misconception, not 'incorrect' or 'confused about X'. E.g. 'base-strength/steric-access conflation', 'radical-vs-ionic mechanism confusion', 'operational nucleophile-base non-differentiation'.",
  "why_they_think_it": "2-4 sentences: the plausible mental model the student is running. Written as if narrating their reasoning from the inside. Must ACTUALLY REPRODUCE their stated answer.",
  "correct_principle": "1-2 sentences: the right principle, stated cleanly and specifically for this problem — not a generic platitude.",
  "remediation_move": {
    "contrast_case": "A minimal-pair scenario or example that makes the misconception fail visibly. Concrete, specific, uses real substrates/values.",
    "probe_question": "One question to ask the student that forces them to confront the misconception. Does NOT contain the answer."
  },
  "confidence": 0.0-1.0
}

Rules:
- Name a REAL misconception with domain-appropriate specificity. Not 'they misunderstood the mechanism' — name WHICH conflation or WHICH overgeneralization.
- The 'why_they_think_it' must be a mental model that, if applied, produces the student's actual wrong answer.
- The remediation is a MOVE (contrast case + probe question), not the correct answer handed over.
- Be brief. No preamble. JSON only.
"""


VERIFY_SYSTEM = """You are a verifier checking whether a proposed misconception actually explains a student's wrong answer.

You will receive: the question, the student's wrong answer, and a proposed misconception (name + reconstructed reasoning).

Return JSON:
{
  "reproduces": true | false,
  "explanation": "1-2 sentences: if a student genuinely held this misconception and applied it to this question, would they arrive at (or gravitate toward) the stated wrong answer? Be strict but fair.",
  "adjusted_confidence": 0.0-1.0
}
JSON only."""


def diagnose(inp: dict, api_key: str) -> dict:
    question = str(inp.get("question", "")).strip()
    student_answer = str(inp.get("student_answer", "")).strip()
    expected = str(inp.get("expected_answer", "")).strip()
    subject = str(inp.get("subject", "")).strip()
    student_work = str(inp.get("student_work", "")).strip()

    user_parts = []
    if subject:
        user_parts.append(f"DOMAIN: {subject}")
    user_parts.append(f"QUESTION / SITUATION:\n{question}")
    user_parts.append(f"STUDENT'S WRONG ANSWER (verbatim):\n{student_answer}")
    if student_work:
        user_parts.append(f"STUDENT'S SHOWN WORK:\n{student_work}")
    if expected:
        user_parts.append(f"CORRECT ANSWER / RUBRIC:\n{expected}")
    user_parts.append("Diagnose. Return the JSON schema exactly.")
    user_msg = "\n\n".join(user_parts)

    _log("calling groq (diagnose)…")
    diag = _groq_chat(api_key, DIAGNOSE_SYSTEM, user_msg)

    # ── self-verification pass ──
    verify_user = json.dumps({
        "question": question,
        "student_answer": student_answer,
        "proposed_misconception_name": diag.get("misconception_name", ""),
        "proposed_reasoning": diag.get("why_they_think_it", ""),
    }, ensure_ascii=False)
    _log("calling groq (verify)…")
    try:
        verdict = _groq_chat(api_key, VERIFY_SYSTEM, verify_user)
    except Exception as e:  # noqa: BLE001
        _log(f"verify failed: {e}")
        verdict = {"reproduces": None, "explanation": f"verify skipped: {e}", "adjusted_confidence": diag.get("confidence", 0.5)}

    # merge — final confidence is the verifier's if it reproduces; else halved
    reproduces = verdict.get("reproduces")
    base_conf = float(diag.get("confidence", 0.5) or 0.5)
    if reproduces is True:
        final_conf = float(verdict.get("adjusted_confidence", base_conf) or base_conf)
    elif reproduces is False:
        final_conf = round(base_conf * 0.5, 2)
    else:
        final_conf = base_conf

    diag["confidence"] = round(final_conf, 2)
    diag["verification"] = {
        "reproduces_student_answer": reproduces,
        "verifier_note": verdict.get("explanation", ""),
    }
    return diag


def _fmt_diagnosis(d: dict) -> str:
    lines = []
    lines.append(f"● MISCONCEPTION: {d.get('misconception_name', '(unnamed)')}")
    lines.append(f"  confidence: {d.get('confidence', 0.0)}")
    v = d.get("verification", {})
    rep = v.get("reproduces_student_answer")
    tag = {True: "✓ verified reproduces student's answer", False: "✗ does NOT reproduce — confidence halved", None: "· verification skipped"}[rep] if rep in (True, False, None) else "· verification n/a"
    lines.append(f"  {tag}")
    if v.get("verifier_note"):
        lines.append(f"  verifier: {v['verifier_note']}")
    lines.append("")
    lines.append(f"WHY THEY THINK IT:\n  {d.get('why_they_think_it', '')}")
    lines.append("")
    lines.append(f"CORRECT PRINCIPLE:\n  {d.get('correct_principle', '')}")
    lines.append("")
    rem = d.get("remediation_move", {}) or {}
    lines.append("REMEDIATION MOVE:")
    lines.append(f"  contrast case : {rem.get('contrast_case', '')}")
    lines.append(f"  probe question: {rem.get('probe_question', '')}")
    return "\n".join(lines)


def _offline_diagnosis(inp: dict) -> str:
    # Offline / proof mode (MISFIRE_OFFLINE set, or no LLM key present). Confirms the
    # extension is staged, loaded, and its tool is callable — the Phase-2 staging proof
    # — without needing any LLM credential. Echoes the inputs so the pipeline is
    # end-to-end verifiable.
    q = str(inp.get("question", "")).strip()
    a = str(inp.get("student_answer", "")).strip()
    return (
        "MISFIRE (offline proof mode — no LLM key configured)\n"
        f"  received question     : {q[:200]}\n"
        f"  received wrong answer : {a[:200]}\n"
        "  status: extension staged + loaded + tool invoked successfully.\n"
        "  Set MISFIRE_LLM_KEY to enable real AI misconception diagnosis."
    )


def dispatch_tool(name: str, inp: dict) -> str:
    if name == "misfire_diagnose":
        if not str(inp.get("question", "")).strip() or not str(inp.get("student_answer", "")).strip():
            return "misfire_diagnose: 'question' and 'student_answer' are required."
        # Key: MISFIRE_LLM_KEY env (guest-agent-injected, scoped) first, then the
        # local ~/.synaps-cli/config groq key. Offline proof mode if forced or keyless.
        api_key = os.environ.get("MISFIRE_LLM_KEY", "").strip() or _load_groq_key()
        offline = os.environ.get("MISFIRE_OFFLINE", "").strip().lower() in ("1", "true", "yes") or not api_key
        if offline:
            return _offline_diagnosis(inp)
        diag = diagnose(inp, api_key)
        # return both a human-readable summary and the structured JSON payload
        pretty = _fmt_diagnosis(diag)
        return pretty + "\n\n--- STRUCTURED ---\n" + json.dumps(diag, ensure_ascii=False, indent=2)
    return f"unknown tool: {name}"


def main():
    _log("misfire extension started")
    while True:
        try:
            msg = _read_message()
        except Exception as e:  # noqa: BLE001
            _log(f"read error: {e}")
            break
        if msg is None:
            break
        method = msg.get("method", "")
        req_id = msg.get("id")
        params = msg.get("params", {}) or {}
        try:
            if method == "initialize":
                _ok(req_id, {"protocol_version": 1, "capabilities": {"tools": TOOLS}})
            elif method == "tool.call":
                tool_name = params.get("name", "")
                tool_input = params.get("input", params.get("arguments", {})) or {}
                try:
                    text = dispatch_tool(tool_name, tool_input)
                    _ok(req_id, {"content": text})
                except urllib.error.HTTPError as e:
                    _err(req_id, -32000, f"groq HTTPError {e.code}: {e.read().decode('utf-8', 'ignore')[:400]}")
                except Exception as e:  # noqa: BLE001
                    _err(req_id, -32000, f"{type(e).__name__}: {e}")
            elif method == "hook.handle":
                _ok(req_id, {"action": "continue"})
            elif method == "shutdown":
                _ok(req_id, {})
                break
            else:
                if req_id is not None:
                    _err(req_id, -32601, f"Method not found: {method}")
        except Exception as e:  # noqa: BLE001
            _log(f"error on {method}: {e}")
            if req_id is not None:
                _err(req_id, -32000, str(e))
    _log("misfire extension stopped")


if __name__ == "__main__":
    main()
