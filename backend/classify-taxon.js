// backend/classify-taxon.js
'use strict';

/**
 * classify-taxon.js
 * Single source of truth for organism classification.
 *
 * classifyTaxon(scientificName, taxonPath, interactionTypes, db?)
 *   Returns: { primary_role, secondary_role, bioCategory, flagged }
 *
 * Priority order:
 *   1. taxon_role_overrides table (db required, skipped if db=null)
 *   2. Genus-level rules (from scientific name)
 *   3. Family/superfamily-level rules (from taxon_path)
 *   4. Order/class-level rules (from taxon_path)
 *   5. Kingdom-level fallback
 *   6. neutral + write to taxon_classification_flags
 *
 * taxon_path format: "Biota | Animalia | Arthropoda | Insecta | Hymenoptera | Braconidae | Aphidius"
 */

const VALID_ROLES = new Set([
  'crop', 'weed', 'pollinator',
  'pest_insect', 'pest_mite', 'pest_vertebrate',
  'pathogen_fungal', 'pathogen_viral', 'pathogen_bacterial', 'pathogen_nematode',
  'beneficial_predator', 'beneficial_parasitoid',
  'soil_microbe', 'neutral',
]);

// ── Genus-level rules (highest specificity, checked via scientific name prefix) ──
const GENUS_RULES = [
  // Bees
  { genera: ['apis', 'bombus', 'osmia', 'xylocopa', 'trigona', 'melipona', 'megachile',
             'lasioglossum', 'halictus', 'colletes', 'andrena', 'ceratina', 'eucera',
             'amegilla', 'anthophora', 'dasypoda', 'nomia', 'hylaeus'],
    primary: 'pollinator' },
  // Syrphidae — dual role
  { genera: ['syrphus', 'episyrphus', 'eristalis', 'melanostoma', 'eupeodes',
             'platycheirus', 'baccha', 'scaeva', 'helophilus', 'volucella'],
    primary: 'pollinator', secondary: 'beneficial_predator' },
  // Parasitoid wasps (genus level)
  { genera: ['trichogramma', 'aphidius', 'cotesia', 'encarsia', 'eretmocerus',
             'diglyphus', 'aphelinus', 'pteromalus', 'nasonia', 'habrobracon',
             'macrocentrus', 'meteorus', 'microplitis', 'praon', 'lysiphlebus',
             'opius', 'dacnusa', 'muscidifurax'],
    primary: 'beneficial_parasitoid' },
  // Predatory wasps
  { genera: ['vespula', 'vespa', 'dolichovespula', 'polistes', 'polybia'],
    primary: 'beneficial_predator' },
  // Eumeninae (potter wasps)
  { genera: ['eumenes', 'ancistrocerus', 'symmorphus', 'delta'],
    primary: 'beneficial_parasitoid' },
  // Leaf-cutter ants
  { genera: ['atta', 'acromyrmex'],
    primary: 'pest_insect' },
  // Predatory beetles / lacewings
  { genera: ['coccinella', 'chrysoperla', 'hippodamia', 'adalia', 'harmonia',
             'coleomegilla', 'cryptolaemus', 'stethorus', 'chrysopa', 'chrysocarabus'],
    primary: 'beneficial_predator' },
  // Entomopathogenic fungi (biocontrol agents that live in soil)
  { genera: ['beauveria', 'metarhizium', 'isaria', 'lecanicillium', 'paecilomyces',
             'nomuraea', 'hirsutella'],
    primary: 'beneficial_parasitoid', secondary: 'soil_microbe' },
  { genera: ['trichoderma'],
    primary: 'beneficial_parasitoid', secondary: 'soil_microbe' },
  // Mycorrhizal & N-fixing soil microbes
  { genera: ['glomus', 'rhizophagus', 'funneliformis', 'scutellospora', 'gigaspora',
             'rhizobium', 'bradyrhizobium', 'sinorhizobium', 'mesorhizobium',
             'azotobacter', 'azospirillum', 'frankia', 'nitrobacter', 'nitrosomonas'],
    primary: 'soil_microbe' },
  // Entomopathogenic nematodes (beneficial)
  { genera: ['steinernema', 'heterorhabditis'],
    primary: 'beneficial_parasitoid' },
  // Plant-parasitic nematodes
  { genera: ['meloidogyne', 'pratylenchus', 'globodera', 'heterodera', 'ditylenchus',
             'aphelenchoides', 'nacobbus', 'tylenchulus', 'rotylenchulus'],
    primary: 'pathogen_nematode' },
  // Oomycetes (treated as fungal pathogens in ag)
  { genera: ['phytophthora', 'pythium', 'plasmopara', 'peronospora', 'bremia',
             'albugo', 'phytopythium', 'hyaloperonospora'],
    primary: 'pathogen_fungal' },
  // Vertebrate pests
  { genera: ['rattus', 'mus', 'arvicola', 'microtus', 'apodemus', 'clethrionomys',
             'oryctolagus', 'lepus', 'sylvilagus', 'odocoileus', 'capreolus',
             'cervus', 'dama', 'sus'],
    primary: 'pest_vertebrate' },
  // Beneficial bats
  { genera: ['rhinolophus', 'myotis', 'pipistrellus', 'tadarida', 'desmodus',
             'eptesicus', 'noctilio', 'artibeus'],
    primary: 'beneficial_predator' },
];

