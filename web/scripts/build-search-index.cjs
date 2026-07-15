'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { resolveBuildDbPath } = require('./lib/resolve-build-db.cjs');

const ROWS_SQL = `
  SELECT slug, scientific_name, common_name, primary_role, bio_category, family
  FROM entities
  WHERE slug IS NOT NULL AND (
    scope_tier IS NOT NULL
    OR id IN (SELECT subject_entity_id FROM claims WHERE review_status='ai_reviewed')
    OR id IN (SELECT object_entity_id  FROM claims WHERE review_status='ai_reviewed' AND object_entity_id IS NOT NULL)
  )
  ORDER BY scientific_name`;

function selectSearchRows(db) { return db.prepare(ROWS_SQL).all(); }

function main() {
  const db = new Database(resolveBuildDbPath(), { readonly: true });
  const rows = selectSearchRows(db);
  const outDir = path.join(__dirname, '..', 'public');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'entity-index.json'), JSON.stringify(rows));
  console.log(`public/entity-index.json: ${rows.length} entities`);
  db.close();
}

module.exports = { selectSearchRows };
if (require.main === module) main();
