# Agroecological Framework — Distilled Principles (Multi-Source)

This is the always-loaded cheat sheet. The corpus has **four grep-able sources**, each with a distinct scope — verify every citation against the matching full-text file before citing back to the user.

| Short name | File prefix | Scope when critiquing AgroEco |
|------------|-------------|-------------------------------|
| **Gliessman** (2015) — primary framework | `gliessman_*` | Baseline agroecology, interaction typology, Five-Level conversion, sustainability indicators |
| **Rickerl & Francis** (2004) — ASA Monograph 43 | `ricker_francis_*` | Landscape conservation, whole-farm/multifunctional economics, ethics, habitat management (Nicholls & Altieri Ch 4) |
| **Andow, Ragsdale & Nyvall** (1997) — biocontrol | `andow_biocontrol_*` | Biological control mechanics: parasitoid specificity, establishment criteria, tritrophic/multitrophic interactions, host–pathogen coevolution |
| **Dieckmann, Law & Metz** (2000) — spatial theory | `dieckmann_geometry_*` | Why mean-field/pair claims fail; neighborhood effects, spatial heterogeneity, adaptive dynamics |

**Routing rule (which book for which question):**
- Role classification of a predator/parasitoid, or *is this specialist actually a natural enemy of this pest?* → **Andow** first, Gliessman second.
- Companion-pairing plausibility at the species-pair level → **Gliessman Ch 16** first.
- *Does this pair-level claim hold at community/landscape scale?* → **Dieckmann** + **Rickerl & Francis Ch 4, 8**.
- Habitat-management, on-farm design, whole-farm economics → **Rickerl & Francis**.
- Sustainability-level (1–5) classification, ethics framing → **Gliessman** + **Rickerl & Francis Ch 11**.
- *Is this vertebrate (bird/rodent/bat/ungulate) actually a pest, or a pest-controlling / pollinating / seed-dispersing beneficial?* → defer to the **wildlife-ecologist** agent (vertebrate corpus); the vertebrate actor owns vertebrate↔arthropod claims, not the entomologist.

## 1. The Agroecosystem Concept (Ch 2)
A farm is an ecosystem. Apply ecosystem theory — **structure** (components: organisms, soil, climate, water) and **function** (processes: energy flow, nutrient cycling, population regulation, dynamic equilibrium) — to agricultural design and management. This is the central reframe of the whole book.

## 2. The Five Levels of Food System Conversion (Chs 22, 26)
Gliessman's most-cited framework. These are *levels of ambition* for sustainability work:

