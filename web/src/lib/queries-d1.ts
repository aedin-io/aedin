import type { Entity, Claim, EntityWithClaims, GlobiClaim, EntityGlobiClaims, RelatedEntity, CropWebGlobi, CropWebGlobiNode, CropWebGlobiEdge, AtlasGlobiSlice, AtlasGlobiNode, AtlasGlobiEdge, CropGlobiCounts } from './entity-types';

type D1 = { prepare(sql: string): { bind(...a: unknown[]): { all<T = unknown>(): Promise<{ results: T[] }>; first<T = unknown>(): Promise<T | null> } } };

const LIT_CLAIMS_SQL = `
  SELECT
    c.id, c.interaction_category, c.interaction_type_raw, c.interaction_type_globi,
    c.effect_direction, c.source_quote, c.source_page, c.reference_citation,
    c.subject_entity_id, c.object_entity_id, c.source_id,
    s.title AS source_title, s.authors AS source_authors, s.year AS source_year,
    s.publication AS source_publication, s.url AS source_url, s.license AS source_license, s.slug AS source_slug,
    e_s.scientific_name AS subject_scientific_name, e_s.common_name AS subject_common_name, e_s.slug AS subject_slug,
    e_o.scientific_name AS object_scientific_name, e_o.common_name AS object_common_name, e_o.slug AS object_slug,
    (SELECT GROUP_CONCAT(critic_name || '|' || verdict, CHAR(10))
       FROM claim_critic_verdicts ccv WHERE ccv.staging_id = c.staging_id) AS critic_verdicts
  FROM claims c
  LEFT JOIN sources s    ON s.id   = c.source_id
  LEFT JOIN entities e_s ON e_s.id = c.subject_entity_id
  LEFT JOIN entities e_o ON e_o.id = c.object_entity_id
  WHERE (c.subject_entity_id = ? OR c.object_entity_id = ?)
    AND c.review_status = 'ai_reviewed'
    AND c.source_quote IS NOT NULL AND c.source_quote != ''
  ORDER BY c.interaction_category, c.id`;

export async function getEntityBySlug(DB: D1, slug: string): Promise<EntityWithClaims | null> {
  const entity = await DB.prepare(`SELECT * FROM entities WHERE slug = ? LIMIT 1`).bind(slug).first<Entity>();
  if (!entity) return null;
  const { results: claims } = await DB.prepare(LIT_CLAIMS_SQL).bind(entity.id, entity.id).all<Claim>();
  const claims_by_category = new Map<string, Claim[]>();
  for (const c of claims) {
    const k = c.interaction_category || 'uncategorized';
    if (!claims_by_category.has(k)) claims_by_category.set(k, []);
    claims_by_category.get(k)!.push(c);
  }
  return { entity, claims_by_category, total_claims: claims.length };
}

export type EntityTraitClaim = {
  id: number;
  trait_name: string;
  value_numeric: number | null;
  value_text: string | null;
  value_json: string | null;
  unit: string | null;
  source_quote: string | null;
  source_page: number | null;
  regional_context: string | null;
  source_title: string | null;
  source_authors: string | null;
  source_year: number | null;
  source_url: string | null;
  source_slug: string | null;
  inherited_from_entity_id: number | null;
  inherited_from_name: string | null;
  inherited_from_slug: string | null;
};

const TRAIT_CLAIMS_SQL = `
  SELECT t.id, t.trait_name, t.value_numeric, t.value_text, t.value_json, t.unit,
         t.source_quote, t.source_page, t.regional_context,
         s.title AS source_title, s.authors AS source_authors, s.year AS source_year,
         s.url AS source_url, s.slug AS source_slug,
         t.inherited_from_entity_id AS inherited_from_entity_id,
         pe.scientific_name        AS inherited_from_name,
         pe.slug                   AS inherited_from_slug
  FROM entity_trait_claims t
  LEFT JOIN sources s ON s.id = t.source_id
  LEFT JOIN entities pe ON pe.id = t.inherited_from_entity_id
  WHERE t.entity_id = ? AND t.review_status = 'ai_reviewed'
  ORDER BY t.trait_name, t.id`;

export type Revision = {
  field: string;
  before_value: string | null;
  after_value: string | null;
  changed_by: string;
  method: string | null;
  reason: string | null;
  applied_at: string | null;
};

const REVISIONS_SQL = `
  SELECT field, before_value, after_value, changed_by, method, reason, applied_at
  FROM revision_log WHERE target_type = ? AND target_id = ?
  ORDER BY applied_at, id`;

// Modification provenance (GBIF taxonomy re-resolution, bio_category fix,
// rank-floor quarantine, ...) for one entity or claim — the audit trail.
export async function getRevisions(DB: D1, targetType: 'entity' | 'claim', targetId: number): Promise<Revision[]> {
  const { results } = await DB.prepare(REVISIONS_SQL).bind(targetType, targetId).all<Revision>();
  return results;
}

// Literature trait claims (crop pH / days-to-harvest / host-range / toxicity /
// phenology ...) for one entity, grouped by trait_name.
export async function getTraitsForEntity(DB: D1, entityId: number): Promise<Map<string, EntityTraitClaim[]>> {
  const { results } = await DB.prepare(TRAIT_CLAIMS_SQL).bind(entityId).all<EntityTraitClaim>();
  const byTrait = new Map<string, EntityTraitClaim[]>();
  for (const t of results) {
    if (!byTrait.has(t.trait_name)) byTrait.set(t.trait_name, []);
    byTrait.get(t.trait_name)!.push(t);
  }
  return byTrait;
}

