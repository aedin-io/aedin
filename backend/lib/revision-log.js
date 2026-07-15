'use strict';

/**
 * revision-log.js — shared writer for the revision_log audit trail (migration
 * 055). Every script that mutates an entity or claim field calls logRevisions
 * so the change (old → new) is queryable + displayable on the item's page.
 *
 * better-sqlite3 (sync). Only fields whose value actually changed are recorded.
 */

// Normalise for comparison so 'NULL'→value and same-value-rewrites aren't logged.
const norm = (v) => (v === undefined || v === null) ? null : String(v);

/**
 * @param {Database} db  better-sqlite3 handle
 * @param {object} opts
 *   targetType 'entity' | 'claim'
 *   targetId   number
 *   changes    Array<{ field, before, after }>
 *   changedBy  string  (script name)
 *   method     string  (e.g. 'gbif_accepted_name_match')
 *   reason     string  (human-readable)
 * @returns {number} rows written
 */
function logRevisions(db, { targetType, targetId, changes, changedBy, method = null, reason = null, appliedAt = null }) {
  if (!targetType || targetId == null || !Array.isArray(changes) || !changedBy) {
    throw new Error('logRevisions: targetType, targetId, changes[], changedBy are required');
  }
  // appliedAt lets a retroactive backfill preserve the ORIGINAL change time;
  // omit it for live writes to use the DEFAULT datetime('now').
  const stmt = appliedAt
    ? db.prepare(`INSERT INTO revision_log (target_type, target_id, field, before_value, after_value, changed_by, method, reason, applied_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    : db.prepare(`INSERT INTO revision_log (target_type, target_id, field, before_value, after_value, changed_by, method, reason)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  let n = 0;
  for (const c of changes) {
    if (!c || !c.field) continue;
    if (norm(c.before) === norm(c.after)) continue; // no-op change → skip
    if (appliedAt) stmt.run(targetType, targetId, c.field, norm(c.before), norm(c.after), changedBy, method, reason, appliedAt);
    else stmt.run(targetType, targetId, c.field, norm(c.before), norm(c.after), changedBy, method, reason);
    n++;
  }
  return n;
}

module.exports = { logRevisions };
