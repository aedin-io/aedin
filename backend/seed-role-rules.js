/**
 * seed-role-rules.js
 *
 * One-time script to populate the role_rules table from the hardcoded rules
 * in classify-taxon.js and assign-biocontrol-role.js.
 *
 * Idempotent — uses INSERT OR IGNORE on the UNIQUE constraint.
 *
 * Usage:
 *   node seed-role-rules.js             # insert rules
 *   node seed-role-rules.js --dry-run   # preview without inserting
 */
'use strict';

const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { CORPUS_DB } = require('./lib/db-paths.cjs');

const DB_PATH = CORPUS_DB;

// ── Rules extracted from classify-taxon.js GENUS_RULES ──────────────────────
// Priority 70 (genus level)
const GENUS_RULES = [
  // Bees
  { genera: ['apis', 'bombus', 'osmia', 'xylocopa', 'trigona', 'melipona', 'megachile',
             'lasioglossum', 'halictus', 'colletes', 'andrena', 'ceratina', 'eucera',
             'amegilla', 'anthophora', 'dasypoda', 'nomia', 'hylaeus'],
    role: 'pollinator', reason: 'Bee genus — primary pollinator' },
  // Syrphidae — dual role
  { genera: ['syrphus', 'episyrphus', 'eristalis', 'melanostoma', 'eupeodes',
             'platycheirus', 'baccha', 'scaeva', 'helophilus', 'volucella'],
    role: 'pollinator', secondary: 'beneficial_predator', reason: 'Hoverfly genus — pollinator (adult), aphid predator (larva)' },
  // Parasitoid wasps (genus level)
  { genera: ['trichogramma', 'aphidius', 'cotesia', 'encarsia', 'eretmocerus',
             'diglyphus', 'aphelinus', 'pteromalus', 'nasonia', 'habrobracon',
             'macrocentrus', 'meteorus', 'microplitis', 'praon', 'lysiphlebus',
             'opius', 'dacnusa', 'muscidifurax'],
    role: 'beneficial_parasitoid', reason: 'Parasitoid wasp genus' },
  // Predatory wasps
  { genera: ['vespula', 'vespa', 'dolichovespula', 'polistes', 'polybia'],
    role: 'beneficial_predator', reason: 'Predatory social wasp genus' },
  // Potter wasps
  { genera: ['eumenes', 'ancistrocerus', 'symmorphus', 'delta'],
    role: 'beneficial_parasitoid', reason: 'Potter wasp genus — parasitoid of caterpillars' },
  // Leaf-cutter ants
  { genera: ['atta', 'acromyrmex'],
    role: 'pest_insect', reason: 'Leaf-cutter ant genus — defoliator' },
  // Predatory beetles / lacewings
  { genera: ['coccinella', 'chrysoperla', 'hippodamia', 'adalia', 'harmonia',
             'coleomegilla', 'cryptolaemus', 'stethorus', 'chrysopa', 'chrysocarabus'],
    role: 'beneficial_predator', reason: 'Predatory beetle/lacewing genus — aphid predator' },
  // Entomopathogenic fungi
  { genera: ['beauveria', 'metarhizium', 'isaria', 'lecanicillium', 'paecilomyces',
             'nomuraea', 'hirsutella', 'cordyceps', 'ophiocordyceps', 'entomophthora',
             'pandora', 'neozygites', 'purpureocillium'],
    role: 'biocontrol', secondary: 'soil_microbe', reason: 'Entomopathogenic fungus genus' },
  // Trichoderma (soil biocontrol)
  { genera: ['trichoderma'],
    role: 'biocontrol', secondary: 'soil_microbe', reason: 'Trichoderma — suppresses plant pathogens in soil' },
  // Mycorrhizal & N-fixing soil microbes
  { genera: ['glomus', 'rhizophagus', 'funneliformis', 'scutellospora', 'gigaspora',
             'rhizobium', 'bradyrhizobium', 'sinorhizobium', 'mesorhizobium',
             'azotobacter', 'azospirillum', 'frankia', 'nitrobacter', 'nitrosomonas'],
    role: 'soil_microbe', reason: 'Mycorrhizal or nitrogen-fixing microbe genus' },
  // Entomopathogenic nematodes
  { genera: ['steinernema', 'heterorhabditis', 'phasmarhabditis'],
    role: 'biocontrol', reason: 'Entomopathogenic nematode genus' },
  // Plant-parasitic nematodes
  { genera: ['meloidogyne', 'pratylenchus', 'globodera', 'heterodera', 'ditylenchus',
             'aphelenchoides', 'nacobbus', 'tylenchulus', 'rotylenchulus'],
    role: 'pathogen_nematode', reason: 'Plant-parasitic nematode genus' },
  // Oomycetes
  { genera: ['phytophthora', 'pythium', 'plasmopara', 'peronospora', 'bremia',
             'albugo', 'phytopythium', 'hyaloperonospora'],
    role: 'pathogen_fungal', reason: 'Oomycete genus — plant pathogen (treated as fungal)' },
  // Vertebrate pests
  { genera: ['rattus', 'mus', 'arvicola', 'microtus', 'apodemus', 'clethrionomys',
             'oryctolagus', 'lepus', 'sylvilagus', 'odocoileus', 'capreolus',
             'cervus', 'dama', 'sus'],
    role: 'pest_vertebrate', reason: 'Vertebrate pest genus — rodent/lagomorph/ungulate' },
  // Beneficial bats
  { genera: ['rhinolophus', 'myotis', 'pipistrellus', 'tadarida', 'desmodus',
             'eptesicus', 'noctilio', 'artibeus'],
    role: 'beneficial_predator', reason: 'Bat genus — insectivorous biocontrol' },
  // Entomopathogenic bacteria (genus level)
  { genera: ['photorhabdus', 'xenorhabdus'],
    role: 'biocontrol', reason: 'Entomopathogenic bacterium genus — nematode symbiont' },
];

