'use strict';

/**
 * reclassify-bio-category.js — correct mislabeled entities.bio_category
 * (Pass-13 post-mortem #2). Auto-created extraction entities often carry the
 * extractor's wrong bio_category guess (Bacillus thuringiensis→plantae,
 * Lycopersicon esculentum→invertebrate), which mis-routes claims and lowers
 * critic confidence. bio_category ∈ {plantae,fungi,invertebrate,vertebrate,microbe,other}.
 *
 * Derivation, in confidence order (first match wins):
 *   T1  AUTHORITATIVE — phylum/class taxonomy already in the row maps to a
 *       kingdom that contradicts bio_category. Real taxonomy, not a heuristic.
 *       (Also fixes plants whose phylum is present, e.g. Streptophyta.)
 *   T2a NAME-MAP — NULL-taxonomy entity whose genus is a known bacterial /
 *       fungal genus.
 *   T2b PLANT-TRAIT — NULL-taxonomy entity (not caught by T1/T2a) that is the
 *       subject of a plantae-ONLY trait claim → plantae. Ordering T1 first
 *       means a Basidiomycota fungus with a mis-assigned plant trait (e.g.
 *       Ustilago maydis) is already resolved to fungi and never reaches here.
 *
 * SAFE BY DEFAULT: dry-run prints every proposed change grouped by tier + a
 * timestamped JSON backup of (id, old, new, signal). --apply commits. Reversible.
 *
 * Usage:
 *   node reclassify-bio-category.js            # dry-run + backup, no writes
 *   node reclassify-bio-category.js --tier1    # restrict to authoritative T1
 *   node reclassify-bio-category.js --apply    # apply all tiers
 *   node reclassify-bio-category.js --tier1 --apply
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { CORPUS_DB } = require('./lib/db-paths.cjs');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const TIER1_ONLY = argv.includes('--tier1');
// --safe: ONLY the name-genus tier (T2a). The dry-run (2026-06-06) showed the
// entities.phylum/taxon_class columns are themselves corrupt for many rows
// (genus-name collisions: Ficus→Mollusca, Cyathus→Arthropoda), so the T1
// taxonomy tier is NOT trustworthy, and T2b (plant-trait) has pathogen
// false-positives (Erysiphe→plantae). T2a reads only curated bacterial/fungal
// genus names, never the corrupt taxonomy, and refuses to override an existing
// animal tag (dodges the Bacillus-the-stick-insect collision class).
const SAFE_ONLY = argv.includes('--safe');
const DB_PATH = CORPUS_DB;
const BACKUP_DIR = path.join(__dirname, 'backups');

// --- taxonomy → bio_category maps (authoritative) ---
const PHYLUM_TO_BIO = {
  // bacteria (current + legacy names)
  firmicutes: 'microbe', bacillota: 'microbe', proteobacteria: 'microbe', pseudomonadota: 'microbe',
  actinobacteria: 'microbe', actinomycetota: 'microbe', bacteroidetes: 'microbe', bacteroidota: 'microbe',
  cyanobacteria: 'microbe', tenericutes: 'microbe', mycoplasmatota: 'microbe', spirochaetes: 'microbe',
  // fungi
  ascomycota: 'fungi', basidiomycota: 'fungi', mucoromycota: 'fungi', glomeromycota: 'fungi',
  zygomycota: 'fungi', chytridiomycota: 'fungi', blastocladiomycota: 'fungi', microsporidia: 'fungi',
  // plants
  streptophyta: 'plantae', tracheophyta: 'plantae', magnoliophyta: 'plantae', bryophyta: 'plantae',
  chlorophyta: 'plantae', marchantiophyta: 'plantae', anthocerotophyta: 'plantae', rhodophyta: 'plantae',
  // animals
  arthropoda: 'invertebrate', mollusca: 'invertebrate', nematoda: 'invertebrate', annelida: 'invertebrate',
  platyhelminthes: 'invertebrate', chordata: 'vertebrate',
};
const CLASS_TO_BIO = {
  bacilli: 'microbe', gammaproteobacteria: 'microbe', alphaproteobacteria: 'microbe',
  betaproteobacteria: 'microbe', actinomycetia: 'microbe', actinomycetes: 'microbe', actinobacteria: 'microbe',
  clostridia: 'microbe', mollicutes: 'microbe',
  magnoliopsida: 'plantae', liliopsida: 'plantae', pinopsida: 'plantae', polypodiopsida: 'plantae',
  insecta: 'invertebrate', arachnida: 'invertebrate', collembola: 'invertebrate', gastropoda: 'invertebrate',
  chromadorea: 'invertebrate', secernentea: 'invertebrate',
  aves: 'vertebrate', mammalia: 'vertebrate', reptilia: 'vertebrate', amphibia: 'vertebrate', actinopterygii: 'vertebrate',
};
// NULL-taxonomy genus name-map (curated, high-confidence)
const BACTERIAL_GENERA = new Set([
  'bacillus','paenibacillus','pseudomonas','rhizobium','bradyrhizobium','sinorhizobium','mesorhizobium',
  'ensifer','agrobacterium','streptomyces','xanthomonas','erwinia','pectobacterium','ralstonia','clavibacter',
  'pantoea','burkholderia','azospirillum','azotobacter','serratia','escherichia','photorhabdus','xenorhabdus',
  'pasteuria','curtobacterium','lactobacillus','acetobacter','gluconacetobacter','frankia','nostoc','anabaena',
  'spiroplasma','liberibacter','candidatus','wolbachia','acidovorax','dickeya','leifsonia','rhodococcus','lysobacter',
]);
const FUNGAL_GENERA = new Set([
  'trichoderma','beauveria','metarhizium','lecanicillium','verticillium','glomus','rhizophagus','funneliformis',
  'pleurotus','aspergillus','penicillium','fusarium','botrytis','alternaria','colletotrichum','cercospora',
  'septoria','puccinia','sclerotinia','rhizoctonia','ustilago','phakopsora','corynespora','curvularia','stemphylium',
]);

const PLANT_TRAITS = new Set([
  'ph_min','ph_max','growth_habit','bloom_months','fruit_months','maximum_height_cm','toxicity',
  'allelopathic_activity','native_zones','introduced_zones','days_to_harvest','agronomic_uses',
  'hardiness_zone','light_requirement','temperature_min_c','temperature_max_c','invasive_regions','habitat_type',
]);

const db = new Database(DB_PATH);

const norm = s => (s || '').toString().trim().toLowerCase();
const genusOf = sci => norm(sci).split(/\s+/)[0];

// entities that are the subject of a plantae-only trait claim (for T2b)
const plantTraitEntityIds = new Set(
  db.prepare(
    `SELECT DISTINCT entity_id FROM entity_trait_claims WHERE trait_name IN (${[...PLANT_TRAITS].map(() => '?').join(',')})`
  ).all(...PLANT_TRAITS).map(r => r.entity_id)
);

function derive(e) {
  const isAnimal = v => v === 'invertebrate' || v === 'vertebrate';
  // --safe: name-genus tier ONLY, and never override an existing animal tag.
  if (SAFE_ONLY) {
    const g = genusOf(e.scientific_name);
    if (isAnimal(norm(e.bio_category))) return null;
    if (BACTERIAL_GENERA.has(g)) return { bio: 'microbe', tier: 'T2a-genus', signal: `genus ${g}` };
    if (FUNGAL_GENERA.has(g)) return { bio: 'fungi', tier: 'T2a-genus', signal: `genus ${g}` };
    return null;
  }
  // T1: taxonomy (NOTE: corrupt for many rows — see --safe; kept for diagnosis)
  const phy = PHYLUM_TO_BIO[norm(e.phylum)];
  if (phy) return { bio: phy, tier: 'T1-phylum', signal: e.phylum };
  const cls = CLASS_TO_BIO[norm(e.taxon_class)];
  if (cls) return { bio: cls, tier: 'T1-class', signal: e.taxon_class };
  if (TIER1_ONLY) return null;
  // T2a: genus name-map (NULL taxonomy)
  const g = genusOf(e.scientific_name);
  if (BACTERIAL_GENERA.has(g)) return { bio: 'microbe', tier: 'T2a-genus', signal: `genus ${g}` };
  if (FUNGAL_GENERA.has(g)) return { bio: 'fungi', tier: 'T2a-genus', signal: `genus ${g}` };
  // T2b: plant-only trait subject
  if (plantTraitEntityIds.has(e.id)) return { bio: 'plantae', tier: 'T2b-plant-trait', signal: 'plantae-only trait claim' };
  return null;
}

const rows = db.prepare(
  `SELECT id, scientific_name, bio_category, phylum, taxon_class FROM entities
   WHERE bio_category IS NULL OR bio_category != 'species_placeholder'`
).all();

const changes = [];
for (const e of rows) {
  const d = derive(e);
  if (d && d.bio !== norm(e.bio_category)) {
    changes.push({ id: e.id, name: e.scientific_name, old: e.bio_category, new: d.bio, tier: d.tier, signal: d.signal });
  }
}

// report
const byTier = {};
for (const c of changes) byTier[c.tier] = (byTier[c.tier] || 0) + 1;
console.log(`[reclassify] mode=${APPLY ? 'APPLY' : 'DRY-RUN'}${TIER1_ONLY ? ' (T1 only)' : ''}  proposed changes: ${changes.length}`);
console.log('[reclassify] by tier:', JSON.stringify(byTier));

fs.mkdirSync(BACKUP_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupFile = path.join(BACKUP_DIR, `reclassify-bio-category-${stamp}.json`);
fs.writeFileSync(backupFile, JSON.stringify({ created_at: new Date().toISOString(), changes }, null, 2));
console.log(`[reclassify] backup: ${backupFile}`);

console.log('[reclassify] sample (first 25):');
for (const c of changes.slice(0, 25)) {
  console.log(`  #${c.id}  ${String(c.name).slice(0, 38).padEnd(38)} ${String(c.old).padEnd(12)} → ${String(c.new).padEnd(11)} [${c.tier}: ${c.signal}]`);
}

if (!APPLY) {
  console.log('[reclassify] DRY-RUN — nothing changed. Re-run with --apply (optionally --tier1) to commit.');
  db.close();
  process.exit(0);
}

const upd = db.prepare('UPDATE entities SET bio_category = ? WHERE id = ?');
const tx = db.transaction(cs => { for (const c of cs) upd.run(c.new, c.id); });
tx(changes);
console.log(`[reclassify] UPDATED ${changes.length} entities. Reversible from backup ${path.basename(backupFile)}.`);
db.close();
