'use strict';

/**
 * curated-genera.js — high-confidence genus → kingdom-group hints, used to break
 * GBIF name collisions (lib/kingdom-hint.js) and bio_category reclassification.
 * These are genera whose NAME is an unambiguous signal of a microbial/fungal
 * organism even when the entity's stored taxonomy is NULL or corrupt.
 */

const BACTERIAL_GENERA = new Set([
  'bacillus', 'paenibacillus', 'pseudomonas', 'rhizobium', 'bradyrhizobium', 'sinorhizobium',
  'mesorhizobium', 'ensifer', 'agrobacterium', 'streptomyces', 'xanthomonas', 'erwinia',
  'pectobacterium', 'ralstonia', 'clavibacter', 'pantoea', 'burkholderia', 'azospirillum',
  'azotobacter', 'serratia', 'escherichia', 'photorhabdus', 'xenorhabdus', 'pasteuria',
  'curtobacterium', 'lactobacillus', 'acetobacter', 'gluconacetobacter', 'frankia', 'nostoc',
  'anabaena', 'spiroplasma', 'liberibacter', 'candidatus', 'wolbachia', 'acidovorax', 'dickeya',
  'leifsonia', 'rhodococcus', 'lysobacter',
]);

const FUNGAL_GENERA = new Set([
  'trichoderma', 'beauveria', 'metarhizium', 'lecanicillium', 'verticillium', 'glomus',
  'rhizophagus', 'funneliformis', 'pleurotus', 'aspergillus', 'penicillium', 'fusarium',
  'botrytis', 'alternaria', 'colletotrichum', 'cercospora', 'septoria', 'puccinia',
  'sclerotinia', 'rhizoctonia', 'ustilago', 'phakopsora', 'corynespora', 'curvularia',
  'stemphylium',
  // Rust/smut form-genera — collision-prone (GBIF mis-resolved 'Uredo' to Plantae);
  // a 'fungi' hint makes such a match a hint_contradiction → abstain.
  'uredo', 'aecidium', 'caeoma', 'uredinopsis', 'peridermium', 'roestelia', 'melampsora',
  'cronartium', 'gymnosporangium', 'hemileia', 'phragmidium', 'tilletia', 'urocystis',
  'sphacelotheca', 'tranzschelia', 'uromyces',
  // Plant-pathogenic ascomycete / coelomycete genera surfaced by the animal-tagged
  // corruption cleanup (2026-06-16). Each verified collision-free against confirmed-animal
  // entities in the DB; ambiguous dual-kingdom namesakes (Asterina/starfish,
  // Fenestella/bryozoan, Caryospora/coccidia, Sphaerella/alga, Flammula) were EXCLUDED
  // and left for manual review.
  'ramularia', 'hendersonia', 'diatrypella', 'ophiobolus', 'sphaerulina', 'phloeospora',
  'actinonema', 'anthostoma', 'coniophora', 'cryptodiscus', 'diplodina', 'graphis',
  'odontotrema', 'parodiella',
]);

module.exports = { BACTERIAL_GENERA, FUNGAL_GENERA };
