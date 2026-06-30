"""finlens.report — human-readable markdown report writer.

Pure formatting, no network, deterministic.  Given verdict dicts + per-ticker
lens outputs + an LLM narrative string, writes a .md file and returns its path.

Verdict dict shape (produced by synthesis.aggregate.aggregate_ticker):
  {
    "ticker":      str,
    "direction":   "bullish" | "bearish" | "neutral",
    "conviction":  float  0..1,
    "state":       str    e.g. "convergence" | "divergence" | "thin",
    "dissent":     str    e.g. "insider disagrees" or "",
    "lens_count":  int,
    "meff":        float | None,
    "note":        str    optional free-form note
  }

This module never imports synthesis — it only knows dicts and LensOutput objects.
The synthesis layer imports this module, not the other way around.

Public API:
  write_report(verdicts, lens_outputs_by_ticker, narrative, out_dir, run_id) -> str
  render_watchlist_table(verdicts) -> str
"""
from __future__ import annotations

import os
import datetime as _dt
from typing import Any

from .formatters import table, fmt_score
from .contract import LensOutput

# ── constants ─────────────────────────────────────────────────────────────────
_BANNER = """\
╔══════════════════════════════════════════════════════════════════════════════╗
║  ⚠️  RESEARCH LEADS — NOT FINANCIAL ADVICE / PAPER-ONLY SIMULATION          ║
║                                                                              ║
║  These outputs are research signals, NOT trading recommendations.            ║
║  All lenses carry honest confidence labels; most are weak standalone.        ║
║  Value lives in CONVERGENCE + DIVERGENCE across independent lenses —         ║
║  never in any single lens screaming.  DO YOUR OWN DUE DILIGENCE.            ║
║  Past signal quality does not guarantee future predictive value.             ║
╚══════════════════════════════════════════════════════════════════════════════╝
"""

_DIRECTION_EMOJI = {
    "bullish":  "▲",
    "bearish":  "▼",
    "neutral":  "◆",
}

_STATE_EMOJI = {
    "convergence":  "🔵",
    "divergence":   "🔴",
    "thin":         "⬜",
}


# ── public helpers ────────────────────────────────────────────────────────────

def render_watchlist_table(verdicts: list[dict[str, Any]]) -> str:
    """Return a compact fixed-width text table of the ranked watchlist.

    Columns: rank, ticker, direction, conviction, state, dissent/note.
    """
    if not verdicts:
        return "(no verdicts)"

    headers = ["#", "Ticker", "Direction", "Conviction", "State", "Dissent / Note"]
    rows: list[list[str]] = []

    for idx, v in enumerate(verdicts, start=1):
        direction   = str(v.get("direction", "neutral"))
        conviction  = v.get("conviction", 0.0)
        state       = str(v.get("state", ""))
        dissent     = str(v.get("dissent", v.get("note", "")))
        ticker      = str(v.get("ticker", "?")).upper()

        emoji_dir   = _DIRECTION_EMOJI.get(direction, "◆")
        emoji_state = _STATE_EMOJI.get(state, "")

        rows.append([
            str(idx),
            ticker,
            f"{emoji_dir} {direction}",
            f"{float(conviction):.2f}",
            f"{emoji_state} {state}".strip(),
            dissent[:80] if dissent else "—",
        ])

    return table(rows, headers=headers)


