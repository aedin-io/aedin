---
name: extractor
description: LLM-driven literature ingestion. Extracts atomic agroecological claims (interactions, crop vulnerabilities, biocontrol, crop traits) from research papers, extension bulletins, and books into structured JSON. NOT a runtime-invokable critic agent — this file is the prompt source-of-truth consumed by backend/extract-source.js. Update the schema or vocabulary here, not in JS. The script reads this file at runtime, replaces {{DOCUMENT}} with the source text, and ships the result to claude-sonnet-4-6.
tools: []
model: claude-sonnet-4-6
system_prompt: "You are an agroecology data extraction assistant. Extract structured data from agricultural research documents and extension publications. Return only valid JSON — no explanation, no markdown."
---

# Agroecology Atomic-Claim Extractor

Extract all agroecological data from the document at the end of this prompt. Return a single JSON object with exactly these eight top-level keys: `source_meta`, `interactions`, `crop_vulnerabilities`, `biocontrol`, `entity_traits`, `attractor_relationships`, `new_crops`, `crop_enrichment`.

## Naming convention (applies to every organism field)

All organism names MUST be scientific names (binomial Latin nomenclature, e.g. `Cucumis sativus` not `cucumber`, `Mangifera indica` not `mango`). Always include a separate `*_common_name` field for the common name.

### Species-resolution precedence (STRICT — follow in order)

When a claim refers to an organism by common name, resolve the scientific name in this exact priority order. **The document is always the highest authority — never override it with a species you happen to associate with the common name.**

1. **Document-explicit binomial wins.** Search the ENTIRE provided text for an explicit binomial (`Genus species`) that the document ties to this organism — even if it appears in a different sentence, paragraph, table, or section than the claim quote. If the document names the species anywhere (e.g. the abstract says "the melon fly *Bactrocera cucurbitae*" and a later line just says "melon fly"), you MUST use the document's species. Do not substitute a more familiar congener. **Use the "COMMON-NAME → SPECIES MAP" in the Document species glossary below as the document's own authoritative definitions** — match the claim's FULL common-name phrase (the modifier matters: "melon fly" ≠ "oriental fruit fly" ≠ "mango fruit fly", even though all are "fruit flies").

2. **When the common name is ambiguous, do NOT guess — drop to genus.** If multiple species in the document share the common name's head noun (e.g. several *Bactrocera*), or the COMMON-NAME → SPECIES MAP flags the name as AMBIGUOUS, resolve the SPECIFIC species ONLY if the claim's own local context fixes it (an adjacent binomial, or a host/symptom the document ties to one species). Otherwise emit `Genus sp.` (e.g. `Bactrocera sp.`). A confident guess between congeners is exactly the right-genus/wrong-species error we must avoid. The same applies when one common name spans different genera (e.g. "fruit fly" = Tephritidae or Drosophilidae) — fix the genus from context or stay at the level the evidence supports.

3. **Genus-only when the document is genus-only.** If the document gives only a genus or a common name that maps to a genus (and never names the species), emit `Genus sp.` — do NOT guess the species from your own knowledge. Right-genus/wrong-species is a worse error than honest genus-level.

4. **Family/genus collective is the DEFAULT when only a common name is present.** When the document refers to a taxon collectively (e.g. "ladybird beetles", "lacewings", "spider mites", "aphids", "brassicas") and provides no document-level binomial, emit at the highest unambiguous rank the **`common-names-collective.json`** allowlist resolves to: `Coccinellidae (family)`, `Chrysopidae (family)`, `Tetranychidae (family)`, `Aphididae (family)`, `Brassica spp.`, etc. Set `confidence_score ≤ 0.6` to mark the rank-coarser-than-species fallback. Do not over-specify; the family-level claim is *true*, a guessed-species claim is *often false*.

5. **FORBIDDEN — never guess a species from a common name using your own knowledge.** If the document gives no binomial and the common name is not in the curated `backend/lib/common-names-species.json` allowlist (the one-to-one unambiguous list, e.g. "European corn borer" → *Ostrinia nubilalis*) AND not in `common-names-collective.json` (the family/genus list), **DROP the claim** and emit the unresolved vernacular as a `common_name_unresolved` entry in `source_meta.notes` (one line: `unresolved_vernacular: "<name>" — <reason>`). Do NOT supply a species from training-data knowledge under any circumstance. The downstream `common_name_unresolved` log is for human curation to extend the allowlists.

   - **Allowlist semantics:** `common-names-species.json` entries (e.g. `{ "common": "diamondback moth", "scientific": "Plutella xylostella", "rank": "species" }`) are deterministic mappings — use them at full confidence. `common-names-collective.json` entries (e.g. `{ "common": "lacewing", "scientific": "Chrysopidae", "rank": "family" }`) are family/genus fallbacks — use them per step 4 with `confidence_score ≤ 0.6`.

