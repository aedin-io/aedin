import { getDb } from './db';
import type { Entity, Claim, EntityWithClaims, RelatedEntity } from './entity-types';

export type { Entity, Claim, EntityWithClaims, RelatedEntity } from './entity-types';

export type Source = {
  id: number;
  slug: string;
  title: string | null;
  authors: string | null;
  year: number | null;
  publication: string | null;
  source_type: string | null;
  url: string | null;
  doi: string | null;
  license: string | null;
};

export type SourceWithClaims = {
  source: Source;
  claims: Claim[];
};

export function getEntityBySlug(slug: string): EntityWithClaims | null {
  const db = getDb();
  const entity = db.prepare(`
    SELECT * FROM entities WHERE slug = ? LIMIT 1
  `).get(slug) as Entity | undefined;

  if (!entity) return null;

  const claims = db.prepare(`
    SELECT
      c.id, c.interaction_category, c.interaction_type_raw, c.interaction_type_globi,
      c.effect_direction,
      c.source_quote, c.source_page, c.reference_citation,
      c.subject_entity_id, c.object_entity_id, c.source_id,
      s.title       AS source_title,
      s.authors     AS source_authors,
      s.year        AS source_year,
      s.publication AS source_publication,
      s.url         AS source_url,
      s.license     AS source_license,
      s.slug        AS source_slug,
      e_s.scientific_name AS subject_scientific_name,
      e_s.common_name     AS subject_common_name,
      e_s.slug            AS subject_slug,
      e_o.scientific_name AS object_scientific_name,
      e_o.common_name     AS object_common_name,
      e_o.slug            AS object_slug,
      (SELECT GROUP_CONCAT(critic_name || '|' || verdict, CHAR(10))
         FROM claim_critic_verdicts ccv
         WHERE ccv.staging_id = c.staging_id
      ) AS critic_verdicts
    FROM claims c
    LEFT JOIN sources s   ON s.id   = c.source_id
    LEFT JOIN entities e_s ON e_s.id = c.subject_entity_id
    LEFT JOIN entities e_o ON e_o.id = c.object_entity_id
    WHERE (c.subject_entity_id = ? OR c.object_entity_id = ?)
      AND c.review_status = 'ai_reviewed'
      AND c.source_quote IS NOT NULL
      AND c.source_quote != ''
    ORDER BY c.interaction_category, c.id
  `).all(entity.id, entity.id) as Claim[];

  const claims_by_category = new Map<string, Claim[]>();
  for (const c of claims) {
    const k = c.interaction_category || 'uncategorized';
    if (!claims_by_category.has(k)) claims_by_category.set(k, []);
    claims_by_category.get(k)!.push(c);
  }

  return { entity, claims_by_category, total_claims: claims.length };
}

/**
 * Genus-level evidence rollup.
 *
 * The extractor deliberately emits `Genus sp.` / `Genus spp.` / collective
 * ranks when a source does not determine the species (see
 * docs/common-name-species-resolution.md → species-resolution precedence).
 * Those nodes would otherwise be orphaned from their species siblings, since
 * entities resolve by exact `scientific_name`. This surfaces, for a given
 * entity, the claims attached to the genus-level / collective nodes that share
 * its genus — rendered as a SEPARATE, clearly-labelled section so the species'
 * precision is never silently blended with genus-level evidence.
 *
 * Matching is by the leading genus token of `scientific_name` (the `genus`
 * column is empty on auto-created genus-level nodes); the
 * `taxonomic_resolution` filter keeps real species binomials out even though
 * the LIKE pattern would match them.
 */
