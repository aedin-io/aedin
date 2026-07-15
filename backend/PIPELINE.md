# AgroEco Data Pipeline

9-stage flow from raw GloBI data to scored companion recommendations and tritrophic chains.

All steps are incremental by default — they skip already-processed data unless `--force` is passed.

## Quick Start

```bash
# Incremental run (most common — processes only new data)
node run-pipeline.js

# Full rebuild from scratch (destructive, takes hours)
node run-pipeline.js --force

# Skip API steps (fast, offline)
node run-pipeline.js --skip-api

# Run only scoring (after manual claim edits, etc.)
node run-pipeline.js --only 9

# Resume from step 6 after fixing an issue
node run-pipeline.js --from 6
```

## Pipeline Flow

```
sync-globi.js ─── GloBI CSV dump ──────────────────> interactions (6.75M)
       │
migrate-entities.js ─── interaction names ──────────> entities (193K)
       │
cleanup-garbage.js ─┐
cleanup-genus.js ───┼── remove junk before API calls
fix-trailing-*.js ──┘
       │
sync-gbif.js ─── GBIF Species API (--limit 500) ──> entities + taxonomy
       │
sync-trefle-entities.js ─── Trefle API (--limit 100) > entities + botanical
       │
reclassify-bio.js ─── GBIF taxonomy ──────────────> entities.bio_category
       │
seed-role-rules.js ──> role_rules (297)
apply-role-rules.js ──> entities.primary_role
       │
load-globi-claims.js ─── interactions + entities ──> claims (1.77M)
       │
build-scores.js ──> companion_scores + tritrophic_chains + agroeco_functions
```

## Stages

### 1. Raw interactions — sync-globi.js

Downloads the full GloBI CSV gz dump and streams into SQLite. Accepts records with location data OR predation/parasitism types without location (literature-derived biocontrol records). Rebuilds locality coverage tables from regions.json.

| | |
|---|---|
| **Input** | GloBI CSV dump (depot.globalbioticinteractions.org) |
| **Output** | `interactions`, `interaction_locality_coverage`, `species_locality_coverage`, `crop_locality_coverage` |
| **Incremental** | Skips if interactions table has data |
| **Force** | `--force` drops and re-downloads |

### 2. Entity creation — migrate-entities.js

Creates entity records from planner_organisms and interaction names. If planner_organisms has been dropped (already migrated), exits cleanly.

| | |
|---|---|
| **Input** | `planner_organisms` (if exists), `verified_crops` |
| **Output** | `entities` |
| **Incremental** | INSERT OR IGNORE handles dedup |
| **Force** | `--force` clears and re-migrates |

### 3. Data cleaning

Removes garbage before spending API calls on enrichment.

| Script | What it removes |
|--------|-----------------|
| `cleanup-garbage.js` | GenBank accessions, habitat descriptions, UUIDs, indeterminate "sp." |
| `cleanup-genus.js` | Genus-only names (no species epithet) |
| `fix-trailing-periods-and-varieties.js` | Trailing periods, normalizes variety notation |

All support `--dry-run`.

### 4. GBIF taxonomy — sync-gbif.js

Enriches entities with GBIF Species API taxonomy.

| | |
|---|---|
| **Input** | GBIF Species API (CC0 licensed) |
| **Output** | `entities` taxonomy columns: kingdom, phylum, taxon_class, taxon_order, family, genus, gbif_key, common_name |
| **Incremental** | Only queries entities where gbif_key IS NULL |
| **Default limit** | 500 per run |
| **Flags** | `--force`, `--bio KINGDOM`, `--role ROLE`, `--limit N`, `--parallel N` |

### 5. Trefle botanical — sync-trefle-entities.js

Enriches plant entities with botanical data from the Trefle API.

| | |
|---|---|
| **Input** | Trefle API (requires TREFLE_TOKEN in .env) |
| **Output** | `entities` botanical columns: growth_habit, nitrogen_fixation, ph_min/max, min_root_depth_cm |
| **Incremental** | Only queries plants where trefle_synced_at IS NULL |
| **Default limit** | 100 per run |

### 6. Bio reclassification — reclassify-bio.js

Re-derives bio_category from GBIF taxonomy columns. Always runs (fast, no API calls).

| | |
|---|---|
| **Input** | GBIF taxonomy columns on entities |
| **Output** | Corrected `entities.bio_category` |
| **Flags** | `--dry-run` |

### 7. Role assignment — seed-role-rules.js + apply-role-rules.js

First seeds the role_rules table from hardcoded taxonomy lists (idempotent), then evaluates entities against rules.

| | |
|---|---|
| **Input** | `role_rules`, `entities`, `role_corrections` |
| **Output** | `entities.primary_role`, `role_assignment_log` |
| **Incremental** | Default evaluates only unclassified/neutral entities |
| **Force** | `--all` re-evaluates everything |
| **Flags** | `--entity ID`, `--family NAME`, `--bio CATEGORY`, `--respect-corrections`, `--dry-run` |

### 8. Build claims — load-globi-claims.js

Transforms raw interactions into deduplicated claims with resolved categories, effects, and weights. Auto-creates entities for organisms found in interactions but not in the entities table.

| | |
|---|---|
| **Input** | `interactions`, `entities`, `interaction_locality_coverage` |
| **Output** | `claims` |
| **Incremental** | Dedup against existing claim keys |
| **Force** | `--force` clears and rebuilds all tier2_globi claims |

### 9. Scoring + chains — build-scores.js

Derived scoring pipeline. Always rebuilds to reflect current claims state.

| | |
|---|---|
| **Input** | `claims`, `entities` |
| **Output** | `companion_scores`, `tritrophic_chains`, `entities.agroeco_functions` |
| **Stage 1** | Companion scores (polyculture compatibility) |
| **Stage 2** | Tritrophic chains (crop <- pest <- biocontrol) |
| **Stage 3** | Agroeco functions cache (nitrogen_fixer, pollinator_habitat, insectary) |

## Key Tables

| Table | ~Rows | Source |
|-------|-------|--------|
| interactions | 6.75M | sync-globi.js |
| entities | 193K | migrate-entities.js, load-globi-claims.js |
| claims | 1.77M | load-globi-claims.js |
| companion_scores | 1.2K | build-scores.js |
| tritrophic_chains | 71 | build-scores.js |
| role_rules | 297 | seed-role-rules.js |
| role_assignment_log | 179K | apply-role-rules.js |

## Supplemental Scripts (not in core pipeline)

| Script | Purpose |
|--------|---------|
| `fetch-globi-predation.js` | Backfill predation data from GloBI API without full re-sync |
| `load-predation-claims.js` | Process backfilled predation into claims |
| `sync-wikidata.js` | Wikidata enrichment (conservation status, images) |
| `sync-eppo.js` | EPPO pest/pathogen data (non-commercial only) |
| `sync-grin-varieties.js` | USDA GRIN variety/cultivar data |
| `sync-trefle-catalog.js` | Full Trefle plant catalog (~415K species) |
| `run-role-agent.js` | LLM-powered role classification for edge cases |
| `extract-source.js` | LLM document extraction module |
