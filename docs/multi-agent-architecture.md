# Multi-Agent Reviewer Architecture — Evaluation

**Date:** 2026-05-01
**Question:** Should AEDIN use multiple specialist reviewer agents (Plant Pathologist, Entomologist, Soil Scientist, Horticulturist, Agroecologist) for literature ingestion review, or is a single agroecologist agent sufficient?
**Verdict:** **Yes — go multi-agent, with the architecture below.** Helpful, not prohibitively expensive, and aligns with how real-world expert review works.

---

## TL;DR

| Question | Answer |
|---|---|
| Helpful? | **Yes.** Each specialist has a focused, smaller corpus → faster grep + better domain coverage. Cross-validation catches errors a single critic misses. |
| Unnecessary? | No. The corpus naturally partitions into 5 specialties; the books we have map cleanly. A single generalist agent would have to grep across all 22 sources for every claim. |
| Too expensive? | **No.** Per-claim cost goes from ~$0.005 (single critic) to ~$0.010–$0.015 (1–2 specialists + synthesizer). Under any plausible scale, additional cost is < 1% of total operating budget. |
| Risk? | Coordination overhead is the real cost — needs deliberate routing logic and conflict-resolution rules, not just "always run all 5." |

---

## The 5 specialist agents

Each agent has a focused corpus subset (drawn from the now-22-source library), a defined remit, and a routing rule that determines when it's invoked.

| Agent | Primary corpus | Remit | When invoked |
|---|---|---|---|
| **Agroecologist** (lead / synthesizer) | Gliessman 3rd + 4th, Altieri, Rickerl & Francis, Chalker-Scott, Dieckmann, papers | Always invoked. Synthesizes specialist verdicts into a single review. Primary lead on: companion pairings, sustainability levels (Gliessman 5-Level), landscape framing, counter-evidence calibration. | Every claim. |
| **Plant Pathologist** | Agrios, Andow Ch 9 (Leonard host–pathogen coevolution), relevant biocontrol chapters | Disease/pathogen claims; eponymous-pathogen detection; durability of resistance; fungal/bacterial/viral host-range. | Claims with `interaction_category IN ('pathogen', 'pathogenOf', 'infection')` OR target taxa containing 'virus'/'phage'/'viroid'/'fungus'. |
| **Entomologist** | Pedigo, Dent, Omkar Insect Predators, Omkar Parasitoids, Andow, Gurr ecological engineering | Pest classification; predator/parasitoid specificity; life-stage-dependent roles; economic injury thresholds; IPM decisions. | Claims involving Arthropoda OR `interaction_category IN ('predation', 'parasitism', 'herbivory')` AND non-plant subject. |
| **Soil Scientist** | Brady & Weil, Magdoff & van Es | Soil chemistry; nutrient cycling; mycorrhizae/rhizobia/soil microbes; organic matter; soil-amendment claims. | Claims with `interaction_category IN ('nitrogen_fixation', 'mycorrhizal', 'soil_facilitation')` OR target/subject is `bio_category='microbe'` OR `primary_role='soil_organism'`. |
| **Horticulturist / Crop Ecologist** | Loomis & Connor, Agroforestry, Gliessman crop chapters | Crop trait claims (yield, growth params, climate/water needs); polyculture geometry; agroforestry; cultivation requirements. | Claims about plant trait values (`crop_type`, `min_temp_c`, `growth_habit`, `days_to_harvest`, etc.) OR claims involving 2+ plant subjects (intercropping/agroforestry/polyculture). |

---

## Routing — when does each agent fire?

```
For each new claim entering the review pipeline:
  1. ALWAYS invoke: agroecologist (lead)
  2. Conditionally invoke specialists per the rules above
  3. If 0 specialists triggered → agroecologist runs alone
  4. If 1+ specialists triggered → each runs in parallel, then agroecologist synthesizes
  5. Disagreement between specialist + synthesizer → escalate to human review queue
```

**Typical claim → typical reviewers:**

| Claim type | Specialists invoked |
|---|---|
| "Apis mellifera pollinates Phacelia tanacetifolia" | Agroecologist (alone — straightforward mutualism) |
| "AcMNPV is pathogen of Acronicta americana" | Plant Pathologist + Entomologist + Agroecologist |
| "Mycorrhizal fungi enhance phosphorus uptake in Allium cepa" | Soil Scientist + Horticulturist + Agroecologist |
| "Trichogramma minutum parasitizes Helicoverpa zea on Zea mays" | Entomologist + Agroecologist |
| "Box elder is companion of pawpaw" | Horticulturist + Agroecologist (questionable: neither is a food crop) |
| "Gliessman Level-3 redesign requires polyculture + habitat" | Agroecologist alone (sustainability framing) |

The "always agroecologist + 0–2 specialists" pattern means the average claim invokes ~1.5–2 agents, not 5.

---

## Cost analysis — per-claim and at scale

