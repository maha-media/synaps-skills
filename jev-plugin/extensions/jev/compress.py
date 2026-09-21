"""compress — after_tool_call output relevance compression (opt-in).

The safest form of the "context meter" idea: decide how much of a large tool
output the agent actually needs *at ingestion*, before it enters history.
Nothing is removed retroactively, so the prompt-cache prefix is never
invalidated and the reasoning trail stays intact — the elision marker tells
the model exactly what was cut and how to get it back.

Conservative by design:
  * off by default (`compress = false`)
  * only tools in `compress_tools` (default: bash)
  * only outputs ≥ `compress_min_bytes` (default 6000)
  * never when the output looks like a failure the agent must inspect
  * only when P(head+tail suffice) ≥ `compress_min_conf` (mass on levels 0+1)
"""

from __future__ import annotations

import re
import time

from .client import DecisionClient, JevError, top_level

NEED_LEVELS = [
    "Only the outcome matters (pass/fail, a count, the last few lines)",
    "The first and last parts are enough; the middle is repetitive or boilerplate",
    "Most of it is needed",
    "Every line matters — the agent will act on specific lines throughout",
]

_ERRORISH = re.compile(
    r"(?im)^(?:.*(?<!\b0 )\b(error|errors|panic|panicked|failed|failure|traceback|exception|fatal|segfault)\b.*|.*exit (?:code|status) [1-9]\d*.*)$"
)


class CompressConfig:
    def __init__(self, cfg: dict) -> None:
        self.tools = {t.strip() for t in str(cfg.get("compress_tools") or "bash").split(",") if t.strip()}
        self.min_bytes = int(cfg.get("compress_min_bytes", 6000))
        self.min_conf = float(cfg.get("compress_min_conf", 0.85))
        self.head = int(cfg.get("compress_head", 1500))
        self.tail = int(cfg.get("compress_tail", 1000))


def questions() -> dict:
    return {
        "need": {
            "type": "score",
            "instructions": "Given `goal` and `call`, how much of the full tool `output` (only `output_head` and `output_tail` are shown; `total_bytes` is the real size) does the agent need to continue?",
            "criteria": NEED_LEVELS,
        },
        "is_failure": {
            "type": "noul",
            "instructions": "Does `output` indicate a failure, error, or unexpected result that the agent must inspect in detail?",
            "criteria": {"true": "Errors, failing tests, stack traces, non-zero exit", "false": "Routine or successful output"},
        },
    }


def render(output: str, answer_need: dict, cfg: CompressConfig) -> str:
    head, tail = output[: cfg.head], output[-cfg.tail :]
    elided = len(output) - len(head) - len(tail)
    _, label = top_level(answer_need)
    p = p_head_tail_suffice(answer_need)
    marker = (
        f"\n\n[jev: elided {elided} of {len(output)} bytes — relevance \"{label}\" (p={p:.2f}). "
        "Re-run the command with a narrower filter if you need the full output.]\n\n"
    )
    return head + marker + tail


def p_head_tail_suffice(answer_need: dict) -> float:
    """Probability mass on the two levels where head+tail is enough.

    Jev's `confidence` measures spread across *all* levels; levels 0 and 1
    both lead to the same action here, so we collapse them (docs: "you are
    never locked into our definition" of confidence).
    """
    probs = answer_need.get("probabilities") or {}
    return float(probs.get("0", 0.0)) + float(probs.get("1", 0.0))


def should_compress(answers: dict, cfg: CompressConfig) -> bool:
    if float((answers.get("is_failure") or {}).get("noul", 1.0)) >= 0.3:
        return False
    return p_head_tail_suffice(answers.get("need") or {}) >= cfg.min_conf


def handle(params: dict, goal: str, client: DecisionClient, cfg: CompressConfig, audit, log) -> dict:
    from .triage import recognized
    if recognized(params):
        return {"action": "continue"}
    tool = params.get("tool_runtime_name") or params.get("tool_name") or ""
    output = params.get("tool_output")
    if tool not in cfg.tools or not isinstance(output, str) or len(output) < cfg.min_bytes:
        return {"action": "continue"}
    if len(output) <= cfg.head + cfg.tail + 200:
        return {"action": "continue"}
    if _ERRORISH.search(output[-3000:]):
        return {"action": "continue"}

    tool_input = params.get("tool_input") or {}
    state = {
        "goal": goal[:600] or "(unknown)",
        "call": {"tool": tool, "command": str(tool_input.get("command", ""))[:500]},
        "output_head": output[:1500],
        "output_tail": output[-800:],
        "total_bytes": len(output),
    }
    t0 = time.monotonic()
    try:
        resp = client.decide(state, questions(), op="compress")
        answers = resp["answers"]
        ms = int((time.monotonic() - t0) * 1000)
        if not should_compress(answers, cfg):
            audit.bump("compress.keep")
            log(f"compress {tool}: keep ({ms} ms)")
            return {"action": "continue"}
        new = render(output, answers["need"], cfg)
        audit.bump("compress.elide")
        audit.write({"op": "compress", "tool": tool, "from": len(output), "to": len(new), "ms": ms,
                     "usage": resp.get("usage"), "answers": answers})
        log(f"compress {tool}: {len(output)} → {len(new)} bytes ({ms} ms)")
        return {"action": "replace", "output": new}
    except (JevError, KeyError, TypeError, ValueError) as e:
        audit.bump("compress.error")
        log(f"compress {tool}: upstream error → keep ({e})")
        return {"action": "continue"}
