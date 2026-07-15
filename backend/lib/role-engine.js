/**
 * lib/role-engine.js
 *
 * Core role-assignment engine. Shared by apply-role-rules.js (CLI),
 * run-role-agent.js (LLM agent), and server.js (API).
 *
 * Three layers:
 *   1. Taxonomy rules   — genus/family/class matching from role_rules table
 *   2. Interaction profile — what claims say about this entity's ecological behavior
 *   3. LLM agent        — edge cases (handled externally, not in this module)
 *
 * Exports:
 *   computeInteractionProfile(db, entityId)
 *   evaluateRules(db, entity, profile?)
 *   assignRole(db, entityId, role, source, opts?)
 *   logCorrection(db, entityId, oldRole, newRole, source, reason?, ruleId?)
 *   getUnreviewedCorrections(db)
 */
'use strict';

/**
 * Compute the interaction profile for an entity from claims data.
 * Returns an object with claim counts by category (as subject and as object).
 *
 * @param {object} db - sqlite db handle
 * @param {number} entityId
 * @returns {{ asSubject: Object, asObject: Object, totalSubject: number, totalObject: number }}
 */
async function computeInteractionProfile(db, entityId) {
  const asSubject = await db.all(`
    SELECT interaction_category, effect_direction, COUNT(*) as n
    FROM claims WHERE subject_entity_id = ?
    GROUP BY interaction_category, effect_direction
  `, [entityId]);

  const asObject = await db.all(`
    SELECT interaction_category, effect_direction, COUNT(*) as n
    FROM claims WHERE object_entity_id = ?
    GROUP BY interaction_category, effect_direction
  `, [entityId]);

  const subjectMap = {};
  let totalSubject = 0;
  for (const row of asSubject) {
    const key = row.interaction_category;
    subjectMap[key] = (subjectMap[key] || 0) + row.n;
    totalSubject += row.n;
  }

  const objectMap = {};
  let totalObject = 0;
  for (const row of asObject) {
    const key = row.interaction_category;
    objectMap[key] = (objectMap[key] || 0) + row.n;
    totalObject += row.n;
  }

  return { asSubject: subjectMap, asObject: objectMap, totalSubject, totalObject };
}

/**
 * Preload and index all enabled rules for fast batch evaluation.
 * Call once, then pass the result to evaluateRules as the 4th argument.
 *
 * @param {object} db - sqlite db handle
 * @returns {object} indexed rule cache
 */
async function preloadRules(db) {
  const rules = await db.all(`
    SELECT * FROM role_rules WHERE enabled = 1 ORDER BY priority DESC, id ASC
  `);

  // Build lookup maps for O(1) matching on common rule types
  const speciesMap = new Map();  // scientific_name → rule
  const genusMap = new Map();    // genus → rule
  const familyMap = new Map();   // family → [rule, ...] (multiple: biocontrol_family + taxonomy_family)
  const bioMap = new Map();      // bio_category → rule
  const classRules = [];         // taxon_path contains — must scan
  const profileRules = [];       // interaction_profile — must evaluate

  for (const rule of rules) {
    const mv = rule.match_value.toLowerCase();
    switch (rule.rule_type) {
      case 'taxonomy_species':
        if (!speciesMap.has(mv)) speciesMap.set(mv, rule);
        break;
      case 'taxonomy_genus':
        if (!genusMap.has(mv)) genusMap.set(mv, rule);
        break;
      case 'biocontrol_family':
      case 'taxonomy_family': {
        const existing = familyMap.get(mv) || [];
        existing.push(rule);
        familyMap.set(mv, existing);
        break;
      }
      case 'taxonomy_class':
        classRules.push(rule);
        break;
      case 'bio_category_default':
        if (!bioMap.has(mv)) bioMap.set(mv, rule);
        break;
      case 'interaction_profile':
        profileRules.push(rule);
        break;
    }
  }

  return { speciesMap, genusMap, familyMap, classRules, bioMap, profileRules, allRules: rules };
}