Pricing benchmark: Sonnet 4.6 with prompt-cached + batched + context-mode-mediated retrieval (per the existing pitch doc's regime).

| Pattern | Per-claim cost | 6 K-claim bootstrap | 400 K-claim US-complete |
|---|---|---|---|
| Current (single agroecologist) | ~$0.005 | ~$30 | ~$2,000 |
| Multi-agent (avg 2 invocations) | ~$0.010 | ~$60 | ~$4,000 |
| Multi-agent (worst case, 4 invocations) | ~$0.020 | ~$120 | ~$8,000 |
| **Cost premium for multi-agent** | **+$0.005–$0.015 per claim** | **+$30–$90** | **+$2,000–$6,000** |

**At Phase-1 scale**: $30–$90 extra LLM cost over the bootstrap. Trivial.
**At US-complete scale**: $2K–$6K extra over a multi-million-dollar program. <0.2% of total operating cost.

Multi-agent is **not** budget-meaningful. The cost question is settled — scale it on review quality, not compute.

---

## Quality benefits — concrete examples

These are bugs the agroecologist critic *did* catch in the smoke test, AND additional bugs a multi-agent reviewer would catch that a single agroecologist might miss:

| Bug type | Single-agent (Agroecologist) | Multi-agent | Win |
|---|---|---|---|
| Eponymous pathogen (AcMNPV) | Caught (had Andow ch 9, prior) | Caught (Plant Pathologist owns this domain) + flagged with higher specificity | More confident verdict |
| Stage-dependent role (larva pest, adult pollinator) | Caught (general framework) | Caught + Entomologist provides specific developmental biology citations | Stronger evidence trail |
| Mycorrhizal fungus mis-classified as pathogen | Likely caught | Definitely caught (Soil Scientist's primary domain) + Magdoff citation | Coverage gap closed |
| Crop trait values inconsistent with actual species | NOT caught (agroecologist isn't a crop physiologist) | Caught (Horticulturist with Loomis & Connor) | New bug class detected |
| Spatial-density assumption in pair-claim | Caught (agroecologist has Dieckmann) | Caught + Entomologist may reinforce with specific pest-density data | Same |
| Soil pH range inconsistent with rhizobium | NOT caught | Caught (Soil Scientist) | New bug class detected |

The biggest *new* gain is **catching domain-specific factual errors** that aren't agroecology-framework violations but are real: bad crop trait values, wrong soil chemistry, wrong host-plant lists. A single agroecologist agent doesn't have the expertise.

---

## Implementation plan

### Phase A — Agent definitions (1–2 days)

Five agent files in `.claude/agents/`:
- `agroecologist.md` — already exists; update to mention specialists exist and that it's the synthesizer
- `plant-pathologist.md` — new
- `entomologist.md` — new
- `soil-scientist.md` — new
- `horticulturist.md` — new

Each with: routing rule, corpus pointers (specific `*_full_text.md` files), output format that matches the agroecologist's template, calibration rules ("cite or decline", "INSUFFICIENT DATA over false confidence").

### Phase B — Shared corpus pool (already done by extraction)

All `*_full_text.md` files live in `.claude/agents/agroecologist/reference/`. Each agent's definition file lists which subset to consult. No file duplication.

### Phase C — Routing function (1–2 days)

A small JS module: `backend/lib/agent-router.js` that takes a claim and returns the list of agents to invoke.

```js
function routeAgents(claim) {
  const agents = ['agroecologist'];
  if (isPathogenClaim(claim)) agents.push('plant-pathologist');
  if (isPestOrPredatorClaim(claim)) agents.push('entomologist');
  if (isSoilOrMicrobeClaim(claim)) agents.push('soil-scientist');
  if (isCropTraitOrPolycultureClaim(claim)) agents.push('horticulturist');
  return agents;
}
```

Used by the LLM extraction + critic pipeline (Phase 3 in the roadmap).

### Phase D — Conflict resolution (1 day)

Schema update: `claim_reviews` table where each (claim, agent) pair gets a verdict. Disagreements (PLAUSIBLE vs IMPLAUSIBLE between two agents) flag the claim for human review with all reasoning attached.

### Phase E — Calibration study extension (additive)

The 200-claim calibration study in Phase 3 of the roadmap should now dual-review with multi-agent setup, not just one. This is a small extension; the cost of dual-reviewing 200 claims with all 5 agents is ~$10 in compute.

---

## What this architecture deliberately does NOT do

- **Does not require all 5 agents on every claim.** Routing rules ensure typically 1–2 agents fire. Forcing 5 agents on every claim would be wasteful.
- **Does not eliminate human review.** The tiered pipeline still routes auto-approved claims to sampling audit and contested claims to human reviewers. Multi-agent improves *which* claims need humans, not *whether* humans are in the loop.
- **Does not require a new database engine.** All review records live in the existing relational schema (extension of `role_corrections` pattern).
- **Does not preclude future specialist agents.** Adding a Mycologist or Microbiologist later is an additive change, not a rearchitecture.

---

## Recommendation

**Go multi-agent.** Build out the 4 new specialist agent definitions in parallel with Phase 1 of the roadmap. The cost is trivial; the quality improvement is meaningful and concrete (new bug classes detected); the architecture mirrors how real-world expert review works.

**Sequencing**: don't build the routing function yet — wait until Phase 3 (literature ingestion pipeline) when it's actually needed. For now, just write the agent definitions so they're available when the pipeline is ready, and so the user can manually invoke any specialist for ad-hoc review like we did with the agroecologist.

---

## Open questions for the user

- **Should the agroecologist remain the "lead" with veto?** Or should it be one-vote-per-agent with majority-rule? My recommendation is agroecologist-as-lead because the project's positioning is agroecological, not generalist-IPM.
- **Should specialists be able to escalate to each other** (e.g., Entomologist asking Soil Scientist about a soil-dwelling pest)? Adds complexity. My recommendation is no — keep specialists single-pass; escalation goes through the agroecologist synthesizer.
- **License for the per-specialist agent definitions** — should they be checked into the repo? Yes, alongside `agroecologist.md` in `.claude/agents/`. They're project artifacts.