**Rationale:** a common name in a claim quote is not authority for a species. The paper that wrote "fruit fly" almost always named the exact species elsewhere; your job is to find and use *that* species, not the one the common name evokes globally. When the document genuinely doesn't name the species, the right answer is **family/genus or drop** — *never* a confident guess. Right-genus/wrong-species is a worse downstream error than honest family-level (it corrupts the entity layer, the scoped BFS, and companion-planting outputs). The Pass-12 *Pseudomonas/Ralstonia* and Pass-13 *Mites→Acari* bug classes both originated in step-5-style guessing; this policy closes that window. (Original driver: a real Guam-document error where the resolver guessed instead of reading the document's own species mention.)

## JSON schema

### `source_meta`
```
{ "title", "authors", "publication", "year", "source_type", "region_focus", "crop_focus" }
```
- `authors`: a single string (e.g. "Wezel A., Casagrande M., Celette F., …"). Do **not** return as an array or object.
- `source_type` ∈ {`peer_reviewed`, `extension_bulletin`, `usda_report`, `fao_document`, `book`, `user_contributed`, `unknown`}.

### `interactions` (organism-to-organism relationships — crop↔crop, crop↔wild plant, animal↔plant, etc.)
Each item:
```
{ "subject_organism", "subject_common_name",
  "object_organism", "object_common_name",
  "subject_variety": "<optional cultivar name, e.g. Solar Fire — see guidance below>",
  "object_variety": "<optional cultivar name>",
  "interaction_type", "interaction_type_globi", "effect_direction", "mechanism",
  "confidence_score" (0.0-1.0), "evidence_tier",
  "extracted_claim", "source_quote" (under 15 words),
  "source_page", "effect_magnitude", "study_scale", "regional_context",
  "impact_class" (optional),
  "observed_absence" (optional boolean — see "Negative / absence results" below),
  "absence_basis" (optional — required when observed_absence is true),
  "coevolution_structure" (optional — host-pathogen claims only; see "Coevolution structure" below),
  "resistance_level" (optional — REQUIRED for disease_resistance / pest_resistance; one of: complete | strong | partial | tolerant) }
```
Examples: trap cropping, companion planting, allelopathy, alternative-host relationships, nurse plants.

If plant A serves as an alternative host for a pest of plant B, label this as `pest_pressure` (subject A enables pest pressure on object B) — `subject=A`, `object=B`, `effect=harmful`, `mechanism="alternative host for [pest name]"`. Do NOT use `facilitation` for this case — facilitation is reserved for **beneficial** indirect effects (shade, ground cover, nitrogen transfer, nurse-plant relationships). Mixing `facilitation` with `effect=harmful` is internally contradictory.

### `crop_vulnerabilities` (a pest or pathogen attacks a crop)
Each item:
```
{ "crop", "crop_common_name",
  "crop_variety": "<optional cultivar name, see guidance below>",
  "pest_scientific_name", "pest_common_name", "pest_organism_type",
  "impact_class", "damage_type", "interaction_type_globi", "affected_part", "season", "crop_growth_stage",
  "confidence_score" (0.0-1.0), "evidence_tier",
  "extracted_claim", "source_quote" (under 15 words),
  "source_page", "regional_context",
  "observed_absence" (optional boolean — see "Negative / absence results" below),
  "absence_basis" (optional — required when observed_absence is true),
  "coevolution_structure" (optional — pathogen claims only; see "Coevolution structure" below) }
```
Include EVERY crop-pest pair mentioned. If a pest attacks 8 crops, create 8 entries.

### Coevolution structure

For a host–pathogen (or host–parasite) claim, set `coevolution_structure` when the
source describes the resistance/virulence relationship. One of:

- `gene_for_gene` — race-specific resistance, R-gene/avirulence-gene matching,
  vertical resistance, boom-and-bust cycles, named physiological races. Non-durable;
  the prediction layer must NOT generalize such an interaction across cultivars or
  regions.
- `quantitative` — polygenic / horizontal / partial / field resistance; durable;
  no named races.
- `unknown` — host-pathogen claim but the source does not describe the structure.

Omit the field entirely for non-pathogen interactions. Set it only when the source
affirmatively describes the resistance type — do not infer from the pathogen's
taxonomy.

### Negative / absence results

Record a negative when the source explicitly reports that an expected interaction
did NOT occur — a resistant cultivar, a no-choice trial the herbivore/parasitoid
rejected, or a survey finding the organism absent. Emit the normal interaction
shape (in `interactions` or `crop_vulnerabilities`) with the TRUE relationship type
(e.g. `interaction_type="herbivory"` / `damage_type="pest_pressure"`), set
`effect_direction="neutral"`, `observed_absence=true`, and `absence_basis` to the
method:

- `no_choice_trial` — organism confined with the host and did not feed/oviposit/infect.
- `choice_trial` — given a choice, organism avoided this host.
- `field_survey_absent` — survey of the host/region did not detect the organism.
- `explicit_non_host` — source states the organism does not use this host.
- `resistance_screen` — cultivar/accession screened and found resistant/non-susceptible.

Do NOT invent absences from silence — only when the source affirmatively states the
non-occurrence. These become negative training signal for predictive inference
(downstream they are stored with `applied_weight=0` and never served as positive
interactions).

### Host-plant resistance (`disease_resistance` / `pest_resistance`)

When a source states a crop or cultivar **resists** an attacker, emit an `interactions` claim:
- `subject_organism` = the host (crop/variety); `object_organism` = the attacker.
- `interaction_type` = `disease_resistance` if the attacker is a **pathogen** (fungus, bacterium, virus, **nematode**, parasitic plant); `pest_resistance` if it is an **arthropod** (insect, mite).
- `effect_direction` = `beneficial` (resistance protects the host).
- `resistance_level`: `tolerant` = endures / yields despite the attack; `strong` or `complete` = limits / prevents it; `partial` = intermediate. Distinguish **resistant** ("resistant to X") from **tolerant** ("tolerance to X") — do not upgrade tolerance to resistance.
- Use the attacker's name as given; the pipeline resolves it (and abstains on unknowns) — do not invent a pathogen/pest binomial.

### `biocontrol` (natural enemy / beneficial organism relationships)
Each item:
```
{ "beneficial_organism", "beneficial_common_name",
  "target_pest", "target_pest_common_name",
  "target_pest_variety": "<optional; rare in practice, only when source specifies a host cultivar>",
  "control_type", "interaction_type_globi", "mechanism", "impact_class",
  "confidence_score" (0.0-1.0), "evidence_tier",
  "extracted_claim", "source_quote" (under 15 words),
  "source_page", "regional_context" }
```
- `control_type` ∈ {`predation`, `parasitoidism`, `pathogen_of_pest`, `antagonism`}.
  - `antagonism` = direct chemical/competitive suppression of the pest/pathogen (a plant's named allelochemical/phytotoxin; a microbe's antibiosis or siderophore/nutrient competition). The mechanism MUST be explicitly stated in the source — never assumed.

Include ALL natural enemies, predators, parasitoids mentioned in the document.

**Agent boundary (direct vs indirect).** A plant or microbe is a biocontrol `beneficial_organism` ONLY when it acts DIRECTLY on the pest/pathogen — predation, parasitoidism, infection, or a specifically-named `antagonism` mechanism. A plant that merely SUPPORTS natural enemies (nectar, refuge, banker/beetle-bank, insectary strip, alternative prey, habitat) is NOT a biocontrol agent — emit it in `attractor_relationships` (`nectar_provision` / `provides_refuge` / `attracts_natural_enemy`) instead.
  - WRONG (do not emit as biocontrol): "buckwheat strip provides nectar to a parasitoid" → that is `nectar_provision` in `attractor_relationships`.
  - WRONG: "beetle bank from which natural enemies emerge" → that is `provides_refuge`.

**Target boundary.** `target_pest` is ALWAYS the pest/pathogen controlled, NEVER the protected crop. If the source says an agent "suppresses diseases of [crop]" without naming the pathogen: name it if inferable (e.g. "fire blight" → Erwinia amylovora). If it resolves only to a generic, unidentifiable target ("diseases", "natural enemies", "predatory arthropods"), SKIP the claim entirely — do NOT emit a collective/placeholder node, and never point the edge at the crop.

### `entity_traits` (organism-level traits — applies to any bio_category)

Each item:
```
{ "scientific_name", "common_name",
  "variety_name": "<optional; if the trait reading is specific to a named cultivar, e.g. Solar Fire, of the species in scientific_name>",
  "trait_name",                 // MUST be in traits_vocabulary below
  "value_numeric"|"value_text"|"value_json",  // pick one matching value_kind
  "unit",                        // canonical, MUST match expected_unit
  "regional_context",
  "confidence_score" (0.0-1.0),
  "evidence_tier",
  "extracted_claim",
  "source_quote" (under 15 words),
  "source_page",
  "notes" }
```

Constraints:
- `trait_name` MUST exist in the trait vocabulary table (below).
- Exactly one of `value_numeric|value_text|value_json` filled, matching the trait's `value_kind`.
- `value_kind=numeric` → `value_numeric` is a JSON number.
- `value_kind=categorical` → `value_text` is one of the trait's `enum_values`.
- `value_kind=boolean` → `value_text` is `"true"` or `"false"`.
- `value_kind=range` → `value_json` is `{"min": <num>, "max": <num>}`.
- `value_kind=list` → `value_json` is a JSON array of strings or numbers.
- `unit` must equal the trait's `expected_unit` exactly (canonicalize: convert °F → °C, in → cm, etc.).
- Use `regional_context="Global"` if the document does not scope the trait reading.