export function getGenusLevelEvidence(entity: Entity): Claim[] {
  const db = getDb();
  const genusToken =
    (entity.genus && entity.genus.trim()) ||
    (entity.scientific_name ? entity.scientific_name.trim().split(/\s+/)[0] : '');
  if (!genusToken) return [];

  const idSub = `
    SELECT id FROM entities
    WHERE taxonomic_resolution IN ('genus_only', 'collective')
      AND id != ?
      AND (scientific_name = ? OR scientific_name LIKE ? || ' %')`;

  return db.prepare(`
    SELECT
      c.id, c.interaction_category, c.interaction_type_raw, c.interaction_type_globi,
      c.effect_direction,
      c.source_quote, c.source_page, c.reference_citation,
      c.subject_entity_id, c.object_entity_id, c.source_id,
      s.title       AS source_title,
      s.authors     AS source_authors,
      s.year        AS source_year,
      s.publication AS source_publication,
      s.url         AS source_url,
      s.license     AS source_license,
      s.slug        AS source_slug,
      e_s.scientific_name AS subject_scientific_name,
      e_s.common_name     AS subject_common_name,
      e_s.slug            AS subject_slug,
      e_o.scientific_name AS object_scientific_name,
      e_o.common_name     AS object_common_name,
      e_o.slug            AS object_slug,
      (SELECT GROUP_CONCAT(critic_name || '|' || verdict, CHAR(10))
         FROM claim_critic_verdicts ccv
         WHERE ccv.staging_id = c.staging_id
      ) AS critic_verdicts
    FROM claims c
    LEFT JOIN sources s    ON s.id   = c.source_id
    LEFT JOIN entities e_s ON e_s.id = c.subject_entity_id
    LEFT JOIN entities e_o ON e_o.id = c.object_entity_id
    WHERE (c.subject_entity_id IN (${idSub}) OR c.object_entity_id IN (${idSub}))
      AND c.review_status = 'ai_reviewed'
      AND c.source_quote IS NOT NULL
      AND c.source_quote != ''
    ORDER BY c.interaction_category, c.id
    LIMIT 50
  `).all(
    entity.id, genusToken, genusToken,
    entity.id, genusToken, genusToken,
  ) as Claim[];
}

export type LandingStats = {
  total_servable_claims: number;
  total_entities_with_claims: number;
  total_sources: number;
  total_globi_interactions: number;
  sample_entities: { slug: string; scientific_name: string; common_name: string | null; claim_count: number }[];
  top_sources: { slug: string; title: string; authors: string | null; year: number | null; claim_count: number }[];
};

export type Revision = {
  field: string;
  before_value: string | null;
  after_value: string | null;
  changed_by: string;
  method: string | null;
  reason: string | null;
  applied_at: string | null;
};

// Build-time modification provenance for a claim (the claim page is static).
export function getRevisionsForClaim(claimId: number): Revision[] {
  const db = getDb();
  return db.prepare(`
    SELECT field, before_value, after_value, changed_by, method, reason, applied_at
    FROM revision_log WHERE target_type = 'claim' AND target_id = ?
    ORDER BY applied_at, id
  `).all(claimId) as Revision[];
}

