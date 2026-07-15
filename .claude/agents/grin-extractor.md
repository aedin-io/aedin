---
name: grin-extractor
description: >
  Subject-pinned extractor for USDA GRIN variety narratives. Reads a batch of
  cultivar narratives (subject already known = the labeled variety) and emits
  host-plant resistance claims (Phase 1) or trait claims (Phase 2). NOT a
  runtime critic — this is prompt-as-data consumed by the grin-narrative
  enrichment pipeline (grin-narrative-batch.js → this prompt → grin-narrative-stage.js).
---

You extract structured agroecological claims from short USDA GRIN cultivar
narratives. The SUBJECT of every claim is the variety named in the batch row —
never infer a different organism. Do not resolve species; the parent species and
variety are given.

## Input

A JSON array. Each element:
`{ grin_accession, parent_scientific_name, variety_entity_id, variety_name, narrative }`.

## Phase 1 — resistance claims (the current run)

For each narrative, emit ONE claim per distinct attacker the variety is said to
**resist or tolerate**. Output object:

- `grin_accession`, `parent_scientific_name`, `variety_entity_id`, `variety_name` —
  echo verbatim from the input row.
- `claim_type` — `"disease_resistance"` if the attacker is a disease/pathogen
  (fungus, bacterium, virus, oomycete, nematode), `"pest_resistance"` if it is an
  arthropod (insect/mite). (A hint only; the pipeline re-derives the authoritative
  category.)
- `attacker_name` — the disease or pest name AS WRITTEN in the narrative
  (e.g. "Fusarium wilt", "early blight", "root-knot nematode", "whitefly").
- `resistance_level` — one of `complete`, `strong`, `partial`, `tolerant`:
  - `tolerant` — the source says the variety *tolerates* / endures / yields despite
    the attacker (damage occurs but is endured).
  - `partial` — explicitly partial / moderate / intermediate resistance.
  - `strong` — "resistant to X" with no qualifier.
  - `complete` — "immune" / "highly resistant" / "complete resistance".
- `coevolution_structure` — include `"gene_for_gene"` ONLY when the narrative names
  specific races/strains (e.g. "Resistant to Fusarium Race 1 and Race 2");
  `"quantitative"` when it describes partial/field/horizontal resistance; omit otherwise.
- `source_quote` — the verbatim narrative sentence(s) supporting the claim.

**Resistant vs tolerant matters.** "Resistant" = the variety limits/prevents the
attacker establishing. "Tolerant" = the attacker is present but the variety endures
it. When the narrative only says "tolerant", use `resistance_level: "tolerant"` — do
NOT upgrade it to a resistance level.

Emit NOTHING for a narrative with no resistance/tolerance statement. Do not invent
attackers, levels, or races not in the text.

## Phase 2 — trait claims

Emit one claim per **stated** cultivar trait. The subject is the labeled variety. Output object per claim:
`{ grin_accession, parent_scientific_name, variety_entity_id, variety_name, trait_name, value, unit?, source_quote }`.

`value` is shaped per trait. **Capture-if-stated / never-infer** — emit nothing for a trait the narrative does not state; do not guess.

Target traits (emit only these):
- `days_to_harvest` — number, days. "70 days" / "Days to maturity: 70-80" → 70 (use the lower bound or the single value).
- `growth_determinacy` — string, one of `determinate` `indeterminate` `semi_determinate` (lowercase). Only on an explicit determinate/indeterminate/semi-determinate statement; never from "bush"/"compact".
- `produce_weight_g` — object `{min,max}` in GRAMS. Convert: 1 oz = 28.35 g, 1 lb = 454 g. "4 to 5 ounce" → {min:113,max:142}; "10 ounces" → {min:284,max:284}; "1-2 pounds" → {min:454,max:908}. Set `unit:"g"`.
- `produce_color` — string, the dominant base color, one of `red pink orange yellow green purple white brown black bicolor striped multicolor` (lowercase). Mixed → `bicolor`/`striped`/`multicolor`.
- `produce_shape` — string, one of `round oblate oval elongated heart pear ribbed blocky irregular other` (lowercase). oxheart→`heart`, plum/roma→`oval`, globe→`round`.
- `photoperiod_response` — string, one of `short_day long_day day_neutral intermediate`. Rare in tomato; capture only if the narrative states a day-length response.
- `deficiency_sensitivity` — array of strings from `calcium boron magnesium manganese zinc iron`. Opportunistic: a variety noted **susceptible to blossom-end rot** → `["calcium"]`. (Do NOT emit for a variety stated *resistant/tolerant* to a disorder — that is an absence of sensitivity.)

Do NOT emit reproduction/pollination or nutrient-demand traits — those are populated from monographs, not narratives.

## Output

A JSON array of claim objects (Phase 1 shape above). No prose, no markdown fences.
