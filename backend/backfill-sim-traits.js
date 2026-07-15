#!/usr/bin/env node
'use strict';
/** backfill-sim-traits.js — apply the sim-trait source cascade (lib/sim-trait-sources) to un-surfaced
 *  entities scalar inputs. Runs each source in priority order; fill-if-NULL means earlier sources win.
 *  Reversible (source-tagged backup + revision_log). Dry-run by default; --apply to write. */
const fs = require('fs'); const path = require('path');
const Database = require('better-sqlite3');
const { CORPUS_DB } = require('./lib/db-paths.cjs');
const SOURCES = require('./lib/sim-trait-sources');
const { applyScalarBackfill } = require('./lib/sim-scalar-backfill');
function loadJsonDir(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; }
  }).filter((o) => o && o.matched);
}
function main() {
  const apply = process.argv.includes('--apply');
  const db = new Database(CORPUS_DB); db.pragma('busy_timeout = 30000');
  const idsForName = db.prepare(`SELECT id FROM entities WHERE scientific_name = ? COLLATE NOCASE AND bio_category='plantae'`);
  const allBackup = []; const report = {};
  for (const src of SOURCES) {
    const records = loadJsonDir(path.join(__dirname, src.cacheDir));
    const plan = [];
    for (const rec of records) {
      const { query_name, fields } = src.extract(rec);
      if (!query_name || !fields) continue;
      const ids = idsForName.all(query_name).map((r) => r.id);
      for (const id of ids) for (const [field, value] of Object.entries(fields)) if (value != null) plan.push({ entity_id: id, field, value });
    }
    const res = applyScalarBackfill(db, plan, { apply });
    report[src.name] = { cached: records.length, planned: plan.length, applied: res.applied, skipped: res.skipped };
    allBackup.push(...res.backup.map((b) => ({ ...b, source: src.name })));
  }
  console.log(`[backfill-sim-traits] ${apply ? 'APPLIED' : 'DRY RUN'} (cascade order: ${SOURCES.map((s) => s.name).join(' -> ')})`);
  for (const [name, r] of Object.entries(report)) console.log(`  ${name}: cached=${r.cached} planned=${r.planned} applied=${r.applied} skipped=${r.skipped}`);
  if (apply && allBackup.length) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupsDir = path.join(__dirname, 'backups');
    fs.mkdirSync(backupsDir, { recursive: true }); // fresh worktrees lack backups/ (gitignored)
    const bpath = path.join(backupsDir, `sim-trait-backfill-${stamp}.json`);
    fs.writeFileSync(bpath, JSON.stringify(allBackup, null, 1));
    console.log('  backup:', bpath);
  }
  db.close();
}
if (require.main === module) main();
module.exports = { loadJsonDir };
