---
type: Dataset
title: entities
description: The central taxon/organism table — the live source of truth for taxonomy, roles, bio-categories, varieties, and serving status.
tags: [dataset, entities, taxonomy, roles]
timestamp: 2026-06-29T00:00:00Z
---

# Role

`entities` is the central table — the corpus's largest. It holds every taxon/organism AEDIN knows — GloBI-native species, literature-ingested entities, crops, and [varieties](/datasets/varieties.md).

# Key columns

| Column | Meaning |
|---|---|
| `scientific_name`, `common_name` | identity |
| `primary_role` | **live source of truth** for role (pest, beneficial, pathogen, crop, …) — see [classification](/architecture/classification-system.md) |
| `bio_category` | plantae / fungi / invertebrate / vertebrate / microbe / other |
| `taxon_path`, `phylum`, `taxon_class`, `family` | higher taxonomy (GBIF/Wikidata-resolved; collision-prone — see classification hazards) |
| `parent_entity_id` | non-null → this is a **variety** of that parent |
| `variety_type`, `grin_accession` | variety discriminator + germplasm key (see [varieties](/datasets/varieties.md)) |
| `scope_tier` | non-null → **served**. But the [D1 build](/architecture/corpus-and-live-d1.md) serving set is BROADER than `scope_tier`: `build-d1.cjs` also selects any entity **referenced by an `ai_reviewed` claim/trait**. So a `scope_tier`-NULL literature entity is row-included on D1 once a promoted claim cites it — but the **page** needs a `slug` (next row). |
| `slug` | URL key for the entity page (`/entity/[slug]`) and the **real serving gate** — `entity/[slug].astro` is slug-keyed, so a NULL-slug entity is row-on-D1-but-page-less. `slugify(scientific_name)` — lowercase, runs of non-alphanumerics → one hyphen, trim (`lib/slugify.js`). Set at ingest + at variety promote. Two backfills fill the gaps (both via `lib/slug-backfill.js`'s collision partition: clean → slug, slug-collision = duplicate taxon → **flag `needs_dedup`, never suffix**, e.g. `×`-hybrid pairs `Citrus limon`/`Citrus × limon`): `backfill-entity-slugs.js` for `scope_tier`-served entities; **`serve-referenced-entities.js`** (2026-06-29) for the `scope_tier`-NULL literature-ingested tail that promoted claims reference — it sets `slug` + `scope_tier=0` to give them a page, **clean only** (excludes `needs_dedup`/`needs_taxonomy_review`, plus an agroecologist `--hold-ids` list of generic-guild collectives / class-and-coarser ranks that should be quarantined not served). |
| `needs_dedup`, `needs_taxonomy_review` | quarantine/curation flags |
| `merged_into_entity_id` | non-null → this row is a **tombstoned duplicate** merged into that canonical entity (see [entity dedup](/pipelines/entity-dedup.md)); read paths filter it out |
| `common_names_synced_at` | multilingual vernacular sync marker |

# Related data

- `entity_common_names` — language-tagged vernacular names (the multilingual backfill; canonical `language` codes via `lib/lang-normalize.js`).
- `entity_trait_claims` — environmental/biology trait claims per entity (the inheritance substrate).
- `revision_log` (migration 055) — audit trail of every programmatic field mutation (`lib/revision-log.js::logRevisions`).

# Hazards

Genus-name collisions corrupt higher taxonomy; synonym/typo duplicate rows persist (`needs_dedup`). See the [classification system](/architecture/classification-system.md) for the detectors and the open dedup work. Duplicate rows are detected as slug-collisions (the `needs_dedup` flag) and epithet-Levenshtein pairs (`entity_dedup_candidates`), tiered by confidence, and the high-confidence tier merged reversibly — see [entity dedup](/pipelines/entity-dedup.md).

# Citations

[1] `CLAUDE.md` §"Classification system", §"Entity page + modification provenance", §"Open Phase-1 follow-ons".