export type InteractionRow = {
  id: number;
  provenance: 'literature' | 'globi';
  direction: 'out' | 'in';           // out: this entity is the subject; in: it is the object
  category: string | null;
  verb: string | null;               // interaction_type_raw, else interaction_type_globi
  partnerName: string | null;
  partnerCommon: string | null;
  partnerSlug: string | null;
  region: string | null;             // literature: regional_context; globi: formatted country list
  citation: string | null;           // literature: "Authors Year" or title
  referenceCitation: string | null;  // globi: reference_citation (the aggregated study)
  referenceDoi: string | null;       // globi: reference_doi
  observationUrl: string | null;     // GloBI: reference_url (currently always empty upstream)
  sourceQuote: string | null;        // literature only
  sourceSlug: string | null;
  verdicts: string | null;           // literature critic verdicts ("name|verdict\n…")
  modified: boolean;
  sourceId: number | null;
  effectDirection: string | null;
  resistanceLevel: string | null;    // disease/pest_resistance: complete|strong|partial|tolerant|…
  subjectName: string | null;
  objectName: string | null;
  subjectCommon: string | null;
  objectCommon: string | null;
};

const INTERACTION_ROWS_SQL = `
  SELECT
    c.id, c.interaction_category, c.interaction_type_raw, c.interaction_type_globi,
    c.review_status, c.data_tier, c.source_quote, c.reference_url,
    c.reference_citation, c.reference_doi, c.regional_context,
    c.subject_entity_id, c.object_entity_id, c.source_id, c.effect_direction, c.resistance_level,
    s.authors AS source_authors, s.year AS source_year, s.title AS source_title, s.slug AS source_slug,
    e_s.scientific_name AS subject_name, e_s.common_name AS subject_common, e_s.slug AS subject_slug,
    e_o.scientific_name AS object_name, e_o.common_name AS object_common, e_o.slug AS object_slug,
    (SELECT GROUP_CONCAT(DISTINCT cl.country) FROM claim_localities cl WHERE cl.claim_id = c.id) AS globi_countries,
    (SELECT GROUP_CONCAT(critic_name || '|' || verdict, CHAR(10))
       FROM claim_critic_verdicts ccv WHERE ccv.staging_id = c.staging_id) AS verdicts,
    (SELECT COUNT(*) FROM revision_log r WHERE r.target_type='claim' AND r.target_id=c.id) AS mod_count
  FROM claims c
  LEFT JOIN sources s    ON s.id   = c.source_id
  LEFT JOIN entities e_s ON e_s.id = c.subject_entity_id
  LEFT JOIN entities e_o ON e_o.id = c.object_entity_id
  WHERE (c.subject_entity_id = ? OR c.object_entity_id = ?)
    AND ( (c.review_status='ai_reviewed' AND c.source_quote IS NOT NULL AND c.source_quote != '')
          OR (c.data_tier='tier2_globi' AND c.chain_role IS NOT NULL) )
  ORDER BY c.id
  LIMIT ?`;

type InteractionSqlRow = {
  id: number; interaction_category: string | null; interaction_type_raw: string | null;
  interaction_type_globi: string | null; review_status: string | null; data_tier: string | null;
  source_quote: string | null; reference_url: string | null;
  reference_citation: string | null; reference_doi: string | null; regional_context: string | null;
  subject_entity_id: number | null; object_entity_id: number | null;
  source_id: number | null; effect_direction: string | null; resistance_level: string | null;
  source_authors: string | null; source_year: number | null; source_title: string | null; source_slug: string | null;
  subject_name: string | null; subject_common: string | null; subject_slug: string | null;
  object_name: string | null; object_common: string | null; object_slug: string | null;
  globi_countries: string | null; verdicts: string | null; mod_count: number;
};

// Format the GROUP_CONCAT(DISTINCT country) blob from claim_localities into a
// compact cell string: null/"" -> null, "A" -> "A", "A,B" -> "A, B",
// "A,B,C,D" -> "A, B +2". The GloBI claim page shows the full locality list.
// We sort alphabetically so the displayed first-two are deterministic regardless
// of SQLite's GROUP_CONCAT row order (which is engine-defined, not contractual).
// Split on ',' is safe: claim_localities.country holds short GloBI names — none
// contain a comma (verified against the corpus).
function formatGlobiRegion(concat: string | null): string | null {
  if (!concat) return null;
  const countries = concat.split(',').map(s => s.trim()).filter(Boolean).sort();
  if (countries.length === 0) return null;
  if (countries.length <= 2) return countries.join(', ');
  return `${countries[0]}, ${countries[1]} +${countries.length - 2}`;
}

// Pure normalizer (exported for the smoke-test) — turns a joined claim row into
// the unified InteractionRow from THIS entity's perspective.
export function normalizeInteractionRow(r: InteractionSqlRow, entityId: number): InteractionRow {
  const isSubject = r.subject_entity_id === entityId;
  const provenance: 'literature' | 'globi' = r.review_status === 'ai_reviewed' ? 'literature' : 'globi';
  const citation = provenance === 'literature'
    ? ([r.source_authors, r.source_year ? `(${r.source_year})` : null].filter(Boolean).join(' ') || r.source_title || null)
    : null;
  const region = provenance === 'literature'
    ? (r.regional_context || null)
    : formatGlobiRegion(r.globi_countries);
  return {
    id: r.id,
    provenance,
    direction: isSubject ? 'out' : 'in',
    category: r.interaction_category,
    verb: r.interaction_type_raw || r.interaction_type_globi,
    partnerName: isSubject ? r.object_name : r.subject_name,
    partnerCommon: isSubject ? r.object_common : r.subject_common,
    partnerSlug: isSubject ? r.object_slug : r.subject_slug,
    region,
    citation,
    referenceCitation: provenance === 'globi' ? r.reference_citation : null,
    referenceDoi: provenance === 'globi' ? r.reference_doi : null,
    observationUrl: provenance === 'globi' ? r.reference_url : null,
    sourceQuote: provenance === 'literature' ? r.source_quote : null,
    sourceSlug: r.source_slug,
    verdicts: r.verdicts,
    modified: (r.mod_count || 0) > 0,
    sourceId: r.source_id,
    effectDirection: r.effect_direction,
    resistanceLevel: r.resistance_level,
    subjectName: r.subject_name,
    objectName: r.object_name,
    subjectCommon: r.subject_common,
    objectCommon: r.object_common,
  };
}

