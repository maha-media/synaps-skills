---
name: quarterly-check
description: Six-lens deterministic quarterly read on one ticker — drives finlens insider/fundamentals/technicals/sentiment/news/search_trend and cites every number to a lens call_id.
---

# Quarterly Check

## When to Use
Any question of the form "what does the setup look like for <TICKER>" /
"is <TICKER> risk-on/off this quarter" / "anything I should know about
<TICKER> before earnings".

## Procedure
- [ ] 1. Call `finlens_lens(fundamentals, TICKER)` — extract revenue / FCF / margin trend.
- [ ] 2. Call `finlens_lens(technicals, TICKER)` — extract trend + key levels.
- [ ] 3. Call `finlens_lens(insider, TICKER)` — recent insider transactions.
- [ ] 4. Call `finlens_lens(news, TICKER)` — last 30d material news.
- [ ] 5. Call `finlens_lens(sentiment, TICKER)` — aggregate social/analyst sentiment (CONTRARIAN read).
- [ ] 6. Call `finlens_lens(search_trend, TICKER)` — attention delta.
- [ ] 7. Compose `Verdict.findings`: every NUMERIC claim must cite the
       `lens_call_id` of the lens it came from. Numbers without a citation
       will be rejected at the type boundary — do not invent them.
- [ ] 8. Self-critique pass (mandatory). For each finding ask:
       (a) does a lens result back this number?
       (b) is there a steelmanned opposing read in the lens data I'm dropping?
       (c) am I conflating sentiment with fundamentals?
       Patch the verdict if any answer is "yes".

## Pitfalls
- Inventing a number the lens did not return → verdict rejected at the type boundary.
- Treating sentiment/search_trend as fundamental signals.
- Stopping after 3 lenses because the answer "looks done" — run all six.
