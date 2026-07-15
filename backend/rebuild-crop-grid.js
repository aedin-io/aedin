/**
 * rebuild-crop-grid.js
 * One-time script to build the crop_grid_cells table from the existing interactions DB.
 * Run with: node rebuild-crop-grid.js
 * Takes a few minutes. Only needed once; sync-globi.js handles it on future syncs.
 */
const sqlite3 = require('sqlite3').verbose();
const { RAW_DB, ATTACH_CORPUS_SQL } = require('./lib/db-paths.cjs');
const db = new sqlite3.Database(RAW_DB);
db.run(ATTACH_CORPUS_SQL);

console.log('Building crop geographic grid from existing interactions...');
const start = Date.now();

db.serialize(() => {
  db.run('PRAGMA journal_mode = OFF');
  db.run('PRAGMA synchronous = OFF');

  db.run('DROP TABLE IF EXISTS crop_grid_cells');
  db.run(`CREATE TABLE crop_grid_cells (
    crop_name TEXT,
    lat_cell  INTEGER,
    lng_cell  INTEGER,
    PRIMARY KEY (crop_name, lat_cell, lng_cell)
  )`);

  console.log('  Inserting from source_name side...');
  db.run(`
    INSERT OR IGNORE INTO crop_grid_cells (crop_name, lat_cell, lng_cell)
    SELECT i.source_name, CAST(i.lat AS INTEGER), CAST(i.lng AS INTEGER)
    FROM interactions i
    INNER JOIN corpus.verified_crops vc ON vc.name = i.source_name
    WHERE i.lat IS NOT NULL AND i.lat != 0 AND i.lng IS NOT NULL AND i.lng != 0
  `, function(err) {
    if (err) { console.error('source side error:', err.message); process.exit(1); }
    console.log(`  source_name side done (${this.changes} rows)`);

    console.log('  Inserting from target_name side...');
    db.run(`
      INSERT OR IGNORE INTO crop_grid_cells (crop_name, lat_cell, lng_cell)
      SELECT i.target_name, CAST(i.lat AS INTEGER), CAST(i.lng AS INTEGER)
      FROM interactions i
      INNER JOIN corpus.verified_crops vc ON vc.name = i.target_name
      WHERE i.lat IS NOT NULL AND i.lat != 0 AND i.lng IS NOT NULL AND i.lng != 0
    `, function(err2) {
      if (err2) { console.error('target side error:', err2.message); process.exit(1); }
      console.log(`  target_name side done (${this.changes} additional rows)`);

      db.get('SELECT COUNT(*) as n FROM crop_grid_cells', (err3, row) => {
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        console.log(`Done. ${row.n} crop-grid-cell entries in ${elapsed}s.`);
        console.log('Restart the backend server to use the new table.');
        db.close();
      });
    });
  });
});
