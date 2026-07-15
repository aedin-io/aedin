'use strict';
// Reversible applier for the disease-vector re-encode (Phase 2a: flip + quarantine).
// planActions is pure; main() does the DB writes (dry-run default, --apply to write),
// logging every change to revision_log with a JSON backup first.
const path = require('path');

function planActions(rows, decisions) {
  const byId = new Map(rows.map(r => [r.id, r]));
  const updates = [];
  const skipped = [];
  for (const [idStr, dec] of Object.entries(decisions || {})) {
    const id = Number(idStr);
    const r = byId.get(id);
    if (!r) { skipped.push({ id, why: 'id not in rows' }); continue; }
    if (dec.action === 'flip') {
      if (r.interaction_category === 'disease_vector') { skipped.push({ id, why: 'already disease_vector' }); continue; }
      updates.push({
        id,
        set: { interaction_category: 'disease_vector', interaction_type_globi: 'vectorOf' },
        before: { interaction_category: r.interaction_category, interaction_type_globi: r.interaction_type_globi },
      });
    } else if (dec.action === 'quarantine') {
      const status = 'quarantined_' + (dec.reason || 'review');
      if (r.review_status === status) { skipped.push({ id, why: 'already ' + status }); continue; }
      updates.push({ id, set: { review_status: status }, before: { review_status: r.review_status } });
    } else if (dec.action === 'repoint') {
      const pathogenId = dec.pathogenId;
      if (typeof pathogenId !== 'number' || !Number.isFinite(pathogenId)) {
        skipped.push({ id, why: 'repoint requires pathogenId to be a finite number' }); continue;
      }
      if (r.object_entity_id === pathogenId && r.interaction_category === 'disease_vector') {
        skipped.push({ id, why: 'already repointed (object_entity_id=' + pathogenId + ', disease_vector)' }); continue;
      }
      updates.push({
        id,
        set: { object_entity_id: pathogenId, interaction_category: 'disease_vector', interaction_type_globi: 'vectorOf' },
        before: { object_entity_id: r.object_entity_id, interaction_category: r.interaction_category, interaction_type_globi: r.interaction_type_globi },
      });
    } else if (dec.action === 'repurpose') {
      const pathogenId = dec.pathogenId;
      if (typeof pathogenId !== 'number' || !Number.isFinite(pathogenId)) {
        skipped.push({ id, why: 'repurpose requires pathogenId to be a finite number' }); continue;
      }
      if (r.subject_entity_id === pathogenId && r.interaction_category === 'pathogen_pressure') {
        skipped.push({ id, why: 'already repurposed (subject_entity_id=' + pathogenId + ', pathogen_pressure)' }); continue;
      }
      updates.push({
        id,
        set: { subject_entity_id: pathogenId, interaction_category: 'pathogen_pressure', interaction_type_globi: 'pathogenOf' },
        before: { subject_entity_id: r.subject_entity_id, interaction_category: r.interaction_category, interaction_type_globi: r.interaction_type_globi },
      });
    } else {
      skipped.push({ id, why: 'unknown action: ' + dec.action });
    }
  }
  return { updates, skipped };
}

module.exports = { planActions };

if (require.main === module) {
  const Database = require('better-sqlite3');
  const fs = require('fs');
  const { CORPUS_DB } = require('./lib/db-paths.cjs');
  const { logRevisions } = require('./lib/revision-log');
  const apply = process.argv.includes('--apply');
  const methodArg = (process.argv.find(a => a.startsWith('--method=')) || '').split('=')[1];
  const method = methodArg || 'vector_reencode_2a';
  const decPathArg = (process.argv.find(a => a.startsWith('--decisions=')) || '').split('=')[1];
  const decPath = decPathArg || path.join(__dirname, 'data', 'vector-reencode-2a-decisions.json');
  const decisions = JSON.parse(fs.readFileSync(decPath, 'utf8'));
  const ids = Object.keys(decisions).map(Number);
  if (ids.length === 0) { console.log('No decisions — nothing to do.'); process.exit(0); }
  const db = new Database(CORPUS_DB);
  const rows = db.prepare(
    `SELECT id, interaction_category, interaction_type_globi, review_status, subject_entity_id, object_entity_id FROM claims WHERE id IN (${ids.map(() => '?').join(',')})`
  ).all(...ids);
  const { updates, skipped } = planActions(rows, decisions);
  console.log(`decisions=${ids.length} updates=${updates.length} skipped=${skipped.length}`);
  for (const s of skipped) console.log('  skip', s.id, s.why);
  if (!apply) { console.log('DRY RUN — pass --apply to write'); process.exit(0); }
  if (updates.length === 0) { console.log('Nothing to apply.'); db.close(); process.exit(0); }
  // backup the full affected rows first
  const stamp = process.env.STAMP || 'manual';
  const backupRows = db.prepare(`SELECT * FROM claims WHERE id IN (${updates.map(() => '?').join(',')})`).all(...updates.map(u => u.id));
  const backupPath = path.join(__dirname, 'backups', `vector-reencode-2a-${stamp}.json`);
  fs.mkdirSync(path.join(__dirname, 'backups'), { recursive: true });
  fs.writeFileSync(backupPath, JSON.stringify(backupRows, null, 2));
  console.log('backup written:', backupPath);
  const tx = db.transaction(() => {
    for (const u of updates) {
      const cols = Object.keys(u.set);
      db.prepare(`UPDATE claims SET ${cols.map(c => c + '=?').join(', ')} WHERE id=?`).run(...cols.map(c => u.set[c]), u.id);
      logRevisions(db, {
        targetType: 'claim', targetId: u.id, changedBy: 'reencode-vector-claims',
        method,
        changes: cols.map(c => ({ field: c, before: u.before[c], after: u.set[c] })),
      });
    }
  });
  tx();
  console.log(`APPLIED ${updates.length} updates.`);
  db.close();
}
