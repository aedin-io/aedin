/**
 * apply-role-rules.js
 *
 * Evaluate entities against role_rules and assign primary_role.
 * Replaces assign-biocontrol-role.js with a data-driven approach.
 *
 * Usage:
 *   node apply-role-rules.js                              # evaluate unclassified entities
 *   node apply-role-rules.js --all                        # re-evaluate ALL entities
 *   node apply-role-rules.js --entity 12345               # evaluate single entity
 *   node apply-role-rules.js --family Syrphidae           # evaluate all in a family
 *   node apply-role-rules.js --bio invertebrate           # evaluate all in a bio_category
 *   node apply-role-rules.js --unmatched                  # only entities with no rule match
 *   node apply-role-rules.js --with-profile               # also compute interaction profiles
 *   node apply-role-rules.js --respect-corrections        # skip manually-corrected entities
 *   node apply-role-rules.js --dry-run                    # preview without applying
 *   node apply-role-rules.js --unmatched-to-unclassified  # null result → assign 'unclassified' (logged, reversible)
 */
'use strict';

const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { CORPUS_DB } = require('./lib/db-paths.cjs');
const {
  computeInteractionProfile,
  evaluateRules,
  preloadRules,
  assignRole,
  logCorrection,
  preloadCorrectedEntityIds,
} = require('./lib/role-engine');

const DB_PATH = CORPUS_DB;

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const all = args.includes('--all');
  const withProfile = args.includes('--with-profile');
  const respectCorrections = args.includes('--respect-corrections');
  const unmatched = args.includes('--unmatched');
  const unmatchedToUnclassified = args.includes('--unmatched-to-unclassified');

  // Parse --entity, --family, --bio flags
  const entityId = getArgValue(args, '--entity');
  const family = getArgValue(args, '--family');
  const bioCategory = getArgValue(args, '--bio');

  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });
  await db.run('PRAGMA journal_mode = WAL');
  await db.run('PRAGMA busy_timeout = 10000');

  // Build query — exclude merged tombstones (they have no canonical identity)
  let where = 'parent_entity_id IS NULL AND merged_into_entity_id IS NULL';
  const params = [];

  if (entityId) {
    where += ' AND id = ?';
    params.push(parseInt(entityId, 10));
  } else if (family) {
    where += ' AND family = ? COLLATE NOCASE';
    params.push(family);
  } else if (bioCategory) {
    where += ' AND bio_category = ?';
    params.push(bioCategory);
  } else if (!all) {
    // Default: only unclassified
    where += " AND primary_role IN ('unclassified', 'neutral')";
  }

  const entities = await db.all(`
    SELECT id, scientific_name, common_name, family, genus, bio_category,
           primary_role, kingdom, phylum, taxon_class, taxon_order, taxonomy_path
    FROM entities WHERE ${where}
  `, params);

  console.log(`=== Apply Role Rules (${dryRun ? 'DRY RUN' : 'LIVE'}) ===`);
  console.log(`Target: ${entities.length} entities`);
  if (respectCorrections) console.log('Respecting manual corrections (skipping corrected entities)');
  if (withProfile) console.log('Computing interaction profiles');
  console.log('');

  // Preload rules once for batch evaluation
  const cache = await preloadRules(db);
  console.log(`Rules loaded: ${cache.allRules.length} (${cache.speciesMap.size} species, ${cache.genusMap.size} genera, ${cache.familyMap.size} families, ${cache.classRules.length} class/order, ${cache.bioMap.size} bio defaults)`);

  // Preload corrected entity IDs for fast batch lookup
  let correctedIds = new Set();
  if (respectCorrections) {
    correctedIds = await preloadCorrectedEntityIds(db);
    console.log(`Manual corrections to protect: ${correctedIds.size}`);
  }
  console.log('');

  let assigned = 0;
  let skipped = 0;
  let noMatch = 0;
  let unchanged = 0;
  const byRole = {};
  const bySource = {};
  const samples = [];
  const unmatchedEntities = [];

  // Wrap all writes in a single transaction for performance
  if (!dryRun) await db.run('BEGIN TRANSACTION');

  let processed = 0;
  for (const entity of entities) {
    processed++;
    if (processed % 10000 === 0) {
      process.stdout.write(`  ${processed}/${entities.length}...\r`);
    }
    // Skip manually-corrected entities if requested
    if (respectCorrections && correctedIds.has(entity.id)) {
      skipped++;
      continue;
    }

    // Compute interaction profile if requested
    let profile = null;
    if (withProfile) {
      profile = await computeInteractionProfile(db, entity.id);
    }

    const outcome = await reclassifyEntity(db, entity, cache, {
      unmatchedToUnclassified,
      respectCorrections,
      correctedIds,
      dryRun,
      profile,
    });

    if (outcome.status === 'no_match') {
      noMatch++;
      if (unmatchedEntities.length < 20) {
        unmatchedEntities.push({ name: entity.scientific_name, bio: entity.bio_category, family: entity.family, role: entity.primary_role });
      }
    } else if (outcome.status === 'unchanged') {
      // Don't count unchanged hits when --unmatched is active (the caller only wants no-match
      // entities; 'unchanged' means a rule fired but the role stayed the same, which is noise here).
      if (!unmatched) {
        unchanged++;
      }
    } else if (outcome.status === 'assigned') {
      assigned++;
      byRole[outcome.assignedRole] = (byRole[outcome.assignedRole] || 0) + 1;
      const sourceType = outcome.ruleType || 'unknown';
      bySource[sourceType] = (bySource[sourceType] || 0) + 1;

      if (samples.length < 30) {
        samples.push({
          name: entity.scientific_name,
          oldRole: entity.primary_role,
          newRole: outcome.assignedRole,
          via: outcome.source,
        });
      }
    }
  }

  // Commit the transaction
  if (!dryRun) await db.run('COMMIT');

  // Summary
  console.log(`Assigned: ${assigned}`);
  console.log(`Unchanged: ${unchanged}`);
  console.log(`Skipped (manual corrections): ${skipped}`);
  console.log(`No rule match: ${noMatch}`);

  if (Object.keys(byRole).length > 0) {
    console.log('\nBy role:');
    for (const [role, count] of Object.entries(byRole).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${role}: ${count}`);
    }
  }

  if (Object.keys(bySource).length > 0) {
    console.log('\nBy rule type:');
    for (const [src, count] of Object.entries(bySource).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${src}: ${count}`);
    }
  }

  if (samples.length > 0) {
    console.log('\nSamples:');
    for (const s of samples) {
      console.log(`  ${s.name}: ${s.oldRole} → ${s.newRole} via ${s.via}`);
    }
  }

  if (unmatchedEntities.length > 0) {
    console.log('\nUnmatched entities (no rule):');
    for (const u of unmatchedEntities) {
      console.log(`  ${u.name} (${u.bio}/${u.family || '?'}) — current: ${u.role}`);
    }
    if (noMatch > 20) console.log(`  ... and ${noMatch - 20} more`);
  }

  if (!dryRun) {
    const stats = await db.all("SELECT primary_role, COUNT(*) as n FROM entities WHERE parent_entity_id IS NULL GROUP BY primary_role ORDER BY n DESC");
    console.log('\nRole breakdown (all entities):');
    for (const s of stats) console.log(`  ${s.primary_role}: ${s.n}`);
  }

  await db.close();
  console.log('\nDone.');
}