// ── Rules extracted from classify-taxon.js FAMILY_RULES ─────────────────────
// Priority 50 (family level)
const FAMILY_RULES = [
  // Parasitoid wasps/flies
  { match: 'ichneumonidae',     role: 'beneficial_parasitoid', reason: 'Ichneumon wasps — parasitoids' },
  { match: 'braconidae',        role: 'beneficial_parasitoid', reason: 'Braconid wasps — parasitoids' },
  { match: 'trichogrammatidae', role: 'beneficial_parasitoid', reason: 'Trichogramma egg parasitoids' },
  { match: 'aphelinidae',       role: 'beneficial_parasitoid', reason: 'Aphelinid wasps (Encarsia, Eretmocerus)' },
  { match: 'encyrtidae',        role: 'beneficial_parasitoid', reason: 'Encyrtid wasps — parasitoids' },
  { match: 'pteromalidae',      role: 'beneficial_parasitoid', reason: 'Pteromalid wasps — parasitoids' },
  { match: 'eulophidae',        role: 'beneficial_parasitoid', reason: 'Eulophid wasps — parasitoids' },
  { match: 'figitidae',         role: 'beneficial_parasitoid', reason: 'Figitid wasps — parasitoids' },
  { match: 'platygastridae',    role: 'beneficial_parasitoid', reason: 'Platygastrid wasps — egg parasitoids' },
  { match: 'scelionidae',       role: 'beneficial_parasitoid', reason: 'Scelionid wasps — egg parasitoids' },
  { match: 'proctotrupidae',    role: 'beneficial_parasitoid', reason: 'Proctotrupid wasps — parasitoids' },
  { match: 'chalcidoidea',      role: 'beneficial_parasitoid', reason: 'Chalcid wasps (superfamily) — parasitoids' },
  { match: 'tachinidae',        role: 'beneficial_parasitoid', reason: 'Tachinid flies — parasitoids of caterpillars' },
  // Predatory wasps/beetles/lacewings
  { match: 'sphecidae',         role: 'beneficial_predator', reason: 'Sphecid wasps — predators' },
  { match: 'pompilidae',        role: 'beneficial_predator', reason: 'Pompilid wasps — spider hunters' },
  { match: 'crabronidae',       role: 'beneficial_predator', reason: 'Crabronid wasps — predators' },
  { match: 'coccinellidae',     role: 'beneficial_predator', reason: 'Ladybugs — aphid predators' },
  { match: 'carabidae',         role: 'beneficial_predator', reason: 'Ground beetles — slug/caterpillar predators' },
  { match: 'staphylinidae',     role: 'beneficial_predator', reason: 'Rove beetles — soil pest predators' },
  { match: 'chrysopidae',       role: 'beneficial_predator', reason: 'Green lacewings — aphid predators (larvae)' },
  { match: 'hemerobiidae',      role: 'beneficial_predator', reason: 'Brown lacewings — predators' },
  { match: 'phytoseiidae',      role: 'beneficial_predator', reason: 'Predatory mites (Amblyseius, Phytoseiulus)' },
  // Pollinators
  { match: 'apidae',            role: 'pollinator', reason: 'Bee family' },
  { match: 'halictidae',        role: 'pollinator', reason: 'Sweat bee family' },
  { match: 'colletidae',        role: 'pollinator', reason: 'Colletid bee family' },
  { match: 'andrenidae',        role: 'pollinator', reason: 'Mining bee family' },
  { match: 'megachilidae',      role: 'pollinator', reason: 'Leafcutter/mason bee family' },
  { match: 'syrphidae',         role: 'pollinator', secondary: 'beneficial_predator', reason: 'Hoverflies — pollinator (adult), predator (larva)' },
  // Pest insects
  { match: 'aphididae',         role: 'pest_insect', reason: 'Aphids — sap-feeding pests' },
  { match: 'aleyrodidae',       role: 'pest_insect', reason: 'Whiteflies — sap-feeding pests' },
  { match: 'coccidae',          role: 'pest_insect', reason: 'Soft scales — sap-feeding pests' },
  { match: 'diaspididae',       role: 'pest_insect', reason: 'Armored scales — sap-feeding pests' },
  { match: 'pseudococcidae',    role: 'pest_insect', reason: 'Mealybugs — sap-feeding pests' },
  { match: 'thripidae',         role: 'pest_insect', reason: 'Thrips — cell-piercing pests' },
  { match: 'phlaeothripidae',   role: 'pest_insect', reason: 'Tube-tailed thrips — pests' },
  { match: 'chrysomelidae',     role: 'pest_insect', reason: 'Leaf beetles — defoliators' },
  { match: 'curculionidae',     role: 'pest_insect', reason: 'Weevils — boring/feeding pests' },
  { match: 'cerambycidae',      role: 'pest_insect', reason: 'Longhorn beetles — wood borers' },
  { match: 'scolytidae',        role: 'pest_insect', reason: 'Bark beetles — wood borers' },
  { match: 'agromyzidae',       role: 'pest_insect', reason: 'Leafminer flies' },
  { match: 'tephritidae',       role: 'pest_insect', reason: 'Fruit flies — fruit pests' },
  { match: 'cecidomyiidae',     role: 'pest_insect', reason: 'Gall midges — some pest, some biocontrol' },
  { match: 'sciaridae',         role: 'pest_insect', reason: 'Fungus gnats — root pests' },
  { match: 'acrididae',         role: 'pest_insect', reason: 'Grasshoppers/locusts — defoliators' },
  { match: 'gryllidae',         role: 'pest_insect', reason: 'Crickets — occasional pests' },
  { match: 'cynipidae',         role: 'pest_insect', reason: 'Gall wasps — gall-forming pests' },
  { match: 'tenthredinidae',    role: 'pest_insect', reason: 'Sawflies — defoliators' },
  { match: 'siricidae',         role: 'pest_insect', reason: 'Wood wasps — wood borers' },
  // Pest mites
  { match: 'tetranychidae',     role: 'pest_mite', reason: 'Spider mites — sap-feeding pests' },
  { match: 'eriophyidae',       role: 'pest_mite', reason: 'Gall/rust mites — pests' },
  { match: 'tarsonemidae',      role: 'pest_mite', reason: 'Broad/cyclamen mites — pests' },
  // Soil microbes
  { match: 'glomeromycota',     role: 'soil_microbe', reason: 'Arbuscular mycorrhizal fungi (phylum)' },
];

