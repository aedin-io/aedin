// backend/lib/dedup-critic-prompts.js
'use strict';
// Routing + prompt composition for the entity-dedup review surface. Reuses the
// claim-router's taxon logic and the critic personas; asks a SAME-TAXON question
// (not plausibility). No DB access.
const { pickDomainCritic } = require('./critic-router');
const { loadCriticIdentity, CRITIC_MODEL_DEFAULT } = require('./critic-prompts');

/**
 * routeDedupCritic(a, b) -> criticName
 * Routes the pair to one specialty critic by its taxon. Uses the router's
 * entity_trait branch (bio_category-driven) since a dedup pair IS a taxon.
 * Falls back to the agroecologist (not horticulturist) for non-plant unknowns.
 */
function routeDedupCritic(a, b) {
  // route on the side with the richer taxon_path (more signal for the router)
  const e = String(a.taxon_path || '').length >= String(b.taxon_path || '').length ? a : b;
  const bio = String(e.bio_category || '').toLowerCase();
  const pseudo = { scientific_name: e.scientific_name, bio_category: e.bio_category, taxon_path: e.taxon_path, trait_name: '' };
  let critic = pickDomainCritic(pseudo, 'entity_trait');
  if (critic === 'horticulturist' && bio !== 'plantae') critic = 'agroecologist';
  return critic;
}

/**
 * composeDedupPrompt(criticName, pair) -> { name, systemPrompt, body, model }
 * Persona from the agent .md (via loadCriticIdentity); a same-taxon question;
 * the pair's disambiguating context; a 3-class JSON contract.
 */
function composeDedupPrompt(criticName, pair) {
  const id = loadCriticIdentity(criticName);
  const systemPrompt =
    `You are the ${id.name} critic resolving a taxonomic DEDUPLICATION question for AEDIN. ` +
    `Specialty: ${id.description} Return ONE JSON object, no markdown. ` +
    `Judge only from taxonomy + nomenclature knowledge and the two names; do not invent synonymy.`;
  const body = [
    `# Entity dedup — same taxon or distinct?`,
    ``,
    `Two entity rows may be the SAME taxon recorded twice (one a typo, or a nomenclatural / spelling variant of the other) or they may be DISTINCT species. Decide which.`,
    `CAUTION: meaningful-prefix epithets (micro-/macro-, brevi-/longi-, parvi-/grandi-, albi-/nigri-) look like one-letter typos but denote DISTINCT species. A shared gbif_key is decisive evidence of the SAME taxon.`,
    ``,
    `## Pair`,
    `A: #${pair.a_id} "${pair.a_name}" — gbif_key ${pair.a_gbif || 'none'}, taxon_path "${pair.a_path || ''}", ${pair.a_claims} claims`,
    `B: #${pair.b_id} "${pair.b_name}" — gbif_key ${pair.b_gbif || 'none'}, taxon_path "${pair.b_path || ''}", ${pair.b_claims} claims`,
    `Proposed canonical (survivor): #${pair.suggested_canonical_id}`,
    ``,
    `## Verdict`,
    `verdict ∈ { same | distinct | uncertain }`,
    `- same: one taxon (typo / nomenclatural variant). Safe to merge.`,
    `- distinct: different species; must NOT merge.`,
    `- uncertain: cannot tell from the names + taxonomy; needs a human.`,
    `suggested_canonical_id: which id should SURVIVE — prefer the served, correctly-spelled/accepted name. Null to accept the proposed canonical.`,
    ``,
    `Return ONE JSON object (no markdown, no preamble):`,
    `{"candidate_id":${pair.candidate_id},"critic":"${id.name}","verdict":"same|distinct|uncertain","confidence":<0.0-1.0>,"suggested_canonical_id":<id or null>,"reasoning":"one sentence (≤30 words)"}`,
  ].join('\n');
  return { name: id.name, systemPrompt, body, model: CRITIC_MODEL_DEFAULT };
}

module.exports = { routeDedupCritic, composeDedupPrompt };
