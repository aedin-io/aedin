'use strict';
/**
 * family-verdicts.js — compile domain-critic verdicts into role_rules rows.
 *
 * Phase 3 of the gated family-rule curation pass. Consumes the verdict blocks
 * a critic returned and produces the rows to insert; see
 * docs/superpowers/specs/2026-08-21-taxonomy-rule-graph-design.md
 */

const SOURCE = 'family_curation_2026_08';

/**
 * @param {{family: string, verdict: string, role?: string, exceptions?: string[],
 *          reason: string, confidence?: string}} verdict
 * @returns {Array<object>} role_rules rows to insert
 */
function verdictToRules(verdict) {
  const { family, verdict: outcome, role, exceptions, reason } = verdict;

  // Refusals carry no rule. Their reason text becomes an `assertable: false`
  // entry in the taxonomy graph's rules file instead.
  if (outcome !== 'assert') return [];

  // role_rules cannot express "assert for the family EXCEPT these genera".
  // The only available lever is a genus-rank rule, and role-engine.js returns
  // at the genus tier BEFORE consulting claim evidence (see evaluateRules
  // steps 2 and 4) — so an exception rule would silently suppress
  // evidence-based classification for every entity in that genus. Refuse
  // until the taxonomy graph can represent the exception as a deeper node.
  if (exceptions && exceptions.length) {
    throw new Error(
      `${family}: role_rules cannot express a family assertion with exceptions ` +
      `(${exceptions.join(', ')}). A genus rule would pre-empt claim evidence. ` +
      `Hold this verdict for the taxonomy graph.`);
  }

  return [{
    rule_type: 'taxonomy_family',
    match_field: 'family',
    match_value: family.toLowerCase(),
    assigned_role: role,
    confidence: 1.0,
    priority: 50,
    reason,
    source: SOURCE,
    enabled: 1,
  }];
}

module.exports = { verdictToRules, SOURCE };
