'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

// Proves the Phase-2 pattern: open corpus as main, ATTACH raw, read raw.* + write main.*
test('cross-DB ATTACH reads raw.interactions and writes corpus.claims', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-'));
  const rawPath = path.join(dir, 'globi.sqlite');
  const corpusPath = path.join(dir, 'aedin.sqlite');
  // build a raw DB
  const raw = new Database(rawPath);
  raw.exec(`CREATE TABLE interactions (rowid INTEGER PRIMARY KEY, source_name TEXT, target_name TEXT)`);
  raw.prepare('INSERT INTO interactions (source_name, target_name) VALUES (?,?)').run('Apis mellifera', 'Trifolium');
  raw.close();
  // build a corpus DB
  const corpus = new Database(corpusPath);
  corpus.exec(`CREATE TABLE claims (id INTEGER PRIMARY KEY, subject_name TEXT, object_name TEXT)`);
  corpus.exec(`ATTACH DATABASE '${rawPath}' AS raw`);
  // read raw, write corpus — the Phase-2 shape
  const row = corpus.prepare('SELECT source_name, target_name FROM raw.interactions WHERE rowid = 1').get();
  corpus.prepare('INSERT INTO claims (subject_name, object_name) VALUES (?,?)').run(row.source_name, row.target_name);
  const out = corpus.prepare('SELECT subject_name, object_name FROM claims').get();
  assert.deepEqual(out, { subject_name: 'Apis mellifera', object_name: 'Trifolium' });
  corpus.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
