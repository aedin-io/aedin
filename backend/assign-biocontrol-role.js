/**
 * assign-biocontrol-role.js
 *
 * Assigns primary_role = 'biocontrol' to entities that are known biological
 * control agents. Run AFTER sync-gbif.js so taxonomy is populated.
 *
 * Categories:
 *   1. Predatory insects (by family)
 *   2. Parasitoid wasps (already role=parasitoid, also by family)
 *   3. Entomopathogenic fungi (known species/genera)
 *   4. Entomopathogenic bacteria (known species/genera)
 *   5. Entomopathogenic nematodes (by family/genus)
 *   6. Predatory mites (by family)
 *
 * Usage:
 *   node assign-biocontrol-role.js --dry-run   # preview
 *   node assign-biocontrol-role.js             # apply
 */
'use strict';

const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { CORPUS_DB } = require('./lib/db-paths.cjs');

const DB_PATH = CORPUS_DB;

// ── Predatory insect families ────────────────────────────────────────────────
// These families contain primarily predatory species used in biocontrol
const PREDATOR_FAMILIES = new Set([
  // Beetles
  'coccinellidae',       // Ladybugs — aphid predators
  'carabidae',           // Ground beetles — slug/caterpillar predators
  'staphylinidae',       // Rove beetles — soil pest predators

  // Lacewings & allies
  'chrysopidae',         // Green lacewings — aphid predators (larvae)
  'hemerobiidae',        // Brown lacewings
  'coniopterygidae',     // Dustywings

  // Hoverflies (larvae are aphid predators, adults pollinate)
  'syrphidae',

  // True bugs
  'anthocoridae',        // Minute pirate bugs (Orius spp.)
  'miridae',             // Plant bugs (some predatory: Macrolophus, Dicyphus)
  'nabidae',             // Damsel bugs
  'reduviidae',          // Assassin bugs
  'geocoridae',          // Big-eyed bugs
  'pentatomidae',        // Some predatory stink bugs (Podisus)

  // Flies
  'cecidomyiidae',       // Gall midges (Aphidoletes aphidimyza)
  'tachinidae',          // Tachinid flies — parasitoids of caterpillars

  // Dragonflies
  'libellulidae',
  'aeshnidae',

  // Mantids
  'mantidae',
]);

// ── Parasitoid wasp families ─────────────────────────────────────────────────
const PARASITOID_FAMILIES = new Set([
  'braconidae',          // Braconid wasps
  'ichneumonidae',       // Ichneumon wasps
  'trichogrammatidae',   // Trichogramma egg parasitoids
  'aphelinidae',         // Aphelinid wasps (Encarsia, Eretmocerus)
  'encyrtidae',          // Encyrtid wasps
  'eulophidae',          // Eulophid wasps
  'pteromalidae',        // Pteromalid wasps
  'mymaridae',           // Fairyflies — egg parasitoids
  'platygastridae',      // Platygastrid wasps
  'scelionidae',         // Scelionid wasps — egg parasitoids
  'chalcididae',         // Chalcid wasps
  'figitidae',           // Figitid wasps
  'diapriidae',          // Diapriid wasps
  'bethylidae',          // Bethylid wasps
]);

// ── Predatory mite families ──────────────────────────────────────────────────
const PREDATORY_MITE_FAMILIES = new Set([
  'phytoseiidae',        // Amblyseius, Neoseiulus, Phytoseiulus
  'laelapidae',          // Stratiolaelaps (soil mite predators)
  'macrochelidae',       // Macrocheles (fly egg predators)
]);

// ── Entomopathogenic fungi — genus-level matching ────────────────────────────
const ENTOMOPATHOGENIC_FUNGI_GENERA = new Set([
  'beauveria',           // Beauveria bassiana — broad spectrum
  'metarhizium',         // Metarhizium anisopliae — soil pests
  'isaria',              // Isaria fumosorosea — whitefly
  'cordyceps',           // Cordyceps spp. — various insects
  'ophiocordyceps',      // Ophiocordyceps — ant zombification
  'entomophthora',       // Entomophthora — aphid pathogen
  'pandora',             // Pandora neoaphidis — aphid pathogen
  'neozygites',          // Neozygites — mite/aphid pathogen
  'lecanicillium',       // Lecanicillium (formerly Verticillium lecanii)
  'hirsutella',          // Hirsutella — mite pathogen
  'nomuraea',            // Nomuraea rileyi — caterpillar pathogen
  'paecilomyces',        // Paecilomyces — nematode/insect pathogen
  'purpureocillium',     // Purpureocillium lilacinum — nematode biocontrol
  'trichoderma',         // Trichoderma — soil fungal biocontrol (suppresses plant pathogens)
]);