function getArgValue(args, flag) {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return null;
  return args[idx + 1];
}

/**
 * Evaluate and (if needed) reassign a single entity's primary_role.
 *
 * Extracted from the main loop so it can be unit-tested with an in-memory DB
 * without running the full CLI. Behavior is identical to the old inline logic.
 *
 * @param {object} db       - sqlite db handle
 * @param {object} entity   - row from `entities` table
 * @param {object} cache    - preloaded rule cache from preloadRules()
 * @param {object} opts
 * @param {boolean} opts.unmatchedToUnclassified - assign 'unclassified' on null result
 * @param {boolean} opts.respectCorrections      - skip entities in correctedIds
 * @param {Set}     opts.correctedIds            - entity ids protected from reassignment
 * @param {boolean} opts.dryRun                  - preview only, no DB mutations
 * @param {object|null} opts.profile             - precomputed interaction profile (or null)
 *
 * @returns {Promise<{status: 'no_match'|'unchanged'|'assigned', assignedRole?, source?, ruleType?}>}
 */
async function reclassifyEntity(db, entity, cache, opts) {
  const {
    unmatchedToUnclassified = false,
    respectCorrections = false,
    correctedIds = new Set(),
    dryRun = false,
    profile = null,
  } = opts;

  // Guard: protected corrections
  if (respectCorrections && correctedIds.has(entity.id)) {
    return { status: 'unchanged', assignedRole: entity.primary_role };
  }

  // Evaluate rules (using preloaded cache)
  const result = await evaluateRules(db, entity, profile, cache);

  if (!result) {
    // No rule/profile match
    // Note: the outer respectCorrections guard (above) already skips protected entities before
    // we reach here, so no inner correctedIds check is needed in this branch.
    if (unmatchedToUnclassified && entity.primary_role !== 'unclassified') {
      const oldRole = entity.primary_role;
      await assignRole(db, entity.id, 'unclassified', 'family-floor:no-match', { dryRun });
      if (!dryRun) {
        await logCorrection(db, entity.id, entity.scientific_name, oldRole, 'unclassified',
          'family_floor', 'no surviving rule/profile match (coarse defaults removed)', null);
      }
      return { status: 'assigned', assignedRole: 'unclassified', source: 'family-floor:no-match', ruleType: 'no_match' };
    }
    return { status: 'no_match' };
  }

  // Skip if role wouldn't change.
  // Note: under --all, a matched entity whose role is unchanged no longer refreshes
  // entities.updated_at / role_assignment_log. This is intentional — no role or data
  // changed, so writing a log entry would be audit-log noise with no substance.
  if (result.assignedRole === entity.primary_role) {
    return { status: 'unchanged', assignedRole: result.assignedRole };
  }

  // Assign the matched role
  const oldRole = entity.primary_role;
  await assignRole(db, entity.id, result.assignedRole, result.source, {
    ruleId: result.rule ? result.rule.id : null,
    confidence: result.confidence,
    profile,
    dryRun,
  });

  // Log the change as rule_engine correction
  if (!dryRun) {
    await logCorrection(db, entity.id, entity.scientific_name, oldRole, result.assignedRole,
      'rule_engine', result.rule ? result.rule.reason : null, result.rule ? result.rule.id : null);
  }

  return {
    status: 'assigned',
    assignedRole: result.assignedRole,
    source: result.source,
    ruleType: result.rule ? result.rule.rule_type : 'unknown',
  };
}

// Export for testing
module.exports = { reclassifyEntity };

if (require.main === module) {
  main().catch(err => { console.error('Failed:', err); process.exit(1); });
}
