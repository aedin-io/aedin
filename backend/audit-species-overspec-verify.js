#!/usr/bin/env node
/**
 * Ground the borderline congener judgments against the source PDFs.
 * For each (claim_id, search-terms) probe, print every doc line/window that
 * mentions the genus or relevant keyword, so we can see what species (if any)
 * the document itself names.
 */
const fs = require('fs');
const { execSync } = require('child_process');
const { CORPUS_DB } = require('./lib/db-paths.cjs');

const probes = [
  { src: 68, label: 'Alternaria brassicicola / Guam pesticide guide',
    file: null, terms: ['alternaria'] },
  { src: 51, label: 'Chilo partellus / agroecology review',
    file: null, terms: ['stem borer', 'stemborer', 'chilo', 'busseola', 'partellus'] },
  { src: 74, label: 'Diatraea saccharalis / augmentative biocontrol',
    file: null, terms: ['diatraea', 'saccharalis', 'cotesia flavipes'] },
];

const Database = require('better-sqlite3');
const db = new Database(CORPUS_DB, { readonly: true });
for (const p of probes) {
  p.file = db.prepare('SELECT file_path FROM sources WHERE id=?').get(p.src).file_path;
}

for (const p of probes) {
  console.log(`\n===== src#${p.src} ${p.label} =====`);
  console.log(`file: ${p.file}`);
  if (!p.file || !fs.existsSync(p.file)) { console.log('  (no file)'); continue; }
  const txt = execSync(`pdftotext -q ${JSON.stringify(p.file)} -`,
    { maxBuffer: 64 * 1024 * 1024 }).toString().replace(/\s+/g, ' ');
  const low = txt.toLowerCase();
  for (const term of p.terms) {
    let idx = low.indexOf(term), hits = 0;
    while (idx !== -1 && hits < 4) {
      const win = txt.slice(Math.max(0, idx - 60), idx + term.length + 80).replace(/\s+/g, ' ');
      console.log(`  [${term}] …${win}…`);
      idx = low.indexOf(term, idx + 1); hits++;
    }
    if (hits === 0) console.log(`  [${term}] — NOT FOUND in doc`);
  }
}
