#!/usr/bin/env node
'use strict';
/**
 * backfill-sim-height.js — populate entities.maximum_height_cm (an UN-SURFACED
 * scalar sim input) from extracted plant-height values, so the height-gated
 * sim_plant_growth.param_status='derived' label lights up.
 *
 * Sim-data provenance policy (see .okf/datasets/sim-params.md + memory
 * sim-data-provenance-policy): a height NUMBER may come from any source,
 * including copyrighted references, because the simulator consumes only the
 * value and never surfaces/cites the source. Therefore:
 *   - store as the entities scalar attribute (a bare number, no citation) —
 *     NOT as a cited entity_trait_claims row;
 *   - the revision_log method is GENERIC ('sim_height_backfill'), deliberately
 *     NOT naming the source, since revision_log surfaces on entity pages;
 *   - fill-if-NULL only (never clobber an existing/claim-backed height),
 *     plantae-only (avoid name collisions), sanity-range guarded, reversible.
 *
 * Usage: node backfill-sim-height.js [--apply]   (dry-run by default)
 */
const fs = require('fs');
const path = require('path');

const SANE_MIN = 5, SANE_MAX = 4000; // cm — 5 cm .. 40 m (headroom over tallest crop trees)

function sanityOk(cm) {
  return typeof cm === 'number' && Number.isFinite(cm) && cm >= SANE_MIN && cm <= SANE_MAX;
}

/** items: [{scientific_name, value_numeric}] → Map(trimmed name -> max sane height cm). */
function aggregateHeights(items) {
  const m = new Map();
  for (const it of (items || [])) {
    const name = ((it && it.scientific_name) || '').trim();
    const v = Number(it && it.value_numeric);
    if (!name || !sanityOk(v)) continue;
    const prev = m.get(name);
    if (prev == null || v > prev) m.set(name, v);
  }
  return m;
}

function loadItems(dir) {
  const items = [];
  for (const f of fs.readdirSync(dir).filter((x) => /^rubatzky-chunk\d+\.json$/.test(x))) {
    try {
      const o = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      for (const it of (o.entity_traits || [])) items.push(it);
    } catch (e) { console.warn(`  skip ${f}: ${e.message}`); }
  }
  return items;
}

function main() {
  const Database = require('better-sqlite3');
  const { CORPUS_DB } = require('./lib/db-paths.cjs');
  const { logRevisions } = require('./lib/revision-log');
  const apply = process.argv.includes('--apply');
  const outDir = path.join(__dirname, 'reingest', 'out');

  const items = loadItems(outDir);
  const heights = aggregateHeights(items);
  console.log(`height items read: ${items.length} | species with a sane height: ${heights.size}`);

  const db = new Database(CORPUS_DB);
  db.pragma('busy_timeout = 30000');
  const sel = db.prepare(`SELECT id, maximum_height_cm FROM entities WHERE scientific_name = ? COLLATE NOCASE AND bio_category='plantae'`);
  const plan = [];
  for (const [name, cm] of heights) {
    for (const r of sel.all(name)) {
      if (r.maximum_height_cm == null) plan.push({ id: r.id, name, cm });
    }
  }
  console.log(`entity matches to fill (plantae, height currently NULL): ${plan.length}`);

  if (!apply) {
    console.log('DRY RUN — pass --apply to write. Sample:');
    for (const p of plan.slice(0, 12)) console.log(`  ${p.name} → ${p.cm} cm (entity ${p.id})`);
    db.close();
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(__dirname, 'backups', `sim-height-backfill-${stamp}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(plan.map((p) => ({ entity_id: p.id, field: 'maximum_height_cm', before: null, after: p.cm })), null, 1));

  const upd = db.prepare(`UPDATE entities SET maximum_height_cm = ? WHERE id = ? AND maximum_height_cm IS NULL`);
  let applied = 0;
  const tx = db.transaction(() => {
    for (const p of plan) {
      const info = upd.run(p.cm, p.id);
      if (info.changes) {
        applied++;
        logRevisions(db, {
          targetType: 'entity', targetId: p.id,
          changes: [{ field: 'maximum_height_cm', before: null, after: p.cm }],
          changedBy: 'backfill-sim-height', method: 'sim_height_backfill',
        });
      }
    }
  });
  tx();
  db.close();
  console.log(`applied: ${applied} entities updated. backup: ${backupPath}`);
}

if (require.main === module) main();
module.exports = { sanityOk, aggregateHeights, loadItems, SANE_MIN, SANE_MAX };