// All interactions for an entity (literature + GloBI, no category cap). Capped at
// `limit` (default 10,000) as a pathological-size guard; max today is ~7,222.
export async function getInteractionRows(DB: D1, entityId: number, limit = 10000): Promise<InteractionRow[]> {
  const { results } = await DB.prepare(INTERACTION_ROWS_SQL).bind(entityId, entityId, limit).all<InteractionSqlRow>();
  return results.map(r => normalizeInteractionRow(r, entityId));
}

export type GlobiClaimDetail = {
  id: number;
  subjectName: string | null; subjectCommon: string | null; subjectSlug: string | null;
  objectName: string | null; objectCommon: string | null; objectSlug: string | null;
  category: string | null; verb: string | null;
  referenceCitation: string | null; referenceDoi: string | null;
  localities: { country: string; subdivision: string }[];
};

const GLOBI_CLAIM_SQL = `
  SELECT c.id, c.interaction_category, c.interaction_type_raw,
         c.reference_citation, c.reference_doi,
         e_s.scientific_name AS subject_name, e_s.common_name AS subject_common, e_s.slug AS subject_slug,
         e_o.scientific_name AS object_name, e_o.common_name AS object_common, e_o.slug AS object_slug
    FROM claims c
    LEFT JOIN entities e_s ON e_s.id = c.subject_entity_id
    LEFT JOIN entities e_o ON e_o.id = c.object_entity_id
   WHERE c.id = ? AND c.data_tier='tier2_globi' AND c.chain_role IS NOT NULL`;

type GlobiClaimSqlRow = {
  id: number; interaction_category: string | null; interaction_type_raw: string | null;
  reference_citation: string | null; reference_doi: string | null;
  subject_name: string | null; subject_common: string | null; subject_slug: string | null;
  object_name: string | null; object_common: string | null; object_slug: string | null;
};

// A single served GloBI claim for /globi/[id]. Returns null when the id is not a
// served GloBI claim (literature ids 404 here — they have /claim/[id]).
export async function getGlobiClaimById(DB: D1, id: number): Promise<GlobiClaimDetail | null> {
  const row = await DB.prepare(GLOBI_CLAIM_SQL).bind(id).first<GlobiClaimSqlRow>();
  if (!row) return null;
  const { results: localities } = await DB.prepare(
    `SELECT country, subdivision FROM claim_localities WHERE claim_id = ? ORDER BY country, subdivision`
  ).bind(id).all<{ country: string; subdivision: string }>();
  return {
    id: row.id,
    subjectName: row.subject_name, subjectCommon: row.subject_common, subjectSlug: row.subject_slug,
    objectName: row.object_name, objectCommon: row.object_common, objectSlug: row.object_slug,
    category: row.interaction_category, verb: row.interaction_type_raw,
    referenceCitation: row.reference_citation, referenceDoi: row.reference_doi,
    localities,
  };
}

export type TraitRow = {
  id: number; trait: string; value: string; unit: string | null;
  region: string | null; citation: string | null; sourceQuote: string | null;
  sourcePage: number | null; sourceSlug: string | null;
  inheritedFromEntityId: number | null; inheritedFromName: string | null; inheritedFromSlug: string | null;
};

// Flatten literature trait claims into table rows (one per trait claim).
// Render a trait value for display. value_text/value_numeric pass through; a
// value_json range {min,max} becomes "min–max" (or "x" when equal), a list array
// becomes "a, b" — the unit (e.g. "g") is appended by the renderer. Falls back to
// the raw json (then "—") so an unexpected shape never crashes the page.
function formatTraitValue(t: EntityTraitClaim): string {
  if (t.value_text != null) return t.value_text;
  if (t.value_numeric != null) return String(t.value_numeric);
  if (t.value_json != null) {
    try {
      const v = JSON.parse(t.value_json);
      if (v && typeof v === 'object' && !Array.isArray(v) && 'min' in v && 'max' in v) {
        return v.min === v.max ? String(v.min) : `${v.min}–${v.max}`;
      }
      if (Array.isArray(v)) return v.join(', ');
    } catch { /* fall through to raw json */ }
    return t.value_json;
  }
  return '—';
}

export async function getTraitRows(DB: D1, entityId: number): Promise<TraitRow[]> {
  const { results } = await DB.prepare(TRAIT_CLAIMS_SQL).bind(entityId).all<EntityTraitClaim>();
  return results.map(t => ({
    id: t.id,
    trait: t.trait_name,
    value: formatTraitValue(t),
    unit: t.unit,
    region: t.regional_context,
    citation: [t.source_authors, t.source_year ? `(${t.source_year})` : null].filter(Boolean).join(' ') || t.source_title || null,
    sourceQuote: t.source_quote,
    sourcePage: t.source_page,
    sourceSlug: t.source_slug,
    inheritedFromEntityId: t.inherited_from_entity_id ?? null,
    inheritedFromName: t.inherited_from_name ?? null,
    inheritedFromSlug: t.inherited_from_slug ?? null,
  }));
}

export type ClaimModItem = {
  claimId: number; served: boolean; subjectName: string | null; objectName: string | null;
  field: string; before: string | null; after: string | null; method: string | null;
  reason: string | null; appliedAt: string | null;
};
export type ClaimModSummary = { total: number; removed: number; items: ClaimModItem[] };