### Trait vocabulary

{{TRAITS_VOCABULARY}}

(This table is generated from the database at extraction time — do not invent trait_names not listed here. If you encounter a literature-supported trait not in the table, leave it out and note it in source_meta.notes.)

### `attractor_relationships` (plant supports a beneficial OR protects a main crop via deflection)

Each item:
```
{ "subject_organism", "subject_common_name",     // the supporting / deflecting plant (or alt-prey species)
  "object_organism", "object_common_name",       // the beneficial OR the protected main crop (see object semantics below)
  "subject_variety": "<optional cultivar name>",
  "object_variety": "<optional cultivar name>",
  "interaction_category",                          // one of: attracts_natural_enemy, nectar_provision,
                                                   // pollen_provision, provides_alternative_prey,
                                                   // provides_refuge, provides_oviposition_site,
                                                   // trap_cropping, banker_planting, barrier_planting
  "interaction_type_globi",                        // canonical GloBI predicate
  "impact_class",                                  // low | moderate | high | null
  "mechanism",                                     // for trap_cropping/banker_planting/barrier_planting: name the deflected/managed pest binomial (e.g. "deflects Plutella xylostella")
  "confidence_score" (0.0-1.0),
  "evidence_tier",
  "extracted_claim",
  "source_quote" (under 15 words),
  "source_page",
  "regional_context" }
```

These map to `claims` rows with `interaction_category` from this set. **`subject` is always the supporting/deflecting plant.** `object` semantics depend on category:
- `attracts_natural_enemy`, `nectar_provision`, `pollen_provision`, `provides_alternative_prey`, `provides_refuge`, `provides_oviposition_site` → `object` = the **beneficial** (natural enemy supported).
  - **Skip generic beneficials.** If the supported beneficial resolves only to an unidentifiable functional guild ("natural enemies", "predatory arthropods", "beneficial insects", "Parasitoidea") or a rank coarser than family, SKIP the claim — do NOT emit a collective/placeholder node. An identifiable taxon (family or finer) is required; a functionally-coherent group is acceptable only when every member shares the role (e.g. Araneae — all spiders are predators), never a mixed group (e.g. Coleoptera, Hymenoptera).
- `trap_cropping`, `banker_planting`, `barrier_planting` → `object` = the **protected main crop**; name the pest in `mechanism`.
  - `trap_cropping`: sacrificial/decoy plant that lures pests away from the main crop (e.g. mustard for diamondback moth, nasturtium for aphids on brassicas).
  - `banker_planting`: plant maintained alongside the main crop to sustain natural enemies via alt-prey/nectar/refuge over time (e.g. cereal banker plants supplying aphid alt-prey to parasitoids).
  - `barrier_planting`: plant forming a physical/visual/olfactory barrier slowing pest arrival at the main crop (e.g. tall grass strips against flying aphids).

### Interaction vocabulary (extends the table at the top of this prompt)

{{INTERACTION_VOCABULARY}}

### `new_crops` (crop scientific names mentioned that are not common-knowledge staples)
Each item: `{ "scientific_name", "common_name", "region_context" }`.

### `crop_enrichment` (botanical/agronomic data found for any crop, new or existing)

**Deprecated as of 2026-05-07.** New extractions should emit `entity_traits` (which is more general). `crop_enrichment` is retained for backward-compat with in-flight stagings; no new fields will be added here.

Each item:
```
{ "scientific_name", "common_name", "region_context",
  "nitrogen_fixation", "ph_min", "ph_max", "min_root_depth_cm",
  "soil_texture", "soil_humidity", "soil_nutriments",
  "min_temp_c", "max_temp_c", "growth_rate", "growth_habit",
  "days_to_harvest", "native_zones", "introduced_zones", "notes" }
```
Only include fields the document actually mentions — omit the rest entirely.

## Vocabulary constraints

- `interaction_type` ∈ {`facilitation`, `mutualism`, `pollination`, `biocontrol`, `herbivory`, `pest_pressure`, `pathogen_pressure`, `parasitism`}
  - `facilitation` = **beneficial** indirect effect — one organism helps another (companion planting, shade, ground cover, nitrogen transfer, nurse plants). Always paired with `effect=beneficial`. NEVER use with `effect=harmful` — for harmful indirect effects use `pest_pressure` or `pathogen_pressure`.
  - `mutualism` = mutual benefit (mycorrhizal networks, nitrogen-fixation partnerships)
  - `pollination` = pollinator interactions
  - `biocontrol` = biological pest/pathogen control (predation, parasitoidism of pests)
  - `herbivory` = direct plant feeding damage (insect feeding, browsing)
  - `pest_pressure` = pest attacking a crop, OR an organism that enables pest pressure on another (alternative host, vector amplifier, refuge habitat for pests)
  - `pathogen_pressure` = disease/pathogen attacking a crop, OR an organism that enables pathogen spread to another (alternative host for pathogen, vector)
  - `disease_vector` = an organism that TRANSMITS a pathogen (subject = the vector, e.g. aphid/whitefly/leafhopper/thrips/nematode; object = the pathogen it carries, e.g. a named virus/bacterium). Use this — NOT `pathogen_pressure`/`pest_pressure` — whenever the relationship is vectoring/transmission. Set `interaction_type_globi='vectorOf'`.
  - `parasitism` = parasitic relationship
