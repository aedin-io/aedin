'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const migrate = require('./058_taxon_backbone');

test('058 creates taxon_backbone with self-FK ancestry + indexes, idempotently', () => {
  const db = new Database(':memory:');
  migrate(db);

  const cols = db.prepare('PRAGMA table_info(taxon_backbone)').all().map(c => c.name);
  assert.deepEqual(cols, ['gbif_key', 'rank', 'parent_key', 'canonical', 'rank_path']);

  const idx = db.prepare('PRAGMA index_list(taxon_backbone)').all().map(i => i.name);
  assert.ok(idx.includes('idx_tb_parent'));
  assert.ok(idx.includes('idx_tb_canonical'));

  migrate(db); // idempotent
  db.close();
});

test('058 supports a parent_key ancestry chain (kingdom→phylum→class)', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);

  const ins = db.prepare(
    'INSERT INTO taxon_backbone (gbif_key, rank, parent_key, canonical, rank_path) VALUES (?,?,?,?,?)'
  );
  ins.run(1, 'kingdom', null, 'Animalia', 'Animalia');
  ins.run(54, 'phylum', 1, 'Arthropoda', 'Animalia>Arthropoda');
  ins.run(216, 'class', 54, 'Insecta', 'Animalia>Arthropoda>Insecta');

  // Walk up one level: Insecta's parent is Arthropoda.
  const parent = db.prepare(
    `SELECT p.canonical FROM taxon_backbone c
       JOIN taxon_backbone p ON p.gbif_key = c.parent_key
      WHERE c.gbif_key = 216`
  ).get();
  assert.equal(parent.canonical, 'Arthropoda');

  // rank_path prefix is the distance primitive: Insecta is under Arthropoda.
  const insecta = db.prepare('SELECT rank_path FROM taxon_backbone WHERE gbif_key = 216').get();
  assert.ok(insecta.rank_path.startsWith('Animalia>Arthropoda'));
  db.close();
});
