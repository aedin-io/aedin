// backend/lib/coarse-rank-audit.js
'use strict';
/**
 * Source of truth for which role_rules rows assert role by COARSE taxonomy
 * (kingdom/phylum/class/order) and must be disabled, vs genuine family-rank
 * rows that are kept. See docs/superpowers/specs/2026-06-27-role-classification-no-coarse-defaults-design.md
 */

// Class/order/kingdom/phylum names currently stored as taxonomy_class rules.
// formicidae is deliberately ABSENT — it is family-rank and is kept.
const COARSE_TAXA = new Set([
  'lepidoptera', 'diptera', 'hemiptera', 'coleoptera', 'orthoptera', 'thysanoptera',
  'hymenoptera', 'insecta', 'hexapoda', 'araneae', 'acari', 'arachnida', 'nematoda',
  'fungi', 'mycota', 'oomycota', 'bacteria', 'proteobacteria', 'firmicutes',
  'actinobacteria', 'archaea', 'virus', 'viridae', 'virales', 'mammalia', 'aves',
  'reptilia', 'amphibia', 'actinopterygii', 'vertebrata', 'plantae', 'viridiplantae',
]);

function isCoarseRoleRule(rule) {
  if (!rule || !rule.rule_type) return false;
  if (rule.rule_type === 'bio_category_default') return true;
  if (rule.rule_type === 'taxonomy_class') {
    return COARSE_TAXA.has(String(rule.match_value || '').toLowerCase());
  }
  return false;
}

module.exports = { COARSE_TAXA, isCoarseRoleRule };
