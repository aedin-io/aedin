---
type: Pipeline
title: GloBI ingestion
description: Streams the raw GloBI CSV dump into the raw DB, builds indexes and locality-coverage caches, then normalizes interactions into claims.
tags: [pipeline, globi, ingestion, normalization]
timestamp: 2026-06-30T00:00:00Z
---

# Stages

1. **`sync-globi.js`** streams the GloBI CSV gz dump (millions of interaction rows) into `globi.sqlite` (`interactions`), then builds indexes on `source_name`, `target_name`, `lat/lng`, `location`, `interaction_type` and locality-coverage tables keyed on `regions.json` presets.
2. **`load-globi-scoped.js`** (the crop-anchored loader that built today's `tier2_globi`) BFS-expands 4 trophic levels from crops over the raw interactions, emitting **only chain edges** (crop edge → pest → biocontrol → attractant); off-chain interaction types are dropped, so ~212k of the millions of raw rows become claims. (`load-globi-claims.js` is the older all-triples variant.)

# Interaction classification

`lib/globi-classify.js` maps a raw `interaction_type` → an [interaction_category](/datasets/claims.md). FIXED_RULES are unconditional (e.g. `pollinates`→pollination, `vectorOf`→disease_vector); VARIABLE_TYPES (`eats`, `parasiteOf`, `hasHost`, `hasVector`, …) resolve by the subject/object `bio_category`.

**`hasVector` is dispersal, not disease (corrected 2026-06-30).** GloBI's `hasVector` dump is **~74% plant→frugivore/nectarivore seed/pollen DISPERSAL** (bats, birds, ants/myrmecochory), ~15% phoresy/taxonomy-mislabeled, and only **16 pathogen-named edges — all out-of-scope Zika→*Aedes***. So `hasVector` is **not** a fixed disease-vector rule: it resolves by bio_category (plant→animal ⇒ `seed_dispersal`; microbe/fungi→arthropod ⇒ `disease_vector`; else `facilitation`). The prior FIXED_RULE→`disease_vector` mislabeled dispersers (it had produced one served-side *Sanguinaria*→*Formica* myrmecochory edge, since corrected).

**Negative result — GloBI vector recovery abandoned.** The disease-vector spec's Track B / "Phase 3" assumed GloBI `hasVector` held a recoverable trove of agricultural disease vectors. It does not — there are **zero** in-scope agricultural disease-vector edges to recover. The atlas's absence of GloBI vector data reflects that the data does not exist, not a pipeline loss.

# Commands

```bash
cd backend
npm run sync-global        # re-download & rebuild globi.sqlite
npm run rebuild            # sync-globi → add indexes → build crop list
npm run rebuild-pipeline   # reload GloBI claims & recompute companion scores
```

# Locality model

Bounding-box filtering happens at **query time** via `regions.json` presets + the locality-coverage tables. Locality caches are bounded to `regions.json` — user-drawn bboxes outside known presets return empty. (`POST /api/ingest-bbox` does **not** exist — do not rely on it.)

# Related

- The raw store lives in [`globi.sqlite`](/architecture/db-split.md).
- Output feeds [scoring](/pipelines/scoring.md) and the [claims dataset](/datasets/claims.md).

# Citations

[1] `CLAUDE.md` §"Architecture → Data flow" items 1, 3; §"Important Notes".
