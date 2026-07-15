#!/usr/bin/env node
'use strict';
/**
 * audit-crop-slot-types.js — size the deterministic crop entity-type gate before/after wiring.
 *
 * For every crop_vulnerabilities staging row (the crop is the `object`), resolve the crop name
 * to an entities.bio_category and run lib/crop-entity-type-gate::cropSlotVerdict. Reports how many
 * crop-slot organisms would be REJECTED (clear animal in a crop field — the field_mislabel error
 * class) vs FLAGGED (microbe) vs OK (plant/fungi/unknown). Lists the reject cases so a human can
 * confirm they are genuine mislabels (low false-positive risk).
 *
 * Read-only. Usage: node audit-crop-slot-types.js
 */
const { CORPUS_DB } = require('./lib/db-paths.cjs');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { cropSlotVerdict } = require('./lib/crop-entity-type-gate');

function pick(p, ...keys) { for (const k of keys) if (p[k] != null && p[k] !== '') return p[k]; return null; }

(async () => {
  const db = await open({ filename: CORPUS_DB, driver: sqlite3.Database });
  const rows = await db.all(`
    SELECT id, payload FROM extraction_staging
    WHERE target_table='crop_vulnerabilities' AND ai_vouch_status IN ('plausible','uncertain')
  `);
  const tally = { ok: 0, flag: 0, reject: 0, unresolved: 0 };
  const rejects = [], flags = [];
  for (const r of rows) {
    let p; try { p = JSON.parse(r.payload); } catch { continue; }
    const crop = pick(p, 'crop', 'crop_scientific_name');
    if (!crop) { tally.unresolved++; continue; }
    const ent = await db.get('SELECT bio_category, kingdom FROM entities WHERE scientific_name = ? COLLATE NOCASE', crop);
    if (!ent) { tally.unresolved++; continue; }
    const v = cropSlotVerdict(ent.bio_category, ent.kingdom);
    tally[v.severity]++;
    if (v.severity === 'reject') rejects.push({ staging_id: r.id, crop, bio: ent.bio_category, kingdom: ent.kingdom });
    else if (v.severity === 'flag') flags.push({ staging_id: r.id, crop, bio: ent.bio_category, kingdom: ent.kingdom });
  }
  console.log(`crop_vulnerabilities staging rows (vouched): ${rows.length}`);
  console.log(`resolved-to-entity verdicts: ok=${tally.ok} flag=${tally.flag} reject=${tally.reject} (unresolved/no-entity=${tally.unresolved})`);
  const judged = tally.ok + tally.flag + tally.reject;
  console.log(`REJECT rate among resolved: ${judged ? (100 * tally.reject / judged).toFixed(2) : 0}%  (low = safe to wire)`);
  if (rejects.length) { console.log('\n--- REJECTED crop-slot organisms (verify these are genuine animal-in-crop mislabels) ---'); for (const x of rejects.slice(0, 25)) console.log(`  staging ${x.staging_id}: "${x.crop}" -> ${x.bio}`); }
  if (flags.length) { console.log('\n--- FLAGGED (microbe in crop slot) ---'); for (const x of flags.slice(0, 15)) console.log(`  staging ${x.staging_id}: "${x.crop}" -> ${x.bio}`); }
  await db.close();
})().catch(e => { console.error('Fatal:', e); process.exit(1); });
