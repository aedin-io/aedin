'use strict';
/**
 * kingdom-consensus.js — reduce several critics' verdicts on one entity's
 * bio_category into a single outcome.
 *
 * The gate is deliberately stricter than a plain majority: ANY critic that
 * actively names a different organism blocks the change, even when outvoted.
 * These rows are genus collisions (Graphium the butterfly vs Graphium the
 * ascomycete), so a lone dissent is usually a critic recognising the OTHER
 * namesake — the single most informative signal in the batch, not noise to be
 * averaged away. Blocking costs an unfixed row; overriding costs a wrongly
 * reclassified organism, and AEDIN holds ambiguity to beat false identification.
 *
 * Abstentions are not votes in either direction. Low-confidence votes are
 * recorded but do not count toward the majority.
 */
const MIN_VOTES = 2;

// The value a critic asserts, whichever verdict form they used to say it.
function assertedValue(v, { ours, ottProposes }) {
  if (v.verdict === 'ott_correct') return v.correct_value || ottProposes;
  if (v.verdict === 'ours_correct') return v.correct_value || ours;
  if (v.verdict === 'neither') return v.correct_value || null;
  return null;                                     // abstain, or unrecognised
}

function consensusFor(row, verdicts) {
  const asserted = verdicts
    .map((v) => ({ value: assertedValue(v, row), confidence: v.confidence }))
    .filter((a) => a.value);

  const counting = asserted.filter((a) => a.confidence !== 'low');
  if (!counting.length) return { outcome: 'insufficient', value: null, votes: 0, dissent: 0 };

  const tally = {};
  for (const a of counting) tally[a.value] = (tally[a.value] || 0) + 1;
  const [value, votes] = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];

  // Dissent counts every asserted value that differs — including low-confidence
  // ones, which block even though they cannot carry a majority.
  const dissent = asserted.filter((a) => a.value !== value).length;
  if (dissent > 0) return { outcome: 'disputed', value, votes, dissent };
  if (votes < MIN_VOTES) return { outcome: 'insufficient', value, votes, dissent };
  return { outcome: 'confirmed', value, votes, dissent };
}

module.exports = { consensusFor, assertedValue, MIN_VOTES };
