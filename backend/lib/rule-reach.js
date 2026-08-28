'use strict';
/**
 * rule-reach.js — classify how many entities a role rule actually REACHES, and
 * when it reaches none, why.
 *
 * A rule that matches nothing is not neutral. It reads as coverage during
 * review — someone looking at role_rules sees the taxon handled — while
 * asserting nothing at all. AEDIN has now hit this "declared but inert" shape
 * three times (the traits_vocabulary kingdom declarations, the extractor's
 * blank interaction categories, and these rules), and the pattern is that a
 * wrong or unreachable declaration is never contradicted by anything, so it
 * survives indefinitely.
 *
 * Two causes are distinguishable and want different fixes:
 *
 *   rank_mismatch    the value is a real taxon, but at a DIFFERENT rank than
 *                    the rule's match_field (glomeromycota stored as a family
 *                    is a phylum). Fix by re-keying to the right rank.
 *   vintage_mismatch the value is a real taxon at a rank our corpus no longer
 *                    uses, because the two follow classifications of different
 *                    ages (Lymantriidae is a family in older schemes and the
 *                    subfamily Lymantriinae within Erebidae in ours).
 *
 * Re-keying always prefers the FINEST rank where the value is found. A rule
 * curated for a family must not silently acquire a phylum's reach.
 */
// Finest first: a re-key must never widen a rule beyond what was curated.
const RANKS_FINEST_FIRST = ['genus', 'subfamily', 'family', 'taxon_order', 'taxon_class', 'phylum', 'kingdom'];
const DEMOTION_RANKS = new Set(['genus', 'subfamily']);
const THIN_THRESHOLD = 20;

/**
 * Zoological demotion RENAMES as well as re-ranks: a family `-idae` becomes a
 * subfamily `-inae`. So looking the unchanged string up at other ranks finds
 * nothing — the first version of this audit missed both cases that motivated
 * it for exactly that reason. Botanical names (`-aceae`) have no equivalent
 * transform and return nothing.
 */
function demotedForms(name) {
  const n = String(name || '').toLowerCase();
  return /idae$/.test(n) ? [n.replace(/idae$/, 'inae')] : [];
}

function classifyReach({ matched, ruleRank, altRanks, demotedAt }) {
  const alts = { ...(altRanks || {}) };
  // A renamed demotion counts as the value appearing at that finer rank.
  for (const [rank, n] of Object.entries(demotedAt || {})) {
    if (n > 0) alts[rank] = (alts[rank] || 0) + n;
  }
  const foundAt = RANKS_FINEST_FIRST.find((r) => r !== ruleRank && alts[r] > 0) || null;
  const elsewhere = foundAt ? alts[foundAt] : 0;

  if (matched > 0) {
    // Reaching some entities while a finer rank holds far more is worth
    // surfacing, but it is not by itself a defect — small taxa are small.
    const status = matched < THIN_THRESHOLD && elsewhere > matched ? 'underreaching' : 'live';
    return { status, foundAt, matched, reachable: status === 'live' ? matched : elsewhere };
  }

  if (!foundAt) return { status: 'dead', foundAt: null, matched: 0, reachable: 0 };
  // A demotion (found at a finer rank) is a vintage mismatch; found at a
  // coarser one, the rule was simply filed under the wrong rank to begin with.
  const status = DEMOTION_RANKS.has(foundAt) ? 'vintage_mismatch' : 'rank_mismatch';
  return { status, foundAt, matched: 0, reachable: elsewhere };
}

module.exports = { classifyReach, demotedForms, RANKS_FINEST_FIRST, THIN_THRESHOLD };
