'use strict';

/**
 * router-eval.js — fitness harness for critic-router.js (Hermes flexibility map §3).
 *
 * Pure, dependency-free scoring of a routing function. No LLM calls, no DB handle —
 * callers load data and pass plain objects in, so every function is deterministic
 * and unit-testable. See docs/hermes-flexibility-map.md §4 (graduation criterion 1).
 */

/**
 * scoreRouter(fixtures, routeFn) → { total, correct, incorrect, accuracy, cases }
 *   fixtures: [{ id, payload, target_table, expected_critic }]
 *   routeFn:  (payload, targetTable) => criticName
 *   cases:    [{ id, expected, actual, ok }]
 */
function scoreRouter(fixtures, routeFn) {
  const cases = fixtures.map(f => {
    const actual = routeFn(f.payload, f.target_table);
    return { id: f.id, expected: f.expected_critic, actual, ok: actual === f.expected_critic };
  });
  const correct = cases.filter(c => c.ok).length;
  const total = cases.length;
  return {
    total,
    correct,
    incorrect: total - correct,
    accuracy: total === 0 ? null : correct / total,
    cases,
  };
}

/**
 * recusalRate(rows, routeFn) → { total, judged, skipped, recused, rate, recusedCases }
 *   rows: [{ id, payload, target_table, verdicts: { criticName: verdictString } }]
 *   A row "recused" when the ROUTED specialist's verdict is 'out_of_scope'.
 *   Rows whose routed critic has no recorded verdict are skipped (can't judge).
 */
function recusalRate(rows, routeFn) {
  let recused = 0, judged = 0, skipped = 0;
  const recusedCases = [];
  for (const r of rows) {
    const critic = routeFn(r.payload, r.target_table);
    const verdict = r.verdicts ? r.verdicts[critic] : undefined;
    if (verdict === undefined) { skipped++; continue; }
    judged++;
    if (verdict === 'out_of_scope') {
      recused++;
      recusedCases.push({ id: r.id, critic });
    }
  }
  return {
    total: rows.length,
    judged,
    skipped,
    recused,
    rate: judged === 0 ? null : recused / judged,
    recusedCases,
  };
}

module.exports = { scoreRouter, recusalRate };
