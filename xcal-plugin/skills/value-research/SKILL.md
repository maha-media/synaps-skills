---
name: value-research
description: Four-master value-investing deep read on one ticker — runs the six finlens lenses through Buffett/Munger/Duan/Li Lu's 7-module sequence, cross-validates numbers across lenses, and forces a decisive stance (pass/fail/grey-zone) with a red-flag veto and a 5-sentence mirror test.
---

# Value Research (Four-Master Deep Read)

## When to Use
A conviction-grade question on a single company: "is <TICKER> a buy at this
price?", "should I hold/add/trim <TICKER>?", "is <TICKER> a quality business
worth a 10-year hold?". Use over `quarterly-check` when the question is a
DECISION, not a status read — this skill is built to force a verdict, not
deliver a balanced shrug.

## Procedure — the 7 modules (run in order)
- [ ] 1. **Data collection.** Run all six lenses: `finlens_lens(fundamentals|technicals|insider|news|sentiment|search_trend, TICKER)`. Every number used later MUST cite the lens `call_id` it came from — uncited numerics are rejected at the type boundary.
- [ ] 2. **Business essence (Duan Yongping).** Is this a *good business*? What does it actually sell, who needs it, what's the unit economics? Ground in `fundamentals` (margins, growth, returns on capital).
- [ ] 3. **Moat (Buffett).** How deep and durable is the competitive advantage — network effects, switching costs, scale, brand? Is the moat *widening or narrowing*? Cite fundamentals/technicals where they evidence pricing power or share.
- [ ] 4. **Inversion (Munger).** Set `Verdict.inversion`: "What would make this thesis fail? Under what conditions does this company die in 10 years?" List the top failure scenarios. This is mandatory — a thesis you can't invert is a thesis you don't understand.
- [ ] 5. **Management & integrity (Duan + Buffett).** Capital allocation discipline, insider behavior (`insider` lens), honesty signals. Any integrity concern → add to `Verdict.red_flags` (a red flag VETOES a 'pass' regardless of how cheap the stock is).
- [ ] 6. **Civilizational trend (Li Lu).** Is the business riding a durable long-term tailwind, or fighting a structural decline? Distinguish a real paradigm shift from a fad (cross-check `news`/`search_trend` attention vs `fundamentals` substance).
- [ ] 7. **Valuation & margin of safety (Buffett + Duan).** Is the price sane relative to the business? Use `fundamentals` valuation metrics. Any `Recommendation` carrying a price band MUST cite a lens — no fabricated price targets.

## Discipline gates (this is the point of the skill)
- [ ] **Cross-validate** the load-bearing numbers: when two independent lenses confirm the same fact, record the second as a `Finding.corroboration` (different lens than the primary citation) — a cross-validated number is worth more than a single-sourced one.
- [ ] **Grade each finding's `info_richness`** A/B/C (A = corroborated/rich data, B = limited/single-source, C = sparse/inferred). Do not let a pile of C-grade findings masquerade as certainty.
- [ ] **Force a `stance`**: `pass` | `fail` | `grey_zone`. No fence-sitting. A "balanced analysis that ends in 'it depends'" is a FAIL of this skill.
- [ ] **Tiered `recommendations`**: aggressive / steady / conservative — each with a concrete action (and a cited price band if you give one).
- [ ] **Mirror test**: a `pass` REQUIRES a `mirror_test` — your buy thesis in ≤5 sentences. If you can't say why in five sentences, it's not a pass. (Enforced at the type boundary.)
- [ ] **Red-flag veto**: any tripped red line (management integrity, accounting irregularity, broken thesis) → cannot be a `pass`. One veto = no buy, no exceptions.

## Pitfalls
- Producing a neutral "synthesis" instead of a decisive stance — that's the exact failure this skill exists to prevent.
- Letting valuation cheapness override a red flag — the veto is absolute.
- Treating `sentiment`/`search_trend` attention as fundamental signal (Munger: invert — is the crowd the reason, or the risk?).
- Single-sourcing a load-bearing number when a second lens could corroborate it — cross-validate.
- A `pass` you can't defend in five sentences. If the mirror test is hard, the conviction isn't there.