/**
 * Evaluate rules against an entity, returning the best match.
 * Accepts an optional pre-loaded rule cache (from preloadRules) for batch efficiency.
 *
 * Priority order:
 *   1. Species-level (scientific_name match, priority 90)
 *   2. Genus-level (genus match, priority 70)
 *   3. Biocontrol family override (priority 55)
 *   4. Family-level (family match, priority 50)
 *   5. Class/order/kingdom (taxon_path contains, priority 30)
 *   6. Bio_category default (priority 10)
 *
 * @param {object} db - sqlite db handle
 * @param {object} entity - { id, scientific_name, genus, family, bio_category, taxon_path?, kingdom?, taxon_class?, taxon_order? }
 * @param {object} [profile] - interaction profile (from computeInteractionProfile)
 * @param {object} [cache] - preloaded rule cache (from preloadRules)
 * @returns {{ rule: object, assignedRole: string, secondaryRole: string|null, confidence: number, source: string }|null}
 */
async function evaluateRules(db, entity, profile, cache) {
  const name = (entity.scientific_name || '').toLowerCase();
  const genus = (entity.genus || name.split(' ')[0] || '').toLowerCase();
  const family = (entity.family || '').toLowerCase();
  const bio = (entity.bio_category || '').toLowerCase();

  // Build searchPath for class-level rules
  const taxonPath = (entity.taxonomy_path || entity.taxon_path || '').toLowerCase();
  const kingdom = (entity.kingdom || '').toLowerCase();
  const taxonClass = (entity.taxon_class || '').toLowerCase();
  const taxonOrder = (entity.taxon_order || '').toLowerCase();
  const phylum = (entity.phylum || '').toLowerCase();
  const searchPath = [taxonPath, kingdom, phylum, taxonClass, taxonOrder, family].join(' | ').toLowerCase();

  // Load rules if no cache provided
  if (!cache) {
    cache = await preloadRules(db);
  }

  function makeResult(rule) {
    return {
      rule,
      assignedRole: rule.assigned_role,
      secondaryRole: rule.secondary_role || null,
      confidence: rule.confidence,
      source: `rule:${rule.id}:${rule.rule_type}:${rule.match_value}`,
    };
  }

  // 1. Species match (priority 90)
  const speciesRule = cache.speciesMap.get(name);
  if (speciesRule) return makeResult(speciesRule);

  // 2. Genus match (priority 70)
  const genusRule = cache.genusMap.get(genus);
  if (genusRule) return makeResult(genusRule);

  // 3. Family match — pick highest priority among biocontrol_family (55) and taxonomy_family (50)
  const familyRules = cache.familyMap.get(family);
  if (familyRules && familyRules.length > 0) {
    // Already sorted by priority DESC from the original query
    return makeResult(familyRules[0]);
  }

  // 4. Interaction profile rules (priority varies, typically 40-60)
  for (const rule of cache.profileRules) {
    if (rule.match_bio_category && rule.match_bio_category.toLowerCase() !== bio) continue;
    if (evaluateProfileRule(rule, profile)) return makeResult(rule);
  }

  // 5. Class/order/kingdom fallback (priority 30)
  for (const rule of cache.classRules) {
    const mv = rule.match_value.toLowerCase();
    if (searchPath.includes(mv)) return makeResult(rule);
  }

  // 6. Bio_category default (priority 10)
  const bioRule = cache.bioMap.get(bio);
  if (bioRule) return makeResult(bioRule);

  return null;
}

/**
 * Evaluate an interaction_profile rule against a profile.
 * Rule match_value is a JSON condition, e.g.:
 *   {"field": "asSubject.biocontrol", "op": "pct_gt", "value": 40}
 *   {"field": "asSubject.biocontrol", "op": "count_gt", "value": 5}
 */
function evaluateProfileRule(rule, profile) {
  if (!profile) return false;
  try {
    const cond = JSON.parse(rule.match_value);
    const parts = cond.field.split('.');
    const side = parts[0] === 'asSubject' ? profile.asSubject : profile.asObject;
    const category = parts[1];
    const count = side[category] || 0;
    const total = parts[0] === 'asSubject' ? profile.totalSubject : profile.totalObject;

    switch (cond.op) {
      case 'count_gt': return count > cond.value;
      case 'count_gte': return count >= cond.value;
      case 'pct_gt': return total > 0 && (count / total * 100) > cond.value;
      case 'pct_gte': return total > 0 && (count / total * 100) >= cond.value;
      default: return false;
    }
  } catch {
    return false;
  }
}

