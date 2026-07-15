---
type: Architecture
title: Classification system
description: How organism roles (primary_role) and bio-categories are assigned — the family-floor role cascade, the still-multiple paths, and the source-of-truth entity fields.
tags: [architecture, classification, roles, bio-category, taxonomy, family-floor]
timestamp: 2026-06-27T00:00:00Z
---

# Active classification paths

Several paths assign roles/categories (consolidation into `lib/role-engine.js` is the highest-leverage open cleanup):

- **`lib/role-engine.js`** — the rule-based role cascade (see below), used by `apply-role-rules.js`. The source of truth for `primary_role`.
- **`classify-taxon.js::getBioCategory`** — taxon_path string-match → `plantae`/`fungi`/`invertebrate`/`vertebrate`/`microbe`/`other`. This derives the taxonomic **bio_category** (a fact), NOT a role; imported by `server.js`. Unchanged by the family-floor work. (Its former hard-coded `CLASS_RULES` role-valence defaults were emptied 2026-06-27 — that path no longer asserts a role.)
- **`lib/organism-type.js`** — maps LLM-extraction `organism_type` → bio_category + primary_role.
- **`run-role-agent.js`** — LLM-driven classification (Claude) via `prompts/role-agent.md`.

# Role assignment: the family-floor cascade

`role-engine.js::evaluateRules` resolves `primary_role` from the `role_rules` table by descending specificity: **species → genus → biocontrol-family → family → interaction-profile (claim-derived) → (no match)**. A role is asserted ONLY from claim-derived evidence (`interaction_profile` rules — what the corpus's claims say the entity does) or a curated **species/genus/family** rule. **Family is the floor.**

Coarse-taxonomy default tiers were **removed 2026-06-27** (`role_rules.enabled=0`, reversible): the `taxonomy_class` rules (class/order/kingdom: `fungi→pathogen_fungal`, `plantae→weed`, `insecta→pest_insect`, `mammalia→pest_vertebrate`, …) and the `bio_category_default` tier. These asserted role-by-kingdom ("every fungus is a pathogen"), the largest manufacturer of false roles. Any entity matching no rule/profile now resolves to **`unclassified`** (the evidence-free default — by design the dominant role). Governing principle: **ambiguity > false identification** (this is a citable knowledge base; cf. [/decisions/](decisions/) on generic-guild quarantine). New ingested entities default to `unclassified` (`promote-staged-claims.js`); varieties inherit their parent species' corrected role.

A small curated keep-list survives the floor where a family is functionally monomorphic (e.g. `Glomeraceae`/`Rhizobiaceae`→`soil_microbe`, `Lumbricidae`→`neutral`, `Formicidae`→`neutral`). Crop identity is re-asserted authoritatively from FAO ECOCROP (`reclassify-crops-from-ecocrop.js`), not from taxonomy.

**Tooling (all reversible):** `lib/coarse-rank-audit.js` (what counts as coarse), `disable-coarse-role-rules.js` / `add-family-floor-rules.js` (both `--undo`), `apply-role-rules.js --unmatched-to-unclassified` (the load-bearing null→unclassified), `reclassify-variety-roles.js`, `verify-no-coarse-defaults.js`, and `web/scripts/gen-roles-patch.cjs` (D1 sync). Every role change is logged to `role_corrections` (`source='family_floor'`/`'variety_inherit'`), so the whole migration is replayable/reversible. Spec/plan: `docs/superpowers/{specs,plans}/2026-06-27-role-classification-no-coarse-defaults*`.

# Source of truth

`entities.primary_role` is the live source of truth. `planner_organisms` is a legacy migration name — prefer [`entities`](/datasets/entities.md) in current code paths.

# Known taxonomy hazards

- **Genus-name collisions** corrupt `entities.phylum`/`taxon_class` (e.g. *Cyathus* fungus → phylum Arthropoda). GBIF is the collision *source*, so it can't fix them; the durable fix is a curated genus→expected-phylum validator (`lib/phylum-validator.js` + `detect-taxonomy-corruption.js`) that uses the curated genus NAME as the primary signal and claim context only to confirm.
- **Ingested-entity taxonomy** is GBIF-resolved via `lib/gbif-resolve.js` (disambiguate-or-abstain) + `lib/kingdom-hint.js`; abstentions are flagged `needs_taxonomy_review`.

# Related

- [Entities dataset](/datasets/entities.md) — where roles/categories live.
- [LLM literature ingestion](/pipelines/llm-literature-ingestion.md) — creates literature entities (default `unclassified`) needing taxonomy resolution.
- [Corpus ↔ live-D1 serving](/architecture/) — `gen-roles-patch.cjs` syncs role changes to served entities via `wrangler d1 execute`.

# Citations

[1] `CLAUDE.md` §"Classification system" and §"Open Phase-1 follow-ons" (taxonomy corruption).
[2] `docs/superpowers/specs/2026-06-27-role-classification-no-coarse-defaults-design.md` — family-floor design + agroecologist gate.
