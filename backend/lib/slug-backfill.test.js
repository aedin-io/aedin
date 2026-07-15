'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { planSlugs, applyBackfill, planFromRows, selectSluglessReferenced, applyReferencedServe } = require('./slug-backfill');

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE entities (
      id INTEGER PRIMARY KEY, scientific_name TEXT, slug TEXT,
      scope_tier INTEGER, parent_entity_id INTEGER, needs_dedup INTEGER DEFAULT 0
    );
    CREATE TABLE revision_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, target_type TEXT, target_id INTEGER, field TEXT,
      before_value TEXT, after_value TEXT, changed_by TEXT, method TEXT, reason TEXT,
      applied_at TEXT DEFAULT (datetime('now'))
    );
  `);
  const ins = db.prepare("INSERT INTO entities (id,scientific_name,slug,scope_tier,parent_entity_id,needs_dedup) VALUES (?,?,?,?,?,?)");
  ins.run(1, 'Solanum lycopersicum', null, 0, null, 0);          // clean served slugless -> assign
  ins.run(2, 'Aesculus carnea', null, 0, null, 0);               // collision pair (×)
  ins.run(3, 'Aesculus × carnea', null, 0, null, 0);             // -> both flagged, neither slugged
  ins.run(4, 'Zea mays', 'zea-mays', 0, null, 0);                // already slugged -> untouched + occupies slug space
  ins.run(5, 'Daucus carota', null, null, null, 0);              // UNSERVED slugless -> untouched
  ins.run(6, 'Zea mays', null, 0, null, 0);                      // base collides with existing slug (id4) -> flagged
  return db;
}

test('planSlugs: clean -> assign; ×-pair + existing-collision -> flag; served+slugged & unserved excluded', () => {
  const { assign, flag } = planSlugs(makeDb());
  assert.deepEqual(assign, [{ id: 1, slug: 'solanum-lycopersicum' }]);
  const flaggedIds = flag.flatMap(g => g.members.map(m => m.id)).sort();
  assert.deepEqual(flaggedIds, [2, 3, 6]);   // not 1 (clean), not 4 (already slugged), not 5 (unserved)
});

test('applyBackfill: slugs clean, flags collisions needs_dedup, no suffixing, revision_log, idempotent', () => {
  const db = makeDb();
  const res = applyBackfill(db, { changedBy: 'backfill-entity-slugs' });
  assert.equal(res.slugged, 1);
  assert.equal(res.flaggedEntities, 3);
  assert.equal(db.prepare('SELECT slug FROM entities WHERE id=1').get().slug, 'solanum-lycopersicum');
  // collisions: still slugless, needs_dedup set
  for (const id of [2, 3, 6]) {
    const r = db.prepare('SELECT slug, needs_dedup FROM entities WHERE id=?').get(id);
    assert.equal(r.slug, null);
    assert.equal(r.needs_dedup, 1);
  }
  // already-slugged + unserved untouched
  assert.equal(db.prepare('SELECT slug FROM entities WHERE id=4').get().slug, 'zea-mays');
  assert.equal(db.prepare('SELECT slug FROM entities WHERE id=5').get().slug, null);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM revision_log WHERE field='slug'").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM revision_log WHERE field='needs_dedup'").get().n, 3);
  // idempotent: re-run slugs 0 (id1 now slugged; collisions still slugless but needs_dedup already 1 -> no new revision)
  const before = db.prepare('SELECT COUNT(*) n FROM revision_log').get().n;
  const res2 = applyBackfill(db, { changedBy: 'backfill-entity-slugs' });
  assert.equal(res2.slugged, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM revision_log').get().n, before);
});

// ── Referenced-entity serve (the literature-ingested tail) ──────────────────
function refDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE entities (
      id INTEGER PRIMARY KEY, scientific_name TEXT, slug TEXT,
      scope_tier INTEGER, needs_dedup INTEGER, needs_taxonomy_review INTEGER
    );
    CREATE TABLE claims (
      id INTEGER PRIMARY KEY, subject_entity_id INTEGER, object_entity_id INTEGER, review_status TEXT
    );
    CREATE TABLE entity_trait_claims (
      id INTEGER PRIMARY KEY, entity_id INTEGER, review_status TEXT
    );
    CREATE TABLE revision_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, target_type TEXT, target_id INTEGER, field TEXT,
      before_value TEXT, after_value TEXT, changed_by TEXT, method TEXT, reason TEXT,
      applied_at TEXT DEFAULT (datetime('now'))
    );
  `);
  return db;
}

test('planFromRows: clean assigns; in-batch dup flags both; existing-slug collision flags; empty base flags', () => {
  const rows = [
    { id: 1, scientific_name: 'Alternaria sp.' },          // clean
    { id: 2, scientific_name: 'Cercospora sp.' },          // in-batch dup with 3
    { id: 3, scientific_name: 'Cercospora sp.' },
    { id: 4, scientific_name: 'Musa sp.' },                // collides with existing slug
    { id: 5, scientific_name: '×' },                       // empty base
  ];
  const { assign, flag } = planFromRows(rows, new Set(['musa-sp']));
  assert.deepEqual(assign, [{ id: 1, slug: 'alternaria-sp' }]);
  const flaggedIds = flag.flatMap(g => g.members.map(m => m.id)).sort((a, b) => a - b);
  assert.deepEqual(flaggedIds, [2, 3, 4, 5]);
  assert.equal(flag.find(g => g.base === 'cercospora-sp').members.length, 2);
});