// ── Entomopathogenic bacteria — genus or species level ───────────────────────
const ENTOMOPATHOGENIC_BACTERIA = new Set([
  'bacillus thuringiensis',
  'bacillus popilliae',
  'bacillus sphaericus',
  'lysinibacillus sphaericus',
  'paenibacillus popilliae',
  'serratia entomophila',
  'photorhabdus luminescens',
  'xenorhabdus nematophila',
]);

const ENTOMOPATHOGENIC_BACTERIA_GENERA = new Set([
  'photorhabdus',        // Symbiont of entomopathogenic nematodes
  'xenorhabdus',         // Symbiont of Steinernema nematodes
]);

// ── Entomopathogenic nematode families/genera ────────────────────────────────
const NEMATODE_GENERA = new Set([
  'steinernema',         // Steinernema spp.
  'heterorhabditis',     // Heterorhabditis spp.
  'phasmarhabditis',     // Slug biocontrol
]);

// ── Classification logic ─────────────────────────────────────────────────────

function shouldBeBiocontrol(entity) {
  const family = (entity.family || '').toLowerCase();
  const genus = (entity.genus || '').toLowerCase();
  const name = (entity.scientific_name || '').toLowerCase();
  const bio = (entity.bio_category || '').toLowerCase();
  const cls = (entity.taxon_class || '').toLowerCase();

  // 1. Predatory insect families
  if (bio === 'invertebrate' && PREDATOR_FAMILIES.has(family)) {
    return { reason: `predatory family: ${family}` };
  }

  // 2. Parasitoid wasp families
  if (bio === 'invertebrate' && PARASITOID_FAMILIES.has(family)) {
    return { reason: `parasitoid family: ${family}` };
  }

  // 3. Predatory mite families
  if (bio === 'invertebrate' && PREDATORY_MITE_FAMILIES.has(family)) {
    return { reason: `predatory mite family: ${family}` };
  }

  // 4. Entomopathogenic fungi
  if (bio === 'fungi' && ENTOMOPATHOGENIC_FUNGI_GENERA.has(genus)) {
    return { reason: `entomopathogenic fungus: ${genus}` };
  }

  // 5. Entomopathogenic bacteria (exact species or genus match)
  if (bio === 'microbe') {
    if (ENTOMOPATHOGENIC_BACTERIA.has(name)) {
      return { reason: `entomopathogenic bacterium: ${name}` };
    }
    if (ENTOMOPATHOGENIC_BACTERIA_GENERA.has(genus)) {
      return { reason: `entomopathogenic bacterium genus: ${genus}` };
    }
  }

  // 6. Entomopathogenic nematodes
  if (NEMATODE_GENERA.has(genus)) {
    return { reason: `entomopathogenic nematode: ${genus}` };
  }

  // 7. Already classified as predator or parasitoid (keep as biocontrol)
  if (entity.primary_role === 'predator' || entity.primary_role === 'parasitoid') {
    return { reason: `existing role: ${entity.primary_role}` };
  }

  return null;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });

  const entities = await db.all(`
    SELECT id, scientific_name, common_name, bio_category, primary_role,
           family, genus, taxon_class
    FROM entities
    WHERE parent_entity_id IS NULL
      AND primary_role != 'biocontrol'
  `);

  console.log(`=== Biocontrol Role Assignment ===`);
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log(`Scanning ${entities.length} entities...\n`);

  let assigned = 0;
  const byReason = {};
  const samples = [];

  for (const e of entities) {
    const result = shouldBeBiocontrol(e);
    if (!result) continue;

    byReason[result.reason] = (byReason[result.reason] || 0) + 1;

    if (samples.length < 30) {
      samples.push({ name: e.scientific_name, role: e.primary_role, bio: e.bio_category, reason: result.reason });
    }

    if (!dryRun) {
      await db.run(
        "UPDATE entities SET primary_role = 'biocontrol', updated_at = datetime('now') WHERE id = ?",
        e.id
      );
    }

    assigned++;
  }

  console.log(`Assigned: ${assigned}\n`);

  console.log('By reason:');
  const sorted = Object.entries(byReason).sort((a, b) => b[1] - a[1]);
  for (const [reason, count] of sorted) {
    console.log(`  ${reason}: ${count}`);
  }

  console.log('\nSamples:');
  for (const s of samples) {
    console.log(`  ${s.name} (was: ${s.role}/${s.bio}) — ${s.reason}`);
  }

  if (!dryRun) {
    const stats = await db.all("SELECT primary_role, COUNT(*) as n FROM entities WHERE parent_entity_id IS NULL GROUP BY primary_role ORDER BY n DESC");
    console.log('\nRole breakdown:');
    for (const s of stats) console.log(`  ${s.primary_role}: ${s.n}`);
  }

  await db.close();
  console.log('\nDone.');
}

main().catch(err => { console.error('Failed:', err); process.exit(1); });
