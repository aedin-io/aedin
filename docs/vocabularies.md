# AEDIN Controlled Vocabularies

Canonical enumeration of the controlled-value sets used across the AEDIN data layer. When adding values, update **both this doc AND the relevant source-of-truth file** (extractor prompt, role engine, etc.) — the doc is the authority for cross-cutting decisions; the source-of-truth files are what the runtime reads.

## `claims.interaction_category`

The category of an extracted agroecological relationship. Used by both LLM literature extraction (`tier1_paper`) and the scoped GloBI loader (`tier2_globi`).

### Core ecological categories
- `herbivory` — animal consumes plant tissue
- `pest_pressure` — pest causes economic-level damage to a crop
- `pathogen_pressure` — pathogen causes disease in a crop
- `parasitism` — parasite exploits host (animal↔animal or animal↔plant)
- `pollination` — pollinator transfers pollen
- `flower_visitor` — visits flowers without confirmed pollination
- `mutualism` — mutual benefit (mycorrhizal, N-fixation partnerships, etc.)
- `mycorrhizal` — fungal–root mutualism (subset of mutualism, kept separate for query convenience)
- `facilitation` — indirect beneficial effect (nurse plants, shade, ground cover)
- `allelopathy` — chemical interference between plants
- `biocontrol` — natural-enemy suppression of pest/pathogen (predation, parasitoidism, antagonism)
- `disease_vector` — organism transmits a pathogen to a host

### Plant-supports-beneficial (attractor set)
`subject` = supporting plant or alt-prey; `object` = the beneficial.
- `attracts_natural_enemy`
- `nectar_provision`
- `pollen_provision`
- `provides_alternative_prey`
- `provides_refuge`
- `provides_oviposition_site`

### Plant-protects-main-crop (IPM relational set — NEW 2026-05-30)
`subject` = deflecting/supporting plant; `object` = the **protected main crop**; deflected pest named in `claims.mechanism` (e.g. `"deflects Plutella xylostella"`).
- `trap_cropping` — sacrificial/decoy plant lures pest away from the main crop (mustard for diamondback moth; nasturtium for aphids on brassicas; sunflower for stinkbug in soybean)
- `banker_planting` — plant maintained alongside the main crop to sustain natural enemies via alt-prey/nectar/refuge over time
- `barrier_planting` — physical/visual/olfactory barrier slowing pest arrival at the main crop

Rationale for this layer: trap-cropping is a relational fact (it depends on the specific crop + pest context), so its primary home is on the claim edge, not the entity node. The `agroeco_functions` set below adds the complementary node-level "capability" tag.

## `claims.chain_role` (scoped BFS only)

Set by `backend/load-globi-scoped.js` for `data_tier='tier2_globi'` claims:
- `crop_interaction` — direct edge from a crop (tier 0 → tier 1)
- `biocontrol` — antagonist of a tier-1 pest (tier 1 → tier 2)
- `attractant` — plant supporting a tier-2 biocontrol agent (tier 2 → tier 3)

(`trap_cropping` is *not* a `chain_role`; it's an `interaction_category` orthogonal to the BFS structure.)

## `entities.agroeco_functions` (capability tags)

Comma-separated list of standardized IPM/regenerative-ag functions a species **commonly** performs. This is a species-level capability tag — distinct from per-relationship claims, and not a substitute for them. A plant carrying `trap_crop` in `agroeco_functions` is "known to be useful as a trap crop"; the *applied* trap-cropping relationship for a specific main crop + pest still lives in `claims`.

- `trap_crop` — commonly used as a trap crop
- `banker_plant` — commonly used as a banker plant
- `cover_crop` — soil cover / erosion control
- `barrier_crop` — used as a physical/visual/olfactory barrier
- `nurse_crop` — sown to support establishment of a slower-growing main crop
- `green_manure` — grown for incorporation as soil amendment
- `living_mulch` — grown alongside main crop for ground cover

## `entities.primary_role`

Single-value classification of an entity's principal agroecological role:
- `crop` — cultivated for harvest
- `pest_insect`, `pest_mite`, `pest_nematode`, `pest_vertebrate` — arthropod/nematode/vertebrate pest
- `pathogen` — disease-causing microbe / fungus / virus
- `biocontrol` — natural-enemy agent
- `pollinator` — pollinating species
- `weed` — competing volunteer plant
- `soil_organism` — non-pathogenic soil microbe / invertebrate
- `wild_relative` — botanical relative of a crop (genetic-resources context)

## Sources of truth

| Vocabulary | Source-of-truth file |
|---|---|
| `interaction_category` | `.claude/agents/extractor.md` (LLM extraction); `lib/role-engine.js` + `load-globi-claims.js` legacy rules (GloBI mapping) |
| `chain_role` | `backend/load-globi-scoped.js` |
| `agroeco_functions` | this doc + extractor schema (when added) |
| `primary_role` | `lib/role-engine.js`, `lib/organism-type.js` |
| trait_name | `traits_vocabulary` SQLite table + `lib/traits-vocabulary-seed.js` |

Changes here are non-breaking by default — adding values is backward-compatible because the data layer treats unknown values as opaque strings. Renaming or removing values is breaking and requires a migration.
