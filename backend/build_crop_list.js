/**
 * build_crop_list.js
 *
 * Builds the verified_crops table by cross-referencing GloBI's plants table
 * against a curated genus list of all major agronomic and medicinal crops.
 *
 * Optionally queries Wikidata to enrich common names for exact species matches.
 *
 * Run after sync-globi.js + add_indexes.js:
 *   node build_crop_list.js
 *
 * Or via:
 *   npm run rebuild
 */

const https = require('https');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { CORPUS_DB } = require('./lib/db-paths.cjs');

const DB_PATH = CORPUS_DB;

// ---------------------------------------------------------------------------
// Authoritative crop genus list with common names and crop types.
// Source: curated from FAO, USDA, Kew Gardens economic plant lists.
// Max 5 species shown per genus (prevents wild-relative spam).
// ---------------------------------------------------------------------------
const CROP_GENERA = [
  // Cereals & Grains
  { genus: 'triticum',     common: 'Wheat',          type: 'Cereals & Grains' },
  { genus: 'oryza',        common: 'Rice',            type: 'Cereals & Grains' },
  { genus: 'zea',          common: 'Maize / Corn',    type: 'Cereals & Grains' },
  { genus: 'hordeum',      common: 'Barley',          type: 'Cereals & Grains' },
  { genus: 'avena',        common: 'Oat',             type: 'Cereals & Grains' },
  { genus: 'secale',       common: 'Rye',             type: 'Cereals & Grains' },
  { genus: 'sorghum',      common: 'Sorghum',         type: 'Cereals & Grains' },
  { genus: 'saccharum',    common: 'Sugarcane',       type: 'Cereals & Grains' },
  { genus: 'pennisetum',   common: 'Pearl Millet',    type: 'Cereals & Grains' },
  { genus: 'cenchrus',     common: 'Millet',          type: 'Cereals & Grains' },
  { genus: 'eleusine',     common: 'Finger Millet',   type: 'Cereals & Grains' },
  { genus: 'setaria',      common: 'Foxtail Millet',  type: 'Cereals & Grains' },
  { genus: 'eragrostis',   common: 'Teff',            type: 'Cereals & Grains' },
  { genus: 'fagopyrum',    common: 'Buckwheat',       type: 'Cereals & Grains' },
  { genus: 'panicum',      common: 'Proso Millet',    type: 'Cereals & Grains' },
  { genus: 'coix',         common: "Job's Tears",     type: 'Cereals & Grains' },
  { genus: 'digitaria',    common: 'Fonio',           type: 'Cereals & Grains' },
  // Legumes
  { genus: 'glycine',      common: 'Soybean',         type: 'Legumes' },
  { genus: 'phaseolus',    common: 'Bean',            type: 'Legumes' },
  { genus: 'vigna',        common: 'Cowpea / Mung Bean', type: 'Legumes' },
  { genus: 'lens',         common: 'Lentil',          type: 'Legumes' },
  { genus: 'cicer',        common: 'Chickpea',        type: 'Legumes' },
  { genus: 'pisum',        common: 'Pea',             type: 'Legumes' },
  { genus: 'vicia',        common: 'Fava Bean / Vetch', type: 'Legumes' },
  { genus: 'arachis',      common: 'Peanut',          type: 'Legumes' },
  { genus: 'cajanus',      common: 'Pigeon Pea',      type: 'Legumes' },
  { genus: 'lupinus',      common: 'Lupin',           type: 'Legumes' },
  { genus: 'lablab',       common: 'Hyacinth Bean',   type: 'Legumes' },
  { genus: 'mucuna',       common: 'Velvet Bean',     type: 'Legumes' },
  { genus: 'lathyrus',     common: 'Grass Pea',       type: 'Legumes' },
  { genus: 'medicago',     common: 'Alfalfa',         type: 'Legumes' },
  { genus: 'trifolium',    common: 'Clover',          type: 'Legumes' },
  { genus: 'dolichos',     common: 'Dolichos Bean',   type: 'Legumes' },
  // Nightshades
  { genus: 'solanum',      common: 'Potato / Eggplant', type: 'Nightshades' },
  { genus: 'lycopersicon', common: 'Tomato',          type: 'Nightshades' },
  { genus: 'capsicum',     common: 'Pepper / Chilli', type: 'Nightshades' },
  { genus: 'nicotiana',    common: 'Tobacco',         type: 'Nightshades' },
  { genus: 'physalis',     common: 'Tomatillo / Cape Gooseberry', type: 'Nightshades' },
  // Brassicas
  { genus: 'brassica',     common: 'Cabbage / Broccoli / Canola', type: 'Brassicas' },
  { genus: 'raphanus',     common: 'Radish',          type: 'Brassicas' },
  { genus: 'eruca',        common: 'Arugula',         type: 'Brassicas' },
  { genus: 'sinapis',      common: 'White Mustard',   type: 'Brassicas' },
  { genus: 'armoracia',    common: 'Horseradish',     type: 'Brassicas' },
  { genus: 'wasabia',      common: 'Wasabi',          type: 'Brassicas' },
  { genus: 'crambe',       common: 'Crambe',          type: 'Brassicas' },
  { genus: 'camelina',     common: 'False Flax',      type: 'Brassicas' },
  // Cucurbits
  { genus: 'cucumis',      common: 'Cucumber / Melon', type: 'Cucurbits' },
  { genus: 'cucurbita',    common: 'Squash / Pumpkin', type: 'Cucurbits' },
  { genus: 'citrullus',    common: 'Watermelon',      type: 'Cucurbits' },
  { genus: 'luffa',        common: 'Luffa',           type: 'Cucurbits' },
  { genus: 'lagenaria',    common: 'Bottle Gourd',    type: 'Cucurbits' },
  { genus: 'momordica',    common: 'Bitter Melon',    type: 'Cucurbits' },
  { genus: 'sechium',      common: 'Chayote',         type: 'Cucurbits' },
  { genus: 'benincasa',    common: 'Winter Melon',    type: 'Cucurbits' },
  // Tree Fruits & Nuts (Rosaceae)
  { genus: 'malus',        common: 'Apple',           type: 'Fruits & Nuts' },
  { genus: 'pyrus',        common: 'Pear',            type: 'Fruits & Nuts' },
  { genus: 'prunus',       common: 'Cherry / Peach / Plum / Almond', type: 'Fruits & Nuts' },
  { genus: 'fragaria',     common: 'Strawberry',      type: 'Fruits & Nuts' },
  { genus: 'rubus',        common: 'Raspberry / Blackberry', type: 'Fruits & Nuts' },
  { genus: 'cydonia',      common: 'Quince',          type: 'Fruits & Nuts' },
  { genus: 'eriobotrya',   common: 'Loquat',          type: 'Fruits & Nuts' },
  // Nuts
  { genus: 'juglans',      common: 'Walnut',          type: 'Fruits & Nuts' },
  { genus: 'corylus',      common: 'Hazelnut',        type: 'Fruits & Nuts' },
  { genus: 'castanea',     common: 'Chestnut',        type: 'Fruits & Nuts' },
  { genus: 'carya',        common: 'Pecan / Hickory', type: 'Fruits & Nuts' },
  { genus: 'pistacia',     common: 'Pistachio',       type: 'Fruits & Nuts' },
  { genus: 'anacardium',   common: 'Cashew',          type: 'Fruits & Nuts' },
  { genus: 'bertholletia', common: 'Brazil Nut',      type: 'Fruits & Nuts' },
  { genus: 'macadamia',    common: 'Macadamia',       type: 'Fruits & Nuts' },
  // Citrus
  { genus: 'citrus',       common: 'Citrus',          type: 'Citrus' },
  { genus: 'fortunella',   common: 'Kumquat',         type: 'Citrus' },
  { genus: 'poncirus',     common: 'Trifoliate Orange', type: 'Citrus' },
  // Tropical Fruits
  { genus: 'musa',         common: 'Banana / Plantain', type: 'Tropical Fruits' },
  { genus: 'cocos',        common: 'Coconut',         type: 'Tropical Fruits' },
  { genus: 'elaeis',       common: 'Oil Palm',        type: 'Tropical Fruits' },
  { genus: 'phoenix',      common: 'Date Palm',       type: 'Tropical Fruits' },
  { genus: 'carica',       common: 'Papaya',          type: 'Tropical Fruits' },
  { genus: 'ananas',       common: 'Pineapple',       type: 'Tropical Fruits' },
  { genus: 'mangifera',    common: 'Mango',           type: 'Tropical Fruits' },
  { genus: 'persea',       common: 'Avocado',         type: 'Tropical Fruits' },
  { genus: 'psidium',      common: 'Guava',           type: 'Tropical Fruits' },
  { genus: 'annona',       common: 'Soursop / Cherimoya', type: 'Tropical Fruits' },
  { genus: 'artocarpus',   common: 'Breadfruit / Jackfruit', type: 'Tropical Fruits' },
  { genus: 'durio',        common: 'Durian',          type: 'Tropical Fruits' },
  { genus: 'garcinia',     common: 'Mangosteen',      type: 'Tropical Fruits' },
  { genus: 'litchi',       common: 'Lychee',          type: 'Tropical Fruits' },
  { genus: 'nephelium',    common: 'Rambutan',        type: 'Tropical Fruits' },
  { genus: 'averrhoa',     common: 'Starfruit',       type: 'Tropical Fruits' },
  { genus: 'syzygium',     common: 'Java Plum / Rose Apple', type: 'Tropical Fruits' },
  { genus: 'tamarindus',   common: 'Tamarind',        type: 'Tropical Fruits' },
  { genus: 'theobroma',    common: 'Cacao',           type: 'Tropical Fruits' },
  // Vine Fruits & Berries
  { genus: 'vitis',        common: 'Grape',           type: 'Vine Fruits & Berries' },
  { genus: 'vaccinium',    common: 'Blueberry / Cranberry', type: 'Vine Fruits & Berries' },
  { genus: 'ribes',        common: 'Currant / Gooseberry', type: 'Vine Fruits & Berries' },
  { genus: 'sambucus',     common: 'Elderberry',      type: 'Vine Fruits & Berries' },
  { genus: 'actinidia',    common: 'Kiwifruit',       type: 'Vine Fruits & Berries' },
  // Root & Tuber Crops
  { genus: 'daucus',       common: 'Carrot',          type: 'Roots & Tubers' },
  { genus: 'pastinaca',    common: 'Parsnip',         type: 'Roots & Tubers' },
  { genus: 'beta',         common: 'Beet / Sugar Beet / Chard', type: 'Roots & Tubers' },
  { genus: 'ipomoea',      common: 'Sweet Potato',    type: 'Roots & Tubers' },
  { genus: 'manihot',      common: 'Cassava',         type: 'Roots & Tubers' },
  { genus: 'colocasia',    common: 'Taro',            type: 'Roots & Tubers' },
  { genus: 'xanthosoma',   common: 'Cocoyam',         type: 'Roots & Tubers' },
  { genus: 'dioscorea',    common: 'Yam',             type: 'Roots & Tubers' },
  { genus: 'arracacia',    common: 'Arracacha',       type: 'Roots & Tubers' },
  { genus: 'apios',        common: 'Groundnut / Hopniss', type: 'Roots & Tubers' },
  { genus: 'canna',        common: 'Canna',           type: 'Roots & Tubers' },
  { genus: 'helianthus',   common: 'Sunflower / Jerusalem Artichoke', type: 'Roots & Tubers' },
  // Alliums & Onion Family
  { genus: 'allium',       common: 'Onion / Garlic / Leek', type: 'Alliums' },
  // Leafy Vegetables
  { genus: 'lactuca',      common: 'Lettuce',         type: 'Leafy Vegetables' },
  { genus: 'spinacia',     common: 'Spinach',         type: 'Leafy Vegetables' },
  { genus: 'cichorium',    common: 'Chicory / Endive', type: 'Leafy Vegetables' },
  { genus: 'cynara',       common: 'Artichoke',       type: 'Leafy Vegetables' },
  { genus: 'asparagus',    common: 'Asparagus',       type: 'Leafy Vegetables' },
  { genus: 'rheum',        common: 'Rhubarb',         type: 'Leafy Vegetables' },
  { genus: 'amaranthus',   common: 'Amaranth',        type: 'Leafy Vegetables' },
  { genus: 'atriplex',     common: 'Saltbush / Orache', type: 'Leafy Vegetables' },
  { genus: 'portulaca',    common: 'Purslane',        type: 'Leafy Vegetables' },
  { genus: 'basella',      common: 'Malabar Spinach', type: 'Leafy Vegetables' },
  { genus: 'abelmoschus',  common: 'Okra',            type: 'Leafy Vegetables' },
  { genus: 'chenopodium',  common: 'Quinoa / Lamb\'s Quarters', type: 'Leafy Vegetables' },
  // Herbs & Aromatics
  { genus: 'ocimum',       common: 'Basil',           type: 'Herbs & Aromatics' },
  { genus: 'mentha',       common: 'Mint',            type: 'Herbs & Aromatics' },
  { genus: 'thymus',       common: 'Thyme',           type: 'Herbs & Aromatics' },
  { genus: 'origanum',     common: 'Oregano / Marjoram', type: 'Herbs & Aromatics' },
  { genus: 'salvia',       common: 'Sage',            type: 'Herbs & Aromatics' },
  { genus: 'rosmarinus',   common: 'Rosemary',        type: 'Herbs & Aromatics' },
  { genus: 'lavandula',    common: 'Lavender',        type: 'Herbs & Aromatics' },
  { genus: 'melissa',      common: 'Lemon Balm',      type: 'Herbs & Aromatics' },
  { genus: 'satureja',     common: 'Savory',          type: 'Herbs & Aromatics' },
  { genus: 'agastache',    common: 'Anise Hyssop',    type: 'Herbs & Aromatics' },
  { genus: 'monarda',      common: 'Bee Balm',        type: 'Herbs & Aromatics' },
  { genus: 'coriandrum',   common: 'Coriander / Cilantro', type: 'Herbs & Aromatics' },
  { genus: 'petroselinum', common: 'Parsley',         type: 'Herbs & Aromatics' },
  { genus: 'anethum',      common: 'Dill',            type: 'Herbs & Aromatics' },
  { genus: 'foeniculum',   common: 'Fennel',          type: 'Herbs & Aromatics' },
  { genus: 'cuminum',      common: 'Cumin',           type: 'Herbs & Aromatics' },
  { genus: 'carum',        common: 'Caraway',         type: 'Herbs & Aromatics' },
  { genus: 'pimpinella',   common: 'Anise',           type: 'Herbs & Aromatics' },
  { genus: 'apium',        common: 'Celery',          type: 'Herbs & Aromatics' },
  { genus: 'levisticum',   common: 'Lovage',          type: 'Herbs & Aromatics' },
  // Spices
  { genus: 'zingiber',     common: 'Ginger',          type: 'Spices' },
  { genus: 'curcuma',      common: 'Turmeric',        type: 'Spices' },
  { genus: 'elettaria',    common: 'Cardamom',        type: 'Spices' },
  { genus: 'alpinia',      common: 'Galangal',        type: 'Spices' },
  { genus: 'piper',        common: 'Black Pepper',    type: 'Spices' },
  { genus: 'vanilla',      common: 'Vanilla',         type: 'Spices' },
  { genus: 'myristica',    common: 'Nutmeg',          type: 'Spices' },
  { genus: 'cinnamomum',   common: 'Cinnamon',        type: 'Spices' },
  { genus: 'illicium',     common: 'Star Anise',      type: 'Spices' },
  { genus: 'capsicum',     common: 'Chilli / Paprika', type: 'Spices' },
  { genus: 'crocus',       common: 'Saffron',         type: 'Spices' },
  { genus: 'laurus',       common: 'Bay Leaf',        type: 'Spices' },
  // Beverages
  { genus: 'coffea',       common: 'Coffee',          type: 'Beverages' },
  { genus: 'camellia',     common: 'Tea',             type: 'Beverages' },
  { genus: 'ilex',         common: 'Yerba Mate',      type: 'Beverages' },
  { genus: 'cola',         common: 'Kola Nut',        type: 'Beverages' },
  { genus: 'paullinia',    common: 'Guarana',         type: 'Beverages' },
  // Oilseeds & Fiber
  { genus: 'gossypium',    common: 'Cotton',          type: 'Fiber & Oil Crops' },
  { genus: 'cannabis',     common: 'Hemp / Cannabis', type: 'Fiber & Oil Crops' },
  { genus: 'linum',        common: 'Flax / Linseed',  type: 'Fiber & Oil Crops' },
  { genus: 'sesamum',      common: 'Sesame',          type: 'Fiber & Oil Crops' },
  { genus: 'carthamus',    common: 'Safflower',       type: 'Fiber & Oil Crops' },
  { genus: 'ricinus',      common: 'Castor Bean',     type: 'Fiber & Oil Crops' },
  { genus: 'jatropha',     common: 'Jatropha',        type: 'Fiber & Oil Crops' },
  { genus: 'corchorus',    common: 'Jute',            type: 'Fiber & Oil Crops' },
  { genus: 'hibiscus',     common: 'Roselle / Kenaf', type: 'Fiber & Oil Crops' },
  { genus: 'boehmeria',    common: 'Ramie',           type: 'Fiber & Oil Crops' },
  { genus: 'agave',        common: 'Agave / Sisal',   type: 'Fiber & Oil Crops' },
  { genus: 'hevea',        common: 'Rubber Tree',     type: 'Fiber & Oil Crops' },
  // Medicinal
  { genus: 'aloe',         common: 'Aloe Vera',       type: 'Medicinal' },
  { genus: 'echinacea',    common: 'Echinacea',       type: 'Medicinal' },
  { genus: 'valeriana',    common: 'Valerian',        type: 'Medicinal' },
  { genus: 'hypericum',    common: "St. John's Wort", type: 'Medicinal' },
  { genus: 'matricaria',   common: 'Chamomile',       type: 'Medicinal' },
  { genus: 'silybum',      common: 'Milk Thistle',    type: 'Medicinal' },
  { genus: 'panax',        common: 'Ginseng',         type: 'Medicinal' },
  { genus: 'withania',     common: 'Ashwagandha',     type: 'Medicinal' },
  { genus: 'andrographis', common: 'Andrographis',    type: 'Medicinal' },
  { genus: 'centella',     common: 'Gotu Kola',       type: 'Medicinal' },
  { genus: 'bacopa',       common: 'Brahmi',          type: 'Medicinal' },
  { genus: 'morinda',      common: 'Noni',            type: 'Medicinal' },
  { genus: 'opuntia',      common: 'Prickly Pear',    type: 'Medicinal' },
  { genus: 'papaver',      common: 'Poppy',           type: 'Medicinal' },
  // Misc / Other food crops
  { genus: 'ficus',        common: 'Fig',             type: 'Tropical Fruits' },
  { genus: 'morus',        common: 'Mulberry',        type: 'Tropical Fruits' },
  { genus: 'olea',         common: 'Olive',           type: 'Fruits & Nuts' },
  { genus: 'taraxacum',    common: 'Dandelion',       type: 'Leafy Vegetables' },
  { genus: 'scorzonera',   common: 'Scorzonera',      type: 'Roots & Tubers' },
  { genus: 'tropaeolum',   common: 'Nasturtium / Mashua', type: 'Roots & Tubers' },
  // Ornamentals (companion planting & beneficial-insect attractors)
  { genus: 'rosa',          common: 'Rose',                     type: 'Ornamentals' },
  { genus: 'tagetes',       common: 'Marigold',                 type: 'Ornamentals' },
  { genus: 'calendula',     common: 'Calendula / Pot Marigold', type: 'Ornamentals' },
  { genus: 'zinnia',        common: 'Zinnia',                   type: 'Ornamentals' },
  { genus: 'cosmos',        common: 'Cosmos',                   type: 'Ornamentals' },
  { genus: 'phacelia',      common: 'Phacelia',                 type: 'Ornamentals' },
  { genus: 'achillea',      common: 'Yarrow',                   type: 'Ornamentals' },
  { genus: 'chrysanthemum', common: 'Chrysanthemum',            type: 'Ornamentals' },
  { genus: 'pelargonium',   common: 'Geranium',                 type: 'Ornamentals' },
  { genus: 'lobularia',     common: 'Sweet Alyssum',            type: 'Ornamentals' },
  { genus: 'verbena',       common: 'Verbena',                  type: 'Ornamentals' },
  { genus: 'rudbeckia',     common: 'Black-Eyed Susan',         type: 'Ornamentals' },
  { genus: 'dahlia',        common: 'Dahlia',                   type: 'Ornamentals' },
  { genus: 'tulipa',        common: 'Tulip',                    type: 'Ornamentals' },
  { genus: 'lilium',        common: 'Lily',                     type: 'Ornamentals' },
  { genus: 'narcissus',     common: 'Daffodil',                 type: 'Ornamentals' },
  { genus: 'iris',          common: 'Iris',                     type: 'Ornamentals' },
  { genus: 'petunia',       common: 'Petunia',                  type: 'Ornamentals' },
  { genus: 'lantana',       common: 'Lantana',                  type: 'Ornamentals' },
  { genus: 'impatiens',     common: 'Impatiens / Busy Lizzie',  type: 'Ornamentals' },
  // Wild Plants (beneficial-insect habitat & trap-crop candidates)
  { genus: 'urtica',        common: 'Stinging Nettle',          type: 'Wild Plants' },
  { genus: 'plantago',      common: 'Plantain',                 type: 'Wild Plants' },
  { genus: 'rumex',         common: 'Dock / Sorrel',            type: 'Wild Plants' },
  { genus: 'symphytum',     common: 'Comfrey',                  type: 'Wild Plants' },
  { genus: 'borago',        common: 'Borage',                   type: 'Wild Plants' },
  { genus: 'tanacetum',     common: 'Tansy',                    type: 'Wild Plants' },
  { genus: 'artemisia',     common: 'Wormwood / Mugwort',       type: 'Wild Plants' },
  { genus: 'solidago',      common: 'Goldenrod',                type: 'Wild Plants' },
  { genus: 'verbascum',     common: 'Mullein',                  type: 'Wild Plants' },
  { genus: 'dipsacus',      common: 'Teasel',                   type: 'Wild Plants' },
  { genus: 'stellaria',     common: 'Chickweed',                type: 'Wild Plants' },
  { genus: 'galium',        common: 'Cleavers / Bedstraw',      type: 'Wild Plants' },
];