export function getLandingStats(): LandingStats {
  const db = getDb();
  const totals = db.prepare(`
    SELECT
      COUNT(*) AS total_servable_claims,
      COUNT(DISTINCT subject_entity_id) AS total_subjects
    FROM claims
    WHERE review_status = 'ai_reviewed'
      AND source_quote IS NOT NULL AND source_quote != ''
  `).get() as { total_servable_claims: number; total_subjects: number };

  const total_sources = (db.prepare(`SELECT COUNT(DISTINCT source_id) AS n FROM claims WHERE review_status = 'ai_reviewed'`).get() as { n: number }).n;

  // Scoped GloBI interactions surfaced on the site (aggregated, not independently
  // verified — distinct from the verified literature claims above). Matches the set
  // served on entity pages: tier2_globi with a chain_role. Recomputed every build.
  const total_globi_interactions = (db.prepare(`
    SELECT COUNT(*) AS n FROM claims WHERE data_tier = 'tier2_globi' AND chain_role IS NOT NULL
  `).get() as { n: number }).n;

  const sample_entities = db.prepare(`
    SELECT e.slug, e.scientific_name, e.common_name, COUNT(c.id) AS claim_count
    FROM entities e
    JOIN claims c ON (c.subject_entity_id = e.id OR c.object_entity_id = e.id)
    WHERE c.review_status = 'ai_reviewed'
      AND c.source_quote IS NOT NULL AND c.source_quote != ''
      AND e.slug IS NOT NULL
    GROUP BY e.id
    ORDER BY claim_count DESC
    LIMIT 12
  `).all() as { slug: string; scientific_name: string; common_name: string | null; claim_count: number }[];

  const top_sources = db.prepare(`
    SELECT s.slug, s.title, s.authors, s.year, COUNT(c.id) AS claim_count
    FROM sources s
    JOIN claims c ON c.source_id = s.id
    WHERE c.review_status = 'ai_reviewed'
      AND c.source_quote IS NOT NULL AND c.source_quote != ''
      AND s.slug IS NOT NULL
    GROUP BY s.id
    ORDER BY claim_count DESC
    LIMIT 10
  `).all() as { slug: string; title: string; authors: string | null; year: number | null; claim_count: number }[];

  return {
    total_servable_claims: totals.total_servable_claims,
    total_entities_with_claims: totals.total_subjects,
    total_sources,
    total_globi_interactions,
    sample_entities,
    top_sources
  };
}

export function getRelatedEntities(entityId: number, limit: number = 8): RelatedEntity[] {
  const db = getDb();
  return db.prepare(`
    SELECT
      e.slug, e.scientific_name, e.common_name, e.bio_category,
      COUNT(*) AS shared_count
    FROM claims c
    JOIN entities e ON e.id = CASE
      WHEN c.subject_entity_id = ? THEN c.object_entity_id
      ELSE c.subject_entity_id
    END
    WHERE (c.subject_entity_id = ? OR c.object_entity_id = ?)
      AND c.review_status = 'ai_reviewed'
      AND c.source_quote IS NOT NULL AND c.source_quote != ''
      AND e.id != ?
      AND e.slug IS NOT NULL
    GROUP BY e.id
    ORDER BY shared_count DESC
    LIMIT ?
  `).all(entityId, entityId, entityId, entityId, limit) as RelatedEntity[];
}

export function getAllEntitySlugsWithServableClaims(): string[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT DISTINCT e.slug
    FROM entities e
    JOIN claims c ON (c.subject_entity_id = e.id OR c.object_entity_id = e.id)
    WHERE c.review_status = 'ai_reviewed'
      AND c.source_quote IS NOT NULL AND c.source_quote != ''
      AND e.slug IS NOT NULL
  `).all() as { slug: string }[];
  return rows.map(r => r.slug);
}

export function getAllSourceSlugsWithServableClaims(): string[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT DISTINCT s.slug
    FROM sources s
    JOIN claims c ON c.source_id = s.id
    WHERE c.review_status = 'ai_reviewed'
      AND c.source_quote IS NOT NULL AND c.source_quote != ''
      AND s.slug IS NOT NULL
  `).all() as { slug: string }[];
  return rows.map(r => r.slug);
}

export type ClaimDetail = Claim & {
  subject_taxonomy_path: string | null;
  subject_bio_category: string | null;
  object_taxonomy_path: string | null;
  object_bio_category: string | null;
};

// ─── Region browse pages ─────────────────────────────────────────────────

export type RegionSummary = {
  region: string;          // canonical display name (e.g. "Guam", "United States")
  slug: string;            // URL slug (e.g. "guam", "united-states")
  claim_count: number;
  entity_count: number;
};

export type RegionPage = {
  region: string;
  slug: string;
  claim_count: number;
  entity_count: number;
  top_entities: { slug: string; scientific_name: string; common_name: string | null; bio_category: string | null; claim_count: number }[];
  top_sources: { slug: string; title: string; authors: string | null; year: number | null; claim_count: number }[];
  claims_by_category: Map<string, Claim[]>;
};

