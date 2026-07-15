#!/usr/bin/env node
'use strict';

/**
 * fix-taxonomy-corruption-patch.js — curated correction of 5 GloBI-native entities
 * whose ENTIRE higher-taxonomy lineage was attached to the wrong namesake by a GBIF
 * genus-name collision (see backend/detect-taxonomy-corruption.js + CLAUDE.md
 * "Corrupt entities.phylum" follow-on). GBIF is the collision SOURCE, so these are
 * NOT re-resolvable against it — the corrected lineages below are curated from
 * standard references and each was context-confirmed via the entity's own claims.
 *
 *   Cyathus striatus     bird's-nest fungus  ← ostracod genus Cyathus
 *   Aecidium elongatum   rust fungus         ← scarab beetle Aegidium
 *   Septoria bakeri      leaf-spot fungus    ← spider-mite genus Bryobia
 *   Ficus variegata      fig tree            ← gastropod genus Ficus
 *   Dacrydium cupressinum rimu conifer       ← bivalve genus Dacrydium
 *
 * Dry-run by default (prints the diff). Pass --apply to write. Idempotent: only
 * fields whose current value differs are changed; a name-guard aborts a row if the
 * stored scientific_name no longer matches (e.g. a concurrent id reshuffle). Every
 * field change is recorded in revision_log via lib/revision-log.js.
 *
 * Usage: node fix-taxonomy-corruption-patch.js [--apply]
 */

const Database = require('better-sqlite3');
const { logRevisions } = require('./lib/revision-log');
const { CORPUS_DB } = require('./lib/db-paths.cjs');

const APPLY = process.argv.includes('--apply');
const DB_PATH = CORPUS_DB;

// Curated corrections. `target` lists the CORRECT value for each taxonomy field;
// the script diffs against the live row and changes only what differs.
const CORRECTIONS = [
  { id: 7994, name: 'Cyathus striatus',
    target: { bio_category: 'fungi', kingdom: 'Fungi', phylum: 'Basidiomycota', taxon_class: 'Agaricomycetes', taxon_order: 'Agaricales', family: 'Nidulariaceae', genus: 'Cyathus' },
    reason: "bird's-nest fungus; GBIF mis-resolved to ostracod genus Cyathus (Animalia/Arthropoda)" },
  { id: 209769, name: 'Aecidium elongatum',
    target: { bio_category: 'fungi', kingdom: 'Fungi', phylum: 'Basidiomycota', taxon_class: 'Pucciniomycetes', taxon_order: 'Pucciniales', family: null, genus: 'Aecidium' },
    reason: 'rust form-genus; GBIF mis-resolved to scarab beetle Aegidium. family NULL (anamorph form-genus, no stable family)' },
  { id: 349074, name: 'Septoria bakeri',
    target: { bio_category: 'fungi', kingdom: 'Fungi', phylum: 'Ascomycota', taxon_class: 'Dothideomycetes', taxon_order: 'Capnodiales', family: 'Mycosphaerellaceae', genus: 'Septoria' },
    reason: 'leaf-spot fungus; GBIF mis-resolved to spider-mite genus Bryobia (Arachnida)' },
  { id: 941, name: 'Ficus variegata',
    target: { bio_category: 'plantae', kingdom: 'Plantae', phylum: 'Tracheophyta', taxon_class: 'Magnoliopsida', taxon_order: 'Rosales', family: 'Moraceae', genus: 'Ficus' },
    reason: 'fig tree; GBIF mis-resolved to gastropod genus Ficus (Mollusca). Confirmed plant by the Pteropus fruit-bat seed-dispersal claim' },
  { id: 204381, name: 'Dacrydium cupressinum',
    target: { bio_category: 'plantae', kingdom: 'Plantae', phylum: 'Tracheophyta', taxon_class: 'Pinopsida', taxon_order: 'Pinales', family: 'Podocarpaceae', genus: 'Dacrydium' },
    reason: 'rimu conifer; GBIF mis-resolved to bivalve genus Dacrydium (Mollusca)' },
];

const FIELDS = ['bio_category', 'kingdom', 'phylum', 'taxon_class', 'taxon_order', 'family', 'genus'];

function main() {
  const db = new Database(DB_PATH);
  let totalChanges = 0, applied = 0, skipped = 0;

  const run = db.transaction(() => {
    for (const c of CORRECTIONS) {
      const row = db.prepare(`SELECT id, scientific_name, ${FIELDS.join(', ')} FROM entities WHERE id = ?`).get(c.id);
      if (!row) { console.log(`#${c.id} ${c.name}: NOT FOUND — skipped`); skipped++; continue; }
      if (row.scientific_name !== c.name) {
        console.log(`#${c.id}: name guard FAILED (stored "${row.scientific_name}" ≠ expected "${c.name}") — skipped`);
        skipped++; continue;
      }

      const changes = [];
      for (const f of FIELDS) {
        const before = row[f] ?? null;
        const after = c.target[f] ?? null;
        if (String(before) !== String(after)) changes.push({ field: f, before, after });
      }

      if (!changes.length) { console.log(`#${c.id} ${c.name}: already correct — no change`); continue; }

      console.log(`\n#${c.id} ${c.name}  (scope_tier served=${row.scope_tier ?? 'n'})`);
      for (const ch of changes) console.log(`   ${ch.field}: ${ch.before ?? 'NULL'} → ${ch.after ?? 'NULL'}`);
      totalChanges += changes.length;

      if (APPLY) {
        const setSql = changes.map(ch => `${ch.field} = ?`).join(', ');
        db.prepare(`UPDATE entities SET ${setSql}, updated_at = datetime('now') WHERE id = ?`)
          .run(...changes.map(ch => ch.after), c.id);
        logRevisions(db, {
          targetType: 'entity', targetId: c.id, changes,
          changedBy: 'fix-taxonomy-corruption-patch.js',
          method: 'curated_collision_fix',
          reason: c.reason,
        });
        applied++;
      }
    }
  });

  run();
  db.close();

  console.log(`\n${'='.repeat(60)}`);
  console.log(`${APPLY ? 'APPLIED' : 'DRY-RUN'}: ${totalChanges} field changes across ${CORRECTIONS.length - skipped} entities (skipped ${skipped}).`);
  if (!APPLY) console.log('Re-run with --apply to write + log to revision_log.');
  else console.log(`${applied} entities updated; revision_log rows written.`);
}

main();
