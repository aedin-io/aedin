const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { RAW_DB } = require('./lib/db-paths.cjs');

function getBioCategory(path) {
  const p = (path || "").toLowerCase();
  if (p.includes('plantae') || p.includes('streptophyta') || p.includes('viridiplantae')) return 'plantae';
  if (p.includes('fungi')) return 'fungi';
  if (p.includes('insecta') || p.includes('arachnida') || p.includes('mollusca') || p.includes('nematoda') || p.includes('arthropoda')) return 'invertebrate';
  if (p.includes('mammalia') || p.includes('aves') || p.includes('reptilia') || p.includes('amphibia') || p.includes('actinopterygii')) return 'vertebrate';
  if (p.includes('animalia')) return 'invertebrate';
  if (p.includes('bacteria') || p.includes('viruses') || p.includes('virus')) return 'microbe';
  return 'other';
}

async function run() {
  const db = await open({ filename: RAW_DB, driver: sqlite3.Database });

  // Find a plant to focus on
  const plant = await db.get("SELECT DISTINCT target_name as name, target_path as path FROM interactions WHERE target_path LIKE '%plantae%' LIMIT 1");
  console.log('Focus plant:', plant.name, '| path:', (plant.path||'').substring(0, 60));
  console.log('bioCategory:', getBioCategory(plant.path));
  console.log('');

  // Now simulate BFS level 1
  const rows = await db.all(
    'SELECT source_name, source_path, target_name, target_path, interaction_type FROM interactions WHERE source_name = ? OR target_name = ? LIMIT 20',
    [plant.name, plant.name]
  );

  const allNodes = new Map();

  rows.forEach(row => {
    [
      { name: row.source_name, path: row.source_path },
      { name: row.target_name, path: row.target_path }
    ].forEach(node => {
      const existing = allNodes.get(node.name);
      if (!existing || (node.path && existing.bioCategory === 'other')) {
        const cat = getBioCategory(node.path);
        allNodes.set(node.name, { bioCategory: cat, path: (node.path || 'NULL').substring(0, 50) });
      }
    });
  });

  console.log('Nodes after BFS level 1:');
  allNodes.forEach((v, k) => {
    console.log(' ', v.bioCategory.padEnd(14), k, '| path:', v.path);
  });

  await db.close();
}

run().catch(console.error);
