'use strict';
/**
 * order-consistency.js — find families that carry more than one name for their
 * order, because this corpus mixes taxonomic classification systems.
 *
 * WHAT THIS IS NOT: it is not a misfiling detector. That was the original
 * premise and it is false. `taxon_order` cannot validate `family`, because the
 * order field is itself unreliable — Erysiphaceae stores both Helotiales and
 * Erysiphales, split WITHIN genera (Erysiphe 347/248), and both name the same
 * powdery mildews. Corpus-wide the pattern is overwhelmingly synonymy:
 * Polycarpicae beside Ranunculales (Englerian), Centrospermae beside
 * Caryophyllales, Capnodiales beside Mycosphaerellales (pre/post split).
 * Same organisms, different systems. Cross-field validation fails here for the
 * same reason the 2026-06-10 --corrupt-globi attempt failed: the field being
 * validated against is no more trustworthy than the field under test.
 *
 * WHAT IT IS FOR: a prerequisite check before deriving the taxonomy graph. A
 * deriver that reads these columns naively builds TWO order nodes for one
 * order and splits a family across them. Every family reported here needs a
 * canonical order name chosen by a human before the backbone is built.
 *
 * Frequency does NOT identify the canonical name — in Erysiphaceae the wrong
 * name (Helotiales) is the more common one — so this module deliberately does
 * not name a winner.
 */

/**
 * @param {Array<{taxon_order: string, count: number}>} orderCounts
 * @returns {{names: Array<{taxon_order: string, count: number}>,
 *            needsCanonicalization: boolean, minorityCount: number}}
 */
function findOrderDisagreement(orderCounts) {
  const names = (orderCounts || [])
    .filter(o => o.taxon_order)
    .sort((a, b) => b.count - a.count);

  return {
    names,
    needsCanonicalization: names.length > 1,
    // How many rows sit under a name other than the most common one. A size
    // signal for triage only; it does NOT imply those rows are the wrong ones.
    minorityCount: names.slice(1).reduce((n, o) => n + o.count, 0),
  };
}

module.exports = { findOrderDisagreement };
