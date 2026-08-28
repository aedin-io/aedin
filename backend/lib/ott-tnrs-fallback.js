'use strict';
/**
 * ott-tnrs-fallback.js — resolve the local residual via the Open Tree TNRS API.
 *
 * Local always wins: a name resolvable from the pinned dump never reaches the
 * network (see resolve-entities-to-ott.js). Only the residual arrives here —
 * measured at 27,604 entities (of ~196K) on 2026-08-25.
 *
 * CONTEXT MUST BE PINNED. TNRS infers a context from the whole batch and then
 * silently drops names outside it: ["Ficus variegata", "Oospora pucciniophila"]
 * returns ZERO matches for the plant, because the fungus narrows the inferred
 * context to Ascomycetes. Grouping by kingdom is not an optimisation, it is a
 * correctness requirement.
 *
 * Rows resolved here get ott_status='resolved_tnrs', NOT 'resolved_local' —
 * they are not reproducible from the pinned dump alone.
 */
const https = require('https');

const API = 'https://api.opentreeoflife.org/v3/tnrs/match_names';

const KINGDOM_TO_CONTEXT = Object.freeze({
  plantae: 'Land plants',
  fungi: 'Fungi',
  invertebrate: 'Animals',
  vertebrate: 'Animals',
  microbe: 'Bacteria',
});

function contextForKingdom(bioCategory) {
  return KINGDOM_TO_CONTEXT[String(bioCategory || '').toLowerCase()] || null;
}

function groupByContext(entities) {
  const groups = new Map();
  for (const e of entities || []) {
    const ctx = contextForKingdom(e.bio_category);
    if (!ctx) continue;                       // no safe context -> leave unmatched
    if (!groups.has(ctx)) groups.set(ctx, []);
    groups.get(ctx).push(e);
  }
  return groups;
}

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, (res) => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(data)); } catch (err) { reject(err); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/**
 * @param {string[]} names
 * @param {string} contextName  REQUIRED — never omit
 * @param {(url: string, body: object) => Promise<object>} [fetchImpl]
 * @returns {Promise<Map<string, number>>} name -> ott_id (only matched names)
 */
async function matchNames(names, contextName, fetchImpl = postJson) {
  if (!contextName) throw new Error('matchNames: contextName is required');
  const body = { names, context_name: contextName, do_approximate_matching: false };
  const data = await fetchImpl(API, body);
  const out = new Map();
  for (const r of data.results || []) {
    const m = (r.matches || [])[0];
    if (m && m.taxon && m.taxon.ott_id != null) out.set(r.name, m.taxon.ott_id);
  }
  return out;
}

module.exports = { contextForKingdom, groupByContext, matchNames, KINGDOM_TO_CONTEXT, API };