// ── Additional biocontrol families from assign-biocontrol-role.js ────────────
// These override classify-taxon.js family rules with biocontrol role
// Priority 55 (between family=50 and genus=70)
const BIOCONTROL_FAMILY_OVERRIDES = [
  // Predatory insects — assign-biocontrol-role.js marks these as biocontrol
  { match: 'coccinellidae',     reason: 'Ladybugs — aphid predators (biocontrol)' },
  { match: 'carabidae',         reason: 'Ground beetles — slug/caterpillar predators (biocontrol)' },
  { match: 'staphylinidae',     reason: 'Rove beetles — soil pest predators (biocontrol)' },
  { match: 'chrysopidae',       reason: 'Green lacewings — aphid predators (biocontrol)' },
  { match: 'hemerobiidae',      reason: 'Brown lacewings (biocontrol)' },
  { match: 'coniopterygidae',   reason: 'Dustywings (biocontrol)' },
  { match: 'syrphidae',         reason: 'Hoverflies — aphid predators as larvae (biocontrol)' },
  { match: 'anthocoridae',      reason: 'Minute pirate bugs (Orius spp.) (biocontrol)' },
  { match: 'miridae',           reason: 'Plant bugs — some predatory (Macrolophus) (biocontrol)' },
  { match: 'nabidae',           reason: 'Damsel bugs (biocontrol)' },
  { match: 'reduviidae',        reason: 'Assassin bugs (biocontrol)' },
  { match: 'geocoridae',        reason: 'Big-eyed bugs (biocontrol)' },
  { match: 'pentatomidae',      reason: 'Predatory stink bugs (Podisus) (biocontrol)' },
  { match: 'cecidomyiidae',     reason: 'Gall midges — Aphidoletes (biocontrol)' },
  { match: 'tachinidae',        reason: 'Tachinid flies — parasitoids of caterpillars (biocontrol)' },
  { match: 'libellulidae',      reason: 'Dragonflies (biocontrol)' },
  { match: 'aeshnidae',         reason: 'Dragonflies (biocontrol)' },
  { match: 'mantidae',          reason: 'Mantids (biocontrol)' },
  // Parasitoid wasps
  { match: 'braconidae',        reason: 'Braconid wasps — parasitoids (biocontrol)' },
  { match: 'ichneumonidae',     reason: 'Ichneumon wasps — parasitoids (biocontrol)' },
  { match: 'trichogrammatidae', reason: 'Trichogramma egg parasitoids (biocontrol)' },
  { match: 'aphelinidae',       reason: 'Aphelinid wasps (biocontrol)' },
  { match: 'encyrtidae',        reason: 'Encyrtid wasps (biocontrol)' },
  { match: 'eulophidae',        reason: 'Eulophid wasps (biocontrol)' },
  { match: 'pteromalidae',      reason: 'Pteromalid wasps (biocontrol)' },
  { match: 'mymaridae',         reason: 'Fairyflies — egg parasitoids (biocontrol)' },
  { match: 'platygastridae',    reason: 'Platygastrid wasps (biocontrol)' },
  { match: 'scelionidae',       reason: 'Scelionid wasps — egg parasitoids (biocontrol)' },
  { match: 'chalcididae',       reason: 'Chalcid wasps (biocontrol)' },
  { match: 'figitidae',         reason: 'Figitid wasps (biocontrol)' },
  { match: 'diapriidae',        reason: 'Diapriid wasps (biocontrol)' },
  { match: 'bethylidae',        reason: 'Bethylid wasps (biocontrol)' },
  // Predatory mites
  { match: 'phytoseiidae',      reason: 'Predatory mites (Amblyseius, Phytoseiulus) (biocontrol)' },
  { match: 'laelapidae',        reason: 'Stratiolaelaps — soil mite predators (biocontrol)' },
  { match: 'macrochelidae',     reason: 'Macrocheles — fly egg predators (biocontrol)' },
];

