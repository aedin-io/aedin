---
type: Dataset
title: varieties
description: Cultivar/landrace/infraspecies entities linked to a parent crop species, with a nomenclatural-rank discriminator and inherited traits.
tags: [dataset, varieties, cultivar, landrace, grin]
timestamp: 2026-06-23T00:00:00Z
---

# Definition

A **variety** is an [entity](/datasets/entities.md) with `parent_entity_id IS NOT NULL`, discriminated by `variety_type` ∈ `{cultivar, subsp, var, f, hybrid, morphotype, landrace}`. Built and curated by the [variety-intake pipeline](/pipelines/variety-intake.md).

# Variety types & sources

Served varieties span all `variety_type` values: `cultivar` and `landrace` (the agrobiodiversity pair) plus the infraspecies ranks `subsp`/`var`/`f` (largely GloBI-native), with occasional `hybrid`/`morphotype`. They come from several `source_table`s — `extension_scrape` (farmer-cultivar scrapes), `grin` (USDA germplasm), `globi` (native infraspecies), `planner_organisms`, and `extraction_staging`. For current counts, query the corpus; they drift with every ingestion + build.

# Corpus ↔ live drift

The corpus typically serves **more** varieties than live D1, because the live mirror is a point-in-time [build snapshot](/architecture/corpus-and-live-d1.md): newly-served varieties (notably landraces and GRIN cultivars) appear live only on a **rebuild + republish**. Live D1 also has **no `source_table` column** (it's a projection) — filter served varieties there by `variety_type`/`parent_entity_id`.

# Provenance fields

- `grin_accession` — USDA GRIN PI number (germplasm key).
- `inherited_from_entity_id` — D1-build-only flag marking a trait inherited from the parent (an inferred prior, to be badged distinctly in the UI).
- `origin` (on the `grin_varieties` staging table) — collection provenance, deliberately **not** mapped to `native_regions`.

# Related

- Built by the [variety-intake pipeline](/pipelines/variety-intake.md); rows live in [entities](/datasets/entities.md).

# Citations

[1] memory `variety-intake-system`; `backend/GRIN-SCRAPE-RUNBOOK.md`.
