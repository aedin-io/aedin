'use strict';

/**
 * agroeco-bucket — canonical 7-bucket agroecological functional classification
 * stacked on top of entities.primary_role.
 *
 * The /atlas page uses this as the second of three combinable filter axes
 * (bio_category × agroeco_bucket × primary_role). The buckets are coarser
 * than primary_role and map to long-standing agroecology categories:
 *
 *   producer    — autotrophs / fixers of energy into the system
 *   herbivore   — direct plant-feeders (the "pests" of producer crops)
 *   predator    — natural enemies that kill prey outright
 *   parasitoid  — natural enemies that develop in/on a host
 *   pathogen    — microbial/viral plant disease agents
 *   mutualist   — symbionts (pollinators, mycorrhizae, rhizobia, …)
 *   decomposer  — saprotrophic / detritivore organisms (no rows yet; reserved)
 *
 * Note on `biocontrol` → predator: this primary_role mixes invertebrate
 * predators with entomopathogenic fungi. The 3-axis filter lets users layer
 * (bio_category=fungi) + (primary_role=biocontrol) to recover the fungal-
 * specific slice. Coarse first cut, precise refinement via chip stacking.
 *
 * Note on `entomopathogen_viral` → predator: these are insect-pathogens used
 * as natural enemies (NPVs etc.). Functionally a biocontrol, not a plant
 * pathogen, so they sit with predators, not in the pathogen bucket.
 *
 * Unmapped primary_role values (unclassified, neutral, plus any new value
 * extracted after this map was written) get a NULL agroeco_bucket and fall
 * outside the agroeco filter group — still reachable via the other two axes.
 */

const BUCKET_MAP = Object.freeze({
  // producers
  crop: 'producer',
  weed: 'producer',
  wild_plant: 'producer',

  // herbivores
  pest_insect: 'herbivore',
  pest_vertebrate: 'herbivore',
  pest_mite: 'herbivore',

  // predators (natural enemies that kill prey)
  beneficial_predator: 'predator',
  biocontrol: 'predator',
  entomopathogen_viral: 'predator',

  // parasitoids (develop in/on host)
  beneficial_parasitoid: 'parasitoid',

  // plant pathogens
  pathogen: 'pathogen',
  pathogen_fungal: 'pathogen',
  pathogen_bacterial: 'pathogen',
  pathogen_viral: 'pathogen',
  phytopathogen_viral: 'pathogen',
  pathogen_nematode: 'pathogen',

  // mutualists
  pollinator: 'mutualist',
  soil_microbe: 'mutualist',

  // decomposers — reserved; no current primary_role values map here.
  // Once we extract saprotrophic / detritivore organisms, add entries.
});

const ALL_BUCKETS = Object.freeze([
  'producer',
  'herbivore',
  'predator',
  'parasitoid',
  'pathogen',
  'mutualist',
  'decomposer',
]);

function getAgroEcoBucket(primaryRole) {
  if (!primaryRole) return null;
  return BUCKET_MAP[primaryRole] || null;
}

module.exports = { BUCKET_MAP, ALL_BUCKETS, getAgroEcoBucket };
