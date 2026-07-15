---
type: Pipeline
title: Companion scoring
description: Computes crop_companion_scores from normalized claims plus interaction-type rules, with clamp provenance preserved.
tags: [pipeline, scoring, companion-scores]
timestamp: 2026-06-23T00:00:00Z
---

# What it does

`build-scores.js` computes **`crop_companion_scores`** (a.k.a. `companion_scores`) from normalized [claims](/datasets/claims.md) + `interaction_type_rules`.

- Bonuses are in `[0, 0.2]`, added **after** normalization (composite-score arithmetic fixed 2026-04-19).
- `companion_scores.raw_score` + `ceiling_hit` (migration 019) preserve pre-clamp values. Existing rows need `npm run build-scores` to repopulate.

# Command

```bash
cd backend && npm run build-scores
```

# Positioning

`companion_scores` straddles the planner and data layers. It is **kept as a derived data product** (academic-relevant: "aggregate crop-companion evidence by claim-set") but has **no consumer-friendly serializer** — PolyCrop builds its own scoring on top of [claims](/datasets/claims.md). The planner endpoints themselves are [out of scope](/decisions/repositioning-academic.md).

# Related

- Consumes [claims](/datasets/claims.md); part of the [data flow](/architecture/data-flow.md).

# Citations

[1] `CLAUDE.md` §"Architecture → Data flow" item 4; §"Composite score arithmetic"; §"Planner artifacts".
