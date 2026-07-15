'use strict';
const { normalizeLang } = require('./lang-normalize');

// GBIF /species/{key}/vernacularNames `results` -> records.
function gbifVernacularRecords(results) {
  const out = [];
  for (const v of (results || [])) {
    const name = (v && v.vernacularName ? String(v.vernacularName) : '').trim();
    const language = normalizeLang(v && v.language);
    if (!name || !language) continue;
    out.push({ name, language, source: 'gbif', source_ref: (v && v.source) || null, is_preferred: 0 });
  }
  return out;
}

// Wikidata SPARQL P1843 bindings -> records. P1843 = curated taxon common name;
// treated as preferred (1) for its language (Wikidata has one P1843 value/lang as the curated name).
function wikidataCommonNameRecords(bindings, qid) {
  const out = [];
  for (const b of (bindings || [])) {
    const cn = b && b.commonName;
    const name = (cn && cn.value ? String(cn.value) : '').trim();
    const language = normalizeLang(cn && cn['xml:lang']);
    if (!name || !language) continue;
    out.push({ name, language, source: 'wikidata', source_ref: qid || null, is_preferred: 1 });
  }
  return out;
}

module.exports = { gbifVernacularRecords, wikidataCommonNameRecords };
