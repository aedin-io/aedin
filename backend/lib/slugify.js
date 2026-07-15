'use strict';
// Canonical entity slug. slug = slugify(scientific_name): lowercase, runs of non-alphanumerics
// -> one hyphen, trim. Matches the existing entities.slug format. uniqueSlug appends -2,-3,…
// and is for entity-CREATE paths (promote scripts) where inserts are already dedup-filtered;
// the slug BACKFILL (lib/slug-backfill.js) FLAGS collisions instead of suffixing.
function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
function uniqueSlug(db, base, taken = new Set()) {
  const exists = db.prepare('SELECT 1 FROM entities WHERE slug = ?');
  let slug = base, n = 2;
  while (!slug || taken.has(slug) || exists.get(slug)) { slug = `${base}-${n}`; n++; }
  taken.add(slug);
  return slug;
}
module.exports = { slugify, uniqueSlug };
