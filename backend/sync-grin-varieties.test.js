'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseGrinHtml } = require('./sync-grin-varieties.js');

// Minimal GRIN-shaped row: <tr><td>rowNum</td><td>PI..</td><td>name</td><td>taxonomy</td><td>origin</td>...<td>[14]=improvement</td><td>[15]=narrative</td></tr>
const td = (n) => Array.from({ length: n }, (_, i) => `<td>c${i}</td>`).join('');
const ROW = `<tr><td>1</td><td>PI 695096</td><td>'Goliath'</td><td>Solanum</td><td>Italy</td>${td(10)}<td>Cultivar</td><td>a nice tomato</td></tr>`;

test('parseGrinHtml extracts accession, name, origin, improvement_level (cells[14]), narrative', () => {
  const rows = parseGrinHtml(`<table>${ROW}</table>`);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    grin_accession: 'PI 695096', plant_name: "'Goliath'", origin: 'Italy',
    improvement_level: 'Cultivar', narrative: 'a nice tomato',
  });
});
