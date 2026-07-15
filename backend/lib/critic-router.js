'use strict';

/**
 * critic-router.js — Phase 2.5
 *
 * Given a staged-claim payload, picks the most relevant domain specialist
 * critic from the 5-way set {entomologist, plant-pathologist, soil-scientist,
 * horticulturist, wildlife-ecologist}. The agroecologist synthesizer is always
 * the *other* member of a Phase-2.5 dispatch pair (so we don't return it here).
 *
 * Routing rules are extracted directly from each critic's frontmatter
 * `description` (the "Triggers on..." clauses). They are intentionally
 * conservative — when the payload contains a hard signal (virus name,
 * pathogen interaction, soil chemistry term), we route to the specialist;
 * when nothing is unambiguous, horticulturist is the fallback because
 * plant-trait / multi-crop guild claims are the broadest residual category.
 *
 * Priority order (first match wins):
 *   1. plant-pathologist  (virus/phage/viroid/fungus name OR pathogen interaction)
 *   2. soil-scientist     (soil/pH/nutrient/microbe/mycorrhiza/rhizobium markers)
 *   3. entomologist       (arthropod markers OR predation/parasitism/herbivory)
 *   4. horticulturist     (plant-trait / polyculture / fallback)
 *
 * Pathology before entomology because entomopathogenic-virus claims (e.g.
 * baculovirus → caterpillar) sit on both sides; the host-pathogen taxonomy
 * decision dominates the verdict so the pathologist owns it.
 */

const PATHOGEN_INTERACTIONS = new Set([
  'pathogen', 'pathogenof', 'infection', 'pathogen_pressure',
  'disease_resistance',   // resistance to a pathogen → plant-pathologist
]);

const ARTHROPOD_INTERACTIONS = new Set([
  'predation', 'parasitism', 'herbivory', 'biocontrol', 'pollination',
  'pest_resistance',      // resistance to an arthropod pest → entomologist
]);

const SOIL_INTERACTIONS = new Set([
  'nitrogen_fixation', 'mycorrhizal', 'soil_facilitation', 'facilitation',
]);

const SOIL_ROLES = new Set([
  'soil_organism', 'decomposer', 'mycorrhizal', 'rhizobial', 'nitrogen_fixer',
]);

