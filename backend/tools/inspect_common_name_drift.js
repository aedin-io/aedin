'use strict';
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { CORPUS_DB } = require('../lib/db-paths.cjs');

(async () => {
  const db = await open({ filename: CORPUS_DB, driver: sqlite3.Database });

  console.log('=== Apis mellifera (the canonical bug case from CLAUDE.md) ===');
  const apis = await db.all(`SELECT id, scientific_name, common_name, bio_category, primary_role FROM entities WHERE scientific_name LIKE 'Apis mellifera%'`);
  for (const r of apis) console.log(' ', r);

  console.log('\n=== Entities with " / " in common_name (multi-name issue) ===');
  const slash = await db.all(`SELECT scientific_name, common_name FROM entities WHERE common_name LIKE '% / %' LIMIT 12`);
  console.log(`  total such rows: ${(await db.get(`SELECT COUNT(*) AS n FROM entities WHERE common_name LIKE '% / %'`)).n}`);
  for (const r of slash) console.log(`  ${r.scientific_name}  →  ${r.common_name}`);

  console.log('\n=== Entities with regional/breed/subspecies qualifiers in common_name ===');
  const qualifiers = ['Africanized', 'African', 'European', 'Asian', 'American', 'Western', 'Eastern', 'Northern', 'Southern'];
  for (const q of qualifiers) {
    const rows = await db.all(
      `SELECT scientific_name, common_name FROM entities WHERE common_name LIKE ? AND common_name NOT LIKE ? LIMIT 5`,
      [`${q} %`, `${q} - %`]  // exclude things like "African - Niger"
    );
    if (rows.length > 0) {
      console.log(`\n  qualifier="${q}" (showing up to 5):`);
      for (const r of rows) console.log(`    ${r.scientific_name}  →  ${r.common_name}`);
    }
  }

  console.log('\n=== Entities where common_name matches scientific_name verbatim (lazy population) ===');
  const lazy = await db.get(`SELECT COUNT(*) AS n FROM entities WHERE common_name = scientific_name`);
  console.log(`  count: ${lazy.n}`);

  console.log('\n=== Entities with empty common_name (no human-readable label) ===');
  const empty = await db.get(`SELECT COUNT(*) AS n FROM entities WHERE common_name IS NULL OR common_name = ''`);
  console.log(`  count: ${empty.n}`);

  console.log('\n=== Total entities + common_name coverage ===');
  const tot = await db.get(`SELECT COUNT(*) AS n FROM entities`);
  const withCN = await db.get(`SELECT COUNT(*) AS n FROM entities WHERE common_name IS NOT NULL AND common_name != '' AND common_name != scientific_name`);
  console.log(`  total entities:                 ${tot.n}`);
  console.log(`  with non-trivial common_name:   ${withCN.n} (${(withCN.n / tot.n * 100).toFixed(1)}%)`);

  await db.close();
})().catch(err => { console.error('Fatal:', err); process.exit(1); });