function regionSlug(region: string): string {
  return region.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function getAllRegions(): RegionSummary[] {
  const db = getDb();
  const rows = db.prepare(`
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
  `).all() as { region: string; claim_count: number; entity_count: number }[];
  return rows.map(r => ({ ...r, slug: regionSlug(r.region) }));
}

export function getRegionPage(slug: string): RegionPage | null {
  // The slug is derived from regional_context; resolve back by matching
  // any region whose slugify() == slug.
  const all = getAllRegions();
  const summary = all.find(r => r.slug === slug);
  if (!summary) return null;
  const db = getDb();
  const region = summary.region;

  const top_entities = db.prepare(`
    SELECT e.slug, e.scientific_name, e.common_name, e.bio_category, COUNT(*) AS claim_count
    FROM claims c
    JOIN entities e ON e.id = c.subject_entity_id OR e.id = c.object_entity_id
    WHERE c.review_status = 'ai_reviewed'
      AND c.source_quote IS NOT NULL AND c.source_quote != ''
      AND c.regional_context = ?
      AND e.slug IS NOT NULL
    GROUP BY e.id
    ORDER BY claim_count DESC
    LIMIT 12
  `).all(region) as { slug: string; scientific_name: string; common_name: string | null; bio_category: string | null; claim_count: number }[];

  const top_sources = db.prepare(`
    SELECT s.slug, s.title, s.authors, s.year, COUNT(*) AS claim_count
    FROM claims c JOIN sources s ON s.id = c.source_id
    WHERE c.review_status = 'ai_reviewed'
      AND c.source_quote IS NOT NULL AND c.source_quote != ''
      AND c.regional_context = ?
      AND s.slug IS NOT NULL
    GROUP BY s.id
    ORDER BY claim_count DESC
    LIMIT 8
  `).all(region) as { slug: string; title: string; authors: string | null; year: number | null; claim_count: number }[];

  const claims = db.prepare(`
    SELECT
      c.id, c.interaction_category, c.interaction_type_raw, c.interaction_type_globi,
      c.effect_direction, c.source_quote, c.source_page, c.reference_citation,
      c.subject_entity_id, c.object_entity_id, c.source_id,
      s.title AS source_title, s.authors AS source_authors, s.year AS source_year,
      s.publication AS source_publication, s.url AS source_url, s.license AS source_license, s.slug AS source_slug,
      e_s.scientific_name AS subject_scientific_name, e_s.common_name AS subject_common_name, e_s.slug AS subject_slug,
      e_o.scientific_name AS object_scientific_name, e_o.common_name AS object_common_name, e_o.slug AS object_slug,
      NULL AS critic_verdicts
    FROM claims c
    LEFT JOIN sources s ON s.id = c.source_id
    LEFT JOIN entities e_s ON e_s.id = c.subject_entity_id
    LEFT JOIN entities e_o ON e_o.id = c.object_entity_id
    WHERE c.regional_context = ?
      AND c.review_status = 'ai_reviewed'
      AND c.source_quote IS NOT NULL AND c.source_quote != ''
    ORDER BY c.interaction_category, c.id DESC
    LIMIT 200
  `).all(region) as Claim[];

  const claims_by_category = new Map<string, Claim[]>();
  for (const c of claims) {
    const k = c.interaction_category || 'uncategorized';
    if (!claims_by_category.has(k)) claims_by_category.set(k, []);
    claims_by_category.get(k)!.push(c);
  }
  return { ...summary, top_entities, top_sources, claims_by_category };
}

// ─── Interaction browse pages ────────────────────────────────────────────

export type InteractionSummary = {
  term: string;          // GloBI term, e.g. "preysOn"
  claim_count: number;
};

export type InteractionPage = {
  term: string;
  claim_count: number;
  description: string;
  top_subjects: { slug: string; scientific_name: string; common_name: string | null; bio_category: string | null; n: number }[];
  top_objects: { slug: string; scientific_name: string; common_name: string | null; bio_category: string | null; n: number }[];
  top_regions: { region: string; slug: string; n: number }[];
  claims: Claim[];
};

const GLOBI_DESCRIPTIONS: Record<string, string> = {
  eats: 'Subject consumes object. Use for herbivory, granivory, omnivory — the GloBI canonical term for "Subject feeds on Object."',
  preysOn: 'Subject hunts and kills object. Predator–prey interactions; the default GloBI term for biocontrol-via-predation.',
  pollinates: 'Subject transfers pollen to object\'s flowers, enabling fertilization.',
  pollinatedBy: 'Inverse of pollinates: subject (plant) is pollinated by object (insect / bird / bat).',
  pathogenOf: 'Subject (microbe, fungus, virus) causes disease in object. Bacterial, fungal, and viral plant diseases land here; also entomopathogens.',
  parasiteOf: 'Subject is a parasite (living on/in object). Generic parasitism term — use parasitoidOf when subject is specifically a parasitoid.',
  parasitoidOf: 'Subject is a parasitoid: lays eggs in/on object, larva consumes the host. Parasitic wasps and flies are the canonical examples.',
  mutualistOf: 'Symmetric mutualism: subject and object both benefit. Mycorrhizal partnerships, nitrogen-fixation symbioses.',
  hasArbuscularMycorrhizalHost: 'Subject (AM fungus) has object (plant) as its arbuscular mycorrhizal host.',
  interactsWith: 'Generic interaction term — used when no more specific GloBI relation applies. Most common for plant–plant facilitation.',
  visitsFlowersOf: 'Subject visits flowers of object but pollination is not confirmed.',
  vectorOf: 'Subject is a vector for object (disease agent). Insect vectors of viral plant diseases land here.',
  hasVector: 'Inverse of vectorOf.',
  dispersalVectorOf: 'Subject disperses object\'s seeds / spores.'
};

export function getAllGlobiTerms(): InteractionSummary[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT interaction_type_globi AS term, COUNT(*) AS claim_count
    FROM claims
    WHERE review_status = 'ai_reviewed'
      AND source_quote IS NOT NULL AND source_quote != ''
      AND interaction_type_globi IS NOT NULL AND interaction_type_globi != ''
    GROUP BY interaction_type_globi
    ORDER BY claim_count DESC
  `).all() as InteractionSummary[];
  return rows;
}

export function getInteractionPage(term: string): InteractionPage | null {
  const db = getDb();
  const exists = db.prepare(`SELECT COUNT(*) AS n FROM claims WHERE interaction_type_globi = ? AND review_status = 'ai_reviewed'`).get(term) as { n: number };
  if (!exists || !exists.n) return null;

  const top_subjects = db.prepare(`
    SELECT e.slug, e.scientific_name, e.common_name, e.bio_category, COUNT(*) AS n
    FROM claims c JOIN entities e ON e.id = c.subject_entity_id
    WHERE c.interaction_type_globi = ? AND c.review_status = 'ai_reviewed'
      AND c.source_quote IS NOT NULL AND c.source_quote != ''
      AND e.slug IS NOT NULL
    GROUP BY e.id ORDER BY n DESC LIMIT 12
  `).all(term) as { slug: string; scientific_name: string; common_name: string | null; bio_category: string | null; n: number }[];

  const top_objects = db.prepare(`
    SELECT e.slug, e.scientific_name, e.common_name, e.bio_category, COUNT(*) AS n
    FROM claims c JOIN entities e ON e.id = c.object_entity_id
    WHERE c.interaction_type_globi = ? AND c.review_status = 'ai_reviewed'
      AND c.source_quote IS NOT NULL AND c.source_quote != ''
      AND e.slug IS NOT NULL
    GROUP BY e.id ORDER BY n DESC LIMIT 12
  `).all(term) as { slug: string; scientific_name: string; common_name: string | null; bio_category: string | null; n: number }[];

  const regions = db.prepare(`
    SELECT regional_context AS region, COUNT(*) AS n
    FROM claims
    WHERE interaction_type_globi = ? AND review_status = 'ai_reviewed'
      AND source_quote IS NOT NULL AND source_quote != ''
      AND regional_context IS NOT NULL AND regional_context != ''
    GROUP BY regional_context ORDER BY n DESC LIMIT 10
  `).all(term) as { region: string; n: number }[];

  const claims = db.prepare(`
    SELECT
      c.id, c.interaction_category, c.interaction_type_raw, c.interaction_type_globi,
      c.effect_direction, c.source_quote, c.source_page, c.reference_citation,
      c.subject_entity_id, c.object_entity_id, c.source_id,
      s.title AS source_title, s.authors AS source_authors, s.year AS source_year,
      s.publication AS source_publication, s.url AS source_url, s.license AS source_license, s.slug AS source_slug,
      e_s.scientific_name AS subject_scientific_name, e_s.common_name AS subject_common_name, e_s.slug AS subject_slug,
      e_o.scientific_name AS object_scientific_name, e_o.common_name AS object_common_name, e_o.slug AS object_slug,
      NULL AS critic_verdicts
    FROM claims c
    LEFT JOIN sources s ON s.id = c.source_id
    LEFT JOIN entities e_s ON e_s.id = c.subject_entity_id
    LEFT JOIN entities e_o ON e_o.id = c.object_entity_id
    WHERE c.interaction_type_globi = ? AND c.review_status = 'ai_reviewed'
      AND c.source_quote IS NOT NULL AND c.source_quote != ''
    ORDER BY c.id DESC LIMIT 200
  `).all(term) as Claim[];

  return {
    term,
    claim_count: exists.n,
    description: GLOBI_DESCRIPTIONS[term] ?? 'GloBI Relations Ontology term. See https://github.com/jhpoelen/eol-globi-data for the canonical vocabulary.',
    top_subjects,
    top_objects,
    top_regions: regions.map(r => ({ ...r, slug: regionSlug(r.region) })),
    claims
  };
}

export function getAllServableClaimIds(): number[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id FROM claims
    WHERE review_status = 'ai_reviewed'
      AND source_quote IS NOT NULL AND source_quote != ''
  `).all() as { id: number }[];
  return rows.map(r => r.id);
}

