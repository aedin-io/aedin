const sqlite3 = require('sqlite3').verbose();
const { CORPUS_DB, ATTACH_RAW_SQL } = require('./lib/db-paths.cjs');
const db = new sqlite3.Database(CORPUS_DB);

console.log('Adding indexes and plants table to aedin.sqlite (this may take 2-4 minutes)...');
db.run(ATTACH_RAW_SQL);

db.serialize(() => {
  db.run('CREATE INDEX IF NOT EXISTS raw.idx_source_name ON interactions(source_name)', err => {
    if (err) console.error('idx_source_name error:', err.message);
    else console.log('✓ idx_source_name done');
  });
  db.run('CREATE INDEX IF NOT EXISTS raw.idx_target_name ON interactions(target_name)', err => {
    if (err) console.error('idx_target_name error:', err.message);
    else console.log('✓ idx_target_name done');
  });

  // Materialized plants table — makes /api/crops instant after this runs once
  console.log('Building plants table (full scan, takes ~1-2 min)...');
  db.run('DROP TABLE IF EXISTS plants', () => {});
  db.run(`
    CREATE TABLE plants AS
    SELECT DISTINCT source_name as name, source_path as path
    FROM raw.interactions WHERE source_path LIKE '%plantae%'
    UNION
    SELECT DISTINCT target_name as name, target_path as path
    FROM raw.interactions WHERE target_path LIKE '%plantae%'
  `, err => {
    if (err) console.error('plants table error:', err.message);
    else console.log('✓ plants table done');
  });
  db.run('CREATE INDEX IF NOT EXISTS idx_plants_name ON plants(name)', err => {
    if (err) console.error('idx_plants_name error:', err.message);
    else console.log('✓ idx_plants_name done');
    console.log('All done. Restart server.js now.');
    db.close();
  });
});
