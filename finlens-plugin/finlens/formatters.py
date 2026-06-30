"""finlens.formatters — raw values → compact human/LLM-friendly strings.

Stolen from dexter's formatters.ts: never hand raw JSON or long floats to the
synthesis LLM. Every number passes through here. 5-10x token reduction + readability.
"""
from __future__ import annotations

from typing import Any


def fmt_num(n: Any, *, dollar: bool = False) -> str:
    """123456789 -> '123.5M' (or '$123.5M'). Handles None gracefully."""
    if n is None:
        return "—"
    try:
        n = float(n)
    except (TypeError, ValueError):
        return str(n)
    sign = "-" if n < 0 else ""
    a = abs(n)
    pre = "$" if dollar else ""
    for div, suf in ((1e12, "T"), (1e9, "B"), (1e6, "M"), (1e3, "K")):
        if a >= div:
            return f"{sign}{pre}{a / div:.1f}{suf}"
    if a >= 1:
        return f"{sign}{pre}{a:.0f}"
    return f"{sign}{pre}{a:.2f}"


def fmt_pct(x: Any, *, signed: bool = False) -> str:
    """0.1234 -> '12.3%'. Pass already-percent values via mult=False not supported; pass ratios."""
    if x is None:
        return "—"
    try:
        x = float(x)
    except (TypeError, ValueError):
        return str(x)
    s = f"{x * 100:+.1f}%" if signed else f"{x * 100:.1f}%"
    return s


def fmt_price(x: Any) -> str:
    if x is None:
        return "—"
    try:
        return f"${float(x):,.2f}"
    except (TypeError, ValueError):
        return str(x)


def fmt_ratio(x: Any) -> str:
    """P/E etc. — plain number, 1 decimal."""
    if x is None:
        return "—"
    try:
        return f"{float(x):.1f}"
    except (TypeError, ValueError):
        return str(x)


def fmt_score(x: float) -> str:
    """-1..+1 score -> '+0.42' with sign."""
    try:
        return f"{float(x):+.2f}"
    except (TypeError, ValueError):
        return str(x)


def table(rows: list[list[str]], headers: list[str] | None = None) -> str:
    """Compact fixed-width text table from string cells."""
    all_rows = ([headers] if headers else []) + [[str(c) for c in r] for r in rows]
    if not all_rows:
        return ""
    widths = [max(len(r[i]) for r in all_rows) for i in range(len(all_rows[0]))]
    out = []
    for idx, r in enumerate(all_rows):
        out.append("  ".join(c.ljust(widths[i]) for i, c in enumerate(r)))
        if headers and idx == 0:
            out.append("  ".join("-" * widths[i] for i in range(len(r))))
    return "\n".join(out)