// Reads DENORMALIZED entity columns baked into revision_log at D1-publish time
// (build-d1-revisions-patch.cjs), NOT a JOIN to claims. The claims table on D1
// is the served-subset mirror and does NOT contain quarantined/removed claims —
// JOINing to it would silently drop exactly the removed claims this rollup must
// surface. The patch (which has the full local DB) populates subject_entity_id/
// object_entity_id/subject_name/object_name/served on each claim-target row.
const CLAIM_REVISIONS_SQL = `
  SELECT target_id AS claim_id, field, before_value, after_value, method, reason, applied_at,
         subject_name, object_name, served
  FROM revision_log
  WHERE target_type = 'claim' AND (subject_entity_id = ? OR object_entity_id = ?)
  ORDER BY applied_at, id`;

// Modifications to THIS entity's claims, regardless of serve status — so
// quarantined/removed claims (no longer table rows) still surface in the rollup.
export async function getClaimRevisionsForEntity(DB: D1, entityId: number): Promise<ClaimModSummary> {
  const { results } = await DB.prepare(CLAIM_REVISIONS_SQL).bind(entityId, entityId).all<{
    claim_id: number; field: string; before_value: string | null; after_value: string | null;
    method: string | null; reason: string | null; applied_at: string | null;
    subject_name: string | null; object_name: string | null; served: number | null;
  }>();
  const claimIds = new Set<number>();
  const removedIds = new Set<number>();
  const items: ClaimModItem[] = results.map(r => {
    const served = r.served === 1;
    claimIds.add(r.claim_id);
    if (!served) removedIds.add(r.claim_id);
    return {
      claimId: r.claim_id, served, subjectName: r.subject_name, objectName: r.object_name,
      field: r.field, before: r.before_value, after: r.after_value, method: r.method,
      reason: r.reason, appliedAt: r.applied_at,
    };
  });
  return { total: claimIds.size, removed: removedIds.size, items };
}

const GLOBI_WHERE = `(c.subject_entity_id = ? OR c.object_entity_id = ?) AND c.data_tier = 'tier2_globi' AND c.chain_role IS NOT NULL`;

const GLOBI_CLAIMS_SQL = `
  SELECT
    c.id, c.interaction_category, c.interaction_type_raw, c.interaction_type_globi,
    c.effect_direction, c.source_quote, c.source_page, c.reference_citation,
    c.reference_doi, c.reference_url, c.chain_role, c.interaction_count,
    c.subject_entity_id, c.object_entity_id, c.source_id,
    s.title AS source_title, s.authors AS source_authors, s.year AS source_year,
    s.publication AS source_publication, s.url AS source_url, s.license AS source_license, s.slug AS source_slug,
    e_s.scientific_name AS subject_scientific_name, e_s.common_name AS subject_common_name, e_s.slug AS subject_slug,
    e_o.scientific_name AS object_scientific_name, e_o.common_name AS object_common_name, e_o.slug AS object_slug,
    NULL AS critic_verdicts
  FROM claims c
  LEFT JOIN sources s    ON s.id   = c.source_id
  LEFT JOIN entities e_s ON e_s.id = c.subject_entity_id
  LEFT JOIN entities e_o ON e_o.id = c.object_entity_id
  WHERE ${GLOBI_WHERE}
  ORDER BY c.interaction_count DESC, c.id
  LIMIT ?`;

export async function getGlobiClaimsForEntity(DB: D1, entityId: number, limit = 200): Promise<EntityGlobiClaims> {
  const totalRow = await DB.prepare(
    `SELECT COUNT(*) AS n FROM claims c WHERE ${GLOBI_WHERE}`
  ).bind(entityId, entityId).first<{ n: number }>();
  const { results } = await DB.prepare(GLOBI_CLAIMS_SQL).bind(entityId, entityId, limit).all<Omit<GlobiClaim, 'provenance'>>();
  const claims: GlobiClaim[] = results.map(c => ({ ...c, provenance: 'globi' as const }));
  return { claims, total: totalRow?.n ?? 0 };
}

export async function getRelatedEntities(DB: D1, entityId: number, limit = 8): Promise<RelatedEntity[]> {
  const { results } = await DB.prepare(`
    SELECT e.slug, e.scientific_name, e.common_name, e.bio_category, COUNT(*) AS shared_count
    FROM claims c
    JOIN entities e ON e.id = CASE WHEN c.subject_entity_id = ? THEN c.object_entity_id ELSE c.subject_entity_id END
    WHERE (c.subject_entity_id = ? OR c.object_entity_id = ?)
      AND c.review_status = 'ai_reviewed'
      AND c.source_quote IS NOT NULL AND c.source_quote != ''
      AND e.id != ? AND e.slug IS NOT NULL AND e.merged_into_entity_id IS NULL
    GROUP BY e.id ORDER BY shared_count DESC LIMIT ?
  `).bind(entityId, entityId, entityId, entityId, limit).all<RelatedEntity>();
  return results;
}

export async function getGenusLevelEvidence(DB: D1, entity: Entity): Promise<Claim[]> {
  const genusToken = (entity.genus && entity.genus.trim())
    || (entity.scientific_name ? entity.scientific_name.trim().split(/\s+/)[0] : '');
  if (!genusToken) return [];
  const idSub = `SELECT id FROM entities WHERE taxonomic_resolution IN ('genus_only','collective') AND id != ? AND (scientific_name = ? OR scientific_name LIKE ? || ' %')`;
  const { results } = await DB.prepare(`
    SELECT
      c.id, c.interaction_category, c.interaction_type_raw, c.interaction_type_globi,
      c.effect_direction, c.source_quote, c.source_page, c.reference_citation,
      c.subject_entity_id, c.object_entity_id, c.source_id,
      s.title AS source_title, s.authors AS source_authors, s.year AS source_year,
      s.publication AS source_publication, s.url AS source_url, s.license AS source_license, s.slug AS source_slug,
      e_s.scientific_name AS subject_scientific_name, e_s.common_name AS subject_common_name, e_s.slug AS subject_slug,
      e_o.scientific_name AS object_scientific_name, e_o.common_name AS object_common_name, e_o.slug AS object_slug,
      (SELECT GROUP_CONCAT(critic_name || '|' || verdict, CHAR(10))
         FROM claim_critic_verdicts ccv WHERE ccv.staging_id = c.staging_id) AS critic_verdicts
    FROM claims c
    LEFT JOIN sources s    ON s.id   = c.source_id
    LEFT JOIN entities e_s ON e_s.id = c.subject_entity_id
    LEFT JOIN entities e_o ON e_o.id = c.object_entity_id
    WHERE (c.subject_entity_id IN (${idSub}) OR c.object_entity_id IN (${idSub}))
      AND c.review_status = 'ai_reviewed'
      AND c.source_quote IS NOT NULL AND c.source_quote != ''
    ORDER BY c.interaction_category, c.id
    LIMIT 50
  `).bind(entity.id, genusToken, genusToken, entity.id, genusToken, genusToken).all<Claim>();
  return results;
}

