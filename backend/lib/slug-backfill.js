'use strict';
// Collision-aware slug backfill for slugless SERVED entities. Slugs the CLEAN ones
// (base unique vs the batch AND existing slugs); FLAGS collisions needs_dedup (duplicate
// taxa — e.g. ×-hybrid pairs) instead of suffixing. better-sqlite3 (sync).
const { slugify } = require('./slugify');
const { logRevisions } = require('./revision-log');

const SLUGLESS_SERVED_WHERE = "scope_tier IS NOT NULL AND (slug IS NULL OR slug = '')";

// Slugless ENTITIES the build-d1 serving set references purely by an ai_reviewed
// claim/trait but that were never scope_tier-promoted (the literature-ingested
// tail). Clean only: collision-/taxonomy-flagged rows are held off the public site.
const SLUGLESS_REFERENCED_WHERE = `
  slug IS NULL AND scope_tier IS NULL
  AND COALESCE(needs_dedup, 0) = 0 AND COALESCE(needs_taxonomy_review, 0) = 0
  AND id IN (
    SELECT subject_entity_id FROM claims WHERE review_status='ai_reviewed'
    UNION SELECT object_entity_id FROM claims WHERE review_status='ai_reviewed' AND object_entity_id IS NOT NULL
    UNION SELECT entity_id FROM entity_trait_claims WHERE review_status='ai_reviewed'
  )`;

function selectSluglessServed(db) {
  return db.prepare(
    `SELECT id, scientific_name, needs_dedup FROM entities WHERE ${SLUGLESS_SERVED_WHERE} ORDER BY id`
  ).all();
}

function selectSluglessReferenced(db) {
  return db.prepare(
    `SELECT id, scientific_name, needs_dedup FROM entities WHERE ${SLUGLESS_REFERENCED_WHERE} ORDER BY id`
  ).all();
}

function existingSlugs(db) {
  return new Set(
    db.prepare("SELECT slug FROM entities WHERE slug IS NOT NULL AND slug != ''").all().map(r => r.slug)
  );
}

// Pure collision partition. Clean = base held by exactly one batch row AND not an
// existing slug AND non-empty. A collision is a DUPLICATE TAXON → flag, never suffix.
function planFromRows(rows, existing) {
  const byBase = new Map();
  for (const r of rows) {
    const base = slugify(r.scientific_name);
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(r);
  }
  const assign = [], flag = [];
  for (const [base, members] of byBase) {
    const collides = base === '' || members.length > 1 || existing.has(base);
    if (collides) flag.push({ base, members });
    else assign.push({ id: members[0].id, slug: base });
  }
  return { assign, flag };
}

// No mutation.
function planSlugs(db) {
  return planFromRows(selectSluglessServed(db), existingSlugs(db));
}

// Flag a collision group's members needs_dedup (shared by both apply paths).
function flagCollisions(db, flag, changedBy) {
  const setDedup = db.prepare('UPDATE entities SET needs_dedup = 1 WHERE id = ?');
  let flaggedEntities = 0;
  for (const g of flag) for (const m of g.members) {
    setDedup.run(m.id);
    logRevisions(db, { targetType: 'entity', targetId: m.id, changedBy, method: changedBy,
      changes: [{ field: 'needs_dedup', before: m.needs_dedup, after: 1 }] });   // logRevisions skips if already 1
    flaggedEntities++;
  }
  return flaggedEntities;
}

// Serve the clean literature-ingested referenced tail: assign a slug AND promote to
// scope_tier=0 (build-d1 already includes them; the slug is what gives them a page).
// Collisions are flagged needs_dedup (duplicate taxa → merge rail), never suffixed.
// holdIds: entity ids to EXCLUDE entirely (generic-guild / non-taxon nodes the
// agroecologist held off the public site) — left untouched (slugless), neither
// served nor flagged.
function applyReferencedServe(db, { changedBy, holdIds = new Set() }) {
  const candidates = selectSluglessReferenced(db).filter(r => !holdIds.has(r.id));
  const { assign, flag } = planFromRows(candidates, existingSlugs(db));
  const serve = db.prepare('UPDATE entities SET slug = ?, scope_tier = 0 WHERE id = ?');
  for (const a of assign) {
    serve.run(a.slug, a.id);
    logRevisions(db, { targetType: 'entity', targetId: a.id, changedBy, method: changedBy,
      reason: 'claim-referenced literature entity made servable (slug + scope_tier=0)',
      changes: [
        { field: 'slug', before: null, after: a.slug },
        { field: 'scope_tier', before: null, after: 0 },
      ] });
  }
  const flaggedEntities = flagCollisions(db, flag, changedBy);
  return { served: assign.length, flaggedGroups: flag.length, flaggedEntities };
}

function applyBackfill(db, { changedBy }) {
  const { assign, flag } = planSlugs(db);
  const setSlug = db.prepare('UPDATE entities SET slug = ? WHERE id = ?');
  for (const a of assign) {
    setSlug.run(a.slug, a.id);
    logRevisions(db, { targetType: 'entity', targetId: a.id, changedBy, method: changedBy,
      changes: [{ field: 'slug', before: null, after: a.slug }] });
  }
  const flaggedEntities = flagCollisions(db, flag, changedBy);
  return { slugged: assign.length, flaggedGroups: flag.length, flaggedEntities };
}

module.exports = {
  SLUGLESS_SERVED_WHERE, SLUGLESS_REFERENCED_WHERE,
  selectSluglessServed, selectSluglessReferenced, existingSlugs,
  planFromRows, planSlugs, applyBackfill, applyReferencedServe,
};
