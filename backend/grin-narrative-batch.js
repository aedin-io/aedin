'use strict';
/**
 * grin-narrative-batch.js — emit subject-pinned extraction batches from
 * grin_varieties.narrative. Phase 1 (resistance) selects resistance/tolerance
 * narratives; Phase 2 (traits) selects all non-empty narratives.
 *
 * Each emitted row pins the claim's subject: parent_scientific_name + the
 * EXISTING served variety's variety_name (so the downstream promote attaches to
 * that served entity rather than minting a duplicate). For unserved varieties
 * variety_entity_id is null and variety_name falls back to plant_name; promote's
 * resolveEntityForClaim then auto-creates the (unserved) variety entity.
 *
 * Usage:
 *   node grin-narrative-batch.js --phase=resistance [--batch-size=20] [--out-dir=DIR]
 */

const PHASE_FILTERS = {
  // resistance: narrative mentions resistance OR tolerance
  resistance: `(LOWER(gv.narrative) LIKE '%resist%' OR LOWER(gv.narrative) LIKE '%toleran%')`,
  // traits: any non-empty narrative
  traits: `1=1`,
};

function selectGrinNarratives(db, phase) {
  const filter = PHASE_FILTERS[phase];
  if (!filter) throw new Error(`unknown phase: ${phase}`);
  return db.prepare(`
    SELECT
      gv.grin_accession                         AS grin_accession,
      pe.scientific_name                        AS parent_scientific_name,
      ve.id                                     AS variety_entity_id,
      COALESCE(ve.variety_name, gv.plant_name)  AS variety_name,
      gv.narrative                              AS narrative
    FROM grin_varieties gv
    JOIN entities pe ON pe.id = gv.parent_entity_id
    -- Assumes at most ONE served entity per (grin_accession, parent_entity_id).
    -- entities.grin_accession is a non-unique index, so a duplicate variety
    -- entity (a typo-dedup artifact, see CLAUDE.md open issues) would fan a
    -- narrative into N rows. Verified 0 such duplicates in the corpus (and 0
    -- in the Phase-1 set) at build time; if the dedup tail reintroduces one,
    -- collapse this join with MIN(ve.id) before the next operational run.
    LEFT JOIN entities ve
      ON ve.grin_accession = gv.grin_accession
     AND ve.parent_entity_id = gv.parent_entity_id
    WHERE gv.narrative IS NOT NULL AND TRIM(gv.narrative) <> ''
      AND ${filter}
    ORDER BY gv.grin_accession
  `).all();
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

module.exports = { selectGrinNarratives, chunk };

if (require.main === module) {
  const fs = require('fs');
  const path = require('path');
  const Database = require('better-sqlite3');
  const { CORPUS_DB } = require('./lib/db-paths.cjs');
  const argv = process.argv.slice(2);
  const flag = (n, d) => {
    const a = argv.find(s => s.startsWith(`--${n}=`));
    return a ? a.split('=', 2)[1] : d;
  };
  const phase = flag('phase', 'resistance');
  const batchSize = parseInt(flag('batch-size', '20'), 10) || 20;
  const outDir = flag('out-dir', process.env.BATCH_OUT_DIR || path.join(__dirname, 'grin-batches'));

  const db = new Database(CORPUS_DB, { readonly: true });
  const rows = selectGrinNarratives(db, phase);
  db.close();

  fs.mkdirSync(outDir, { recursive: true });
  for (const f of fs.readdirSync(outDir)) {
    if (f.startsWith('extract-') && f.endsWith('.json')) fs.unlinkSync(path.join(outDir, f));
  }
  const batches = chunk(rows, batchSize);
  batches.forEach((batch, i) => {
    const fname = `extract-${String(i).padStart(3, '0')}.json`;
    fs.writeFileSync(path.join(outDir, fname), JSON.stringify(batch, null, 2));
  });
  console.log(`[grin-batch] phase=${phase} narratives=${rows.length} batches=${batches.length} → ${outDir}`);
}
