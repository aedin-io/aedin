'use strict';
// Upsert one name record, deduping on (entity_id, language, name COLLATE NOCASE).
// On conflict: merge sources (comma-joined, deduped) and OR the is_preferred flag.
function upsertName(db, entityId, rec) {
  if (!rec || !rec.name || !rec.language) return;
  const existing = db.prepare(
    `SELECT id, source, is_preferred FROM entity_common_names
     WHERE entity_id = ? AND language = ? AND name = ? COLLATE NOCASE`
  ).get(entityId, rec.language, rec.name);

  if (!existing) {
    db.prepare(
      `INSERT INTO entity_common_names (entity_id, name, language, source, source_ref, is_preferred)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(entityId, rec.name, rec.language, rec.source, rec.source_ref || null, rec.is_preferred ? 1 : 0);
    return;
  }
  const sources = Array.from(new Set(String(existing.source || '').split(',').concat(rec.source))).filter(Boolean).sort().join(',');
  const preferred = existing.is_preferred || (rec.is_preferred ? 1 : 0);
  db.prepare(
    `UPDATE entity_common_names SET source = ?, is_preferred = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(sources, preferred, existing.id);
}

module.exports = { upsertName };
