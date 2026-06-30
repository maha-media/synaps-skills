#!/usr/bin/env python3
"""
StockTwits Sentiment Scanner v2 — baseline-normalized anomaly detector.

v1 lesson: StockTwits is ~85% bull by default. Absolute bull% is noise.
v2 measures each ticker's EDGE vs the platform baseline, plus buzz VELOCITY,
and surfaces ANOMALIES — the crowd breaking character, not agreeing with it.

NOT financial advice. Anomalies are research leads, not signals.
No API key needed.
"""
import sys, json, time, urllib.request, re
from datetime import datetime, timezone

UA = "Mozilla/5.0 (finance-poc/0.2)"
BASE = "https://api.stocktwits.com/api/2"
CASHTAG = re.compile(r"\$[A-Za-z][A-Za-z.\-]{0,6}")

def get(url, tries=3):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=15) as r:
                return json.load(r)
        except Exception as e:
            if i == tries - 1:
                print(f"  ! fetch failed {url}: {e}", file=sys.stderr); return None
            time.sleep(1.5)

def is_spam(body):
    tags = CASHTAG.findall(body)
    words = [w for w in re.split(r"\s+", CASHTAG.sub("", body).strip()) if len(w) > 2]
    return len(tags) >= 3 and len(words) < 4

def parse_ts(s):
    try: return datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except Exception: return None

def scan_symbol(sym):
    d = get(f"{BASE}/streams/symbol/{sym}.json")
    if not d: return None
    msgs = d.get("messages", [])
    bull = bear = spam = 0; real = []; times = []
    for m in msgs:
        body = m.get("body", "")
        ts = parse_ts(m.get("created_at", ""))
        if ts: times.append(ts)
        if is_spam(body): spam += 1; continue
        s = ((m.get("entities") or {}).get("sentiment") or {}).get("basic")
        if s == "Bullish": bull += 1
        elif s == "Bearish": bear += 1
        real.append((s, body.replace("\n", " ")[:120]))
    tagged = bull + bear
    # velocity: clean messages per hour, from the stream's own time span
    vel = None
    if len(times) >= 2:
        span_h = (max(times) - min(times)).total_seconds() / 3600
        vel = round(len(times) / span_h, 1) if span_h > 0.05 else None
    return {"symbol": sym, "buzz": len(msgs), "clean": len(real), "spam": spam,
            "bull": bull, "bear": bear, "tagged": tagged,
            "bull_pct": (100 * bull / tagged) if tagged else None,
            "vel": vel, "samples": real[:5]}

def confidence(r):
    t = r["tagged"]
    return 0.5 if t >= 20 else 0.35 if t >= 10 else 0.2 if t >= 4 else 0.1

def classify(edge, conf, vel, vbar):
    """edge = bull_pct - baseline. Honest, direction-aware labels."""
    hot = vel is not None and vbar is not None and vel >= 1.8 * vbar
    if conf < 0.2:
        return ("· thin", "not enough tagged posts to trust")
    if edge <= -20:
        return ("🐻 CROWD TURNING", "bearish on a bull-biased platform = rare, notable")
    if edge <= -8:
        return ("⚠️  cooling", "below-crowd — losing the perma-bulls")
    if edge >= 12:
        return ("🔥 EUPHORIA", "well above baseline — can be a CONTRARIAN top")
    if hot:
        return ("📈 BUZZ SPIKE", "attention surging vs peers")
    return ("⚖️  consensus", "moving with the herd — low info")

def main():
    watch = sys.argv[1:] or None
    print("=" * 70)
    print(" StockTwits Scanner v2 — baseline-normalized anomaly detector")
    print(" " + datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC") + "   (NOT advice)")
    print("=" * 70)

    if not watch:
        print("\n→ pulling trending tickers (the sample that sets the baseline)...")
        t = get(f"{BASE}/trending/symbols.json")
        watch = [s["symbol"] for s in (t.get("symbols", []) if t else [])][:12]
        if not watch: watch = ["TSLA","NVDA","AAPL","SPY","AMD","PLTR","AMZN","META"]
    print(f"→ scanning {len(watch)}: {', '.join(watch)}\n")

    rows = []
    for sym in watch:
        r = scan_symbol(sym)
        if r: rows.append(r)
        time.sleep(0.4)

    # ── BASELINE: the platform's structural bull-bias, computed from the sample ──
    tb = sum(r["bull"] for r in rows); tr = sum(r["bear"] for r in rows)
    baseline = 100 * tb / (tb + tr) if (tb + tr) else 50
    vels = [r["vel"] for r in rows if r["vel"]]
    vbar = sum(vels) / len(vels) if vels else None
    print(f"📐 PLATFORM BASELINE: {baseline:.0f}% bull  "
          f"(this sample) — anything near this is NOISE, not signal")
    if vbar: print(f"📐 AVG VELOCITY: {vbar:.1f} msgs/hr across sample\n")

    # score each by EDGE vs baseline (both directions), weighted by confidence
    for r in rows:
        r["edge"] = round(r["bull_pct"] - baseline, 1) if r["bull_pct"] is not None else None
        r["conf"] = confidence(r)
        r["label"], r["why"] = classify(r["edge"] if r["edge"] is not None else 0,
                                        r["conf"], r["vel"], vbar)
        r["score"] = round(abs(r["edge"]) * r["conf"], 1) if r["edge"] is not None else 0

    rows.sort(key=lambda r: r["score"], reverse=True)

    print(f"{'TICK':<6}{'BULL%':>6}{'EDGE':>6}{'VEL':>6}{'CONF':>6}  {'ANOMALY':<16}{'SCORE':>6}")
    print("-" * 70)
    for r in rows:
        bp  = f"{r['bull_pct']:.0f}%" if r["bull_pct"] is not None else "  -"
        ed  = f"{r['edge']:+.0f}" if r["edge"] is not None else "  -"
        vl  = f"{r['vel']}" if r["vel"] else "  -"
        print(f"{r['symbol']:<6}{bp:>6}{ed:>6}{vl:>6}{r['conf']:>6}  {r['label']:<16}{r['score']:>6}")

    print("\n--- top anomalies (read the posts — the number is a lead, not a verdict) ---")
    shown = 0
    for r in rows:
        if r["conf"] < 0.2 or abs(r["edge"] or 0) < 8: continue
        shown += 1
        print(f"\n{r['symbol']}  {r['label']}  ({r['why']})")
        print(f"   edge {r['edge']:+.0f} vs {baseline:.0f}% baseline | "
              f"{r['bull']}🐂/{r['bear']}🐻 | vel {r['vel']} | conf {r['conf']}")
        for s, body in r["samples"][:3]:
            tag = {"Bullish":"🐂","Bearish":"🐻"}.get(s, "·")
            print(f"   {tag} {body}")
        if shown >= 4: break
    if not shown:
        print("  (no ticker broke meaningfully from baseline — the crowd is in consensus)")

    print("\n" + "=" * 70)
    print(" ⚠️  Anomalies are research LEADS. Euphoria can mark tops; a bull")
    print("     platform turning bearish is rare but gameable. Always do your own DD.")
    print("=" * 70)

if __name__ == "__main__":
    main()
