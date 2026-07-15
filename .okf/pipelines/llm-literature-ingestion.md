---
type: Pipeline
title: LLM literature ingestion (multi-critic consensus)
description: The subscription-only Phase-3 pipeline that extracts atomic agroecological claims from OA literature and promotes them through a multi-critic consensus gate.
tags: [pipeline, llm, ingestion, multi-critic, claims]
timestamp: 2026-07-03T00:00:00Z
---

# Shape

Subscription-only (**no Anthropic API spend**) — all LLM work routes via Claude Code Agents reading `backend/critic-batches/*.json`.

1. **Extract** — `pdf-chunk.js` emits an 80K-char text chunk → a general-purpose Agent reads `.claude/agents/extractor.md` and returns claim JSON → `stage-from-json.js` upserts `extraction_queue`/`sources`/`extraction_staging` (one row per atomic claim, with `source_quote`, `source_page`, `confidence_score`).
2. **Vouch** (single-critic, Haiku-tier) — `vouch-batch-prepare.js` → Agent fills verdicts → `vouch-batch-import.js` sets `extraction_staging.ai_vouch_status` (4-class: plausible/implausible/uncertain/out_of_scope).
3. **Multi-critic consensus** — `multi-critic-batch-prepare.js` routes each staged row to the **agroecologist synthesizer + one specialty critic** (entomologist/plant-pathologist/soil-scientist/horticulturist/wildlife-ecologist, picked by `lib/critic-router.js`). Verdicts land in `claim_critic_verdicts` (keyed by `(staging_id, critic_name)`).
4. **Promote** — `promote-staged-claims.js` lifts rows hitting the **consensus gate (≥2 plausible, 0 implausible)** into [`claims`](/datasets/claims.md) with `review_status='ai_reviewed'`.

# Promote-time gates

- **Locality gate** (`lib/region-normalize.js::hasResolvableLocality`) — an **interaction** claim must resolve to ≥1 country/scope. **`entity_trait` rows are exempt** — an intrinsic species trait (edible_part, life_cycle, thermal_min…) is not regional, so `promote-staged-claims.js` routes trait rows to `promoteEntityTraitRow` and `continue`s before this gate (pinned by a no-locality regression test).
- **Rank-floor gate** (`lib/taxon-rank-floor.js`) — reject claims whose subject/object resolves no finer than CLASS; floor is at ORDER (family/genus collectives like Aphididae PASS).
- **Crop-gate** (`promote-staged-claims.js::CROP_ANCHORED_TRAITS`) — growth/morphology/maturity traits (`maximum_height_cm`/`average_height_cm`/`canopy_spread_cm`/in-&between-row spacing/`days_to_harvest`) must attach to a crop anchor (`entities.crop_type IS NOT NULL OR edible=1`); a non-crop subject is skipped. Deliberately NARROW — pest/beneficial traits (voltinism, thermal_min) and general plant descriptors (life_cycle, growth_habit) are NOT gated, so it never rejects legitimate arthropod trait claims.
- **Vector reconciliation** (`lib/interaction-vocabulary.js::reconcileVectorCategory`) — when the GloBI Relations-Ontology term is `vectorOf` (marking a disease/pest vector), the interaction category MUST be `disease_vector`, never the force-fit `pathogen_pressure` or `pest_pressure` the extractor sometimes emits. Applied in `promote-staged-claims.js` immediately after the GloBI-term resolution, before the claim INSERT.

# Critic agents

Two flavors of `.claude/agents/*.md`: **prompt-as-data** (extractor, extractor-vouch — consumed by scripts) and **runtime critics** (agroecologist + specialty critics — invoked interactively via the Agent tool). `lib/critic-prompts.js` composes the dispatch prompt from each agent's `description` so the runtime and data variants don't drift.

# Backlog recovery — tiebreak

The consensus gate holds a large class of **valid** rows "one-plausible-short": the agroecologist synthesizer votes plausible but `lib/critic-router.js` assigns the WRONG 2nd specialist, who returns `out_of_scope`/`uncertain` (can't judge) → 1 plausible, 0 implausible, gate not met. `tiebreak-batch-prepare.js` recovers them: it selects rows with `pl=1 AND im=0 AND n=2` (the `n=2` guard = only the un-tiebroken routed pair → idempotent), ships all 5 specialist templates + each claim's `already_judged_by`, and a general-purpose Agent **self-routes** to the correct specialist by claim content (avoiding one already flagged out_of_scope) — sidestepping the router bug. Import/promote reuse the existing scripts (`VERDICTS_DIR`/`BATCH_OUT_DIR` env overrides); the shared self-routing prompt is `backend/tiebreak-verdicts/INSTRUCTIONS.md`. First run 2026-07-03 recovered 392/508 held rows (77%); the non-recovered are correctly held by the rank-floor/locality gates or an honest implausible tiebreak. This is a recover-existing-rows workaround; the durable fix is repairing `lib/critic-router.js` (the "Open router-tuning backlog" mis-routings).

# Status

The 5K `ai_reviewed` milestone was crossed 2026-05-31; the cumulative total has grown well beyond it (query the corpus for the current figure). Per-pass narratives live in `docs/phase-3-passlog.md`. Pesticide-chemistry sources trip the safety classifier ~43% under subscription mode — API+Batch+Haiku is the durable unblock.

# Related

- Output: [claims](/datasets/claims.md). Critics sanity-check the [classification system](/architecture/classification-system.md).

# Citations

[1] `CLAUDE.md` §"Architecture → Data flow" items 6–8; `docs/phase-3-passlog.md`.
