'use strict';

/**
 * backfill-globi-interaction-remap.js — Phase C of the GloBI semantic cleanup.
 *
 * Applies the correction rules in lib/globi-interaction-remap.js to every
 * tier2_globi row in `claims`. Two-pass design:
 *   Pass 1 (read-only): iterate all GloBI rows joined to their subject/object
 *     entities, run remapRow(), collect the change-set in memory.
 *   Pass 2 (transaction): apply the changes to `claims` and log each one to
 *     `claim_remap_log`. Skipped entirely under --dry-run.
 *
 * Two passes avoid the modify-while-iterating hazard and make --dry-run a
 * clean no-op that still prints the full tally + per-rule samples.
 *
 * Idempotent: every rule in the remap module self-guards (rule 1 only fires
 * when current != 'pollination', flips change subject bio_category so they
 * can't re-match, etc.), so re-running corrects nothing new.
 *
 * Usage:
 *   node backfill-globi-interaction-remap.js --dry-run   # preview, no writes
 *   node backfill-globi-interaction-remap.js             # apply + log
 *   node backfill-globi-interaction-remap.js --limit=1000 # cap rows scanned (testing)
 *
 * Cost: $0 (pure SQL/JS, no LLM). Reversible: see claim_remap_log; re-running
 * with an empty ruleset (or restoring interaction_type_raw → category) undoes it.
 */

const Database = require('better-sqlite3');
const { remapRow } = require('./lib/globi-interaction-remap');
const { CORPUS_DB, ATTACH_RAW_SQL } = require('./lib/db-paths.cjs');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const limitArg = args.find(a => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : 0;

const db = new Database(CORPUS_DB);
db.exec(ATTACH_RAW_SQL);

const SAMPLES_PER_RULE = 4;

function main() {
  let sql = `
    SELECT c.id, c.subject_entity_id, c.object_entity_id,
           c.interaction_type_raw AS raw_interaction_type,
           c.interaction_category, c.effect_direction, c.confidence_score,
           s.bio_category AS subject_bio_category, s.family AS subject_family,
           s.scientific_name AS subject_scientific_name,
           o.bio_category AS object_bio_category, o.family AS object_family,
           o.scientific_name AS object_name
    FROM claims c
    JOIN entities s ON s.id = c.subject_entity_id
    JOIN entities o ON o.id = c.object_entity_id
    WHERE c.data_tier = 'tier2_globi'
  `;
  if (LIMIT) sql += ` LIMIT ${LIMIT}`;
  const selectStmt = db.prepare(sql);

  // ── Pass 1: collect change-set (read-only) ──────────────────────────────────
  const changes = [];
  const tally = {};
  const actionTally = {};
  const samples = {};
  let scanned = 0;

  for (const row of selectStmt.iterate()) {
    scanned++;
    const fix = remapRow(row);
    if (!fix) continue;
    changes.push({ row, fix });
    tally[fix.rule_name] = (tally[fix.rule_name] || 0) + 1;
    actionTally[fix.action] = (actionTally[fix.action] || 0) + 1;
    if (!samples[fix.rule_name]) samples[fix.rule_name] = [];
    if (samples[fix.rule_name].length < SAMPLES_PER_RULE) {
      samples[fix.rule_name].push(
        `${row.subject_scientific_name} (${row.subject_family || '?'}) ` +
        `--${row.raw_interaction_type}--> ${row.object_name} (${row.object_family || '?'})  ` +
        `| ${row.interaction_category} → ${fix.category}` + (fix.action === 'flip' ? ' [FLIPPED]' : '')
      );
    }
  }

  console.log(`\n=== Phase C ${DRY_RUN ? 'DRY-RUN' : 'APPLY'} ===`);
  console.log(`Scanned: ${scanned.toLocaleString()} tier2_globi rows`);
  console.log(`Corrections to apply: ${changes.length.toLocaleString()} (${(changes.length / scanned * 100).toFixed(2)}%)\n`);
  console.log('By rule:');
  for (const [rule, n] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${n.toString().padStart(8)} | ${rule}`);
  }
  console.log('\nBy action:');
  for (const [a, n] of Object.entries(actionTally)) console.log(`  ${n.toString().padStart(8)} | ${a}`);
  console.log('\nSamples (up to 4 per rule):');
  for (const [rule, list] of Object.entries(samples)) {
    console.log(`\n  [${rule}]`);
    list.forEach(s => console.log(`    ${s}`));
  }

  if (DRY_RUN) {
    console.log('\n--dry-run: no rows mutated. Re-run without --dry-run to apply.');
    return;
  }

  // ── Pass 2: apply (transaction) ─────────────────────────────────────────────
  const updateRecat = db.prepare(
    `UPDATE claims SET interaction_category=?, effect_direction=?, confidence_score=? WHERE id=?`
  );
  const updateFlip = db.prepare(
    `UPDATE claims SET subject_entity_id=?, object_entity_id=?, interaction_category=?, effect_direction=?, confidence_score=? WHERE id=?`
  );
  const logStmt = db.prepare(
    `INSERT INTO raw.claim_remap_log
       (claim_id, rule_name, action, before_category, after_category, before_direction, after_direction, flipped, confidence_modifier)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const apply = db.transaction(() => {
    for (const { row, fix } of changes) {
      const newConf = (row.confidence_score == null ? 0.5 : row.confidence_score) * (fix.confidence_modifier == null ? 1.0 : fix.confidence_modifier);
      if (fix.action === 'flip') {
        updateFlip.run(row.object_entity_id, row.subject_entity_id, fix.category, fix.effect_direction, newConf, row.id);
      } else {
        // recategorize OR unclassify (both just set the category)
        updateRecat.run(fix.category, fix.effect_direction, newConf, row.id);
      }
      logStmt.run(
        row.id, fix.rule_name, fix.action,
        row.interaction_category, fix.category,
        row.effect_direction, fix.effect_direction,
        fix.action === 'flip' ? 1 : 0,
        fix.confidence_modifier == null ? 1.0 : fix.confidence_modifier
      );
    }
  });
  apply();

  console.log(`\nAPPLIED ${changes.length.toLocaleString()} corrections to claims + logged to claim_remap_log.`);
}

try {
  main();
} finally {
  db.close();
}
