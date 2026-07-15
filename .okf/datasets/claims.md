---
type: Dataset
title: claims
description: The normalized interaction/trait knowledge table, tiered by evidence source, with a review-status gate governing what is served.
tags: [dataset, claims, interactions, data-tier, review-status]
timestamp: 2026-06-25T12:00:00Z
---

# Role

`claims` is the normalized knowledge table — one row per atomic assertion (an interaction, a crop vulnerability, a biocontrol relationship, a trait). It unifies GloBI-derived and literature-extracted knowledge.

# Evidence tiers

`data_tier` priority: **`tier1_paper` > `tier2_globi` > `tier3_user`**.

- GloBI claims (`tier2_globi`) come from [GloBI ingestion](/pipelines/globi-ingestion.md) via `load-globi-claims.js`. Live D1 preserves the bulk of served `tier2_globi` claims (the largest claim cohort).
- Literature claims (`tier1_paper`) come from the [LLM multi-critic pipeline](/pipelines/llm-literature-ingestion.md), promoted at `review_status='ai_reviewed'`.

# Review status

`claims.review_status` gates serving. `ai_reviewed` is what `promote-staged-claims.js` writes after the multi-critic consensus gate. `quarantined_coarse` marks rank-floor-rejected rows (reversible).

# Host-plant resistance

**Host-plant resistance** (2026-06-25): a crop/variety resisting an attacker is a first-class interaction — `interaction_category` `disease_resistance` (object = pathogen) or `pest_resistance` (object = arthropod), the inverse of `pathogen_pressure` / `pest_pressure`. `subject` = host, `object` = resolved attacker entity, `effect_direction='beneficial'`, a controlled `claims.resistance_level` (complete | strong | partial | tolerant — `tolerant` ≠ `resistant`). The object's kingdom selects the category + the vouching critic (pathogen→plant-pathologist, arthropod→entomologist). `lib/attacker-name-resolve.js` maps disease/pest common names → taxa, abstaining (no guess) on uncurated names. Variety-level, never inherited. **Live serving DONE** (2026-06-25, ordering-safe): live D1 `ALTER TABLE claims ADD COLUMN resistance_level` first, then a surgical patch of the served `disease_resistance` claims (subjects with served-variety pages only; claims whose subject is a slug-less `needs_dedup` cultivar are held for variety-intake), then `queries-d1.ts::getInteractionRows` selects `resistance_level` and `EntityClaimsTable` renders an "is resistant to" sentence (`lib/claim-sentence.ts`) + a `resistance_level` badge.

# Region & provenance

- Region resolves per-tier in `normalizeInteractionRow`: GloBI from `claim_localities` (`GROUP_CONCAT(DISTINCT country)`), literature from `claims.regional_context`.
- Served GloBI claims get pages at `/globi/[id]`; literature claims keep static `/claim/[id]`. **Live GloBI claim ids differ from local `globi.sqlite` ids** (the scoped loader reassigns ids per rebuild).

# Served subset caveat

The D1 `claims` mirror is the **served subset** and omits quarantined/removed rows — so revision rollups bake entity associations at publish time rather than JOINing at runtime. See [corpus vs live D1](/architecture/corpus-and-live-d1.md).

# Related

- Produced by [GloBI](/pipelines/globi-ingestion.md) + [LLM ingestion](/pipelines/llm-literature-ingestion.md); consumed by [scoring](/pipelines/scoring.md); subjects/objects are [entities](/datasets/entities.md).

# Citations

[1] `CLAUDE.md` §"Architecture → Data flow" item 3; §"Region/citation/flag/arrow + GloBI claim pages".