test('selectSluglessReferenced: picks the clean referenced tail; excludes flagged/scoped/slugged/non-ai_reviewed/unreferenced', () => {
  const db = refDb();
  db.exec(`INSERT INTO entities (id, scientific_name, slug, scope_tier, needs_dedup, needs_taxonomy_review) VALUES
    (100, 'Alternaria sp.',  NULL, NULL, NULL, NULL),
    (101, 'Cercospora sp.',  NULL, NULL, NULL, NULL),
    (102, 'Dup taxon',       NULL, NULL, 1,    NULL),
    (103, 'Murky virus',     NULL, NULL, NULL, 1),
    (104, 'Already served',  NULL, 0,    NULL, NULL),
    (105, 'Has slug',        'has-slug', NULL, NULL, NULL),
    (106, 'Only draft ref',  NULL, NULL, NULL, NULL),
    (107, 'Unreferenced',    NULL, NULL, NULL, NULL)`);
  db.exec(`INSERT INTO claims (id, subject_entity_id, object_entity_id, review_status) VALUES
    (1, 100, 999, 'ai_reviewed'),
    (2, 999, 102, 'ai_reviewed'),
    (3, 104, 999, 'ai_reviewed'),
    (4, 105, 999, 'ai_reviewed'),
    (5, 106, 999, 'staged')`);
  db.exec(`INSERT INTO entity_trait_claims (id, entity_id, review_status) VALUES
    (1, 101, 'ai_reviewed'),
    (2, 103, 'ai_reviewed')`);
  const ids = selectSluglessReferenced(db).map(r => r.id).sort((a, b) => a - b);
  assert.deepEqual(ids, [100, 101]);
  db.close();
});

test('applyReferencedServe: clean → slug + scope_tier=0; collision flagged not suffixed; logged; idempotent', () => {
  const db = refDb();
  db.exec(`INSERT INTO entities (id, scientific_name, slug, scope_tier, needs_dedup, needs_taxonomy_review) VALUES
    (100, 'Alternaria sp.',    NULL, NULL, NULL, NULL),
    (200, 'Citrus limon',      NULL, NULL, NULL, NULL),
    (201, 'Phoma sp.',         NULL, NULL, NULL, NULL),
    (202, 'Phoma sp.',         NULL, NULL, NULL, NULL),
    (300, 'Citrus limon DUP',  'citrus-limon', 0, NULL, NULL)`);
  db.exec(`INSERT INTO claims (id, subject_entity_id, object_entity_id, review_status) VALUES
    (1, 100, 999, 'ai_reviewed'), (2, 200, 999, 'ai_reviewed'),
    (3, 201, 999, 'ai_reviewed'), (4, 202, 999, 'ai_reviewed')`);

  const res = applyReferencedServe(db, { changedBy: 'serve-referenced-entities' });
  assert.equal(res.served, 1);
  assert.equal(res.flaggedEntities, 3);

  const served = db.prepare('SELECT slug, scope_tier FROM entities WHERE id=100').get();
  assert.equal(served.slug, 'alternaria-sp');
  assert.equal(served.scope_tier, 0);

  for (const id of [200, 201, 202]) {
    const e = db.prepare('SELECT slug, scope_tier, needs_dedup FROM entities WHERE id=?').get(id);
    assert.equal(e.slug, null, `e${id} stays slugless`);
    assert.equal(e.scope_tier, null, `e${id} not promoted`);
    assert.equal(e.needs_dedup, 1, `e${id} flagged`);
  }

  const logFields = db.prepare(`SELECT field, COUNT(*) n FROM revision_log GROUP BY field`).all()
    .reduce((a, r) => (a[r.field] = r.n, a), {});
  assert.equal(logFields.slug, 1);
  assert.equal(logFields.scope_tier, 1);
  assert.equal(logFields.needs_dedup, 3);

  const res2 = applyReferencedServe(db, { changedBy: 'serve-referenced-entities' });
  assert.equal(res2.served, 0);
  db.close();
});

test('applyReferencedServe: holdIds entities are excluded entirely (neither served nor flagged)', () => {
  const db = refDb();
  db.exec(`INSERT INTO entities (id, scientific_name, slug, scope_tier, needs_dedup, needs_taxonomy_review) VALUES
    (100, 'Alternaria sp.',          NULL, NULL, NULL, NULL),
    (400, 'companion plants (various)', NULL, NULL, NULL, NULL)`);
  db.exec(`INSERT INTO claims (id, subject_entity_id, object_entity_id, review_status) VALUES
    (1, 100, 999, 'ai_reviewed'), (2, 400, 999, 'ai_reviewed')`);

  const res = applyReferencedServe(db, { changedBy: 'serve-referenced-entities', holdIds: new Set([400]) });
  assert.equal(res.served, 1);                                   // only 100
  const held = db.prepare('SELECT slug, scope_tier, needs_dedup FROM entities WHERE id=400').get();
  assert.equal(held.slug, null);                                 // untouched
  assert.equal(held.scope_tier, null);
  assert.equal(held.needs_dedup, null);                          // NOT flagged either
  db.close();
});
