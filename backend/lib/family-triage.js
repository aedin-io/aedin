'use strict';
/**
 * family-triage.js — evidence generation for curated family-rank role rules.
 *
 * This module does NOT decide whether a family gets a rule. It surfaces the
 * evidence a domain critic needs, and raises one high-precision negative
 * signal: the family contains a genus we know is a biocontrol, mutualist, or
 * saprobe, so a blanket family rule would mislabel it.
 */

// Genera whose presence contaminates a family-rank role assertion.
// The genus NAME is the primary signal (cf. lib/phylum-validator.js) — used to
// RAISE a flag for review, never to auto-decide.
const CONTAMINANT_GENERA = new Map([
  // Saprobes / endophytes marketed or documented as biocontrol agents
  ['epicoccum',       { kind: 'biocontrol',     note: 'Saprobe used as a biocontrol agent; not a plant pathogen.' }],
  ['microsphaeropsis',{ kind: 'biocontrol',     note: 'M. ochracea is an apple-scab biocontrol; family is otherwise pathogenic.' }],

  // Mycoparasites — fungi that attack other fungi
  ['coniothyrium',    { kind: 'mycoparasite',   note: 'C. minitans parasitises Sclerotinia; named in the 2026-06-27 false-role incident.' }],
  ['clonostachys',    { kind: 'mycoparasite',   note: 'C. rosea (= Gliocladium roseum), a mycoparasitic biocontrol.' }],
  ['gliocladium',     { kind: 'mycoparasite',   note: 'Mycoparasitic biocontrol; named in the 2026-06-27 false-role incident.' }],
  ['trichoderma',     { kind: 'mycoparasite',   note: 'Mycoparasite and plant-growth promoter; the archetypal fungal biocontrol.' }],
  ['ampelomyces',     { kind: 'mycoparasite',   note: 'A. quisqualis parasitises powdery mildews.' }],

  // Entomopathogens — natural enemies of insects, not plant pathogens
  ['beauveria',       { kind: 'entomopathogen', note: 'B. bassiana, an insect-pathogenic biocontrol.' }],
  ['metarhizium',     { kind: 'entomopathogen', note: 'Insect-pathogenic biocontrol.' }],
  ['lecanicillium',   { kind: 'entomopathogen', note: 'Insect-pathogenic biocontrol (whitefly, aphid).' }],
  ['paecilomyces',    { kind: 'entomopathogen', note: 'Includes insect- and nematode-pathogenic biocontrols.' }],
  ['purpureocillium', { kind: 'entomopathogen', note: 'P. lilacinum, a nematode-egg parasite.' }],
  ['pochonia',        { kind: 'entomopathogen', note: 'P. chlamydosporia, a nematode-egg parasite.' }],
]);

/**
 * @param {string[]} genera - genus names present in the family
 * @returns {Array<{genus: string, kind: string, note: string}>}
 */
function flagContaminants(genera) {
  const hits = [];
  for (const genus of genera || []) {
    const hit = CONTAMINANT_GENERA.get(String(genus).trim().toLowerCase());
    if (hit) hits.push({ genus, kind: hit.kind, note: hit.note });
  }
  return hits;
}

/**
 * Assemble one review-packet entry for a candidate family.
 * Returns evidence and a routing verdict — never an assertion that a role IS
 * appropriate. Converting `needs_review` into a rule is a domain critic's job.
 *
 * @param {{family: string, entityCount: number, genera: Array<{genus: string, count: number}>}} candidate
 */
function triageFamily(candidate) {
  const { family, entityCount, genera } = candidate;
  const contaminants = flagContaminants((genera || []).map(g => g.genus));
  return {
    family,
    entityCount,
    genera: genera || [],
    contaminants,
    verdict: contaminants.length ? 'contaminated' : 'needs_review',
    // Always false. Triage produces evidence, never authority: no family
    // reaches role_rules without an explicit domain-critic verdict.
    autoApplyEligible: false,
  };
}

module.exports = { flagContaminants, triageFamily, CONTAMINANT_GENERA };
