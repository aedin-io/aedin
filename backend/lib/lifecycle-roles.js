'use strict';

// Lifecycle-role inference for stage-dependent ecological roles.
//
// Addresses CLAUDE.md bug #1: entities.primary_role is a scalar but Lepidoptera
// caterpillars (herbivores) and Lepidoptera adults (nectarivores) play very
// different ecological roles. Same is true for many other insect orders, but
// they're more varied — Lepidoptera is the safe canonical case.
//
// Returns { larval_role, adult_role } for entities where we can infer with
// high confidence; null otherwise.
//
// Detection logic (in order):
//   1. taxonomy_path contains "Lepidoptera" (case-insensitive) → Lep
//   2. family is in LEPIDOPTERA_FAMILIES (fallback when taxonomy_path is sparse)

// Top ~30 Lepidoptera families covering the 22,478 Lep entities in the DB.
// These are the families currently in entities.family for taxonomy_path-Lep rows.
const LEPIDOPTERA_FAMILIES = new Set([
  'Noctuidae', 'Nymphalidae', 'Geometridae', 'Tortricidae', 'Erebidae',
  'Hesperiidae', 'Lycaenidae', 'Gracillariidae', 'Pyralidae', 'Crambidae',
  'Sphingidae', 'Pieridae', 'Saturniidae', 'Notodontidae', 'Lasiocampidae',
  'Limacodidae', 'Drepanidae', 'Cossidae', 'Sesiidae', 'Zygaenidae',
  'Riodinidae', 'Papilionidae', 'Tineidae', 'Yponomeutidae', 'Plutellidae',
  'Coleophoridae', 'Elachistidae', 'Oecophoridae', 'Bombycidae', 'Adelidae',
  'Hepialidae', 'Micropterigidae',
]);

// Lepidoptera families with NON-FEEDING adults (vestigial mouthparts, capital
// breeders living a few days on larval reserves). Surfaced by the agroecologist
// gate run 2026-05-01: blanket adult_role='nectarivore' is biologically wrong
// for these families. Adults are aphagous.
const LEPIDOPTERA_NON_FEEDING_ADULT_FAMILIES = new Set([
  'Saturniidae',     // silk moths (Antheraea, Hyalophora, Actias, Samia)
  'Lasiocampidae',   // tent caterpillar moths
  'Bombycidae',      // domestic silk moth (Bombyx mori)
  'Endromidae',      // Kentish glory moths
  'Brahmaeidae',     // brahmin moths
  'Eupterotidae',    // monkey moths
]);

// Corrections that are true at SUBFAMILY rank and FALSE at family rank, so a
// family-keyed rule asserts the opposite of the truth for these. Unblocked by
// entities.subfamily (migration 078, backfilled from the OTT backbone).
//
// A NULL subfamily is an ABSTENTION, not a negative: ~94k entities have no
// subfamily because OTT does not carry one for them, not because they lack one.
// So these Sets only ever ADD a correction; they never withhold the default.
const LEPIDOPTERA_NON_FEEDING_ADULT_SUBFAMILIES = new Set([
  'Lymantriinae',    // tussock/gypsy moths — aphagous adults. OTT still keeps
                     // the older family-rank concept Lymantriidae, which is why
                     // lib/subfamily-source.js has to bridge the two vintages.
]);

// Subfamilies whose LARVAE are carnivorous inside an otherwise herbivorous
// family. Getting this wrong is not a small error: it files a biocontrol agent
// as a crop pest, the same failure class as the GloBI pollinator-as-pest bug.
const LEPIDOPTERA_PREDACEOUS_LARVA_SUBFAMILIES = new Set([
  'Miletinae',       // harvesters — larvae eat aphids, scale insects, mealybugs
                     // (Spalgis epius on mealybugs, Feniseca tarquinius on
                     // woolly aphids, Thestor in ant nests).
]);

// True bee families (Anthophila clade within Hymenoptera). Adults are
// pollinators; larvae are fed by adults (provisioned with pollen + nectar
// in nest cells), so larval_role is "fed_by_adults" rather than herbivore.
const HYMENOPTERA_BEE_FAMILIES = new Set([
  'Apidae',          // honey bees, bumble bees, carpenter bees, stingless bees
  'Megachilidae',    // leafcutter bees, mason bees
  'Halictidae',      // sweat bees
  'Andrenidae',      // mining bees
  'Colletidae',      // plasterer bees, masked bees
  'Melittidae',      // melittid bees
  'Stenotritidae',   // stenotritid bees (Australia only)
]);

const LEPIDOPTERA_ROLES_DEFAULT = { larval_role: 'herbivore', adult_role: 'nectarivore' };
const LEPIDOPTERA_ROLES_NONFEEDING = { larval_role: 'herbivore', adult_role: 'non_feeding' };
const LEPIDOPTERA_ROLES_PREDACEOUS_LARVA = { larval_role: 'predator', adult_role: 'nectarivore' };
const HYMENOPTERA_BEE_ROLES = { larval_role: 'fed_by_adults', adult_role: 'pollinator' };

function inferLifecycleRoles(entity) {
  if (!entity || typeof entity !== 'object') return null;
  const tax = entity.taxonomy_path;
  const isLep = (typeof tax === 'string' && /\blepidoptera\b/i.test(tax)) || LEPIDOPTERA_FAMILIES.has(entity.family);
  if (isLep) {
    // Subfamily beats family: it is the finer, and here the contradicting, fact.
    if (LEPIDOPTERA_PREDACEOUS_LARVA_SUBFAMILIES.has(entity.subfamily)) {
      return { ...LEPIDOPTERA_ROLES_PREDACEOUS_LARVA };
    }
    if (LEPIDOPTERA_NON_FEEDING_ADULT_SUBFAMILIES.has(entity.subfamily)) {
      return { ...LEPIDOPTERA_ROLES_NONFEEDING };
    }
    if (LEPIDOPTERA_NON_FEEDING_ADULT_FAMILIES.has(entity.family)) {
      return { ...LEPIDOPTERA_ROLES_NONFEEDING };
    }
    return { ...LEPIDOPTERA_ROLES_DEFAULT };
  }
  // Hymenoptera bees: family-only signal (taxonomy_path contains "Hymenoptera"
  // for many non-bee groups too — wasps, ants, sawflies — so we route on the
  // bee-family Set, not on order-level taxonomy_path).
  if (HYMENOPTERA_BEE_FAMILIES.has(entity.family)) {
    return { ...HYMENOPTERA_BEE_ROLES };
  }
  return null;
}

module.exports = {
  inferLifecycleRoles,
  LEPIDOPTERA_FAMILIES,
  LEPIDOPTERA_NON_FEEDING_ADULT_FAMILIES,
  LEPIDOPTERA_NON_FEEDING_ADULT_SUBFAMILIES,
  LEPIDOPTERA_PREDACEOUS_LARVA_SUBFAMILIES,
  HYMENOPTERA_BEE_FAMILIES,
};