/**
 * Assign a role to an entity and log the assignment.
 *
 * @param {object} db
 * @param {number} entityId
 * @param {string} role
 * @param {string} source - e.g. 'rule:14:taxonomy_family:coccinellidae' or 'manual' or 'agent'
 * @param {object} [opts] - { ruleId, confidence, profile, secondaryRole, dryRun }
 * @returns {{ entityId: number, role: string, source: string, changed: boolean }}
 */
async function assignRole(db, entityId, role, source, opts = {}) {
  const { ruleId = null, confidence = null, profile = null, dryRun = false } = opts;

  if (dryRun) {
    return { entityId, role, source, changed: true };
  }

  // Update entity
  await db.run(
    "UPDATE entities SET primary_role = ?, updated_at = datetime('now') WHERE id = ?",
    [role, entityId]
  );

  // Upsert assignment log
  const profileJson = profile ? JSON.stringify(profile) : null;
  await db.run(`
    INSERT INTO role_assignment_log (entity_id, assigned_role, assignment_source, rule_id, confidence, interaction_profile, assigned_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(entity_id) DO UPDATE SET
      assigned_role = excluded.assigned_role,
      assignment_source = excluded.assignment_source,
      rule_id = excluded.rule_id,
      confidence = excluded.confidence,
      interaction_profile = excluded.interaction_profile,
      assigned_at = excluded.assigned_at
  `, [entityId, role, source, ruleId, confidence, profileJson]);

  return { entityId, role, source, changed: true };
}

/**
 * Log a role correction (manual or automated).
 */
async function logCorrection(db, entityId, scientificName, oldRole, newRole, source, reason, ruleId) {
  // Also log bio_category changes
  await db.run(`
    INSERT INTO role_corrections
      (entity_id, scientific_name, old_role, new_role, source, reason, rule_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [entityId, scientificName, oldRole, newRole, source, reason || null, ruleId || null]);
}

/**
 * Get unreviewed corrections grouped by pattern.
 * Returns correction records where reviewed = 0.
 */
async function getUnreviewedCorrections(db) {
  return db.all(`
    SELECT rc.*, e.family, e.genus, e.bio_category
    FROM role_corrections rc
    JOIN entities e ON rc.entity_id = e.id
    WHERE rc.reviewed = 0
    ORDER BY rc.created_at DESC
  `);
}

/**
 * Mark corrections as reviewed.
 */
async function markCorrectionsReviewed(db, correctionIds) {
  if (!correctionIds.length) return;
  const placeholders = correctionIds.map(() => '?').join(',');
  await db.run(
    `UPDATE role_corrections SET reviewed = 1 WHERE id IN (${placeholders})`,
    correctionIds
  );
}

/**
 * Check if an entity has been manually corrected (and should be protected from re-evaluation).
 */
async function hasManualCorrection(db, entityId) {
  const row = await db.get(
    "SELECT id FROM role_corrections WHERE entity_id = ? AND source = 'manual' ORDER BY created_at DESC LIMIT 1",
    [entityId]
  );
  return !!row;
}

/**
 * Preload all manually-corrected entity IDs into a Set for O(1) batch lookups.
 * Use this instead of hasManualCorrection() when processing many entities.
 */
async function preloadCorrectedEntityIds(db) {
  const rows = await db.all("SELECT DISTINCT entity_id FROM role_corrections WHERE source = 'manual'");
  return new Set(rows.map(r => r.entity_id));
}

module.exports = {
  computeInteractionProfile,
  preloadRules,
  evaluateRules,
  assignRole,
  logCorrection,
  getUnreviewedCorrections,
  markCorrectionsReviewed,
  hasManualCorrection,
  preloadCorrectedEntityIds,
};
