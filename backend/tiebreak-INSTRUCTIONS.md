# Tiebreak critic — self-routing instructions

You are running a TIEBREAK step in the AEDIN literature-ingestion pipeline (subscription mode — you ARE the critic; do NOT call any external API).

Background: every claim in your batch already got two verdicts — the **agroecologist** synthesizer said "plausible", but a second critic was **mis-routed** and returned out_of_scope/uncertain because it couldn't evaluate this claim's domain. You supply ONE correctly-routed specialist's second opinion.

Your INPUT and OUTPUT paths are given in the dispatch message.

The input JSON has:
- `critic_templates`: for each of 5 specialists (entomologist, plant-pathologist, soil-scientist, horticulturist, wildlife-ecologist) a `system_prompt` + `body_template` (with a `{{CLAIM}}` placeholder).
- `claims[]`: each has `staging_id`, `target_table`, `claim` (payload + source_quote), and `already_judged_by` (critics who already voted, e.g. ["agroecologist:plausible","horticulturist:out_of_scope"]).

For EACH claim:
1. Pick the ONE specialist who is the correct domain expert:
   - **entomologist** → arthropod pests/predators/parasitoids, insect biology, above-ground insect herbivory, entomopathogenic nematodes that kill INSECTS.
   - **plant-pathologist** → fungal/bacterial/viral/oomycete plant diseases, plant-parasitic nematodes on PLANTS.
   - **soil-scientist** → soil chemistry/biology, nutrient cycling, N-fixation, mycorrhizae, earthworms/soil fauna, cover-crop soil effects, soil structure.
   - **horticulturist** → crop trait values, spacing/canopy geometry, intercropping layout, days-to-harvest, climate/water needs.
   - **wildlife-ecologist** → birds/mammals/vertebrates as pests or service providers (pollination by vertebrates, seed dispersal, insectivory).
2. Do NOT pick a specialist listed in `already_judged_by` as `out_of_scope` (it already showed it can't judge this) — pick the genuinely correct one.
3. Adopt that specialist's `system_prompt` + `body_template` (substitute the claim's `claim` object, pretty-printed, into `{{CLAIM}}`). Apply its numbered Checks: direction not inverted; entity types fit the role; a confident SPECIES binomial must be supported by the source_quote (else implausible) — BUT unambiguous monotypic common names (e.g. "Japanese beetle"=Popillia japonica) are fine; stage-dependent roles. Judge HONESTLY — return implausible/uncertain/out_of_scope when warranted; do NOT default to plausible. Watch for extractor-fabricated objects (a crop/organism named in the structured claim but absent from the source_quote → implausible).
4. Produce ONE verdict record for the specialist you chose:
   `{"staging_id": <int>, "critic": "<chosenSpecialist>", "verdict": "plausible|implausible|uncertain|out_of_scope", "reasoning": "<one sentence ≤30 words, name the specialist you chose>", "model": "claude-code-subagent", "critic_confidence": <0.0-1.0>, "evidence_strength": "strong|moderate|weak|none"}`

Assemble ALL claims' records into a FLAT JSON array (one per claim), write valid JSON (no markdown fences) to the OUTPUT path, then re-read to confirm it parses and the record count equals the claim count.

Return ONLY one line: `<batch>: <N> records; plausible=<a> implausible=<b> uncertain=<c> out_of_scope=<d>`.