// Per-crop GloBI chain for the crop-web radial. Two hops, capped per ring:
//   ring 1 = GloBI partners of the focus crop with chain_role in
//            ('crop_interaction','attractant');
//   ring 2 = biocontrol partners of the *kept* ring-1 nodes.
// Node `depth` is the hop that reached it. Independent of entities.scope_tier
// (which may be unpopulated in D1).
// Region predicate for the ring queries: an EXISTS over claim_localities keyed on the
// claim alias `c`. EXISTS (not JOIN) keeps each edge once regardless of how many
// localities it has. Empty country -> no constraint (global).
// Build an `IN ('A','B',…)` clause from a TRUSTED static country list (region-scopes.js
// — never raw user input). Embedded as escaped literals, NOT bound params, because the
// ring-2 query already binds up to ~60 ids and a 54-country scope would exceed D1's
// 100-param limit. Empty list -> matches nothing.
function countryInList(countries: string[]): string {
  if (!countries.length) return "IN (' __none__')";
  return 'IN (' + countries.map(c => `'${c.replace(/'/g, "''")}'`).join(',') + ')';
}

function localityExists(opts: { country?: string | null; subdivision?: string | null; countries?: string[] | null }): { clause: string; binds: string[] } {
  if (opts.countries && opts.countries.length) return {
    clause: ` AND EXISTS (SELECT 1 FROM claim_localities l WHERE l.claim_id = c.id AND l.country ${countryInList(opts.countries)})`,
    binds: [],
  };
  if (!opts.country) return { clause: '', binds: [] };
  if (opts.subdivision) return {
    clause: ' AND EXISTS (SELECT 1 FROM claim_localities l WHERE l.claim_id = c.id AND l.country = ? AND l.subdivision = ?)',
    binds: [opts.country, opts.subdivision],
  };
  return {
    clause: ' AND EXISTS (SELECT 1 FROM claim_localities l WHERE l.claim_id = c.id AND l.country = ?)',
    binds: [opts.country],
  };
}

const RING1_SQL = `
  SELECT c.id, c.subject_entity_id, c.object_entity_id, c.interaction_type_raw,
         c.interaction_category, c.chain_role, c.interaction_count
  FROM claims c
  WHERE (c.subject_entity_id = ? OR c.object_entity_id = ?)
    AND c.data_tier = 'tier2_globi'
    AND c.chain_role IN ('crop_interaction','attractant')
  ORDER BY c.interaction_count DESC, c.id`;

type ChainRow = {
  id: number; subject_entity_id: number; object_entity_id: number | null;
  interaction_type_raw: string | null; interaction_category: string | null;
  chain_role: string | null; interaction_count: number | null;
};

function partnerOf(row: ChainRow, anchor: number): number | null {
  if (row.subject_entity_id === anchor) return row.object_entity_id;
  if (row.object_entity_id === anchor) return row.subject_entity_id;
  return null;
}

function toEdge(row: ChainRow): CropWebGlobiEdge {
  return {
    id: row.id,
    subject_id: row.subject_entity_id,
    object_id: row.object_entity_id as number,
    interaction_type_raw: row.interaction_type_raw,
    interaction_category: row.interaction_category,
    chain_role: row.chain_role,
    interaction_count: row.interaction_count,
    provenance: 'globi',
  };
}

