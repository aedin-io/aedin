'use strict';

async function runMigration(db) {
  // ── role_rules: data-driven rules replacing hardcoded Sets ────────────────
  await db.run(`CREATE TABLE IF NOT EXISTS role_rules (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_type           TEXT NOT NULL,
    match_field         TEXT NOT NULL,
    match_value         TEXT NOT NULL COLLATE NOCASE,
    match_bio_category  TEXT,
    assigned_role       TEXT NOT NULL,
    secondary_role      TEXT,
    confidence          REAL DEFAULT 1.0,
    priority            INTEGER DEFAULT 50,
    reason              TEXT,
    source              TEXT DEFAULT 'seed',
    enabled             INTEGER DEFAULT 1,
    created_at          TEXT DEFAULT (datetime('now')),
    updated_at          TEXT DEFAULT (datetime('now'))
  )`);

  await db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_role_rules_unique
    ON role_rules(rule_type, match_field, match_value, COALESCE(match_bio_category, ''))`);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_role_rules_lookup
    ON role_rules(enabled, priority DESC)`);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_role_rules_type
    ON role_rules(rule_type, match_field)`);

  // ── role_corrections: audit trail of every role change ────────────────────
  await db.run(`CREATE TABLE IF NOT EXISTS role_corrections (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_id       INTEGER NOT NULL REFERENCES entities(id),
    scientific_name TEXT NOT NULL,
    old_role        TEXT,
    new_role        TEXT NOT NULL,
    old_bio_category TEXT,
    new_bio_category TEXT,
    source          TEXT NOT NULL DEFAULT 'manual',
    reason          TEXT,
    rule_id         INTEGER REFERENCES role_rules(id),
    reviewed        INTEGER DEFAULT 0,
    created_at      TEXT DEFAULT (datetime('now'))
  )`);

  await db.run(`CREATE INDEX IF NOT EXISTS idx_role_corrections_entity
    ON role_corrections(entity_id)`);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_role_corrections_unreviewed
    ON role_corrections(reviewed, created_at)`);

  // ── role_assignment_log: why each entity has its current role ─────────────
  await db.run(`CREATE TABLE IF NOT EXISTS role_assignment_log (
    entity_id           INTEGER PRIMARY KEY REFERENCES entities(id),
    assigned_role       TEXT NOT NULL,
    assignment_source   TEXT NOT NULL,
    rule_id             INTEGER REFERENCES role_rules(id),
    confidence          REAL,
    interaction_profile TEXT,
    assigned_at         TEXT DEFAULT (datetime('now'))
  )`);

  console.log('[migration-014] Role agent tables ready (role_rules, role_corrections, role_assignment_log).');
}

module.exports = { runMigration };