| Level | Scope | Typical moves |
|-------|-------|---------------|
| 1 | Industrial/conventional | Increase efficiency of existing inputs (precision ag, reduced tillage) |
| 2 | Input substitution | Replace synthetic inputs with biological ones (organic fertilizer, biocontrol) |
| 3 | Agroecosystem redesign | Redesign *whole systems* on ecological principles (polyculture, succession, habitat for natural enemies) |
| 4 | Food system re-connection | Re-establish direct grower↔eater links (CSAs, farmers' markets, local food systems) |
| 5 | Global food system transformation | Equity, participation, justice, democracy as design criteria |

Note: substitution (Level 2) alone is "not enough" — the book explicitly critiques stopping there.

## 3. Ecological Processes Applied to Agroecosystems
- **Energy flow** (Ch 20) — trophic levels, energy subsidies (industrial ag spends more fossil energy than it returns as food calories).
- **Nutrient cycling** — closing loops (legumes, compost, manure, cover crops); leakiness of industrial systems.
- **Population regulation** — density-dependent feedback, carrying capacity, predator-prey dynamics (Ch 14, 19).
- **Dynamic equilibrium / resilience** — capacity to absorb disturbance without collapsing.

## 4. Species Interactions (Ch 16) — The Interaction Typology
These are the *canonical* interaction types the book uses. Map AgroEco's interaction labels to these when reviewing:

- **Competition** (−/−) — for light, water, nutrients, space.
- **Herbivory / predation / parasitism** (+/−) — one organism consumes/harms another; biological control exploits this.
- **Mutualism** (+/+) — e.g. legume-rhizobia, mycorrhizae, pollinator-plant.
- **Commensalism** (+/0).
- **Amensalism / allelopathy** (−/0 or −/−) — one plant chemically suppresses another (black walnut, allelopathic cover crops). Gliessman treats allelopathy prominently.
- **Facilitation** — cover crop shading weeds, N-fixer supplying companion.

**Tritrophic cascades** (crop ↔ herbivore ↔ natural enemy) — Gliessman does NOT use the word "tritrophic" (0 hits). He describes the same idea under **biological control** and **species interactions at the community level** (Ch 16, 19). When AgroEco uses `tritrophic`, Gliessman's biological-control-cascade language is the closest match, but the richer and more authoritative source is **Andow et al. Ch 17 (Lewis & Sheehan, "Parasitoid Foraging from a Multitrophic Perspective")** — grep `andow_biocontrol_full_text.md` for *multitrophic*, *tritrophic*, or *parasitoid* for verbatim treatment. Andow's Ch 1 Tables 1.1–1.8 give explicit establishment / host-range success criteria you can use to challenge naive predator→pest assignments.

## 5. Diversity Dimensions (Ch 17)
- **Species diversity** — richness + evenness.
- **Genetic diversity** (Ch 15) — within-crop variety; landraces and wild relatives as reservoirs.
- **Structural diversity** — vertical (layered, e.g. agroforestry) and horizontal (mosaic of patches).
- **Temporal diversity** — rotations, sequential cropping.
- **Functional diversity** — different ecological roles filled.

Diversity is instrumental: it supports **stability, resilience, pest regulation, yield insurance**.

## 6. Disturbance and Succession (Ch 18)
Tillage, harvest, cultivation = disturbances. Natural systems recover via succession (r-strategists → K-strategists). Agroecological design borrows from succession: early-successional species for rapid cover, late-successional (perennials, agroforestry) for stability.

## 7. Landscape Ecology (Ch 21)
Field-edge habitat, hedgerows, riparian buffers, corridors — these are the *landscape* context for biological control and pollination. A field isn't an island; neighboring land use regulates pest/beneficial flux into it.

## 8. Indicators of Sustainability (Ch 23)
Four dimensions Gliessman evaluates:
1. **Ecological integrity** — soil health, biodiversity, water quality.
2. **Economic viability** — income, cost structure, resilience to shocks.
3. **Social equity** — labor conditions, land tenure, gender, community wellbeing.
4. **Productivity** — yield, nutrition per area/energy.

A recommendation that optimizes one dimension at the cost of another is NOT sustainable by Gliessman's standard.

## 9. Terminology bridge — AgroEco codebase ↔ Gliessman
| AgroEco term | Gliessman usage |
|--------------|-----------------|
| `tritrophic` endpoint | not used verbatim; find under "biological control", "species interactions", "natural enemies" |
| `companion` / companion planting | Ch 16 species interactions, facilitation, mutualism |
| `pest` | herbivore / heterotroph causing economic damage (Ch 13, 19) |
| `beneficial` | natural enemy / mutualist / pollinator |
| `pathogen` | heterotrophic organism; Ch 13 and biotic-factor chapters |
| `pollinator` | Ch 16, Ch 19 — pollination as mutualism |
| `primary_role` (planner_organisms) | maps to ecological role in agroecosystem; must distinguish autotroph/heterotroph and interaction direction |
| polyculture | Ch 16, 17 — classic agroecological design |

## 10. Red flags the critic should call out
- Treating a mutualist (e.g. mycorrhizal fungi, rhizobia, syrphid flies) as a pest/pathogen.
- Recommending a monoculture expansion as "agroecological."
- Claims of sustainability based on Level-1 or Level-2 moves only.
- Ignoring landscape context when predicting biological control success.
- Conflating species-level interaction (one pair) with community-level regulation (many species).
- Static classifications for organisms whose role shifts with life stage, density, or context (e.g. many insects are pests as larvae and pollinators as adults).

## 11. Biological-control checks (Andow et al. 1997)
When AgroEco's tritrophic or beneficial endpoints assert a predator/parasitoid suppresses a pest, run this checklist — each item has direct treatment in Andow:

1. **Host-range reality check** — is the named natural enemy actually *specific enough* to be a practical control, or is it a generalist whose per-host pressure is low? (Andow Ch 4, 15; Bigler et al. on *Trichogramma*.)
2. **Establishment vs. control** — "the natural enemy was established" ≠ "the pest was controlled." Andow Ch 1 Table 1.7 quantifies the gap.
3. **Multitrophic context** — plant chemistry, plant architecture, and alternate hosts mediate parasitoid foraging efficiency (Ch 17, Lewis & Sheehan). A claim that isolates pair P↔H without the plant's contribution is suspect.
4. **Coevolution and durability** — host–pathogen gene-for-gene systems evolve; static "this plant resists this pathogen" claims warrant a durability caveat (Ch 9, Leonard).
5. **Microbial biocontrol is not a drop-in for chemical control** — Ch 6–7, 14, 16 show biocontrol efficacy depends on soil community, amendments, and timing.

## 12. Spatial / scale checks (Dieckmann, Law & Metz 2000)
Use this corpus when the claim under review depends on assumptions about well-mixed populations or on extrapolating pair-level outcomes to community-level regulation.

- **Mean-field breaks when interactions are local.** If a companion-score is computed from co-occurrence without spacing/density context, cite Dieckmann Ch 2 (Stoll & Weiner, "A Neighborhood View") or Ch 6–8 (Part B, "When the Mean-field Approximation Breaks Down").
- **Pair approximation is a lower bound on fidelity, not a ceiling.** Pair-level scores implicitly assume no higher-order structure; Part C case studies show this assumption can invert the predicted outcome.
- **Invasion / establishment is context-dependent.** Whether a beneficial "takes hold" in an agroecosystem depends on the resident community (Part D, adaptive dynamics). Static `primary_role` columns cannot represent this.
- **Pathogen virulence evolves.** When a pathogen claim is surfaced, ask whether the claim is a snapshot of a virulence equilibrium that selection pressure could shift.

## 13. Landscape / whole-farm checks (Rickerl & Francis 2004)
- **Habitat management for pest suppression (Ch 4, Nicholls & Altieri)** is the applied companion to Gliessman Ch 16–17. Use this when AgroEco recommends a companion pair but ignores the non-crop habitat (hedgerows, flower strips, refugia) that actually sustains the natural enemies.
- **Whole-farm planning (Ch 5, Janke) and multifunctional economics (Ch 6, Dobbs)** — use when a recommendation ignores on-farm opportunity costs or trades one function for another.
- **Landscape conservation (Ch 8, Schumacher & Rickerl; Ch 9, Caldwell on GIS)** — use when AgroEco's region-scoped outputs ignore spatial configuration (e.g. two farms with equal non-crop % but different connectivity).
- **Ecological morality (Ch 11, Kirschenmann)** — the ethics framing for why Gliessman's Level-4/5 conversions matter; cite when a recommendation is technically sound but socially/ethically mute.

## 14. Corpus hygiene — when to concede
- If a question falls outside agroecosystems (pure conservation biology, wildlife, urban ecology), say so.
- If none of the four sources grep-hit the key term, mark "(from general ecological knowledge, not verified in corpus)" and stop — don't fabricate a citation.

## 15. External reference data (non-corpus)

These are *datasets*, not part of the four-book corpus. Cite them as data sources, never as ecological authority — but know they exist so you can distinguish "claim not in corpus" from "claim backed by an external reference".

| Dataset | Scope | When it shows up in AgroEco |
|---------|-------|------------------------------|
| **FAO ECOCROP** (≈1,700 SCIENTNAMEs) | Canonical food/fibre crops with optimal temp, rainfall, pH, soil texture, fertility, salinity, light | Source of truth for `primary_role='crop'` classification (via `reclassify-crops-from-ecocrop.js`); also populates `optimal_*` fields on entities. |
| **SoilGrids v1/v2** (ISRIC, 5 km global) | pH, clay, sand, silt, SOC, CEC, nitrogen, bulk density, field capacity, wilting point | Populates `soil_*` columns on `climate_grid`. Extends ~56°S to ~84°N — high-latitude rows legitimately have NULL soil. |
| **WorldClim v2.1** (1 km global) | 19 bioclim vars + monthly srad / vapr / elev | Populates `bio1..bio19`, `elevation_m`, `mean_*_radiation`, `mean_relative_humidity` on `climate_grid`. |
| **OpenLandMap BDTICM** (5 km global) | Depth to bedrock (cm) | Populates `soil_depth_bedrock_cm`; uncapped — values in deep sedimentary basins (Amazon, Mississippi) legitimately reach hundreds of metres. |
| **Trefle API** (≈400k taxa, narrow growth-data coverage) | pH, light, humidity, root depth, days-to-harvest for common crops | Populates both `optimal_*` and legacy `ph_min/min_temp_c` column families. Sparse outside the top ~2k food crops. |

### How to cite these in reviews
- If a crop classification is under review and the species is in ECOCROP, the classification is **confirmed by an authoritative taxonomic source** — that's stronger than interaction-based inference. Say so explicitly.
- If a claim depends on soil/climate values, verify coverage: high-latitude cells and small islands have known gaps (SoilGrids raster bounds) that are not data errors.
- Derived fields (`soil_texture_class` from USDA triangle; `soil_nutriments_0_10` from N+CEC+SOC; `soil_moisture_index` from de Martonne `P / (T + 10)`) are *proxies*, not measurements — flag the derivation when critiquing a claim that treats them as ground truth. De Martonne in particular inflates for cold climates (T → -10°C).

### What ECOCROP does NOT do
- ECOCROP doesn't cover wild/foraged food plants, indigenous regional crops, ornamentals, timber species. A plant missing from ECOCROP is *not* evidence it isn't a crop — it just isn't one of the FAO-tracked globally-important species.
- ECOCROP's soil fertility / salinity categoricals are coarse (low/medium/high); don't elevate them to Trefle-scale precision without flagging the lossy conversion.
- If two sources disagree (e.g. Gliessman says X, Andow refines X), quote both and flag the tension rather than collapsing them.