export async function getCropWebGlobi(
  DB: D1,
  focus: { id: number; slug: string | null },
  opts: { tier1Cap?: number; tier2Cap?: number; country?: string | null; subdivision?: string | null; countries?: string[] | null } = {},
): Promise<CropWebGlobi> {
  const tier1Cap = opts.tier1Cap ?? 30;
  const tier2Cap = opts.tier2Cap ?? 40;
  const F = focus.id;
  const loc = localityExists(opts);

  // ── Ring 1 ──
  const ring1Sql = RING1_SQL.replace('\n  ORDER BY', `${loc.clause}\n  ORDER BY`);
  const { results: ring1Rows } = await DB.prepare(ring1Sql).bind(F, F, ...loc.binds).all<ChainRow>();
  const partnerBest = new Map<number, number>();
  for (const r of ring1Rows) {
    const p = partnerOf(r, F);
    if (p == null || p === F) continue;
    const c = r.interaction_count ?? 0;
    if (!partnerBest.has(p) || c > (partnerBest.get(p) as number)) partnerBest.set(p, c);
  }
  const rankedRing1 = [...partnerBest.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(e => e[0]);
  const tier1_total = rankedRing1.length;
  const keptRing1 = new Set(rankedRing1.slice(0, tier1Cap));
  const ring1Edges = ring1Rows.filter(r => {
    const p = partnerOf(r, F);
    return p != null && keptRing1.has(p);
  });

  // ── Ring 2 (biocontrol agents of kept ring-1 nodes) ──
  const depthById = new Map<number, 1 | 2>();
  for (const id of keptRing1) depthById.set(id, 1);
  let ring2Edges: ChainRow[] = [];
  if (keptRing1.size > 0) {
    const ids = [...keptRing1];
    const ph = ids.map(() => '?').join(',');
    const sql = `
      SELECT c.id, c.subject_entity_id, c.object_entity_id, c.interaction_type_raw,
             c.interaction_category, c.chain_role, c.interaction_count
      FROM claims c
      WHERE c.data_tier = 'tier2_globi' AND c.chain_role = 'biocontrol'
        AND (c.subject_entity_id IN (${ph}) OR c.object_entity_id IN (${ph}))${loc.clause}
      ORDER BY c.interaction_count DESC, c.id`;
    const { results } = await DB.prepare(sql).bind(...ids, ...ids, ...loc.binds).all<ChainRow>();
    const agentBest = new Map<number, number>();
    const rowsByAgent: ChainRow[] = [];
    for (const r of results) {
      // the ring-1 end is in keptRing1; the agent is the other end
      const r1 = keptRing1.has(r.subject_entity_id) ? r.subject_entity_id : r.object_entity_id as number;
      const agent = partnerOf(r, r1);
      if (agent == null || agent === F || agent === r1) continue;
      const c = r.interaction_count ?? 0;
      if (!agentBest.has(agent) || c > (agentBest.get(agent) as number)) agentBest.set(agent, c);
      rowsByAgent.push(r);
    }
    const keptAgents = new Set(
      [...agentBest.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, tier2Cap).map(e => e[0]),
    );
    for (const a of keptAgents) if (!depthById.has(a)) depthById.set(a, 2);
    ring2Edges = rowsByAgent.filter(r => {
      const r1 = keptRing1.has(r.subject_entity_id) ? r.subject_entity_id : r.object_entity_id as number;
      const agent = partnerOf(r, r1);
      return agent != null && keptAgents.has(agent);
    });
  }

  // ── Node metadata ──
  const nodeIds = [...depthById.keys()];
  let nodes: CropWebGlobiNode[] = [];
  if (nodeIds.length > 0) {
    const ph = nodeIds.map(() => '?').join(',');
    const { results } = await DB.prepare(
      `SELECT id, slug, scientific_name, common_name, bio_category, primary_role
       FROM entities WHERE id IN (${ph})`,
    ).bind(...nodeIds).all<Omit<CropWebGlobiNode, 'depth'>>();
    nodes = results.map(e => ({ ...e, depth: depthById.get(e.id) as 1 | 2 }));
  }

  // ── Edges + category counts ──
  const edges = [...ring1Edges, ...ring2Edges].map(toEdge);
  const catCounts = new Map<string, number>();
  for (const e of edges) {
    const k = e.interaction_category || 'uncategorized';
    catCounts.set(k, (catCounts.get(k) || 0) + 1);
  }
  const categories = [...catCounts.entries()]
    .map(([category, n]) => ({ category, n }))
    .sort((a, b) => b.n - a.n || a.category.localeCompare(b.category));

  return {
    focus: focus.slug || '',
    nodes,
    edges,
    categories,
    capped: { tier1_total, tier1_shown: keptRing1.size },
  };
}

// Bounded global "greatest-hits" GloBI slice for the atlas: top-`cap` edges by
// interaction_count, their nodes (with an evidence weight = sum incident
// interaction_count), and the interaction_category vocabulary.
const ATLAS_GLOBI_EDGES_SQL = `
  SELECT c.id, c.subject_entity_id, c.object_entity_id, c.interaction_type_raw,
         c.interaction_category, c.chain_role, c.interaction_count
  FROM claims c
  WHERE c.data_tier = 'tier2_globi' AND c.chain_role IS NOT NULL
    AND c.object_entity_id IS NOT NULL
  ORDER BY c.interaction_count DESC, c.id
  LIMIT ?`;

// Node metadata for the same top-`cap` edge set, derived inside SQL (no IN-list)
// so we bind only `cap` — D1 caps bound parameters at 100 per query.
const ATLAS_GLOBI_NODES_SQL = `
  WITH top_edges AS (
    SELECT subject_entity_id AS s, object_entity_id AS o
    FROM claims
    WHERE data_tier = 'tier2_globi' AND chain_role IS NOT NULL AND object_entity_id IS NOT NULL
    ORDER BY interaction_count DESC, id
    LIMIT ?
  ),
  node_ids AS (
    SELECT s AS id FROM top_edges UNION SELECT o AS id FROM top_edges
  )
  SELECT e.id, e.slug, e.scientific_name, e.common_name, e.bio_category, e.primary_role, e.taxonomy_path
  FROM entities e JOIN node_ids n ON n.id = e.id`;

export async function getAtlasGlobiSlice(
  DB: D1,
  opts: { cap?: number } = {},
): Promise<AtlasGlobiSlice> {
  const cap = opts.cap ?? 2000;

  const { results: rows } = await DB.prepare(ATLAS_GLOBI_EDGES_SQL).bind(cap).all<{
    id: number; subject_entity_id: number; object_entity_id: number;
    interaction_type_raw: string | null; interaction_category: string | null;
    chain_role: string | null; interaction_count: number | null;
  }>();

  const edges: AtlasGlobiEdge[] = rows.map(r => ({
    id: r.id,
    subject_id: r.subject_entity_id,
    object_id: r.object_entity_id,
    interaction_type_raw: r.interaction_type_raw,
    interaction_category: r.interaction_category,
    chain_role: r.chain_role,
    interaction_count: r.interaction_count,
    provenance: 'globi',
  }));

  // Node evidence weight = sum of incident slice-edge interaction_count.
  const evidence = new Map<number, number>();
  for (const e of edges) {
    const w = e.interaction_count ?? 0;
    evidence.set(e.subject_id, (evidence.get(e.subject_id) || 0) + w);
    evidence.set(e.object_id, (evidence.get(e.object_id) || 0) + w);
  }

  // Node metadata. Cloudflare D1 caps a query at 100 bound parameters, and the
  // slice touches thousands of distinct node ids — so we must NOT bind an
  // IN-list. Re-derive the node ids inside SQL with a CTE (binding only `cap`)
  // and JOIN to entities. The evidence weights come from the JS map above.
  let nodes: AtlasGlobiNode[] = [];
  if (evidence.size > 0) {
    const { results } = await DB.prepare(ATLAS_GLOBI_NODES_SQL).bind(cap).all<Omit<AtlasGlobiNode, 'evidence'>>();
    nodes = results.map(n => ({ ...n, evidence: evidence.get(n.id) || 0 }));
  }

  const catCounts = new Map<string, number>();
  for (const e of edges) {
    const k = e.interaction_category || 'uncategorized';
    catCounts.set(k, (catCounts.get(k) || 0) + 1);
  }
  const categories = [...catCounts.entries()]
    .map(([category, n]) => ({ category, n }))
    .sort((a, b) => b.n - a.n || a.category.localeCompare(b.category));

  const totalRow = await DB.prepare(
    `SELECT COUNT(*) AS n FROM claims
     WHERE data_tier='tier2_globi' AND chain_role IS NOT NULL AND object_entity_id IS NOT NULL`,
  ).first<{ n: number }>();

  return { edges, nodes, categories, total: totalRow?.n ?? 0, cap };
}

// ─── Landing-page stats (SSR from D1) ─────────────────────────────────────
// Mirrors getLandingStats() / getAllRegions() / getAllGlobiTerms() in
// queries.ts, but reads from live D1 at request time so post-deploy ingest
// updates (e.g. the surgical patch from web/scripts/build-d1-patch.cjs)
// surface on the homepage without a site rebuild. Build-time queries.ts
// versions still serve the prerendered region/source/claim pages.

type LandingStatsD1 = {
  total_servable_claims: number;
  total_entities_with_claims: number;
  total_sources: number;
  total_globi_interactions: number;
  sample_entities: { slug: string; scientific_name: string; common_name: string | null; claim_count: number }[];
  top_sources: { slug: string; title: string; authors: string | null; year: number | null; claim_count: number }[];
};

export async function getLandingStatsD1(DB: D1): Promise<LandingStatsD1> {
  const totals = await DB.prepare(`
    SELECT COUNT(*) AS total_servable_claims
    FROM claims
    WHERE review_status = 'ai_reviewed'
      AND source_quote IS NOT NULL AND source_quote != ''
  `).bind().first<{ total_servable_claims: number }>();

  // "Entities" on the landing page = every entity that has its own page
  // (slug IS NOT NULL — papers + GloBI alike), EXCLUDING varieties
  // (parent_entity_id set, e.g. tomato cultivars). The field name
  // total_entities_with_claims is historical; this is the page count.
  const pageEntities = await DB.prepare(
    `SELECT COUNT(*) AS n FROM entities WHERE slug IS NOT NULL AND parent_entity_id IS NULL AND merged_into_entity_id IS NULL`,
  ).bind().first<{ n: number }>();

  const sources = await DB.prepare(
    `SELECT COUNT(DISTINCT source_id) AS n FROM claims WHERE review_status = 'ai_reviewed'`,
  ).bind().first<{ n: number }>();

  const globi = await DB.prepare(
    `SELECT COUNT(*) AS n FROM claims WHERE data_tier = 'tier2_globi' AND chain_role IS NOT NULL`,
  ).bind().first<{ n: number }>();

  const sample = await DB.prepare(`
    SELECT e.slug, e.scientific_name, e.common_name, COUNT(c.id) AS claim_count
    FROM entities e
    JOIN claims c ON (c.subject_entity_id = e.id OR c.object_entity_id = e.id)
    WHERE c.review_status = 'ai_reviewed'
      AND c.source_quote IS NOT NULL AND c.source_quote != ''
      AND e.slug IS NOT NULL
    GROUP BY e.id
    ORDER BY claim_count DESC
    LIMIT 12
  `).bind().all<{ slug: string; scientific_name: string; common_name: string | null; claim_count: number }>();

  const top = await DB.prepare(`
    SELECT s.slug, s.title, s.authors, s.year, COUNT(c.id) AS claim_count
    FROM sources s
    JOIN claims c ON c.source_id = s.id
    WHERE c.review_status = 'ai_reviewed'
      AND c.source_quote IS NOT NULL AND c.source_quote != ''
      AND s.slug IS NOT NULL
    GROUP BY s.id
    ORDER BY claim_count DESC
    LIMIT 10
  `).bind().all<{ slug: string; title: string; authors: string | null; year: number | null; claim_count: number }>();

  return {
    total_servable_claims: totals?.total_servable_claims ?? 0,
    total_entities_with_claims: pageEntities?.n ?? 0,
    total_sources: sources?.n ?? 0,
    total_globi_interactions: globi?.n ?? 0,
    sample_entities: sample.results,
    top_sources: top.results,
  };
}

// Mirror of regionSlug() in queries.ts — keep in sync.
function regionSlugD1(region: string): string {
  return region.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export async function getAllRegionsD1(
  DB: D1,
): Promise<{ region: string; slug: string; claim_count: number; entity_count: number }[]> {
  const { results } = await DB.prepare(`
    SELECT
      regional_context AS region,
      COUNT(*) AS claim_count,
      COUNT(DISTINCT COALESCE(subject_entity_id, 0)) + COUNT(DISTINCT COALESCE(object_entity_id, 0)) AS entity_count
    FROM claims
    WHERE review_status = 'ai_reviewed'
      AND source_quote IS NOT NULL AND source_quote != ''
      AND regional_context IS NOT NULL AND regional_context != ''
    GROUP BY regional_context
    ORDER BY claim_count DESC
  `).bind().all<{ region: string; claim_count: number; entity_count: number }>();
  return results.map(r => ({ ...r, slug: regionSlugD1(r.region) }));
}

// Per-plant incident tier2_globi claim count for the crop-web rail badge. Optional
// region filter via claim_localities (country / country+subdivision). Constant bound
// params (0-2) -> D1-safe (no large IN-list). bio_category='plantae' bounds the result
// to rail entities.
export async function getCropGlobiCounts(
  DB: D1,
  opts: { country?: string | null; subdivision?: string | null; countries?: string[] | null } = {},
): Promise<CropGlobiCounts> {
  const country = opts.country || null;
  const subdivision = opts.subdivision || null;
  const countries = opts.countries && opts.countries.length ? opts.countries : null;
  const locJoin = countries
    ? `JOIN claim_localities l ON l.claim_id = i.claim_id AND l.country ${countryInList(countries)}`
    : !country
      ? ''
      : subdivision
        ? 'JOIN claim_localities l ON l.claim_id = i.claim_id AND l.country = ? AND l.subdivision = ?'
        : 'JOIN claim_localities l ON l.claim_id = i.claim_id AND l.country = ?';
  const sql = `
    WITH incident AS (
      SELECT c.id AS claim_id, c.subject_entity_id AS pid
        FROM claims c WHERE c.data_tier='tier2_globi' AND c.chain_role IS NOT NULL
      UNION ALL
      SELECT c.id, c.object_entity_id
        FROM claims c WHERE c.data_tier='tier2_globi' AND c.chain_role IS NOT NULL
                        AND c.object_entity_id IS NOT NULL
    )
    SELECT i.pid AS id, COUNT(DISTINCT i.claim_id) AS n
    FROM incident i
    JOIN entities e ON e.id = i.pid AND e.bio_category='plantae'
    ${locJoin}
    GROUP BY i.pid`;
  const binds = countries ? [] : !country ? [] : subdivision ? [country, subdivision] : [country];
  const stmt = DB.prepare(sql);
  const res = binds.length ? await stmt.bind(...binds).all<{ id: number; n: number }>()
                           : await stmt.all<{ id: number; n: number }>();
  return { counts: (res.results ?? []).map(r => ({ id: r.id, n: r.n })) };
}

// ── Variety queries ───────────────────────────────────────────────────────────
// Served varieties are entities rows with parent_entity_id set AND scope_tier IS
// NOT NULL (excludes unserved GRIN rows). All three functions enforce this gate.

export async function getParentSummary(
  DB: D1,
  parentId: number,
): Promise<{ slug: string; scientific_name: string; common_name: string | null } | null> {
  return await DB.prepare(
    `SELECT slug, scientific_name, common_name FROM entities WHERE id = ? LIMIT 1`,
  ).bind(parentId).first<{ slug: string; scientific_name: string; common_name: string | null }>();
}

export async function getVarietyTypeCounts(
  DB: D1,
  speciesId: number,
): Promise<{ variety_type: string | null; n: number }[]> {
  const { results } = await DB.prepare(
    `SELECT variety_type, COUNT(*) AS n FROM entities
     WHERE parent_entity_id = ? AND scope_tier IS NOT NULL AND merged_into_entity_id IS NULL
     GROUP BY variety_type ORDER BY n DESC`,
  ).bind(speciesId).all<{ variety_type: string | null; n: number }>();
  return results;
}

export async function getVarietiesForSpecies(
  DB: D1,
  speciesId: number,
  opts: { type?: string; limit?: number; offset?: number } = {},
): Promise<{ slug: string; scientific_name: string; common_name: string | null; variety_type: string | null; grin_accession: string | null }[]> {
  const limit = Math.min(opts.limit ?? 12, 200);
  const offset = opts.offset ?? 0;
  const typeClause = opts.type ? ` AND variety_type = ?` : ``;
  const binds: (number | string)[] = [speciesId];
  if (opts.type) binds.push(opts.type);
  binds.push(limit, offset);
  const { results } = await DB.prepare(
    `SELECT slug, scientific_name, common_name, variety_type, grin_accession FROM entities
     WHERE parent_entity_id = ? AND scope_tier IS NOT NULL AND merged_into_entity_id IS NULL${typeClause}
     ORDER BY scientific_name LIMIT ? OFFSET ?`,
  ).bind(...binds).all<{ slug: string; scientific_name: string; common_name: string | null; variety_type: string | null; grin_accession: string | null }>();
  return results;
}

// Decide whether a resolved entity is a dedup tombstone that should 301 to its
// canonical. Pure: the route fetches the canonical slug and supplies it. Returns
// null for a live entity (render normally) AND for a tombstone whose canonical has
// no servable slug (the route then 404s rather than redirect-looping).
export function resolveMergeRedirect(
  entity: { merged_into_entity_id?: number | null },
  canonicalSlug: string | null,
): { location: string; status: 301 } | null {
  if (entity?.merged_into_entity_id == null) return null;
  if (!canonicalSlug) return null;
  return { location: `/entity/${canonicalSlug}`, status: 301 };
}

// Resolve a canonical entity's current slug (only a non-tombstoned canonical counts).
export async function getCanonicalSlug(DB: D1, id: number): Promise<string | null> {
  const row = await DB.prepare(
    `SELECT slug FROM entities WHERE id = ? AND merged_into_entity_id IS NULL LIMIT 1`,
  ).bind(id).first<{ slug: string | null }>();
  return row?.slug ?? null;
}

export async function getAllGlobiTermsD1(DB: D1): Promise<{ term: string; claim_count: number }[]> {
  const { results } = await DB.prepare(`
    SELECT interaction_type_globi AS term, COUNT(*) AS claim_count
    FROM claims
    WHERE review_status = 'ai_reviewed'
      AND source_quote IS NOT NULL AND source_quote != ''
      AND interaction_type_globi IS NOT NULL AND interaction_type_globi != ''
    GROUP BY interaction_type_globi
    ORDER BY claim_count DESC
  `).bind().all<{ term: string; claim_count: number }>();
  return results;
}
