'use strict';
const path = require('path');
const { logRevisions } = require('./lib/revision-log');

// Preferred-English → any-English → NULL. (is_preferred=1 is a Wikidata curated name.)
// Quality-aware scorer: penalises pseudo-scientific restatements and bare abbreviations.
function derivePreferredEnglish(db, entityId) {
  const ent = db.prepare('SELECT scientific_name FROM entities WHERE id = ?').get(entityId);
  const sci = (ent && ent.scientific_name ? String(ent.scientific_name) : '').toLowerCase();
  const parts = sci.split(/\s+/).filter(Boolean);
  const genus = parts[0] || '';
  const epithet = parts[1] || '';
  const rows = db.prepare(
    "SELECT name, is_preferred FROM entity_common_names WHERE entity_id = ? AND language = 'en'"
  ).all(entityId);
  if (!rows.length) return null;

  // Structural penalty: lower is better. Flags pseudo-scientific restatements + abbreviations.
  const penalty = (name) => {
    const words = name.toLowerCase().split(/[\s\-/]+/).filter(Boolean);
    let p = 0;
    if (genus && words.includes(genus)) p += 100;                  // restates the genus ("Calvia 14-guttata")
    if (epithet && epithet.length > 3 && words.includes(epithet)) p += 100; // restates the species epithet
    if (!words.some((w) => /^[a-z]{3,}$/.test(w))) p += 50;         // no real alphabetic word (e.g. "P14")
    return p;
  };

  const scored = rows.map((r) => ({ name: r.name, p: penalty(r.name), pref: r.is_preferred ? 1 : 0 }));
  scored.sort((a, b) =>
    (a.p - b.p) || (b.pref - a.pref) || (a.name.length - b.name.length) || (a.name < b.name ? -1 : 1)
  );
  const best = scored[0];
  // If even the best English option is pseudo-scientific / an abbreviation, prefer the scientific-name fallback.
  if (best.p >= 50) return null;
  return best.name;
}

// Recompute entities.common_name for every entity that has any common-name rows
// (the SOLE authority; overwrites unconditionally). Logs each actual change.
function run(db, { changedBy = 'derive-display-name' } = {}) {
  const ids = db.prepare('SELECT DISTINCT entity_id FROM entity_common_names').all().map(r => r.entity_id);
  const sel = db.prepare('SELECT common_name FROM entities WHERE id = ?');
  const upd = db.prepare("UPDATE entities SET common_name = ?, updated_at = datetime('now') WHERE id = ?");
  let changed = 0;
  for (const id of ids) {
    const before = sel.get(id);
    if (!before) continue;
    const after = derivePreferredEnglish(db, id);
    if ((before.common_name || null) === (after || null)) continue;
    upd.run(after, id);
    logRevisions(db, {
      targetType: 'entity', targetId: id,
      changes: [{ field: 'common_name', before: before.common_name, after }],
      changedBy, method: 'multilingual_common_names',
    });
    changed++;
  }
  return { changed, total: ids.length };
}

async function main() {
  const Database = require('better-sqlite3');
  const { CORPUS_DB } = require('./lib/db-paths.cjs');
  const db = new Database(CORPUS_DB);
  const res = run(db, { changedBy: 'derive-display-name' });
  console.log(`derive-display-name: ${res.changed} of ${res.total} entities updated`);
  db.close();
}
if (require.main === module) main();
module.exports = { derivePreferredEnglish, run };