// Pathogen names: leading \b dropped so "granulovirus", "baculovirus", etc.
// match via the trailing word boundary; trailing \b kept so "cytisiphagella"
// (a moth) doesn't mis-match "phage". Major fungal genera enumerated.
const PATHOGEN_NAME_RE = /(?:virus|viroid|phage|fungus|fungi|oomycete|bacterium|bacteria|phytoplasma|fusarium|botrytis|alternaria|phytophthora|pythium|rhizoctonia|verticillium|colletotrichum|cercospora|septoria|puccinia|aspergillus|penicillium|sclerotinia|monilinia|xanthomonas|pseudomonas|erwinia|ralstonia)\b/i;
// Arthropod cues: English common names AND high-traffic entomological genera
// (so minimal claim payloads carrying only a binomial still route correctly).
const ARTHROPOD_NAME_RE = /\b(insect|insecta|arthropod|aphid|beetle|wasp|bee|fly|moth|butterfly|caterpillar|mite|spider|thrips|leafhopper|planthopper|fleahopper|treehopper|scale|mealybug|psyllid|whitefly|weevil|borer|looper|webworm|cutworm|armyworm|bollworm|earworm|leafminer|leaf-?miner|leafroller|leaf-?roller|stink[\s-]?bug|leaf-?footed|grasshopper|locust|ants?|apis|aphis|bombus|myzus|pentalonia|coccinella|trichogramma|drosophila|bombyx|spodoptera|pieris|plutella|helicoverpa|chrysodeixis|hellula|crocidolomia|epilachna|diaphania|manduca|tetranychus|polyphagotarsonemus|frankliniella|bemisia|encarsia|orius|nabis|chrysoperla|ichneumon|halticus|aulacophora|nezara|leptoglossus|bactrocera|liriomyza|cosmopolites|erionota|sternochetus|adoretus|empoasca|saissetia|planococcus|pseudococcus|maconellicoccus|oxya|aiolopus|conocephalus|coccinellidae|formicidae|apidae|aphididae|pentatomidae|coreidae|miridae|cicadellidae|pseudococcidae|tephritidae|agromyzidae|chrysomelidae|aleyrodidae|tetranychidae|thripidae|noctuidae|crambidae|curculionidae|araneae|arachnid|harvestman|scorpion|salticidae|lycosidae|araneidae|oxyopidae|theridiidae|tetragnathidae|thomisidae|sparassidae|pholcidae|scytodidae|cheiracanthiidae|clubionidae|agelenidae|linyphiidae|pisauridae|nephilidae|uloboridae|eriophyidae)\b/i;
const SOIL_TERM_RE = /\b(soil|nutrient|nitrogen|phosphorus|potassium|ph[\s-]+(level|range)|cover[\s-]+crop|tilth|tillage|compost|humus|microbial|bacteria|fungi|mycorrhiza|rhizobium|nodulation|cation[\s-]+exchange)\b/i;
const HORT_TERM_RE = /\b(growth|yield|hardiness|spacing|canopy|days[\s-]+to[\s-]+harvest|intercropping|polyculture|guild|agroforestry|temperature|humidity|light|water[\s-]+need|cultivar|variety)\b/i;
// Plant-parasitic nematodes → plant-pathology (nematology), NOT entomology —
// their 'parasitism' / 'pest_pressure' claims otherwise grab the entomologist
// or the crop_vuln→horticulturist fallback. [Pass-13 router fix, post-mortem #3]
const NEMATODE_NAME_RE = /\b(nematode|nematoda|meloidogyne|radopholus|rotylenchulus|pratylenchus|heterodera|globodera|ditylenchus|aphelenchoides|bursaphelenchus|xiphinema|helicotylenchus|tylenchulus|hoplolaimus|scutellonema|root[\s-]?knot|reniform|root[\s-]?lesion|cyst[\s-]+nematode|burrowing[\s-]+nematode)\b/i;
// Parasitic plants (dodder, broomrape, witchweed, mistletoe) → plant/weed
// pathology, not entomology (their 'parasitism' otherwise grabs entomology).
const PARASITIC_PLANT_RE = /\b(cuscuta|cassytha|orobanche|phelipanche|striga|alectra|viscum|arceuthobium|dendrophthoe|dodder|broomrape|witchweed|mistletoe)\b/i;
// Entomopathogenic / insect-biocontrol microbes — their target is arthropods,
// so target_pest_range / commercial_biocontrol traits belong to the
// entomologist, NOT plant-pathology (which is the default for microbe traits).
// [Pass-13 follow-up: Bt was routed to plant-pathologist, who recused.]
const ENTOMOPATH_MICROBE_RE = /\b(bacillus thuringiensis|beauveria|metarhizium|lecanicillium|cordyceps|ophiocordyceps|paecilomyces|isaria|nomuraea|hirsutella|photorhabdus|xenorhabdus|popilliae)\b/i;
// Vertebrate cues: bare ranks, English common names, and high-traffic agricultural
// vertebrate genera (pest AND ecosystem-service providers), so a minimal claim
// payload carrying only a binomial still routes to the wildlife ecologist. Word
// boundaries kept tight to avoid false hits (\bbat\b not "habitat", \brat\b not
// "strategy"). Covers birds, mammals (rodents/bats/ungulates/wild pigs), and
// herptiles. [wildlife-ecologist critic, 2026-06-13]
// Trailing `s?\b` makes the alternation plural-tolerant ("birds", "rats", "bats",
// "rodents") — the trailing word boundary alone would reject the plural form. Inner
// \b tokens are intentionally NOT used (the outer \b...s?\b already bounds every
// alternative); short ambiguous stems (rat/bat/pig/sus/mus) are still protected by
// the leading \b (e.g. "habitat"/"pigment"/"category" do not match).
const VERTEBRATE_NAME_RE = /\b(vertebrate|vertebrata|mammal|mammalia|bird|aves|avian|reptile|reptilia|amphibia|amphibian|rodent|rodentia|chiroptera|ungulate|primate|passerine|sparrow|finch|blackbird|starling|sturnus|crow|corvus|raven|magpie|jay|dove|pigeon|columba|quelea|weaver|munia|parrot|parakeet|cockatoo|lorikeet|bulbul|myna|mynah|thrush|robin|swallow|woodpecker|hornbill|sunbird|hummingbird|flowerpecker|duck|goose|gull|heron|egret|owl|hawk|kestrel|falcon|eagle|agelaius|icterid|rat|rattus|mouse|mus|vole|gopher|squirrel|chipmunk|porcupine|bat|pteropus|rousettus|cynopterus|eidolon|artibeus|carollia|sturnira|macroglossus|syconycteris|leptonycteris|glossophaga|tadarida|myotis|eptesicus|flying[\s-]?fox|fruit[\s-]?bat|deer|cervus|odocoileus|pig|sus|boar|swine|peccary|monkey|macaque|antelope|mongoose|hare|rabbit|oryctolagus|shrew|hedgehog|lizard|snake|gecko|skink|frog|toad|turtle|tortoise)s?\b/i;

