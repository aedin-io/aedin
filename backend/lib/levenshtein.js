'use strict';

/**
 * Bounded Levenshtein distance with early termination.
 *
 * @param {string} a
 * @param {string} b
 * @param {number} cap  Maximum distance to compute precisely. If the true
 *                      distance exceeds cap, returns cap+1 (sentinel).
 *                      Default 5.
 * @returns {number}
 */
function levenshtein(a, b, cap = 5) {
  a = a || '';
  b = b || '';
  if (a === b) return 0;
  const la = a.length, lb = b.length;
  if (la === 0) return lb;
  if (lb === 0) return la;
  if (Math.abs(la - lb) > cap) return cap + 1;

  // DP with two rolling rows
  let prev = new Array(lb + 1);
  let curr = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;

  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,        // insertion
        prev[j] + 1,            // deletion
        prev[j - 1] + cost      // substitution
      );
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > cap) return cap + 1; // early bail
    [prev, curr] = [curr, prev];
  }
  return prev[lb];
}

module.exports = { levenshtein };
