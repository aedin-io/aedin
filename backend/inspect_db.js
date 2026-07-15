const sqlite3 = require('sqlite3');
const { RAW_DB } = require('./lib/db-paths.cjs');
const db = new sqlite3.Database(RAW_DB);

db.all('SELECT source_name, source_path, target_path, interaction_type FROM interactions LIMIT 200', function(e, rows) {
  if (e) { console.error(e); return; }
  const types = {};
  var nullSource = 0, nullTarget = 0;
  rows.forEach(function(r) {
    types[r.interaction_type] = (types[r.interaction_type]||0)+1;
    if (!r.source_path) nullSource++;
    if (!r.target_path) nullTarget++;
  });
  console.log('Sampled', rows.length, 'rows. Null source_path:', nullSource, '| Null target_path:', nullTarget);
  console.log('Interaction types:', JSON.stringify(types, null, 2));

  rows.slice(0, 8).forEach(function(r) {
    var p = (r.source_path || '').toLowerCase();
    var cat = 'other';
    if (p.indexOf('plantae') >= 0 || p.indexOf('streptophyta') >= 0 || p.indexOf('viridiplantae') >= 0) cat = 'plantae';
    else if (p.indexOf('fungi') >= 0) cat = 'fungi';
    else if (p.indexOf('insecta') >= 0 || p.indexOf('arachnida') >= 0 || p.indexOf('arthropoda') >= 0) cat = 'invertebrate';
    else if (p.indexOf('mammalia') >= 0 || p.indexOf('aves') >= 0 || p.indexOf('reptilia') >= 0) cat = 'vertebrate';
    else if (p.indexOf('animalia') >= 0) cat = 'invertebrate';
    else if (p.indexOf('bacteria') >= 0 || p.indexOf('virus') >= 0) cat = 'microbe';
    console.log('[' + cat + ']', r.source_name, '->', r.interaction_type);
  });

  db.close();
});