// ── Entomopathogenic bacteria species from assign-biocontrol-role.js ────────
// Priority 90 (species level)
const BIOCONTROL_SPECIES = [
  { name: 'bacillus thuringiensis', reason: 'Bt — broad-spectrum entomopathogenic bacterium' },
  { name: 'bacillus popilliae',     reason: 'Milky spore disease — Japanese beetle biocontrol' },
  { name: 'bacillus sphaericus',    reason: 'Mosquito biocontrol bacterium' },
  { name: 'lysinibacillus sphaericus', reason: 'Mosquito biocontrol bacterium' },
  { name: 'paenibacillus popilliae', reason: 'Milky spore disease bacterium' },
  { name: 'serratia entomophila',   reason: 'Amber disease — grass grub biocontrol' },
  { name: 'photorhabdus luminescens', reason: 'Entomopathogenic nematode symbiont' },
  { name: 'xenorhabdus nematophila', reason: 'Steinernema nematode symbiont' },
];

// ── Class/order/kingdom fallback from classify-taxon.js CLASS_RULES ─────────
// Priority 30
const CLASS_RULES = [
  { match: 'lepidoptera',  role: 'pest_insect', reason: 'Lepidoptera order — caterpillar pests' },
  { match: 'diptera',      role: 'pest_insect', reason: 'Diptera order — fly pests (default)' },
  { match: 'hemiptera',    role: 'pest_insect', reason: 'Hemiptera order — true bug pests (default)' },
  { match: 'coleoptera',   role: 'pest_insect', reason: 'Coleoptera order — beetle pests (default)' },
  { match: 'orthoptera',   role: 'pest_insect', reason: 'Orthoptera order — grasshopper pests' },
  { match: 'thysanoptera', role: 'pest_insect', reason: 'Thysanoptera order — thrips pests' },
  { match: 'hymenoptera',  role: 'neutral', reason: 'Hymenoptera order — context-dependent (ants, wasps, bees)' },
  { match: 'formicidae',   role: 'neutral', reason: 'Formicidae — ant context-dependent' },
  { match: 'insecta',      role: 'pest_insect', reason: 'Insecta class — default pest (fallback)' },
  { match: 'hexapoda',     role: 'pest_insect', reason: 'Hexapoda subphylum — default pest (fallback)' },
  { match: 'araneae',      role: 'beneficial_predator', reason: 'Araneae order — spiders are predators' },
  { match: 'acari',        role: 'pest_mite', reason: 'Acari subclass — default pest mite (fallback)' },
  { match: 'arachnida',    role: 'pest_mite', reason: 'Arachnida class — default pest mite (fallback)' },
  { match: 'nematoda',     role: 'pathogen_nematode', reason: 'Nematoda phylum — default plant-parasitic (fallback)' },
  { match: 'fungi',        role: 'pathogen_fungal', reason: 'Fungi kingdom — default pathogen (fallback)' },
  { match: 'mycota',       role: 'pathogen_fungal', reason: 'Mycota — fungal pathogen (fallback)' },
  { match: 'oomycota',     role: 'pathogen_fungal', reason: 'Oomycota — oomycete pathogen' },
  { match: 'bacteria',     role: 'pathogen_bacterial', reason: 'Bacteria kingdom — default pathogen (fallback)' },
  { match: 'proteobacteria', role: 'pathogen_bacterial', reason: 'Proteobacteria — bacterial pathogen (fallback)' },
  { match: 'firmicutes',   role: 'pathogen_bacterial', reason: 'Firmicutes — bacterial pathogen (fallback)' },
  { match: 'actinobacteria', role: 'pathogen_bacterial', reason: 'Actinobacteria — bacterial pathogen (fallback)' },
  { match: 'archaea',      role: 'pathogen_bacterial', reason: 'Archaea — treated as bacterial (fallback)' },
  { match: 'virus',        role: 'pathogen_viral', reason: 'Virus — plant virus pathogen' },
  { match: 'viridae',      role: 'pathogen_viral', reason: 'Viridae — virus family suffix' },
  { match: 'virales',      role: 'pathogen_viral', reason: 'Virales — virus order suffix' },
  { match: 'mammalia',     role: 'pest_vertebrate', reason: 'Mammalia class — vertebrate pest (default)' },
  { match: 'aves',         role: 'pest_vertebrate', reason: 'Aves class — vertebrate pest (default, some beneficial)' },
  { match: 'reptilia',     role: 'neutral', reason: 'Reptilia class — neutral (rare agricultural impact)' },
  { match: 'amphibia',     role: 'neutral', reason: 'Amphibia class — neutral (beneficial insect predators)' },
  { match: 'actinopterygii', role: 'neutral', reason: 'Fish — neutral in agriculture' },
  { match: 'vertebrata',   role: 'neutral', reason: 'Vertebrata — neutral (fallback)' },
  { match: 'plantae',      role: 'weed', reason: 'Plantae kingdom — default weed (non-crop plants)' },
  { match: 'viridiplantae', role: 'weed', reason: 'Viridiplantae — default weed (fallback)' },
];

