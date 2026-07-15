'use strict';

/**
 * taxon-rank-floor.js — shared predicate for the "rank floor" data-quality gate.
 *
 * Policy (set 2026-06-05): a claim endpoint that resolves no finer than CLASS is
 * too coarse to support any downstream inference (tritrophic, companion,
 * predictive) and is rejected at promote time + quarantined retroactively.
 *
 * The floor is at ORDER: order-and-finer is KEPT (Lepidoptera, Thysanoptera,
 * Aphididae, Tetranychidae, genus spp., species). class-and-coarser is REJECTED
 * (Insecta, Acari="Mites", Gastropoda, Nematoda, Plantae, Fungi).
 *
 * Why a rank floor and not a "ban common names" rule: most common names resolve
 * to FAMILY level, which is legitimately actionable — IPM/extension literature
 * operates at family granularity ("control the aphids", "scout for whiteflies").
 * Family/genus collectives are the backbone of the corpus (31% of claims); only
 * the class-and-coarser tail (~3.5%) is noise. See the data analysis that
 * motivated this (claim #6735415: "Mites" → Acari subclass).
 *
 * Signal: collective/coarse entities carry a parenthetical rank annotation in
 * scientific_name, e.g. "Acari (subclass)", "Insecta (class)", "Nematoda
 * (phylum)", "Plantae (kingdom)". We reject on the class-and-coarser tokens.
 * Genus-level "spp." names (e.g. "Croton spp") and order/family annotations are
 * NOT matched, so they pass the floor.
 */

// Rank tokens at CLASS and coarser — the reject set under an order floor.
// Lowercased; matched case-insensitively against the parenthetical annotation.
const COARSE_RANK_TOKENS = [
  'class', 'subclass', 'superclass', 'infraclass',
  'phylum', 'subphylum', 'superphylum',
  'kingdom', 'subkingdom',
  'division', 'subdivision', // botanical phylum-equivalents
];

// A name is "coarse" (below the order floor) iff it carries a parenthetical
// rank annotation drawn from COARSE_RANK_TOKENS — e.g. "Insecta (class)".
// Note: "(superclass)"/"(infraclass)" contain "class" as a substring, so the
// token regex uses a parenthesis-delimited match to avoid e.g. matching
// "(class)" inside unrelated text, while still catching the super/infra forms
// via their own explicit tokens.
const COARSE_RANK_RE = new RegExp(
  '\\((?:' + COARSE_RANK_TOKENS.join('|') + ')\\)',
  'i'
);

/**
 * @param {string|null|undefined} scientificName
 * @returns {boolean} true if the name resolves no finer than class (REJECT).
 */
function isCoarseRankName(scientificName) {
  if (!scientificName) return false;
  return COARSE_RANK_RE.test(scientificName);
}

/**
 * SQL boolean fragment for a scientific_name column, for use in WHERE clauses
 * (quarantine sweep, ad-hoc queries). Mirrors isCoarseRankName exactly.
 * @param {string} col — column expression, e.g. "e.scientific_name"
 * @returns {string} a parenthesised SQL boolean expression
 */
function coarseRankSqlFragment(col) {
  const likes = COARSE_RANK_TOKENS.map(t => `${col} LIKE '%(${t})%'`);
  return `(${likes.join(' OR ')})`;
}

module.exports = { COARSE_RANK_TOKENS, isCoarseRankName, coarseRankSqlFragment };
