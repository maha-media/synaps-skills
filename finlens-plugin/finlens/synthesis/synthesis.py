"""
finlens.synthesis.synthesis — Stage 2: narrative synthesis.

Two paths:
  1. LLM path  (config.llm_provider in {"anthropic","openai"} + api key set):
     sends Stage-1 math + per-lens evidence to the LLM with PHILOSOPHY.md as
     system prompt. The LLM EXPLAINS the numbers; it must not invent them.

  2. Deterministic fallback (default, no API key required):
     produces a clean text report directly from Stage-1 verdicts + evidence.
     This path ALWAYS works with zero config.

Network calls are wrapped; on any LLM failure, falls back to deterministic.
"""
from __future__ import annotations

import json
import os
import urllib.request
import urllib.error
from pathlib import Path
from typing import Any

from finlens.config import Config
from finlens.contract import LensOutput
from finlens.formatters import fmt_score, table
from finlens.synthesis.aggregate import aggregate_ticker, rank


_PHILOSOPHY_PATH = Path(__file__).parent.parent / "PHILOSOPHY.md"

_BANNER = """\
════════════════════════════════════════════════════════════════════
  FINLENS — MULTI-LENS RESEARCH WATCHLIST
  ⚠  RESEARCH LEADS — NOT INVESTMENT ADVICE — PAPER-ONLY  ⚠
════════════════════════════════════════════════════════════════════
"""

_FOOTER = """\
────────────────────────────────────────────────────────────────────
⚠  These are research LEADS for further study and paper-trading.
   NOT investment advice. Most lenses are weak/contrarian standalone.
   Value is in orthogonal convergence detection + honest divergence.
   Always do your own research. Past patterns ≠ future results.
────────────────────────────────────────────────────────────────────
"""


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def synthesize(
    verdicts: list[dict],
    lens_outputs_by_ticker: dict[str, list[LensOutput]],
    config: Config | None = None,
) -> str:
    """Produce the final ranked watchlist report.

    Parameters
    ----------
    verdicts : list[dict]
        Stage-1 verdicts from aggregate_ticker(), one per ticker.
    lens_outputs_by_ticker : dict[str, list[LensOutput]]
        Raw lens outputs keyed by ticker (for evidence detail).
    config : Config, optional
        If provided and has LLM credentials, attempts LLM narrative.
        Otherwise (or on failure), falls back to deterministic report.
    """
    ranked = rank(verdicts)

    if config is None:
        config = Config()

    # Try LLM path if configured
    if (config.llm_provider in ("anthropic", "openai")
            and config.llm_api_key):
        try:
            return _llm_synthesize(ranked, lens_outputs_by_ticker, config)
        except Exception:
            # Any failure → deterministic fallback
            pass

    return _deterministic_report(ranked, lens_outputs_by_ticker)


# ---------------------------------------------------------------------------
# Deterministic fallback (the backbone — always works)
# ---------------------------------------------------------------------------

def _deterministic_report(
    ranked_verdicts: list[dict],
    lens_outputs_by_ticker: dict[str, list[LensOutput]],
) -> str:
    """Clean text report from Stage-1 math. No network, no LLM."""
    parts = [_BANNER]

    if not ranked_verdicts:
        parts.append("No tickers to report.\n")
        parts.append(_FOOTER)
        return "\n".join(parts)

    # Summary table
    rows = []
    for v in ranked_verdicts:
        state_icon = {
            "convergent": "✓",
            "divergent": "⚡",
            "weak": "~",
            "thin": "·",
        }.get(v["state"], "?")

        rows.append([
            v["ticker"],
            v["direction"].upper(),
            fmt_score(v["aggregate_score"]),
            f'{v["conviction"]:.2f}',
            f'{v["meff"]:.1f}',
            f'{state_icon} {v["state"]}',
        ])

    parts.append(table(
        rows,
        headers=["Ticker", "Direction", "Score", "Conviction", "Meff", "State"],
    ))
    parts.append("")

    # Per-ticker detail
    for v in ranked_verdicts:
        parts.append(f'\n{"─" * 50}')
        parts.append(f'  {v["ticker"]}  |  {v["direction"].upper()}  |  '
                     f'conviction={v["conviction"]:.2f}  |  '
                     f'state={v["state"]}  |  Meff={v["meff"]:.1f}')
        parts.append(f'{"─" * 50}')

        # Summary line
        parts.append(f'  {v["summary"]}')

        # Agreeing / dissenting
        if v["agreeing"]:
            parts.append(f'  Agreeing:   {", ".join(v["agreeing"])}')
        if v["dissenting"]:
            parts.append(f'  Dissenting: {", ".join(v["dissenting"])}  ← HIGH-INFO CLASH')

        # Per-lens evidence
        ticker = v["ticker"]
        outputs = lens_outputs_by_ticker.get(ticker, [])
        for o in outputs:
            parts.append(f'\n  [{o.lens}]  signal={o.signal}  '
                         f'score={fmt_score(o.score)}  '
                         f'confidence={o.confidence:.2f}')
            for ev in o.evidence:
                parts.append(f'    • {ev}')

        parts.append("")

    parts.append(_FOOTER)
    return "\n".join(parts)