// ── Family / superfamily rules ─────────────────────────────────────────────────
const FAMILY_RULES = [
  { match: 'ichneumonidae',     primary: 'beneficial_parasitoid' },
  { match: 'braconidae',        primary: 'beneficial_parasitoid' },
  { match: 'trichogrammatidae', primary: 'beneficial_parasitoid' },
  { match: 'aphelinidae',       primary: 'beneficial_parasitoid' },
  { match: 'encyrtidae',        primary: 'beneficial_parasitoid' },
  { match: 'pteromalidae',      primary: 'beneficial_parasitoid' },
  { match: 'eulophidae',        primary: 'beneficial_parasitoid' },
  { match: 'figitidae',         primary: 'beneficial_parasitoid' },
  { match: 'platygastridae',    primary: 'beneficial_parasitoid' },
  { match: 'scelionidae',       primary: 'beneficial_parasitoid' },
  { match: 'proctotrupidae',    primary: 'beneficial_parasitoid' },
  { match: 'chalcidoidea',      primary: 'beneficial_parasitoid' },
  { match: 'tachinidae',        primary: 'beneficial_parasitoid' },
  { match: 'sphecidae',         primary: 'beneficial_predator' },
  { match: 'pompilidae',        primary: 'beneficial_predator' },
  { match: 'crabronidae',       primary: 'beneficial_predator' },
  { match: 'coccinellidae',     primary: 'beneficial_predator' },
  { match: 'carabidae',         primary: 'beneficial_predator' },
  { match: 'staphylinidae',     primary: 'beneficial_predator' },
  { match: 'chrysopidae',       primary: 'beneficial_predator' },
  { match: 'hemerobiidae',      primary: 'beneficial_predator' },
  { match: 'phytoseiidae',      primary: 'beneficial_predator' },
  { match: 'apidae',            primary: 'pollinator' },
  { match: 'halictidae',        primary: 'pollinator' },
  { match: 'colletidae',        primary: 'pollinator' },
  { match: 'andrenidae',        primary: 'pollinator' },
  { match: 'megachilidae',      primary: 'pollinator' },
  { match: 'syrphidae',         primary: 'pollinator', secondary: 'beneficial_predator' },
  { match: 'aphididae',         primary: 'pest_insect' },
  { match: 'aleyrodidae',       primary: 'pest_insect' },
  { match: 'coccidae',          primary: 'pest_insect' },
  { match: 'diaspididae',       primary: 'pest_insect' },
  { match: 'pseudococcidae',    primary: 'pest_insect' },
  { match: 'thripidae',         primary: 'pest_insect' },
  { match: 'phlaeothripidae',   primary: 'pest_insect' },
  { match: 'chrysomelidae',     primary: 'pest_insect' },
  { match: 'curculionidae',     primary: 'pest_insect' },
  { match: 'cerambycidae',      primary: 'pest_insect' },
  { match: 'scolytidae',        primary: 'pest_insect' },
  { match: 'agromyzidae',       primary: 'pest_insect' },
  { match: 'tephritidae',       primary: 'pest_insect' },
  { match: 'cecidomyiidae',     primary: 'pest_insect' },
  { match: 'sciaridae',         primary: 'pest_insect' },
  { match: 'acrididae',         primary: 'pest_insect' },
  { match: 'gryllidae',         primary: 'pest_insect' },
  { match: 'cynipidae',         primary: 'pest_insect' },
  { match: 'tenthredinidae',    primary: 'pest_insect' },
  { match: 'siricidae',         primary: 'pest_insect' },
  { match: 'tetranychidae',     primary: 'pest_mite' },
  { match: 'eriophyidae',       primary: 'pest_mite' },
  { match: 'tarsonemidae',      primary: 'pest_mite' },
  { match: 'glomeromycota',     primary: 'soil_microbe' },
];

// Coarse class/order/kingdom role defaults removed 2026-06-27 (family-floor policy).
// Role valence must come from claims or curated species/genus/family rules; broad
// taxonomy no longer asserts pest/pathogen/weed. bio_category derivation lives in
// getBioCategory and is unaffected. See docs/superpowers/specs/2026-06-27-role-classification-no-coarse-defaults-design.md
const CLASS_RULES = [];

