# NOTICE — Third-Party Methodology Credits

The xcal forced-verdict / value-research layer adapts ideas (not code) from two
MIT-licensed open-source projects. Credit where due:

## AI Berkshire — value-investing judgment methodology
- Source: https://github.com/xbtlin/ai-berkshire (MIT, © xbtlin)
- Adapted: the four-master (Buffett/Munger/Duan Yongping/Li Lu) decision
  discipline — forced verdict (no fence-sitting), the "mirror test" (defend a
  buy in ≤5 sentences or it's not a buy), Munger-style inversion, info-richness
  grading, and the red-flag veto. Re-implemented from scratch in xcal's typed
  model and wrapped in xcal's no-fabrication citation guarantee.

## Vibe-Trading (HKUDS) — track-record / Shadow Account pattern
- Source: https://github.com/HKUDS/Vibe-Trading (MIT, © HKUDS)
- Adapted: the "Shadow Account" concept — record every decision with a price
  anchor and score it against subsequent outcomes. Re-implemented as xcal's
  verdict journal + outcome attribution (src/research/shadow.py). The factor
  library and live-trading machinery were intentionally NOT adopted.

Only the *ideas/methodology* were adopted; the implementation is original to
xcal and inherits xcal's guarantees (type-enforced no-fabrication, Axel memory).