// Partners sharing this claim's source + interaction + effect, anchored on whichever
// side yields the LARGER list (resolved decision). Rebuilt from entities, not quote text.
export function getClaimSiblings(claim: {
  source_id: number | null;
  interaction_category: string | null;
  effect_direction: string | null;
  subject_entity_id: number | null;
  object_entity_id: number | null;
}): { id: number; name: string; slug: string | null }[] {
  const db = getDb();
  if (claim.source_id == null || !claim.interaction_category) return [];
  type SibRow = { id: number; name: string; common: string | null; slug: string | null };
  const side = (anchorCol: string, partnerCol: string, anchorId: number | null): SibRow[] => {
    if (anchorId == null) return [];
    const rows = db.prepare(`
      SELECT DISTINCT e.id AS id, e.scientific_name AS name, e.common_name AS common, e.slug AS slug
      FROM claims c JOIN entities e ON e.id = c.${partnerCol}
      WHERE c.source_id = ? AND c.interaction_category = ?
        AND COALESCE(c.effect_direction,'') = COALESCE(?,'')
        AND c.${anchorCol} = ?
        AND c.review_status = 'ai_reviewed'
        AND c.source_quote IS NOT NULL AND c.source_quote != ''
      ORDER BY e.scientific_name
    `).all(claim.source_id!, claim.interaction_category!, claim.effect_direction, anchorId);
    return rows as SibRow[];
  };
  const subjAnchored = side('subject_entity_id', 'object_entity_id', claim.subject_entity_id);
  const objAnchored = side('object_entity_id', 'subject_entity_id', claim.object_entity_id);
  const chosen = subjAnchored.length >= objAnchored.length ? subjAnchored : objAnchored;
  return chosen.map(r => ({ id: r.id, name: r.common || r.name, slug: r.slug }));
}

