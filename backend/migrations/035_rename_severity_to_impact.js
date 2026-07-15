'use strict';

/**
 * Migration 035: rename claims.severity_class → claims.impact_class +
 * normalize free-text values to {low, moderate, high, NULL}. Original
 * unmappable values preserved in impact_class_raw for one cycle.
 */

const NORMALIZE = {
  low: 'low', minor: 'low', trace: 'low',
  moderate: 'moderate', medium: 'moderate',
  high: 'high', severe: 'high', outbreak: 'high', major: 'high',
};

async function runMigration(db) {
  const cols = (await db.all(`PRAGMA table_info(claims)`)).map(c => c.name);

  if (cols.includes('severity_class') && !cols.includes('impact_class')) {
    await db.exec(`ALTER TABLE claims RENAME COLUMN severity_class TO impact_class`);
  }

  // re-fetch column list after rename
  const cols2 = (await db.all(`PRAGMA table_info(claims)`)).map(c => c.name);
  if (!cols2.includes('impact_class_raw')) {
    await db.exec(`ALTER TABLE claims ADD COLUMN impact_class_raw TEXT`);
  }

  // Normalize
  const rows = await db.all(`SELECT id, impact_class FROM claims WHERE impact_class IS NOT NULL`);
  for (const r of rows) {
    const key = String(r.impact_class).toLowerCase().trim();
    const mapped = NORMALIZE[key] ?? null;
    if (mapped !== r.impact_class) {
      await db.run(
        `UPDATE claims SET impact_class = ?, impact_class_raw = ? WHERE id = ?`,
        [mapped, mapped === null ? r.impact_class : null, r.id]
      );
    }
  }

  console.log('[migration-035] severity_class → impact_class renamed + normalized.');
}

module.exports = { runMigration };

if (require.main === module) {
  const sqlite3 = require('sqlite3');
  const { open } = require('sqlite');
  const { CORPUS_DB } = require('../lib/db-paths.cjs');
  (async () => {
    const db = await open({ filename: CORPUS_DB, driver: sqlite3.Database });
    await runMigration(db);
    await db.close();
  })().catch(err => { console.error('Fatal:', err); process.exit(1); });
}
