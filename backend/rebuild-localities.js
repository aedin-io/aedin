/**
 * rebuild-localities.js
 * Rebuilds interaction_locality_coverage, species_locality_coverage, and
 * crop_locality_coverage using direct bounding box range queries against the
 * interactions table — no grid intermediary.
 *
 * Usage: node rebuild-localities.js
 */
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { RAW_DB, ATTACH_CORPUS_SQL } = require('./lib/db-paths.cjs');

const REGIONS_PATH = path.join(__dirname, '../ui-prototype/src/regions.json');
const db = new sqlite3.Database(RAW_DB);
db.run(ATTACH_CORPUS_SQL);
const start = Date.now();

console.log('Loading regions.json...');
const regions = JSON.parse(fs.readFileSync(REGIONS_PATH, 'utf8'));

// Flatten into locality objects with parsed float bboxes
const localities = [];
for (const [country, data] of Object.entries(regions)) {
  if (data.bbox) {
    const [minLng, minLat, maxLng, maxLat] = data.bbox.split(',').map(Number);
    localities.push({ country, subdivision: '', minLat, maxLat, minLng, maxLng });
  }
  for (const sub of (data.subdivisions || [])) {
    if (sub.bbox) {
      const [minLng, minLat, maxLng, maxLat] = sub.bbox.split(',').map(Number);
      localities.push({ country, subdivision: sub.name, minLat, maxLat, minLng, maxLng });
    }
  }
}
console.log(`  ${localities.length} localities loaded (${Object.keys(regions).length} countries)`);

db.serialize(() => {
  db.run('PRAGMA journal_mode = OFF');
  db.run('PRAGMA synchronous = OFF');

  // Drop old grid tables (no longer needed)
  db.run('DROP TABLE IF EXISTS grid_locality');
  db.run('DROP TABLE IF EXISTS species_grid_cells');
  db.run('DROP TABLE IF EXISTS crop_grid_cells');

  // Create the 3 coverage tables fresh
  db.run('DROP TABLE IF EXISTS interaction_locality_coverage');
  db.run(`CREATE TABLE interaction_locality_coverage (
    source_name TEXT,
    target_name TEXT,
    country     TEXT,
    subdivision TEXT,
    PRIMARY KEY (source_name, target_name, country, subdivision)
  )`);

  db.run('DROP TABLE IF EXISTS species_locality_coverage');
  db.run(`CREATE TABLE species_locality_coverage (
    species_name TEXT,
    country      TEXT,
    subdivision  TEXT,
    PRIMARY KEY (species_name, country, subdivision)
  )`);

  db.run('DROP TABLE IF EXISTS crop_locality_coverage');
  db.run(`CREATE TABLE crop_locality_coverage (
    crop_name   TEXT,
    country     TEXT,
    subdivision TEXT,
    PRIMARY KEY (crop_name, country, subdivision)
  )`);

  db.run('BEGIN');

  let i = 0;
  function processNext() {
    if (i >= localities.length) {
      db.run('COMMIT', () => {
        console.log('\nCommitted. Building indexes...');

        db.run('CREATE INDEX IF NOT EXISTS idx_ilc_source ON interaction_locality_coverage(source_name, country, subdivision)');
        db.run('CREATE INDEX IF NOT EXISTS idx_ilc_country ON interaction_locality_coverage(country, subdivision)');
        db.run('CREATE INDEX IF NOT EXISTS idx_slc_country ON species_locality_coverage(country, subdivision)');
        db.run('CREATE INDEX IF NOT EXISTS idx_clc_country ON crop_locality_coverage(country, subdivision)', () => {
          // Report row counts
          db.get('SELECT COUNT(*) AS n FROM interaction_locality_coverage', (_, r1) => {
            db.get('SELECT COUNT(*) AS n FROM species_locality_coverage', (_, r2) => {
              db.get('SELECT COUNT(*) AS n FROM crop_locality_coverage', (_, r3) => {
                const elapsed = ((Date.now() - start) / 1000).toFixed(1);
                console.log(`  interaction_locality_coverage: ${r1 ? r1.n : '?'} rows`);
                console.log(`  species_locality_coverage:     ${r2 ? r2.n : '?'} rows`);
                console.log(`  crop_locality_coverage:        ${r3 ? r3.n : '?'} rows`);
                console.log(`Done. All locality tables rebuilt in ${elapsed}s.`);
                console.log('Restart the backend server to use the new tables.');
                db.close();
              });
            });
          });
        });
      });
      return;
    }

    const loc = localities[i++];
    const { country, subdivision, minLat, maxLat, minLng, maxLng } = loc;
    process.stdout.write(`\r  [${i}/${localities.length}] ${country} / ${subdivision || '(country-level)'}          `);

    const latArgs = [minLat, maxLat, minLng, maxLng];

    db.run(`
      INSERT OR IGNORE INTO interaction_locality_coverage (source_name, target_name, country, subdivision)
      SELECT DISTINCT source_name, target_name, ?, ?
      FROM interactions
      WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?
        AND lat IS NOT NULL AND lat != 0 AND lng IS NOT NULL AND lng != 0
    `, [country, subdivision, ...latArgs], (err) => {
      if (err) console.error('\ninteraction_locality_coverage error:', err.message);

      db.run(`
        INSERT OR IGNORE INTO species_locality_coverage (species_name, country, subdivision)
        SELECT DISTINCT source_name, ?, ? FROM interactions
        WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?
          AND lat IS NOT NULL AND lat != 0 AND lng IS NOT NULL AND lng != 0
        UNION
        SELECT DISTINCT target_name, ?, ? FROM interactions
        WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?
          AND lat IS NOT NULL AND lat != 0 AND lng IS NOT NULL AND lng != 0
      `, [country, subdivision, ...latArgs, country, subdivision, ...latArgs], (err2) => {
        if (err2) console.error('\nspecies_locality_coverage error:', err2.message);

        db.run(`
          INSERT OR IGNORE INTO crop_locality_coverage (crop_name, country, subdivision)
          SELECT DISTINCT i.source_name, ?, ? FROM interactions i
          JOIN corpus.verified_crops vc ON vc.name = i.source_name
          WHERE i.lat BETWEEN ? AND ? AND i.lng BETWEEN ? AND ?
            AND i.lat IS NOT NULL AND i.lat != 0 AND i.lng IS NOT NULL AND i.lng != 0
          UNION
          SELECT DISTINCT i.target_name, ?, ? FROM interactions i
          JOIN corpus.verified_crops vc ON vc.name = i.target_name
          WHERE i.lat BETWEEN ? AND ? AND i.lng BETWEEN ? AND ?
            AND i.lat IS NOT NULL AND i.lat != 0 AND i.lng IS NOT NULL AND i.lng != 0
        `, [country, subdivision, ...latArgs, country, subdivision, ...latArgs], (err3) => {
          if (err3) console.error('\ncrop_locality_coverage error:', err3.message);
          processNext();
        });
      });
    });
  }

  processNext();
});