/**
 * Derive bioCategory from taxon_path (unchanged from existing getBioCategory logic).
 */
function getBioCategory(taxonPath) {
  const p = (taxonPath || '').toLowerCase();
  if (p.includes('plantae') || p.includes('viridiplantae')) return 'plantae';
  if (p.includes('fungi') || p.includes('mycota')) return 'fungi';
  if (p.includes('bacteria') || p.includes('virus') || p.includes('archaea') ||
      p.includes('chromista') || p.includes('protozoa')) return 'microbe';
  if (p.includes('mammalia') || p.includes('aves') || p.includes('reptilia') ||
      p.includes('amphibia') || p.includes('actinopterygii') || p.includes('vertebrata')) return 'vertebrate';
  if (p.includes('insecta') || p.includes('arachnida') || p.includes('arthropoda') ||
      p.includes('nematoda') || p.includes('mollusca') || p.includes('annelida') ||
      p.includes('invertebrata')) return 'invertebrate';
  return 'other';
}

function getGenus(scientificName) {
  return (scientificName || '').split(' ')[0].toLowerCase();
}

function applyGenusRules(scientificName) {
  const genus = getGenus(scientificName);
  for (const rule of GENUS_RULES) {
    if (rule.genera.includes(genus)) {
      return { primary_role: rule.primary, secondary_role: rule.secondary || null };
    }
  }
  return null;
}

function applyPathRules(taxonPath) {
  const p = (taxonPath || '').toLowerCase();
  for (const rule of FAMILY_RULES) {
    if (p.includes(rule.match)) {
      return { primary_role: rule.primary, secondary_role: rule.secondary || null, flag: null };
    }
  }
  for (const rule of CLASS_RULES) {
    if (p.includes(rule.match)) {
      return { primary_role: rule.primary, secondary_role: rule.secondary || null, flag: rule.flag || null };
    }
  }
  return null;
}

function resolveVertebrateRole(interactionTypes) {
  const types = (interactionTypes || []).map(t => t.toLowerCase());
  const eatingPestSignal = types.some(t =>
    t.includes('preyson') || t.includes('eats') || t.includes('kills') || t.includes('predator')
  );
  return eatingPestSignal ? 'beneficial_predator' : 'pest_vertebrate';
}

async function classifyTaxon(scientificName, taxonPath, interactionTypes = [], db = null) {
  const bioCategory = getBioCategory(taxonPath);

  // 1. Check manual overrides first
  if (db) {
    try {
      const override = await db.get(
        'SELECT primary_role, secondary_role FROM taxon_role_overrides WHERE scientific_name = ? COLLATE NOCASE',
        [scientificName]
      );
      if (override) {
        return {
          primary_role: override.primary_role,
          secondary_role: override.secondary_role || null,
          bioCategory,
          flagged: false,
        };
      }
    } catch (_) {}
  }

  // 2. Genus-level rules
  const genusResult = applyGenusRules(scientificName);
  if (genusResult) {
    return { ...genusResult, bioCategory, flagged: false };
  }

  // 3. Family + class rules
  const pathResult = applyPathRules(taxonPath);
  if (pathResult) {
    if (pathResult.flag === 'vertebrate_interaction_signal' && interactionTypes.length > 0) {
      const vertRole = resolveVertebrateRole(interactionTypes);
      const flagged = vertRole === 'pest_vertebrate';
      if (db && flagged) {
        await writeFlag(db, scientificName, taxonPath, 'pest_vertebrate', 'vertebrate_interaction_signal');
      }
      return { primary_role: vertRole, secondary_role: null, bioCategory, flagged };
    }

    const flagged = !!pathResult.flag;
    if (db && flagged) {
      await writeFlag(db, scientificName, taxonPath, pathResult.primary_role, pathResult.flag);
    }
    return {
      primary_role: pathResult.primary_role,
      secondary_role: pathResult.secondary_role,
      bioCategory,
      flagged,
    };
  }

  // 4. Fallback
  if (db) {
    await writeFlag(db, scientificName, taxonPath, 'neutral', 'no_rule_matched');
  }
  return { primary_role: 'neutral', secondary_role: null, bioCategory, flagged: true };
}

async function writeFlag(db, scientificName, taxonPath, currentRole, flagReason) {
  try {
    await db.run(
      `INSERT OR IGNORE INTO taxon_classification_flags
         (scientific_name, taxon_path, current_role, flag_reason)
       VALUES (?, ?, ?, ?)`,
      [scientificName, taxonPath, currentRole, flagReason]
    );
  } catch (_) {}
}

module.exports = { classifyTaxon, getBioCategory, applyPathRules, VALID_ROLES };
