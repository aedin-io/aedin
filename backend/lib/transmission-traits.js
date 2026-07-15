'use strict';
/**
 * transmission-traits.js — DERIVED (D1-only) pathogen transmission traits,
 * materialized at D1-build from the `disease_vector` edges (the same build-time
 * derivation pattern as variety inheritance, lib/variety-traits.js). NEVER stored in
 * the corpus; regenerated on every full build.
 *
 * For each SERVED pathogen that is the object of >=1 `ai_reviewed` `disease_vector` edge:
 *   - `transmission_vector` : value_json = sorted distinct list of its vector names (the edge subjects)
 *   - `transmission_mode`   : value_text = 'vector_borne'
 *
 * Synthetic ids (`pathogenId*1e9 + offset`) keep them collision-free + identifiable.
 * `inherited_from_entity_id` is left null (these are NOT variety-inherited, so the
 * variety-inheritance refresh — which deletes WHERE inherited_from_entity_id IS NOT NULL —
 * never touches them). This is the BIOLOGICAL half only; abiotic `transmission_mode`
 * values (seed/soil/sap/…) come from extraction, not here.
 */
const K = 1_000_000_000;

function makeRow(id, entityId, trait, { text = null, json = null }) {
  return {
    id, entity_id: entityId, trait_name: trait,
    value_numeric: null, value_text: text, value_json: json, unit: null,
    source_id: null, staging_id: null, source_quote: null, source_page: null,
    regional_context: null, review_status: 'ai_reviewed', inherited_from_entity_id: null,
  };
}

function derivePathogenTransmission(db) {
  const edges = db.prepare(`
    SELECT eo.id AS pathogen_id, es.scientific_name AS vector
    FROM claims c
    JOIN entities es ON es.id = c.subject_entity_id
    JOIN entities eo ON eo.id = c.object_entity_id
    WHERE c.interaction_category = 'disease_vector' AND c.review_status = 'ai_reviewed'
      AND eo.scope_tier IS NOT NULL
  `).all();
  // Don't duplicate a pathogen that ALREADY has a stored (extracted, source-backed)
  // transmission trait — the stored one wins (it carries provenance). Reconcile.
  const storedVector = new Set(
    db.prepare(`SELECT DISTINCT entity_id FROM entity_trait_claims WHERE trait_name='transmission_vector'`).all().map(r => r.entity_id)
  );
  const storedVectorBorne = new Set(
    db.prepare(`SELECT DISTINCT entity_id FROM entity_trait_claims WHERE trait_name='transmission_mode' AND value_text='vector_borne'`).all().map(r => r.entity_id)
  );
  const byPathogen = new Map();
  for (const e of edges) {
    if (!byPathogen.has(e.pathogen_id)) byPathogen.set(e.pathogen_id, new Set());
    if (e.vector) byPathogen.get(e.pathogen_id).add(e.vector);
  }
  const out = [];
  for (const [pid, vset] of byPathogen) {
    if (!vset.size) continue;
    if (!storedVector.has(pid)) out.push(makeRow(pid * K + 1, pid, 'transmission_vector', { json: JSON.stringify([...vset].sort()) }));
    if (!storedVectorBorne.has(pid)) out.push(makeRow(pid * K + 2, pid, 'transmission_mode', { text: 'vector_borne' }));
  }
  return out;
}

module.exports = { derivePathogenTransmission };
