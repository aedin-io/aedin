---
type: Architecture
title: Data flow
description: The layered pipeline that turns raw GloBI interactions into served, scored, citable knowledge — ingestion, enrichment, normalization, scoring, serving.
tags: [architecture, pipeline, data-flow]
timestamp: 2026-06-23T00:00:00Z
---

# The layers

1. **Raw ingestion** — [`sync-globi.js`](/pipelines/globi-ingestion.md) streams the GloBI CSV dump into SQLite (`interactions`), then builds indexes + locality-coverage tables keyed on `regions.json`.
2. **Enrichment** — `sync-trefle`, `sync-gbif`, `sync-wikidata`, `sync-climate-grid` populate `crops`, `planner_organisms`, `climate_grid`, and taxonomy.
3. **Normalization** — `load-globi-claims.js` converts raw interactions into normalized [claims](/datasets/claims.md) with a `data_tier` priority (`tier1_paper` > `tier2_globi` > `tier3_user`).
4. **Scoring** — [`build-scores.js`](/pipelines/scoring.md) computes `crop_companion_scores` from normalized data + `interaction_type_rules`.
5. **Serving** — `server.js` exposes REST endpoints reading from SQLite; the [web site](/services/web-site.md) serves a D1 mirror.

# Parallel inputs

- A subscription-only [LLM literature-ingestion pipeline](/pipelines/llm-literature-ingestion.md) (Phase 3) extracts atomic agroecological claims from open-access papers/books and promotes them through a multi-critic consensus gate into [`claims`](/datasets/claims.md).
- A [variety-intake pipeline](/pipelines/variety-intake.md) curates cultivar/landrace data into [entities](/datasets/entities.md).

# The serving boundary

The corpus ([`aedin.sqlite`](/architecture/db-split.md)) is the build source; the live site serves a **projected subset** mirrored to Cloudflare D1. See [corpus vs live D1](/architecture/corpus-and-live-d1.md) — the two routinely drift, and publishing is a deliberate rebuild step.

# Citations

[1] `CLAUDE.md` §"Architecture → Data flow" (items 1–8).