# ---------------------------------------------------------------------------
# LLM synthesis path
# ---------------------------------------------------------------------------

def _load_philosophy() -> str:
    """Load PHILOSOPHY.md for the system prompt."""
    try:
        return _PHILOSOPHY_PATH.read_text(encoding="utf-8")
    except FileNotFoundError:
        return ("You are a finance research synthesis assistant. "
                "Explain the numbers honestly. Never invent data. "
                "These are research leads, not advice.")


def _build_llm_prompt(
    ranked_verdicts: list[dict],
    lens_outputs_by_ticker: dict[str, list[LensOutput]],
) -> str:
    """Build the user prompt with all Stage-1 math + evidence."""
    lines = [
        "Below are Stage-1 deterministic results for a multi-lens finance research scan.",
        "Your job: explain WHY the lenses agree or clash for each ticker, then write",
        "the ranked watchlist narrative. DO NOT invent numbers — only explain what's below.",
        "",
        "=" * 60,
    ]

    for v in ranked_verdicts:
        lines.append(f'\n## {v["ticker"]}')
        lines.append(f'Direction: {v["direction"]} | Score: {v["aggregate_score"]:.4f} | '
                     f'Conviction: {v["conviction"]:.4f} | Meff: {v["meff"]:.1f} | '
                     f'State: {v["state"]}')
        lines.append(f'Agreeing: {", ".join(v["agreeing"])}')
        if v["dissenting"]:
            lines.append(f'Dissenting: {", ".join(v["dissenting"])} ← CLASH')
        lines.append(f'Summary: {v["summary"]}')

        # Per-lens
        outputs = lens_outputs_by_ticker.get(v["ticker"], [])
        for o in outputs:
            lines.append(f'  [{o.lens}] signal={o.signal} score={o.score:+.3f} '
                         f'confidence={o.confidence:.2f}')
            for ev in o.evidence:
                lines.append(f'    - {ev}')

    lines.append("\n" + "=" * 60)
    lines.append("\nWrite the ranked watchlist report now. Lead with divergent/high-info cases.")
    return "\n".join(lines)


def _llm_synthesize(
    ranked_verdicts: list[dict],
    lens_outputs_by_ticker: dict[str, list[LensOutput]],
    config: Config,
) -> str:
    """Call Anthropic or OpenAI API to generate the narrative."""
    system_prompt = _load_philosophy()
    user_prompt = _build_llm_prompt(ranked_verdicts, lens_outputs_by_ticker)

    if config.llm_provider == "anthropic":
        return _call_anthropic(system_prompt, user_prompt, config)
    elif config.llm_provider == "openai":
        return _call_openai(system_prompt, user_prompt, config)
    else:
        raise ValueError(f"Unknown LLM provider: {config.llm_provider}")


def _call_anthropic(system: str, user: str, config: Config) -> str:
    """Call Anthropic /v1/messages. urllib only, no deps."""
    model = config.llm_model or "claude-sonnet-4-20250514"
    payload = json.dumps({
        "model": model,
        "max_tokens": 4096,
        "system": system,
        "messages": [{"role": "user", "content": user}],
    }).encode("utf-8")

    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=payload,
        headers={
            "Content-Type": "application/json",
            "x-api-key": config.llm_api_key,
            "anthropic-version": "2023-06-01",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        body = json.loads(resp.read().decode("utf-8"))

    # Extract text from content blocks
    text_parts = []
    for block in body.get("content", []):
        if block.get("type") == "text":
            text_parts.append(block["text"])

    result = "\n".join(text_parts)
    if not result:
        raise RuntimeError("Empty response from Anthropic API")

    return _BANNER + result + "\n" + _FOOTER


def _call_openai(system: str, user: str, config: Config) -> str:
    """Call OpenAI /v1/chat/completions. urllib only, no deps."""
    model = config.llm_model or "gpt-4o"
    payload = json.dumps({
        "model": model,
        "max_tokens": 4096,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    }).encode("utf-8")

    req = urllib.request.Request(
        "https://api.openai.com/v1/chat/completions",
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {config.llm_api_key}",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        body = json.loads(resp.read().decode("utf-8"))

    choices = body.get("choices", [])
    if not choices:
        raise RuntimeError("Empty response from OpenAI API")

    result = choices[0].get("message", {}).get("content", "")
    if not result:
        raise RuntimeError("Empty content from OpenAI API")

    return _BANNER + result + "\n" + _FOOTER
