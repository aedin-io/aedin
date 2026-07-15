'use strict';
// Nomenclatural-rank classifier for variety entities. Name-derived, uniform across kingdoms.
const QUOTE = /[''‘’]/;                 // straight + curly single quote = cultivar epithet
const HYBRID = /×|\sx\s/;                    // × sign, or " x " between binomials
const SUBSP = /\bsubsp\.|\bssp\./i;
const VAR = /\bvar\./i;
const FORMA = /\bf\.\s/i;

function classifyVarietyType({ scientific_name, variety_name }) {
  const n = String(scientific_name || '');
  const vn = String(variety_name || '');
  if (QUOTE.test(n) || QUOTE.test(vn)) return 'cultivar';
  if (HYBRID.test(n)) return 'hybrid';
  if (SUBSP.test(n)) return 'subsp';
  if (VAR.test(n)) return 'var';
  if (FORMA.test(n)) return 'f';
  return 'morphotype';
}

module.exports = { classifyVarietyType };