function _flatten(payload) {
  const parts = [];
  function walk(v) {
    if (v == null) return;
    if (typeof v === 'string') { parts.push(v); return; }
    if (typeof v === 'number' || typeof v === 'boolean') return;
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (typeof v === 'object') { Object.values(v).forEach(walk); return; }
  }
  walk(payload);
  return parts.join('  '); // unlikely-collision separator
}

function _interactionCategory(payload) {
  const raw = (payload && (
    payload.interaction_category ||
    payload.interaction_type ||
    payload.interactionCategory ||
    payload.interactionType
  )) || '';
  return String(raw).toLowerCase().trim();
}

function _primaryRole(payload) {
  const raw = (payload && (payload.primary_role || payload.role)) || '';
  return String(raw).toLowerCase().trim();
}

function _bioCategory(payload) {
  const raw = (payload && (payload.bio_category || payload.bioCategory)) || '';
  return String(raw).toLowerCase().trim();
}

/**
 * pickDomainCritic(payload, targetTable?) → 'entomologist' | 'plant-pathologist' | 'soil-scientist' | 'horticulturist'
 *
 * Always returns a non-null critic. Pair with 'agroecologist' at the call site.
 */
function pickDomainCritic(payload, targetTable) {
  const flat = _flatten(payload);

  // Taxon hard-overrides that hold for EVERY claim shape: plant-parasitic
  // nematodes and parasitic plants belong to plant-pathology (nematology /
  // weed-pathology). Placed before all other routing so a 'parasitism'
  // interaction or a crop_vuln fallback can't divert them to entomology or
  // horticulture. [Pass-13 router fix — passlog Pass 13 post-mortem #3]
  if (NEMATODE_NAME_RE.test(flat)) return 'plant-pathologist';
  if (PARASITIC_PLANT_RE.test(flat)) return 'plant-pathologist';

  // New: entity_trait routing by bio_category + trait_name signal
  if (targetTable === 'entity_trait') {
    const bio = String((payload && (payload.bio_category || payload.bioCategory)) || '').toLowerCase();
    const trait = String((payload && payload.trait_name) || '').toLowerCase();
    if (bio === 'plantae') return 'horticulturist';
    if (bio === 'vertebrate') return 'wildlife-ecologist';
    if (bio === 'invertebrate') return 'entomologist';
    if (bio === 'fungi') return 'plant-pathologist';
    if (bio === 'microbe') {
      if (trait === 'soil_health_function' || trait === 'nitrogen_fixation_rate_kg_per_ha_per_yr') {
        return 'soil-scientist';
      }
      // Entomopathogen biocontrol microbe (Bt, Beauveria, ...) → entomologist.
      if (ENTOMOPATH_MICROBE_RE.test(flat)) return 'entomologist';
      return 'plant-pathologist';
    }
    // Name-based safety net for missing/wrong bio_category (e.g. spider families
    // "Salticidae" tagged 'other'): an arthropod taxon still routes to the
    // entomologist rather than the horticulturist fallback. [Pass-13 follow-up]
    // Vertebrate name checked first so a mistagged vertebrate trait (e.g. a bird
    // tagged 'other') reaches the wildlife ecologist. [wildlife-ecologist 2026-06-13]
    if (VERTEBRATE_NAME_RE.test(flat)) return 'wildlife-ecologist';
    if (ARTHROPOD_NAME_RE.test(flat)) return 'entomologist';
    return 'horticulturist';
  }

  if (targetTable === 'attractor_relationship') {
    // A plant supporting a vertebrate beneficial (perch/nest-box/hedgerow for
    // insectivorous birds or bats) is the wildlife ecologist's; otherwise the
    // supported beneficial is an arthropod → entomologist.
    if (VERTEBRATE_NAME_RE.test(flat)) return 'wildlife-ecologist';
    return 'entomologist';
  }

  const ic = _interactionCategory(payload);
  const role = _primaryRole(payload);
  const bio = _bioCategory(payload);

  // Vertebrate actor (actor-taxon-owns): a vertebrate taxon in a consumption /
  // service / pest interaction is the wildlife ecologist's, ahead of the
  // cooperative, biocontrol, pollination, and arthropod branches. Name-based
  // (not interaction-category-based) so it also catches crop_vulnerabilities
  // vertebrate pests, whose payloads carry damage_type rather than an
  // interaction_category. EXCLUDES pathogen and soil contexts: a vertebrate HOST
  // of a pathogen stays with the pathologist (PATHOGEN_NAME_RE / PATHOGEN_INTERACTIONS),
  // and soil chemistry stays with the soil scientist. [wildlife-ecologist 2026-06-13]
  if (VERTEBRATE_NAME_RE.test(flat)
      && !PATHOGEN_INTERACTIONS.has(ic)
      && !PATHOGEN_NAME_RE.test(flat)
      && !SOIL_INTERACTIONS.has(ic)
      && !SOIL_TERM_RE.test(flat)) {
    return 'wildlife-ecologist';
  }

  // 0. Cooperative interactions (mutualism / facilitation / biocontrol) must be
  // routed by MECHANISM, before PATHOGEN_NAME_RE — otherwise a named fungal/
  // bacterial partner (mycorrhizae, rhizobia, a microbial biocontrol agent) grabs
  // them for the pathologist, who then recuses (cooperation ≠ disease). This was
  // the bulk of the book-corpus residual. [residual recovery 2026-06-12]
  if (ic === 'mutualism' || ic === 'facilitation') {
    // soil-mediated cooperation (N-fixation, mycorrhiza, rhizobia, nodulation)
    if (/(mycorrhiz|arbuscular|\bglomus\b|rhizobi|bradyrhizob|frankia|nodulat|nitrogen[\s-]*fix|\brhizo)/i.test(flat)) return 'soil-scientist';
    // pollination mutualism → entomology (the animal partner owns it)
    if (ic === 'mutualism' && /(pollinat|nectar|floral|flower[\s-]*visit)/i.test(flat)) return 'entomologist';
    if (ic === 'mutualism' && ARTHROPOD_NAME_RE.test(flat)) return 'entomologist';
    // companion planting / intercropping / polyculture facilitation, general mutualism
    return 'horticulturist';
  }
  // biocontrol is a natural-enemy claim; entomology owns it even when a microbial
  // (fungal/bacterial) agent is named.
  if (ic === 'biocontrol') return 'entomologist';

  // 1. Pathology — hard signals dominate.
  if (PATHOGEN_INTERACTIONS.has(ic)) return 'plant-pathologist';
  if (PATHOGEN_NAME_RE.test(flat)) return 'plant-pathologist';

  // 2. Soil — microbe-as-soil-org or soil/nutrient body terms.
  if (bio === 'microbe' && (SOIL_ROLES.has(role) || /(rhizo|mycorr|nitrogen[\s-]+fix)/i.test(flat))) {
    return 'soil-scientist';
  }
  if (SOIL_INTERACTIONS.has(ic)) return 'soil-scientist';
  if (SOIL_TERM_RE.test(flat)) return 'soil-scientist';

  // 3. Entomology — arthropod taxonomy / animal-vs-animal interactions.
  if (ARTHROPOD_INTERACTIONS.has(ic)) {
    // pollination is borderline (could be horticulture if plant-centric),
    // but predation/parasitism/herbivory clearly belong to entomology when
    // the taxa look animal. Use name heuristics to disambiguate pollination.
    if (ic === 'pollination' && !ARTHROPOD_NAME_RE.test(flat)) return 'horticulturist';
    return 'entomologist';
  }
  if (ARTHROPOD_NAME_RE.test(flat)) return 'entomologist';

  // 4. Horticulture — plant-trait / polyculture / fallback.
  if (targetTable === 'crop_vulnerabilities') return 'horticulturist';
  if (HORT_TERM_RE.test(flat)) return 'horticulturist';

  return 'horticulturist';
}

const ALL_DOMAIN_CRITICS = ['entomologist', 'plant-pathologist', 'soil-scientist', 'horticulturist', 'wildlife-ecologist'];
const ALL_CRITICS = ['agroecologist', ...ALL_DOMAIN_CRITICS];

module.exports = {
  pickDomainCritic, ALL_CRITICS, ALL_DOMAIN_CRITICS,
  // Exported for router-variant tooling (e.g. challenger comparison in the Hermes
  // fitness harness). Behavior-neutral: exposing these constants does not change
  // any routing decision — the guard fixtures prove the incumbent is unchanged.
  ARTHROPOD_INTERACTIONS, ARTHROPOD_NAME_RE, VERTEBRATE_NAME_RE,
};
