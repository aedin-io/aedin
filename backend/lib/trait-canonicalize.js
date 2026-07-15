'use strict';

/**
 * Canonicalize free-text categorical trait values to the enum-allowed form.
 * Extractor agents tend to produce rich descriptive values like
 * "biennial grown as annual; storage root crop" or "shade-loving understory tree"
 * which encode real biological information but fail the strict enum validator.
 * Map common descriptive patterns to the closest enum bucket so consensus-met
 * rows aren't rejected at the validator boundary.
 */

function canonicalizeGrowthHabit(value) {
  if (!value || typeof value !== 'string') return value;
  const v = value.toLowerCase();

  if (/\b(tree|arboreal|tree-?like|forest tree)\b/.test(v)) return 'tree';
  if (/\bsub-?shrub\b/.test(v)) return 'subshrub';
  if (/\b(shrub|bush|shrubby|woody perennial)\b/.test(v)) return 'shrub';
  if (/\b(vine|vining|climbing|liana|trailing|creeping|runner)\b/.test(v)) return 'vine';
  if (/\b(grass|graminoid|sedge|cereal|cane|bamboo|grass-?like|c4 grass|c3 grass|gramineae|poaceae)\b/.test(v)) return 'graminoid';
  if (/\bforb\b/.test(v)) return 'forb';
  if (/(herb|herbaceous|perennial|annual|biennial|tuber|corm|bulb|rhizome|root crop|orchid|fern|legume|forage|cover crop|pasture|grain|oilseed|pulse|brassica|crucifer|umbellifer|composite|aroid|cucurbit|solanaceous|leafy|fruit veg|root veg|spice|medicinal|stem-succulent|aquatic|moss-?like)/.test(v)) return 'herb';
  return 'other';
}

function canonicalizeNitrogenFixation(value) {
  if (!value || typeof value !== 'string') return value;
  const v = value.toLowerCase().trim();
  if (v === 'true' || v === 'yes' || v === '1') return 'high';
  if (v === 'false' || v === 'no' || v === '0') return 'none';
  if (/\b(none|non-?fixer|non-?fixing|absent)\b/.test(v)) return 'none';
  if (/\b(low|weak|minimal|trace)\b/.test(v)) return 'low';
  if (/\b(moderate|medium|intermediate)\b/.test(v)) return 'moderate';
  if (/\b(high|strong|active|vigorous|symbiotic)\b/.test(v)) return 'high';
  return value;
}

function canonicalizeCategorical(vocab, value) {
  if (!vocab || !vocab.enum_values || !value) return value;
  if (vocab.enum_values.includes(value)) return value;
  if (vocab.trait_name === 'growth_habit') return canonicalizeGrowthHabit(value);
  if (vocab.trait_name === 'nitrogen_fixation') return canonicalizeNitrogenFixation(value);
  return value;
}

module.exports = { canonicalizeCategorical, canonicalizeGrowthHabit, canonicalizeNitrogenFixation };
