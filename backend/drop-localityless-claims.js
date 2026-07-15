'use strict';
/**
 * One-time cleanup: remove ai_reviewed (literature) claims whose regional_context
 * does not resolve to any locality (scope or country). Dry-run by default; pass
 * --apply to delete. Reports every affected claim id + quote.
 *   node drop-localityless-claims.js          # dry run (lists, deletes nothing)
 *   node drop-localityless-claims.js --apply   # delete
 */
const Database = require('better-sqlite3');
const { hasResolvableLocality } = require('./lib/region-normalize');
const { CORPUS_DB } = require('./lib/db-paths.cjs');

function findLocalitylessClaims(db) {
  const rows = db.prepare(
    `SELECT id, regional_context, source_quote FROM claims WHERE review_status='ai_reviewed'`
  ).all();
  return rows.filter(r => !hasResolvableLocality(r.regional_context));
}

function main() {
  const apply = process.argv.includes('--apply');
  const db = new Database(CORPUS_DB);
  const doomed = findLocalitylessClaims(db);
  console.log(`[drop-localityless] ${doomed.length} ai_reviewed claims have no resolvable locality`);
  for (const r of doomed) {
    console.log(`  id=${r.id} region=${JSON.stringify(r.regional_context)} quote=${JSON.stringify((r.source_quote || '').slice(0, 80))}`);
  }
  if (!apply) { console.log('[drop-localityless] dry run — pass --apply to delete'); db.close(); return; }
  const del = db.prepare('DELETE FROM claims WHERE id = ?');
  const tx = db.transaction(rows => { for (const r of rows) del.run(r.id); });
  tx(doomed);
  console.log(`[drop-localityless] deleted ${doomed.length} claims`);
  db.close();
}

module.exports = { findLocalitylessClaims };
if (require.main === module) main();
