---
type: Pipeline
title: GRIN-narrative enrichment
description: Turn scraped grin_varieties.narrative snippets into vouched resistance (Phase 1) and trait (Phase 2) claims via the existing multi-critic → promote rails.
tags: [pipeline, grin, varieties, resistance, ingestion, subscription-only]
timestamp: 2026-06-25T00:00:00Z
---

# Why it matters

`grin_varieties.narrative` holds scraped, never-surfaced cultivar prose (essentially
tomato): resistance/tolerance statements and trait descriptions. This pipeline
extracts them into corpus claims, consuming the host-plant resistance model
([resistance categories + `claims.resistance_level`](/datasets/claims.md)) shipped as
sub-project A.

# Shape (subject-pinned, subscription-only)

```
grin_varieties.narrative
  → grin-narrative-batch.js   (select by phase; emit subject-pinned extract-NNN.json)
  → Agent reads .claude/agents/grin-extractor.md → claims-NNN.json
  → grin-narrative-stage.js   (resolveAttackerName abstain gate; regional_context='Global';
                               ai_vouch_status='uncertain'; target_table='interactions')
  → extraction_staging
  → multi-critic-batch-prepare/import (BATCH_OUT_DIR override) → claim_critic_verdicts
  → promote-staged-claims.js  (unchanged: maps resistance_level; consensus gate)
  → claims (disease_resistance / pest_resistance)
```

The build delivers the three front-of-pipe units + tests; the **operational run**
(dispatching Agents over the batch files) is a separate manual step, like the prior
Phase-3 ingestion passes (`docs/phase-3-passlog.md`).

# Design constants

- **Subject pinning** — the batch row carries `parent_scientific_name` + the served
  variety's exact `variety_name`, so `promote-staged-claims.js::resolveEntityForClaim`
  attaches to the served entity (or auto-creates an unserved one) instead of
  mis-attributing. The batcher does NOT pre-create entities; promote does.
- **`regional_context='Global'`** — resistance is a region-independent genetic trait;
  this clears the promote-time locality gate without inventing a country.
- **Attacker resolver is authoritative** — `lib/attacker-name-resolve.js` sets the
  category (pathogen→`disease_resistance`, pest→`pest_resistance`) and **abstains**
  (holds the row) on uncurated names, which become the curated-map worklist.
- **`ai_vouch_status='uncertain'`** seed — sends rows straight to multi-critic
  consensus, skipping the single-critic pre-filter for this small authoritative batch.

# Scope

Phase 1 (resistance) is the current build + run. Phase 2 (traits → `entity_trait_claims`)
reuses the same rails with the trait claim type. Live D1 publish of served resistance
claims is a separate ordering-safe step (web chat). De-serving data-less numerical-code
varieties is a separate variety-curation backlog item, not part of this pipeline.

# Phase 2 — trait enrichment

The same front-of-pipe, different claim type. `grin-narrative-batch.js --phase=traits` →
`grin-extractor.md` (Phase-2 section) → `grin-narrative-stage.js --phase=traits`
(`buildTraitStagingPayload`, `target_table='entity_trait'`) → multi-critic
(routes `entity_trait`+`bio_category=plantae` → **horticulturist**) → `promoteEntityTraitRow`
→ [entity_trait_claims](/datasets/claims.md).

Migration 068 adds 13 foundational plant traits to `traits_vocabulary`. The GRIN run
populates the produce/growth subset (`growth_determinacy`, `produce_weight_g`,
`produce_color`, `produce_shape`, `photoperiod_response`, existing `days_to_harvest`) +
opportunistic `deficiency_sensitivity`; the reproduction/pollination family (5) +
`nutrient_demand` + `nitrogen_use_efficiency` are defined now and monograph/trial-populated
later. **Value typing** is authoritative from `traits_vocabulary.value_kind`
(`lib/trait-value.js`): range = `{min,max}` object, categorical = exact-lowercase enum.
`nutrient_demand` is descriptive-only (never derives companion rows — folklore gate).
The species-level foundational-trait gap analysis is a separate sub-project (backlog memory).

# Citations

[1] spec `docs/superpowers/specs/2026-06-25-grin-narrative-enrichment-design.md`;
    plan `docs/superpowers/plans/2026-06-25-grin-narrative-enrichment.md`.
[2] `grin-narrative-batch.js`, `.claude/agents/grin-extractor.md`,
    `grin-narrative-stage.js`, `lib/attacker-name-resolve.js`.
