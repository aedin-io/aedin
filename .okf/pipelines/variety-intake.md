---
type: Pipeline
title: Variety intake
description: The subsystem that curates plant cultivar/landrace (variety) data into the entity DB — the variety model, kingdom-aware trait inheritance, and the gated GRIN germplasm pipeline.
tags: [pipeline, varieties, cultivar, landrace, grin, inheritance]
timestamp: 2026-06-23T00:00:00Z
---

# Why it matters

Farmers choose at the **variety** level. A variety inherits most traits from its parent species but diverges on the axes farmers care about (yield, days-to-harvest, disease resistance). So the knowledge base needs variety-resolution, not just species-resolution. See [the varieties dataset](/datasets/varieties.md).

# The model

A **variety** = an [entity](/datasets/entities.md) with `parent_entity_id IS NOT NULL`. A nomenclatural-rank discriminator **`entities.variety_type`** (migration 062, plain TEXT — no CHECK) ∈ `{cultivar, subsp, var, f, hybrid, morphotype, landrace}` (uniform across kingdoms; kingdom lives in `bio_category`). `landrace` is a first-class agrobiodiversity category, **not** a uniform cultivar.

# Kingdom-aware trait inheritance

- `lib/variety-traits.js::resolveVarietyTraits(db, varietyId)` = the variety's own `ai_reviewed` trait claims UNION the parent's, gated so a variety only inherits **conserved** traits.
- `lib/trait-inheritance-class.js::inheritanceClass(bio_category, trait_name) → conserved|divergent` is **fail-closed** (not-explicitly-conserved → divergent). The same trait flips class by kingdom (climate envelope conserved for plants, divergent for vertebrates). **Universal rule: `host_range`/target = divergent in every kingdom.**
- **3 corruption-amplifier guards:** inheritance refuses to cross a `bio_category` boundary (Guard A), skips a `needs_taxonomy_review` parent (Guard B), and hybrid/morphotype inherit nothing (Guard C).
- Materialized at build time: `build-d1.cjs` bakes inherited rows flagged with `inherited_from_entity_id` (a D1-build-only column) onto served varieties.

# Gated promotion pattern

Scrape/extract → staging → **gated** promote → variety entity. Shared deciders in `lib/variety-promote.js` (`normalizeVarietyName`, `dedupDecision → {action: update|create|create-flag}`; near-dups flagged `needs_dedup`, **never auto-merged**). Promoted variety entities get a URL [`slug`](/datasets/entities.md) at creation (`slugify(scientific_name)` via `lib/slugify.js`) so they are servable.

- **Extension varieties** (`promote-extension-varieties.js`): maps only `maturity_days → days_to_harvest`; honest-traits discipline skips calendar harvest-windows it can't coerce.
- **GRIN germplasm** (`sync-grin-varieties.js` → `grin_varieties` staging → `promote-grin-varieties.js`): scrapes USDA GRIN-Global; the gate (`lib/grin-gate.js`) maps `improvement_level` (Cultivar/Cultivated→`cultivar`, Landrace→`landrace`; Breeding/blank/Uncertain/Wild→skip) + a **name-hygiene** gate rejecting accession-code names (`/^[A-Z]{1,4}[\s-]?\d{2,}$/`, widened 2026-06-23 to catch hyphenated codes like `EC-329392`). `origin` is kept as provenance, **never** written to `native_regions` (collection-provenance ≠ adaptation region).

# Gate-less reconciliation (2026-06-23)

The pre-#4 gate-less GRIN scraper left **888 ungated entities**. `lib/grin-reconcile.js` + `reconcile-grin-gateless.js` (FK-safe, backup-first, dry-run default) backed them up + deleted them (736 okra + 127 *Abies* firs + 25 *Abelmoschus* crop-wild-relatives), then re-scraped okra → **3 clean cultivars**. GRIN okra is ~98% un-improved accessions (0 Landrace), so the gate correctly promotes few — honest-traits over volume. Full record: `backend/GRIN-SCRAPE-RUNBOOK.md`.

# Status

Data-flow work complete (variety model, inheritance, extension + GRIN intake, reconciliation). The **admin review UI** and **live D1 serving/publish** of varieties are the web chat's domain. The live publish is *coupled* with rendering the own-vs-inherited trait badge (inherited values are inferred priors, not measurements).

# Citations

[1] `CLAUDE.md` §"Open Phase-1 follow-ons" + memory `variety-intake-system`.
[2] `backend/GRIN-SCRAPE-RUNBOOK.md`; specs under `docs/superpowers/specs/2026-06-*-variety-*`.