export function getClaimById(id: number): ClaimDetail | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT
      c.id, c.interaction_category, c.interaction_type_raw, c.interaction_type_globi,
      c.effect_direction,
      c.source_quote, c.source_page, c.reference_citation,
      c.subject_entity_id, c.object_entity_id, c.source_id,
      s.title       AS source_title,
      s.authors     AS source_authors,
      s.year        AS source_year,
      s.publication AS source_publication,
      s.url         AS source_url,
      s.license     AS source_license,
      s.slug        AS source_slug,
      e_s.scientific_name AS subject_scientific_name,
      e_s.common_name     AS subject_common_name,
      e_s.slug            AS subject_slug,
      e_s.taxonomy_path   AS subject_taxonomy_path,
      e_s.bio_category    AS subject_bio_category,
      e_o.scientific_name AS object_scientific_name,
      e_o.common_name     AS object_common_name,
      e_o.slug            AS object_slug,
      e_o.taxonomy_path   AS object_taxonomy_path,
      e_o.bio_category    AS object_bio_category,
      (SELECT GROUP_CONCAT(critic_name || '|' || verdict || '|' || COALESCE(REPLACE(REPLACE(reasoning, '|', '/'), CHAR(10), ' '), ''), CHAR(10))
         FROM claim_critic_verdicts ccv
         WHERE ccv.staging_id = c.staging_id
      ) AS critic_verdicts
    FROM claims c
    LEFT JOIN sources s   ON s.id   = c.source_id
    LEFT JOIN entities e_s ON e_s.id = c.subject_entity_id
    LEFT JOIN entities e_o ON e_o.id = c.object_entity_id
    WHERE c.id = ?
      AND c.review_status = 'ai_reviewed'
      AND c.source_quote IS NOT NULL AND c.source_quote != ''
    LIMIT 1
  `).get(id) as ClaimDetail | undefined;
  return row ?? null;
}

export function getSourceBySlug(slug: string): SourceWithClaims | null {
  const db = getDb();
  const source = db.prepare(`
    SELECT id, slug, title, authors, year, publication, source_type, url, doi, license
    FROM sources WHERE slug = ? LIMIT 1
  `).get(slug) as Source | undefined;

  if (!source) return null;

  const claims = db.prepare(`
    SELECT
      c.id, c.interaction_category, c.interaction_type_raw, c.interaction_type_globi,
      c.effect_direction,
      c.source_quote, c.source_page, c.reference_citation,
      c.subject_entity_id, c.object_entity_id, c.source_id,
      ? AS source_title, ? AS source_authors, ? AS source_year,
      ? AS source_publication, ? AS source_url, ? AS source_license, ? AS source_slug,
      e_s.scientific_name AS subject_scientific_name,
      e_s.common_name     AS subject_common_name,
      e_s.slug            AS subject_slug,
      e_o.scientific_name AS object_scientific_name,
      e_o.common_name     AS object_common_name,
      e_o.slug            AS object_slug,
      (SELECT GROUP_CONCAT(critic_name || '|' || verdict, CHAR(10))
         FROM claim_critic_verdicts ccv
         WHERE ccv.staging_id = c.staging_id
      ) AS critic_verdicts
    FROM claims c
    LEFT JOIN entities e_s ON e_s.id = c.subject_entity_id
    LEFT JOIN entities e_o ON e_o.id = c.object_entity_id
    WHERE c.source_id = ?
      AND c.review_status = 'ai_reviewed'
      AND c.source_quote IS NOT NULL AND c.source_quote != ''
    ORDER BY c.interaction_category, c.id
  `).all(
    source.title, source.authors, source.year,
    source.publication, source.url, source.license, source.slug,
    source.id
  ) as Claim[];

  return { source, claims };
}