// ── Bio-category defaults (lowest priority) ─────────────────────────────────
// Priority 10
const BIO_CATEGORY_DEFAULTS = [
  { bio: 'plantae',      role: 'crop', reason: 'Default for plants — assume crop unless flagged' },
  { bio: 'invertebrate', role: 'pest_insect', reason: 'Default for invertebrates — assume pest unless family known' },
  { bio: 'vertebrate',   role: 'neutral', reason: 'Default for vertebrates — neutral until interaction data available' },
  { bio: 'fungi',        role: 'pathogen_fungal', reason: 'Default for fungi — assume pathogen unless genus known' },
  { bio: 'microbe',      role: 'pathogen_bacterial', reason: 'Default for microbes — assume pathogen unless genus known' },
];


async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });

  // Ensure table exists
  const migration = require('./migrations/014_role_agent');
  await migration.runMigration(db);

  const INSERT = `INSERT OR IGNORE INTO role_rules
    (rule_type, match_field, match_value, match_bio_category, assigned_role, secondary_role, confidence, priority, reason, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'seed')`;

  let inserted = 0;
  const stats = {};

  async function ins(type, field, value, bio, role, secondary, confidence, priority, reason) {
    const key = type;
    stats[key] = (stats[key] || 0) + 1;
    if (dryRun) {
      if (inserted < 10) console.log(`  [DRY] ${type} ${field}=${value} → ${role} (pri=${priority})`);
      inserted++;
      return;
    }
    const result = await db.run(INSERT, [type, field, value, bio, role, secondary, confidence, priority, reason]);
    if (result.changes > 0) inserted++;
  }

  console.log(`=== Seeding Role Rules (${dryRun ? 'DRY RUN' : 'LIVE'}) ===\n`);

  // 1. Genus rules (priority 70)
  for (const rule of GENUS_RULES) {
    for (const genus of rule.genera) {
      await ins('taxonomy_genus', 'genus', genus, null, rule.role, rule.secondary || null, 1.0, 70, rule.reason);
    }
  }

  // 2. Family rules from classify-taxon.js (priority 50)
  for (const rule of FAMILY_RULES) {
    await ins('taxonomy_family', 'family', rule.match, null, rule.role, rule.secondary || null, 0.9, 50, rule.reason);
  }

  // 3. Biocontrol family overrides from assign-biocontrol-role.js (priority 55)
  // These override family rules with 'biocontrol' role for known biocontrol families
  for (const rule of BIOCONTROL_FAMILY_OVERRIDES) {
    await ins('biocontrol_family', 'family', rule.match, null, 'biocontrol', null, 1.0, 55, rule.reason);
  }

  // 4. Biocontrol species (priority 90)
  for (const rule of BIOCONTROL_SPECIES) {
    await ins('taxonomy_species', 'scientific_name', rule.name, null, 'biocontrol', null, 1.0, 90, rule.reason);
  }

  // 5. Class/order/kingdom fallback (priority 30)
  for (const rule of CLASS_RULES) {
    await ins('taxonomy_class', 'taxon_path', rule.match, null, rule.role, null, 0.7, 30, rule.reason);
  }

  // 6. Bio-category defaults (priority 10)
  for (const rule of BIO_CATEGORY_DEFAULTS) {
    await ins('bio_category_default', 'bio_category', rule.bio, null, rule.role, null, 0.5, 10, rule.reason);
  }

  console.log(`\nInserted: ${inserted} rules\n`);
  console.log('By type:');
  for (const [type, count] of Object.entries(stats).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type}: ${count}`);
  }

  if (!dryRun) {
    const total = await db.get('SELECT COUNT(*) as n FROM role_rules');
    console.log(`\nTotal rules in table: ${total.n}`);
  }

  await db.close();
  console.log('\nDone.');
}

main().catch(err => { console.error('Failed:', err); process.exit(1); });