- `damage_type` ∈ {`pest_pressure`, `pathogen_pressure`, `herbivory`}
- `impact_class` ∈ {`low`, `moderate`, `high`} (nullable when source doesn't specify)
- `effect_direction` ∈ {`beneficial`, `harmful`, `neutral`, `context_dependent`}
- `evidence_tier` ∈ {`direct`, `inferred`, `observational`}

## Source fidelity & sanity checks (mandatory — run on every claim before emitting)

These target the most common extraction errors found in review (58% of rejected claims were extraction errors, concentrated in the patterns below). Apply ALL of them to EVERY claim.

**1. Source fidelity — every categorical field must be supported by the source.**
`interaction_type`, `effect_direction`, `growth_habit`, `impact_class`, `damage_type`, and every other categorical field MUST be directly supported by the `source_quote` (or, for cross-chunk facts, the document). If the quote is neutral toward a value or contradicts it, do NOT emit that value — drop the field, lower `confidence_score`, or pick the value the quote actually supports. Do NOT over-specify a `mechanism` beyond what the source states (e.g. if the source says "improves soil phosphorus availability", do not assert "solubilizing soil *organic* phosphorus").

**2. Pest-reducing language is NEVER `pest_pressure` / `harmful`.**
"sink", "trap", "lures away", "reservoir for predators", "suppresses", "deters", "reduces" describe a plant that PROTECTS a crop, not one that harms it. A plant acting as a sink/trap for a pest is `trap_cropping` (in `attractor_relationships`; `object` = the protected crop; effect beneficial) — never `pest_pressure` with `effect=harmful`. *(Prior error: "Panicum maximum as a sink for Chilo partellus" coded as Panicum causing pest pressure.)*

**3. Trophic direction sanity check.**
In `herbivory` / `pest_pressure`, the `subject` is the consumer/pest and the `object` is the plant/crop that is HARMED (`effect_direction=harmful`). A plant DEFENDING against herbivores is the inverse — not a `herbivory` claim with the plant as subject. If you are coding `subject=Plantae / object=Insecta / interaction_type=herbivory`, the direction is backwards — re-read. *(Prior error: "secondary metabolites are the plants' defence against insects" coded as plants doing herbivory to insects.)*

**4. Don't force ill-fitting relationships into the enum.**
If a relationship fits no `interaction_type` value, do NOT mislabel it to the nearest one — drop the claim and record `unmapped_relationship: "<short description>"` in `source_meta.notes`. A broad ecosystem / soil-structure effect with NO specific crop named as harmed is NOT a crop `pest_pressure` claim. *(Prior error: "earthworms reduced forest litter layer" coded as `pest_pressure` on Poaceae.)*

**5. Entity-type gate for crop / pest fields.**
A `crop` field (and `crops` / `new_crops` entries) MUST be a plant (or a fungus/alga cultivated as a crop). Do NOT place animals, microbes, wild non-crop organisms, or ecosystem abstractions in a crop field. The `object` of a `pest_pressure` / `herbivory` claim MUST be a named or strongly-implied crop/plant. If the organism is not a plausible crop/plant, drop the claim or re-target it to the correct array. *(Prior error: a cultivated cucurbit labeled `growth_habit="invasive vine"`; wetland macrophytes / fungi placed in the crops table.)*

## Cultivar vs taxonomic rank

A **cultivar** is a horticultural designation (selected, named lineage within a species). A **botanical variety** (`var.`) or **subspecies** (`subsp.`) is a TAXONOMIC RANK — keep these in `scientific_name`, NOT in the `*_variety` fields.

Rules:

- If the source writes `Brassica oleracea var. capitata` → keep the full string in `scientific_name`. This is cabbage as a taxon, NOT a cultivar.
- If the source writes `Solanum lycopersicum 'Solar Fire'`, `tomato cv. Solar Fire`, or `tomato variety Solar Fire` → put `Solanum lycopersicum` in `scientific_name` and `Solar Fire` (without surrounding quotes) in the appropriate `*_variety` field.
- If unsure whether the source means a cultivar or a botanical rank, default to keeping it in `scientific_name` (no false-positive variety entities).
- Variety names should preserve the source's casing (e.g. "Solar Fire", not "solar fire") — name normalization happens at storage time.

Example interaction with a cultivar:

```json
{
  "subject_organism": "Tuta absoluta",
  "subject_common_name": "tomato leafminer",
  "object_organism": "Solanum lycopersicum",
  "object_common_name": "tomato",
  "object_variety": "Solar Fire",
  "interaction_category": "pest_pressure",
  "effect_direction": "harmful",
  "impact_class": "moderate",
  "source_quote": "Solar Fire showed susceptibility to T. absoluta",
  "source_page": 14
}
```

## Worked examples

The 10 examples below span the main interaction categories. Each shows the exact JSON the extractor should emit for one claim. Fields present here are required when the information is available in the source document; optional fields may be omitted when the source does not supply them.

### Example 1 — pollination (interactions array)

```json
{
  "subject_organism": "Bombus terrestris",
  "subject_common_name": "buff-tailed bumblebee",
  "object_organism": "Borago officinalis",
  "object_common_name": "borage",
  "interaction_type": "pollination",
  "interaction_type_globi": "pollinates",
  "effect_direction": "beneficial",
  "mechanism": "pollen foraging by colony workers adjacent to borage field",
  "confidence_score": 0.9,
  "evidence_tier": "direct",
  "extracted_claim": "Bombus terrestris pollinates Borago officinalis; 63% of pollen foragers collected borage pollen",
  "source_quote": "Sixty-three per cent of pollen foragers collected borage pollen",
  "source_page": 93,
  "effect_magnitude": null,
  "study_scale": "field",
  "regional_context": "Global"
}
```

### Example 2 — herbivory (interactions array)

```json
{
  "subject_organism": "Aulacophora indica",
  "subject_common_name": "red pumpkin beetle",
  "object_organism": "Cucumis sativus",
  "object_common_name": "cucumber",
  "interaction_type": "herbivory",
  "interaction_type_globi": "eats",
  "effect_direction": "harmful",
  "mechanism": "adult feeding on foliage and fruit; larval root feeding",
  "confidence_score": 0.95,
  "evidence_tier": "direct",
  "extracted_claim": "Aulacophora indica is a major insect pest of cucurbit crops including cucumber",
  "source_quote": "major insect pest of cucurbit crops, which include cucumber",
  "source_page": 1,
  "impact_class": "high",
  "effect_magnitude": null,
  "study_scale": "field",
  "regional_context": "Guam"
}
```

### Example 3 — pathogen_pressure (interactions array)

```json
{
  "subject_organism": "Rhizoctonia cerealis",
  "subject_common_name": "sharp eyespot fungus",
  "object_organism": "Triticum aestivum",
  "object_common_name": "winter wheat",
  "interaction_type": "pathogen_pressure",
  "interaction_type_globi": "pathogenOf",
  "effect_direction": "harmful",
  "mechanism": "soilborne fungal infection of stem base causing sharp eyespot lesions",
  "confidence_score": 0.88,
  "evidence_tier": "direct",
  "extracted_claim": "Cropping system influences sharp eyespot incidence in winter wheat caused by Rhizoctonia cerealis",
  "source_quote": "influence of cropping system on sharp eyespot in winter wheat",
  "source_page": 10,
  "impact_class": "moderate",
  "effect_magnitude": null,
  "study_scale": "field",
  "regional_context": "Global"
}
```

### Example 4 — pest_pressure with crop_variety (crop_vulnerabilities array)

```json
{
  "crop": "Solanum lycopersicum",
  "crop_common_name": "tomato",
  "crop_variety": "Solar Fire",
  "pest_scientific_name": "Tuta absoluta",
  "pest_common_name": "tomato leafminer",
  "pest_organism_type": "invertebrate",
  "impact_class": "moderate",
  "damage_type": "pest_pressure",
  "interaction_type_globi": "eats",
  "affected_part": "leaf",
  "season": null,
  "crop_growth_stage": null,
  "confidence_score": 0.82,
  "evidence_tier": "direct",
  "extracted_claim": "Tomato cultivar Solar Fire showed susceptibility to leafminer Tuta absoluta under greenhouse conditions",
  "source_quote": "Solar Fire showed susceptibility to T. absoluta",
  "source_page": 14,
  "regional_context": "Global"
}
```

### Example 5 — pest_pressure from cover crops (interactions array)

```json
{
  "subject_organism": "Gastropoda (order)",
  "subject_common_name": "snails and slugs",
  "object_organism": "cover crops (general)",
  "object_common_name": "cover crops",
  "interaction_type": "pest_pressure",
  "interaction_type_globi": "eats",
  "effect_direction": "harmful",
  "mechanism": "cover crop surface moisture and residue provide shelter and food for gastropod pests",
  "confidence_score": 0.75,
  "evidence_tier": "observational",
  "extracted_claim": "Snail populations increase under cover crops, raising pest risk for subsequent cash crops",
  "source_quote": "risk of pest development, e.g. snails under cover crops",
  "source_page": 9,
  "impact_class": "moderate",
  "effect_magnitude": null,
  "study_scale": "field",
  "regional_context": "Global"
}
```

### Example 6 — biocontrol / predation (biocontrol array)

```json
{
  "beneficial_organism": "Argiope appensa",
  "beneficial_common_name": "banded garden spider",
  "target_pest": "Aulacophora indica",
  "target_pest_common_name": "red pumpkin beetle",
  "control_type": "predation",
  "interaction_type_globi": "preysOn",
  "mechanism": "web-based predation of adult beetles in cucurbit fields",
  "impact_class": "low",
  "confidence_score": 0.72,
  "evidence_tier": "observational",
  "extracted_claim": "Argiope appensa spiders prey on Aulacophora indica in cucurbit fields in Guam",
  "source_quote": "Argiope appensa … have been found to predate on this pest in Guam",
  "source_page": 4,
  "regional_context": "Guam"
}
```

### Example 7 — parasitism (interactions array)

```json
{
  "subject_organism": "Psithyrus spp.",
  "subject_common_name": "cuckoo bumblebees",
  "object_organism": "Bombus spp.",
  "object_common_name": "bumblebees",
  "interaction_type": "parasitism",
  "interaction_type_globi": "parasiteOf",
  "effect_direction": "harmful",
  "mechanism": "social parasitism: cuckoo bee invades host nest, kills queen, exploits workers",
  "confidence_score": 0.93,
  "evidence_tier": "direct",
  "extracted_claim": "Psithyrus spp. are obligate social parasites of Bombus spp., killing the host queen and usurping her workers",
  "source_quote": "they enter the nest, kill the queen, and take over her role",
  "source_page": 12,
  "effect_magnitude": null,
  "study_scale": "colony",
  "regional_context": "Global"
}
```

### Example 8 — facilitation / nitrogen transfer (interactions array)

```json
{
  "subject_organism": "Leguminosae (family)",
  "subject_common_name": "legumes",
  "object_organism": "Triticum aestivum",
  "object_common_name": "winter wheat",
  "interaction_type": "facilitation",
  "interaction_type_globi": "interactsWith",
  "effect_direction": "beneficial",
  "mechanism": "biological nitrogen fixation by legume root symbionts reduces fertilizer requirement for following wheat crop",
  "confidence_score": 0.9,
  "evidence_tier": "direct",
  "extracted_claim": "Integrating legumes into crop rotation supplies atmospheric nitrogen for subsequent wheat crops",
  "source_quote": "integration of leguminous plants into the rotation allows fixing atmospheric nitrogen",
  "source_page": 10,
  "impact_class": "high",
  "effect_magnitude": null,
  "study_scale": "field",
  "regional_context": "Global"
}
```

### Example 9 — mycorrhizal mutualism (interactions array)

```json
{
  "subject_organism": "Rhizophagus irregularis",
  "subject_common_name": "arbuscular mycorrhizal fungus",
  "object_organism": "Zea mays",
  "object_common_name": "maize",
  "interaction_type": "mutualism",
  "interaction_type_globi": "hasArbuscularMycorrhizalHost",
  "effect_direction": "beneficial",
  "mechanism": "AM fungal hyphae extend root phosphorus uptake zone in low-P soils",
  "confidence_score": 0.87,
  "evidence_tier": "direct",
  "extracted_claim": "Rhizophagus irregularis colonises maize roots and improves phosphorus acquisition under low-phosphorus conditions",
  "source_quote": "mycorrhizal colonisation significantly increased P uptake in maize",
  "source_page": 22,
  "impact_class": "moderate",
  "effect_magnitude": null,
  "study_scale": "greenhouse",
  "regional_context": "Global"
}
```

### Example 10 — biocontrol / parasitoidism with target_pest_variety (biocontrol array)

```json
{
  "beneficial_organism": "Cotesia glomerata",
  "beneficial_common_name": "cabbage white parasitoid wasp",
  "target_pest": "Pieris brassicae",
  "target_pest_common_name": "large white butterfly",
  "target_pest_variety": null,
  "control_type": "parasitoidism",
  "interaction_type_globi": "parasitoidOf",
  "mechanism": "female wasp oviposits into young Pieris caterpillars; larvae consume host internally",
  "impact_class": "high",
  "confidence_score": 0.91,
  "evidence_tier": "direct",
  "extracted_claim": "Cotesia glomerata is a gregarious larval parasitoid of Pieris brassicae, providing substantial biocontrol in brassica crops",
  "source_quote": "Cotesia glomerata parasitises Pieris brassicae larvae at rates exceeding 80%",
  "source_page": 37,
  "regional_context": "Global"
}
```

## GloBI interaction-type alignment

`interaction_type_globi` MUST be one of the **GloBI Relations Ontology** terms below. This field aligns our claims with the Global Biotic Interactions standard, enabling our verified data to be pushed back to GloBI. Always pick the most specific applicable term; use `interactsWith` only when no more specific term fits. Consider direction — pick the term where the **subject** is doing the action.

**Trophic / consumption**:
- `eats` — subject consumes object (most herbivory, granivory, omnivory; default for `pest_pressure` and `herbivory` claims)
- `preysOn` — subject is a predator hunting and killing object (use for predator–prey claims; most "biocontrol via predation")
- `pollinates` — subject is a pollinator transferring pollen to object plant
- `visitsFlowersOf` — subject visits flowers but pollination not confirmed (use only when source is explicit about non-pollinator flower visiting)

**Host / parasitism**:
- `parasiteOf` — subject is a parasite living on/in object (general parasitism)
- `parasitoidOf` — subject is a parasitoid (lays eggs in/on object, larva consumes host; e.g. parasitic wasps; use for "biocontrol via parasitoidism")
- `pathogenOf` — subject causes disease in object (use for `pathogen_pressure` claims, microbe/fungus/virus → plant; also "biocontrol via pathogen of pest" e.g. baculoviruses on caterpillars)
- `hasHost` — subject has the object as a host (inverse of `parasiteOf`/`pathogenOf` when natural)
- `endoparasiteOf` / `ectoparasiteOf` — internal vs external parasite, when source explicit

**Mycorrhizal / root associations**:
- `hasArbuscularMycorrhizalHost` — subject is an AM fungus, object is its host plant
- `arbuscularMycorrhizalHostOf` — inverse (plant subject, fungal object)
- `hasEctomycorrhizalHost` / `ectomycorrhizalHostOf` — for ectomycorrhizal pairs

**Mutualism / facilitation**:
- `mutualistOf` — symmetric mutualism (use for general `mutualism` claims when no more specific term fits)
- `interactsWith` — generic fallback when no specific term fits (use sparingly; prefer the table below)

**Vector / dispersal**:
- `vectorOf` — subject is a disease vector for object pathogen
- When `interaction_type_globi` is `vectorOf`, the `interaction_category` MUST be `disease_vector` (subject = vector, object = pathogen) — never `pathogen_pressure`/`pest_pressure`.
- `hasVector` — inverse
- `dispersalVectorOf` — subject disperses object's seeds/spores
- `hasDispersalVector` — inverse

**Mapping shortcut from our `interaction_type` enum** (use these defaults when the source quote doesn't disambiguate further):

| If `interaction_type` is | Default `interaction_type_globi` | Refine to                                      |
|--------------------------|----------------------------------|------------------------------------------------|
| `pollination`            | `pollinates`                     | `visitsFlowersOf` if non-pollinator visit only |
| `pest_pressure`          | `eats`                           | `damages` is NOT a GloBI term — use `eats`     |
| `herbivory`              | `eats`                           | (same)                                         |
| `pathogen_pressure`      | `pathogenOf`                     | `vectorOf` if subject is the vector            |
| `biocontrol` (predation) | `preysOn`                        |                                                |
| `biocontrol` (parasitoid)| `parasitoidOf`                   |                                                |
| `biocontrol` (pathogen)  | `pathogenOf`                     |                                                |
| `parasitism`             | `parasiteOf`                     | `endoparasiteOf` / `ectoparasiteOf` if known   |
| `mutualism`              | `mutualistOf`                    | `hasArbuscularMycorrhizalHost` for AM fungi    |
| `facilitation`           | `interactsWith`                  | (no specific GloBI term for plant facilitation)|

When in doubt, prefer the more general term over an inaccurate specific one. The `interaction_type` enum (our coarse bucket) and `interaction_type_globi` (the formal ontology term) are both required — they serve different consumers.

## Regional context

`regional_context` and `region_context` must be a standard country name or US state/territory name (e.g. `Guam`, `Hawaii`, `United States`, `Kenya`, `Australia`, `Brazil`). Use the most specific applicable region — prefer `Guam` over `United States` if the study was conducted in Guam. If the document does not mention a specific region, use `Global`.

## Correction lessons learned from prior extractions

The following patterns were extracted incorrectly in past runs and corrected by human reviewers. Apply the corrected interpretation when you encounter similar shapes in the document below.

{{CORRECTION_LESSONS}}

## Document species glossary

These are the scientific binomials detected in the FULL source document (not just the excerpt below). Per the species-resolution precedence rules, when a claim refers to an organism by common name, prefer the matching species from THIS list over any species you would otherwise guess — the document is authoritative. If a common name plausibly matches one of these, use it. (This glossary spans the whole document, so it may name a species that appears only in a section not included in the excerpt below — that species is still authoritative for this document.)

{{BINOMIAL_GLOSSARY}}

{{CANDIDATE_ENTITIES}}
## Document

{{DOCUMENT}}
