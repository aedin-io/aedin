#!/usr/bin/env node
'use strict';
/**
 * curate-family-rules.js — phase 1 of the gated family-rule curation pass.
 *
 * Emits a REVIEW PACKET: every unruled family above an entity threshold, with
 * its genus composition, kingdom, current role distribution, and any
 * contaminant genera detected by lib/family-triage.js.
 *
 * This script asserts nothing. It produces the evidence a domain critic needs
 * (plant-pathologist / entomologist / agroecologist), whose verdict — assert a
 * role, mark the family `assertable: false`, or assert with species exclusions
 * — is what phase 3 applies. Reading a family NAME and recalling what the taxon
 * usually is, without looking at the organisms actually filed under it, is the
 * reasoning that produced fungi->pathogen_fungal.
 *
 * Design + rationale: docs/superpowers/specs/2026-08-21-taxonomy-rule-graph-design.md
 *
 *   node curate-family-rules.js                       # summary to stdout
 *   node curate-family-rules.js --min-entities=500    # widen/narrow the net
 *   node curate-family-rules.js --out=packet.json     # write the packet
 *
 * Worktrees have no local corpus DB; point at the real one with
 *   AEDIN_CORPUS_DB=/path/to/backend/aedin.sqlite
 */
const fs = require('fs');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { CORPUS_DB } = require('./lib/db-paths.cjs');
const { triageFamily } = require('./lib/family-triage.js');

const DB_PATH = process.env.AEDIN_CORPUS_DB || CORPUS_DB;

function argValue(flag, fallback) {
  const hit = process.argv.find(a => a.startsWith(`--${flag}=`));
  return hit ? hit.slice(flag.length + 3) : fallback;
}

// Families carrying no enabled family-rank rule, ranked by entities at stake.
const CANDIDATES_SQL = `
  SELECT e.family AS family, COUNT(*) AS entity_count
  FROM entities e
  WHERE e.family IS NOT NULL AND e.family <> ''
    AND e.merged_into_entity_id IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM role_rules r
      WHERE r.enabled = 1
        AND r.rule_type IN ('taxonomy_family', 'biocontrol_family')
        AND lower(r.match_value) = lower(e.family)
    )
  GROUP BY e.family
  HAVING entity_count >= ?
  ORDER BY entity_count DESC`;

(async () => {
  const minEntities = Number(argValue('min-entities', '500'));
  const outPath = argValue('out', null);

  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });
  const candidates = await db.all(CANDIDATES_SQL, [minEntities]);

  const packet = [];
  for (const { family, entity_count } of candidates) {
    const genera = await db.all(
      `SELECT genus, COUNT(*) AS count FROM entities
       WHERE family = ? AND genus IS NOT NULL AND genus <> ''
       GROUP BY genus ORDER BY count DESC`, [family]);
    const kingdoms = await db.all(
      `SELECT kingdom, COUNT(*) AS count FROM entities
       WHERE family = ? AND kingdom IS NOT NULL AND kingdom <> ''
       GROUP BY kingdom ORDER BY count DESC`, [family]);
    const roles = await db.all(
      `SELECT primary_role, COUNT(*) AS count FROM entities
       WHERE family = ? GROUP BY primary_role ORDER BY count DESC`, [family]);

    const entry = triageFamily({ family, entityCount: entity_count, genera });
    entry.kingdom = kingdoms.length ? kingdoms[0].kingdom : null;
    entry.roleDistribution = roles;
    packet.push(entry);
  }
  await db.close();

  const contaminated = packet.filter(e => e.verdict === 'contaminated');
  console.log(`=== family-rule curation · review packet ===`);
  console.log(`db            ${DB_PATH}`);
  console.log(`threshold     >= ${minEntities} entities`);
  console.log(`candidates    ${packet.length} unruled families`);
  console.log(`at stake      ${packet.reduce((n, e) => n + e.entityCount, 0)} entities`);
  console.log(`contaminated  ${contaminated.length} (a family rule would mislabel a known biocontrol)\n`);

  for (const e of packet) {
    const flag = e.verdict === 'contaminated' ? '  <-- CONTAMINATED' : '';
    const top = e.genera.slice(0, 5).map(g => `${g.genus}:${g.count}`).join(' ');
    console.log(`${String(e.entityCount).padStart(6)}  ${(e.kingdom || '?').padEnd(10)} ${e.family.padEnd(24)} ${top}${flag}`);
    for (const c of e.contaminants) console.log(`          ! ${c.genus} (${c.kind}) — ${c.note}`);
  }

  if (outPath) {
    fs.writeFileSync(outPath, JSON.stringify(packet, null, 2));
    console.log(`\nPacket written to ${outPath} (${packet.length} families) — route to domain critics.`);
  }
})().catch(err => { console.error(err); process.exit(1); });
