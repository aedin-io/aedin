'use strict';
/**
 * stale-role.js — the single definition of "this entity holds a role that a
 * now-disabled rule wrote".
 *
 * Disabling a rule (2026-06-27 family floor) did not rewrite the roles it had
 * already assigned. An entity is stale when role_assignment_log says a rule
 * gave it a role, that rule is now enabled=0, and entities.primary_role still
 * equals that value.
 *
 * THIS IS A CANDIDATE SET, NOT A DEFECT SET. A candidate is only defective if
 * re-evaluation would CHANGE its role. Many candidates legitimately hold a value
 * a live rule also produces — ants given 'neutral' by the disabled
 * taxonomy_class:hymenoptera rule match the enabled curated
 * taxonomy_family:formicidae rule, and rust fungi given 'pathogen_fungal' by the
 * disabled kingdom rule now match a curated family rule. Their VALUE is right;
 * only the role_assignment_log pointer is stale, and reclassifyEntity
 * deliberately does not refresh it when a role is unchanged.
 *
 * So the verifier must not simply assert this set is empty — it can never be.
 * It asserts that a DRY-RUN SWEEP over this set changes nothing.
 *
 * NOTE: staleness is about PROVENANCE, not correctness. Some stale rows hold a
 * value a live rule would reproduce anyway (ants given 'neutral' by the
 * disabled taxonomy_class:hymenoptera rule also match the enabled curated
 * taxonomy_family:formicidae rule). The sweep re-evaluates rather than blanks,
 * so those keep their value and gain correct provenance.
 */

// Joins + WHERE for the stale set. Prefix with the columns you want, e.g.
//   `SELECT e.id, e.scientific_name ${STALE_PROVENANCE_CANDIDATES_SQL} ORDER BY e.id`
const STALE_PROVENANCE_CANDIDATES_SQL = `
  FROM role_assignment_log l
  JOIN role_rules r ON r.id = l.rule_id
  JOIN entities  e ON e.id = l.entity_id
  WHERE r.enabled = 0
    AND e.primary_role = l.assigned_role`;

/**
 * @param {{entityRole: string, loggedRole: string, ruleEnabled: number}} row
 * @returns {boolean}
 */
function isStaleAssignment({ entityRole, loggedRole, ruleEnabled }) {
  return Number(ruleEnabled) === 0 && entityRole === loggedRole;
}

module.exports = { STALE_PROVENANCE_CANDIDATES_SQL, isStaleAssignment };
