'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { candidatesFor, kingdomOf, OTT_KINGDOM_MAP } = require('./ott-lookup.js');

function fixture() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE ott_taxa (ott_id INTEGER PRIMARY KEY, parent_ott_id INTEGER,
                           name TEXT, rank TEXT, source_info TEXT, uniqname TEXT, flags TEXT);
    CREATE TABLE ott_synonyms (name TEXT, ott_id INTEGER, type TEXT);

    -- plant spine: Archaeplastida -> Moraceae -> Ficus -> the fig
    INSERT INTO ott_taxa VALUES (304358, NULL,   'Archaeplastida', 'kingdom', '', '', '');
    INSERT INTO ott_taxa VALUES (208031, 304358, 'Moraceae', 'family', '', '', '');
    INSERT INTO ott_taxa VALUES (658513, 208031, 'Ficus', 'genus', '', '', '');
    INSERT INTO ott_taxa VALUES (1050104, 658513, 'Ficus variegata Blume, 1825', 'species', '', '', '');
    -- animal spine: Metazoa -> Ficus (mollusc) -> the mollusc species
    INSERT INTO ott_taxa VALUES (691846, NULL,   'Metazoa', 'kingdom', '', '', '');
    INSERT INTO ott_taxa VALUES (1068336, 691846, 'Ficus', 'genus', '', '', '');
    INSERT INTO ott_taxa VALUES (7494610, 1068336, 'Ficus variegata', 'species', '', '', '');
    -- the bare fig name is a SYNONYM pointing at the accepted plant row
    INSERT INTO ott_synonyms VALUES ('Ficus variegata', 1050104, '');
  `);
  return db;
}

test('kingdomOf walks parents and maps OTT roots to our vocabulary', () => {
  const db = fixture();
  assert.equal(kingdomOf(db, 1050104), 'plantae');
  assert.equal(kingdomOf(db, 7494610), 'invertebrate');
  assert.equal(OTT_KINGDOM_MAP.Archaeplastida, 'plantae');
});

test('candidatesFor searches BOTH taxonomy and synonyms', () => {
  const db = fixture();
  const got = candidatesFor(db, 'Ficus variegata');
  const ids = got.map(c => c.ott_id).sort((a, b) => a - b);
  assert.deepEqual(ids, [1050104, 7494610],
    'the synonym row must surface the fig alongside the mollusc');
});

test('a name only in taxonomy.tsv still resolves', () => {
  const db = fixture();
  assert.deepEqual(candidatesFor(db, 'Moraceae').map(c => c.ott_id), [208031]);
});

test('an unknown name yields no candidates', () => {
  assert.deepEqual(candidatesFor(fixture(), 'Nonexistus fakus'), []);
});

test('THE WRITE GUARD: the pass touches only ott_id, ott_status (and id) across every entity-write statement', () => {
  // The entire "reference alongside" decision rests on this. Read the pass's
  // source and find every SQL statement that writes to `entities`, in ANY
  // shape (UPDATE ... SET, INSERT INTO ... including ON CONFLICT DO UPDATE
  // SET) — not just a plain UPDATE — and assert none of them mention a
  // taxonomy column, and that the only columns actually assigned are
  // ott_id / ott_status (id only ever appears in a WHERE clause).
  const fs = require('fs');
  const rawSrc = fs.readFileSync(require('path').join(__dirname, '..', 'resolve-entities-to-ott.js'), 'utf8');

  // Strip JS comments BEFORE scanning for string literals. A bare apostrophe
  // in a `//` or `/* */` comment (e.g. "they aren't reproducible") is not a
  // string delimiter, but the literal-extraction regex below can't tell the
  // difference — it would treat the apostrophe as opening a string and then
  // consume everything up to the next real quote, corrupting the scan of
  // every literal after it (this happened for real during Task 7 review:
  // the guard reported 0 write sites instead of 2). This is a conservative
  // line/block comment stripper, not a full tokenizer — it only needs to
  // handle plain source code, not comment-like text inside string literals
  // that themselves start earlier than the comment marker, which does not
  // occur in this file.
  const src = rawSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

  // Extract whole string literals (single/double/backtick, escape-aware) so a
  // quote INSIDE the SQL text (e.g. an authority string like "Blume, 1825")
  // can't truncate the match early the way `[^\`']+` did.
  const literalRe = /`(?:\\.|[^`\\])*`|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g;
  const literals = src.match(literalRe) || [];

  const ENTITY_WRITE_RE = /(UPDATE\s+entities\s+SET|INSERT\s+INTO\s+entities\b)/i;
  const writeStatements = literals.filter(l => ENTITY_WRITE_RE.test(l));

  // Adding a new write site to this file is a deliberate, reviewed act.
  // Bump this constant AND re-justify the guard when you do — do not let a
  // second write site slip in silently (this is exactly what Task 7 does:
  // it adds a second UPDATE for TNRS-resolved rows).
  const EXPECTED_WRITE_SITES = 2;
  assert.equal(writeStatements.length, EXPECTED_WRITE_SITES,
    `expected exactly ${EXPECTED_WRITE_SITES} entity-write statement(s), found ${writeStatements.length}. ` +
    'If you intentionally added a write site, bump EXPECTED_WRITE_SITES above and re-justify this guard.');

  const ALLOWED_COLUMNS = new Set(['ott_id', 'ott_status', 'id']);
  const FORBIDDEN_COLUMNS = ['kingdom', 'phylum', 'taxon_class', 'taxon_order', 'family', 'genus'];

  for (const stmt of writeStatements) {
    const assignedCols = new Set();
    for (const m of stmt.matchAll(/SET\s+([\s\S]*?)(?:WHERE|$)/gi)) {
      for (const assignment of m[1].split(',')) {
        const c = assignment.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/);
        if (c) assignedCols.add(c[1]);
      }
    }
    for (const m of stmt.matchAll(/INSERT\s+INTO\s+entities\s*\(([^)]*)\)/gi)) {
      for (const name of m[1].split(',')) {
        const trimmed = name.trim();
        if (trimmed) assignedCols.add(trimmed);
      }
    }

    for (const c of assignedCols) {
      assert.ok(ALLOWED_COLUMNS.has(c),
        `entity-write statement assigns disallowed column "${c}": ${stmt}`);
    }
    for (const forbidden of FORBIDDEN_COLUMNS) {
      assert.ok(!new RegExp(`\\b${forbidden}\\b`).test(stmt),
        `entity-write statement must not mention ${forbidden}: ${stmt}`);
    }
  }
});