const MAX_PER_GENUS = 5;

// ---------------------------------------------------------------------------
// Optional: Wikidata enrichment for species-level common names
// ---------------------------------------------------------------------------
const SPARQL_URL = 'https://query.wikidata.org/sparql';

function sparqlFetch(sparql) {
  return new Promise((resolve, reject) => {
    const url = `${SPARQL_URL}?query=${encodeURIComponent(sparql.trim())}&format=json`;
    const req = https.get(url, {
      headers: { 'User-Agent': 'AgroEcoApp/1.0', 'Accept': 'application/sparql-results+json' },
      timeout: 25000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function fetchWikidataNames(generaList) {
  // Query Wikidata for English common names for specific genera
  // Uses taxon name (P225) and common name (P1843)
  const genusFilter = generaList.map(g => `"${g[0].toUpperCase() + g.slice(1)}"`).join(' ');
  const sparql = `
    SELECT DISTINCT ?taxonName (SAMPLE(?cn) AS ?commonName) WHERE {
      VALUES ?g { ${genusFilter} }
      ?item wdt:P225 ?taxonName .
      FILTER(STRSTARTS(?taxonName, ?g))
      OPTIONAL { ?item wdt:P1843 ?commonName . FILTER(LANG(?commonName) = "en") }
    } GROUP BY ?taxonName
    LIMIT 5000
  `;
  try {
    const result = await sparqlFetch(sparql);
    const map = new Map();
    for (const b of result.results.bindings) {
      const name = b.taxonName?.value?.trim();
      const cn = b.commonName?.value?.trim();
      if (name && cn) map.set(name.toLowerCase(), cn);
    }
    return map;
  } catch (e) {
    console.warn('  Wikidata enrichment skipped:', e.message);
    return new Map();
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('=== build_crop_list.js ===');

  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });

  const hasPlantsTable = await db.get(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='plants'"
  );
  if (!hasPlantsTable) {
    console.error('ERROR: plants table not found. Run add_indexes.js first.');
    process.exit(1);
  }

  // Build lookup structures from the curated genus list
  const genusMap = new Map(); // genus (lower) -> { common, type }
  for (const entry of CROP_GENERA) {
    genusMap.set(entry.genus.toLowerCase(), { common: entry.common, type: entry.type });
  }
  console.log(`Curated crop genera: ${genusMap.size}`);

  // ---------------------------------------------------------------------------
  // Step 1: Cross-reference GloBI plants table by genus
  // ---------------------------------------------------------------------------
  console.log('Cross-referencing with GloBI plants table...');
  const allPlants = await db.all('SELECT name, path FROM plants ORDER BY name');
  console.log(`  GloBI plants entries: ${allPlants.length}`);

  const genusCount = new Map();
  const matched = [];

  for (const plant of allPlants) {
    const nameLower = (plant.name || '').toLowerCase();
    const g = nameLower.split(/[\s_]/)[0];
    const entry = genusMap.get(g);
    if (!entry) continue;

    const count = genusCount.get(g) || 0;
    if (count >= MAX_PER_GENUS) continue;
    genusCount.set(g, count + 1);

    matched.push({
      name: plant.name,
      path: plant.path,
      genus_common: entry.common,
      type: entry.type
    });
  }
  console.log(`  Matched: ${matched.length} species from ${genusCount.size} genera`);

  // ---------------------------------------------------------------------------
  // Step 2: Optional Wikidata enrichment for species-level common names
  // ---------------------------------------------------------------------------
  console.log('\nFetching species-level common names from Wikidata (optional)...');
  const generaBatches = Array.from(genusMap.keys());
  // Query in batches of 30 genera to avoid timeouts
  const wikidataNames = new Map();
  for (let i = 0; i < generaBatches.length; i += 30) {
    const batch = generaBatches.slice(i, i + 30);
    console.log(`  Batch ${Math.floor(i/30)+1}/${Math.ceil(generaBatches.length/30)}...`);
    const result = await fetchWikidataNames(batch);
    for (const [k, v] of result) wikidataNames.set(k, v);
    if (i + 30 < generaBatches.length) await new Promise(r => setTimeout(r, 1000));
  }
  console.log(`  Got ${wikidataNames.size} species-level common names from Wikidata`);

  // ---------------------------------------------------------------------------
  // Step 3: Write verified_crops table
  // ---------------------------------------------------------------------------
  console.log('\nWriting verified_crops table...');
  await db.run('DROP TABLE IF EXISTS verified_crops');
  await db.run(`
    CREATE TABLE verified_crops (
      name        TEXT PRIMARY KEY,
      path        TEXT,
      common_name TEXT,
      type        TEXT
    )
  `);
  await db.run('CREATE INDEX idx_verified_crops_name ON verified_crops(name)');

  await db.run('BEGIN');
  const stmt = await db.prepare(
    'INSERT OR IGNORE INTO verified_crops (name, path, common_name, type) VALUES (?, ?, ?, ?)'
  );
  for (const row of matched) {
    // Prefer Wikidata species-level name, fall back to genus common name
    const specificName = wikidataNames.get(row.name.toLowerCase());
    const commonName = specificName || row.genus_common;
    await stmt.run(row.name, row.path, commonName, row.type);
  }
  await stmt.finalize();
  await db.run('COMMIT');

  const count = await db.get('SELECT COUNT(*) as cnt FROM verified_crops');
  console.log(`\n✓ verified_crops: ${count.cnt} species across ${genusCount.size} crop genera`);
  console.log('Restart server.js to use the updated crop list.');

  await db.close();
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
