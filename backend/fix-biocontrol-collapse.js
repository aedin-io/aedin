'use strict';
const Database = require('better-sqlite3');
const { CORPUS_DB } = require('./lib/db-paths.cjs');
const { logRevisions } = require('./lib/revision-log');

const CHANGED_BY = 'biocontrol-collapse-fix';
const METHOD = 'fix-biocontrol-collapse';

// 11 dispositions covering all 14 collapsed claims (5 weed claims fixed via 2 entity untags).
// Bucket 3 defaults to quarantine; the agroecologist gate (Task 3) flips any whose
// natural enemy is an identifiable taxon to { kind:'reclassify-attractor', newCategory, newObjectId }.
const DISPOSITIONS = [
  // Bucket 1 — weed untag (entities)
  { kind:'untag-weed', entityId:965,   note:'Hypericum perforatum (St Johns wort) — weed, not vegetable' },
  { kind:'untag-weed', entityId:26347, note:'Cytisus scoparius (Scotch broom) — weed, not vegetable' },
  // Bucket 2 — microbial: named pathogen -> retarget to Erwinia amylovora (5842)
  { kind:'retarget', claimId:6493036, newObjectId:5842, note:'Erwinia herbicola fire-blight -> Erwinia amylovora' },
  { kind:'retarget', claimId:6493037, newObjectId:5842, note:'P. fluorescens fire-blight -> Erwinia amylovora' },
  // Bucket 2 — microbial: generic -> reclassify to facilitation
  { kind:'reclassify', claimId:6493038, newCategory:'facilitation', note:'P. cepacia generic maize soil disease' },
  { kind:'reclassify', claimId:6493035, newCategory:'facilitation', note:'P. fluorescens generic wheat iron-competition' },
  // Bucket 3 — companion plants: agroecologist gate (2026-06-20) finalized below.
  // Identifiable enemy taxon that EXISTS as an entity -> reclassify-attractor + re-point;
  // identifiable-but-absent OR generic guild -> quarantine.
  { kind:'quarantine', claimId:6492399, note:'buckwheat: gate ID\x27d enemy Copidosoma koehleri but it is ABSENT from entities (only congeners) -> quarantine (creating served entity out of scope)' },
  { kind:'reclassify-attractor', claimId:6492397, newCategory:'nectar_provision', newObjectId:373892, note:'Phacelia -> Syrphidae (#373892, hoverflies, family rank) per gate' },
  { kind:'quarantine', claimId:6492400, note:'beetle bank: gate confirms generic guild (beetles/natural enemies, no taxon)' },
  { kind:'reclassify-attractor', claimId:6492171, newCategory:'provides_refuge', newObjectId:16211, note:'banana stems -> Pheidole megacephala (#16211, predatory ant) per gate' },
  { kind:'quarantine', claimId:6492401, note:'weed strip: gate confirms generic guild (aphidophagous predators, no taxon)' },
];

function applyDisposition(db, d) {
  if (d.kind === 'untag-weed') {
    const e = db.prepare('SELECT crop_type, primary_role, edible, vegetable FROM entities WHERE id=?').get(d.entityId);
    if (!e) return { changed:false, reason:'entity absent' };
    if (e.primary_role !== 'weed' || e.edible === 1 || e.vegetable === 1) return { changed:false, reason:'not an untaggable weed' };
    if (e.crop_type == null) return { changed:false, reason:'already untagged' };
    db.prepare('UPDATE entities SET crop_type=NULL WHERE id=?').run(d.entityId);
    logRevisions(db, { targetType:'entity', targetId:d.entityId, changedBy:CHANGED_BY, method:METHOD,
      changes:[{ field:'crop_type', before:e.crop_type, after:null }] });
    return { changed:true };
  }
  if (d.kind === 'retarget') {
    const c = db.prepare('SELECT object_entity_id FROM claims WHERE id=?').get(d.claimId);
    if (!c) return { changed:false, reason:'claim absent' };
    if (c.object_entity_id === d.newObjectId) return { changed:false, reason:'already retargeted' };
    db.prepare('UPDATE claims SET object_entity_id=? WHERE id=?').run(d.newObjectId, d.claimId);
    logRevisions(db, { targetType:'claim', targetId:d.claimId, changedBy:CHANGED_BY, method:METHOD,
      changes:[{ field:'object_entity_id', before:c.object_entity_id, after:d.newObjectId }] });
    return { changed:true };
  }
  if (d.kind === 'reclassify' || d.kind === 'reclassify-attractor') {
    const c = db.prepare('SELECT interaction_category, object_entity_id FROM claims WHERE id=?').get(d.claimId);
    if (!c) return { changed:false, reason:'claim absent' };
    const changes = [];
    if (c.interaction_category !== d.newCategory) {
      db.prepare('UPDATE claims SET interaction_category=? WHERE id=?').run(d.newCategory, d.claimId);
      changes.push({ field:'interaction_category', before:c.interaction_category, after:d.newCategory });
    }
    if (d.newObjectId != null && c.object_entity_id !== d.newObjectId) {
      db.prepare('UPDATE claims SET object_entity_id=? WHERE id=?').run(d.newObjectId, d.claimId);
      changes.push({ field:'object_entity_id', before:c.object_entity_id, after:d.newObjectId });
    }
    if (!changes.length) return { changed:false, reason:'already classified' };
    logRevisions(db, { targetType:'claim', targetId:d.claimId, changedBy:CHANGED_BY, method:METHOD, changes });
    return { changed:true };
  }
  if (d.kind === 'quarantine') {
    const c = db.prepare('SELECT review_status FROM claims WHERE id=?').get(d.claimId);
    if (!c) return { changed:false, reason:'claim absent' };
    if (c.review_status === 'quarantined_generic') return { changed:false, reason:'already quarantined' };
    db.prepare("UPDATE claims SET review_status='quarantined_generic' WHERE id=?").run(d.claimId);
    logRevisions(db, { targetType:'claim', targetId:d.claimId, changedBy:CHANGED_BY, method:METHOD,
      changes:[{ field:'review_status', before:c.review_status, after:'quarantined_generic' }] });
    return { changed:true };
  }
  throw new Error('unknown disposition kind: ' + d.kind);
}

function main() {
  const apply = process.argv.includes('--apply');
  const db = new Database(CORPUS_DB);
  const results = [];
  const run = db.transaction(() => {
    for (const d of DISPOSITIONS) results.push({ d, r: applyDisposition(db, d) });
  });
  if (!apply) { db.close(); console.log('DRY RUN — dispositions:'); DISPOSITIONS.forEach(d => console.log('  ', JSON.stringify(d))); console.log('Re-run with --apply.'); return; }
  run();
  db.close();
  const changed = results.filter(x => x.r.changed).length;
  console.log(`Applied. ${changed}/${results.length} dispositions changed state.`);
  results.forEach(x => console.log('  ', x.r.changed ? 'CHANGED' : 'skip', x.d.kind, x.d.claimId || x.d.entityId, x.r.reason || ''));
}

if (require.main === module) main();
module.exports = { applyDisposition, DISPOSITIONS };