def write_report(
    verdicts: list[dict[str, Any]],
    lens_outputs_by_ticker: dict[str, list[LensOutput]],
    narrative: str,
    out_dir: str,
    run_id: str,
) -> str:
    """Write a markdown research report.

    Returns the absolute path to the written file.

    Structure:
      1. RESEARCH LEADS banner (loud, can't miss)
      2. Run metadata
      3. Ranked watchlist table
      4. Synthesis narrative
      5. Per-ticker evidence appendix (one section per ticker, lens outputs as tables)
    """
    os.makedirs(out_dir, exist_ok=True)
    filename = f"report_{run_id}.md"
    path = os.path.join(out_dir, filename)

    ts = _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    lines: list[str] = []

    # ── 1. Banner ─────────────────────────────────────────────────────────────
    lines.append(_BANNER)

    # ── 2. Header / run metadata ──────────────────────────────────────────────
    lines.append(f"# finlens Research Report")
    lines.append(f"")
    lines.append(f"**Run ID:** `{run_id}`  ")
    lines.append(f"**Generated:** {ts}  ")
    lines.append(f"**Tickers:** {len(verdicts)}  ")
    lines.append(f"")
    lines.append("---")
    lines.append("")

    # ── 3. Ranked watchlist ───────────────────────────────────────────────────
    lines.append("## Ranked Watchlist")
    lines.append("")
    lines.append("```")
    lines.append(render_watchlist_table(verdicts))
    lines.append("```")
    lines.append("")
    lines.append(
        "> Direction and conviction are WEIGHTED AGGREGATES of weak, orthogonally-gated signals.  "
        "> Treat conviction ≥0.60 as \"notable\" — anything below is background noise."
    )
    lines.append("")
    lines.append("---")
    lines.append("")

    # ── 4. Synthesis narrative ────────────────────────────────────────────────
    lines.append("## Synthesis Narrative")
    lines.append("")
    if narrative and narrative.strip():
        lines.append(narrative.strip())
    else:
        lines.append("_(No narrative generated for this run.)_")
    lines.append("")
    lines.append("---")
    lines.append("")

    # ── 5. Per-ticker evidence appendix ──────────────────────────────────────
    lines.append("## Evidence Appendix")
    lines.append("")
    lines.append(
        "Each lens's raw output — signal, score, confidence, evidence bullets.  "
        "This is the raw material the synthesis layer reasoned over."
    )
    lines.append("")

    for v in verdicts:
        ticker = str(v.get("ticker", "?")).upper()
        direction  = str(v.get("direction",  "neutral"))
        conviction = float(v.get("conviction", 0.0))
        state      = str(v.get("state", ""))

        lines.append(f"### {ticker}")
        lines.append("")
        lines.append(
            f"**Verdict:** {_DIRECTION_EMOJI.get(direction, '◆')} {direction} | "
            f"**Conviction:** {conviction:.2f} | "
            f"**State:** {state}"
        )
        dissent = str(v.get("dissent", v.get("note", "")))
        if dissent:
            lines.append(f"**Dissent/Note:** {dissent}")
        lines.append("")

        outputs: list[LensOutput] = lens_outputs_by_ticker.get(ticker, [])
        if not outputs:
            lines.append("_No lens outputs recorded for this ticker._")
        else:
            for lo in outputs:
                lines.append(f"#### {lo.lens}")
                lines.append("")
                # Summary row
                summary_headers = ["Field", "Value"]
                summary_rows = [
                    ["signal",     lo.signal],
                    ["score",      fmt_score(lo.score)],
                    ["confidence", f"{lo.confidence:.2f}"],
                    ["freshness",  lo.data_freshness or "—"],
                ]
                lines.append("```")
                lines.append(table(summary_rows, headers=summary_headers))
                lines.append("```")
                lines.append("")

                if lo.evidence:
                    lines.append("**Evidence:**")
                    for ev in lo.evidence:
                        lines.append(f"- {ev}")
                    lines.append("")

                # Key meta fields (skip schema/timestamp noise)
                _skip_meta = {"schema_version", "timestamp"}
                meta_items = {k: v for k, v in (lo.meta or {}).items()
                              if k not in _skip_meta}
                if meta_items:
                    lines.append("**Meta:**")
                    meta_rows = [[str(k), str(val)] for k, val in meta_items.items()]
                    lines.append("```")
                    lines.append(table(meta_rows, headers=["key", "value"]))
                    lines.append("```")
                    lines.append("")

        lines.append("")

    # ── Footer ────────────────────────────────────────────────────────────────
    lines.append("---")
    lines.append("")
    lines.append(
        "_finlens — research leads, not financial advice. "
        "Paper-only simulation. Always do your own due diligence._"
    )
    lines.append("")

    content = "\n".join(lines)

    with open(path, "w", encoding="utf-8") as fh:
        fh.write(content)

    return path
