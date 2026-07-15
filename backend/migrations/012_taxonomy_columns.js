/**
 * 012_taxonomy_columns.js
 *
 * Adds discrete taxonomy rank columns to entities table:
 *   kingdom, phylum, taxon_class, taxon_order
 *
 * Note: "class" and "order" are SQL reserved words, so we use
 * taxon_class and taxon_order as column names.
 */
'use strict';

const columns = [
  'kingdom TEXT',
  'phylum TEXT',
  'taxon_class TEXT',
  'taxon_order TEXT',
];

async function runMigration(db) {
  const existing = await db.all('PRAGMA table_info(entities)');
  const names = new Set(existing.map(c => c.name));

  let added = 0;
  for (const col of columns) {
    const colName = col.split(' ')[0];
    if (!names.has(colName)) {
      await db.run(`ALTER TABLE entities ADD COLUMN ${col}`);
      added++;
    }
  }

  // Index on kingdom for bio_category reclassification
  await db.run('CREATE INDEX IF NOT EXISTS idx_entities_kingdom ON entities(kingdom)');

  if (added > 0) console.log(`[migration-012] Added ${added} taxonomy columns.`);
  else console.log('[migration-012] Taxonomy columns already exist.');
}

module.exports = { runMigration };
