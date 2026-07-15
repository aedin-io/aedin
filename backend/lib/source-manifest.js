'use strict';
const fs = require('node:fs');

const REQUIRED = ['id', 'source_org', 'title', 'filename', 'category', 'canonical_url', 'fetch_urls', 'license'];

function validateManifest(obj) {
  const errors = [];
  if (!obj || !Array.isArray(obj.entries)) {
    return { ok: false, errors: ['manifest must have an "entries" array'] };
  }
  const seen = new Set();
  for (const e of obj.entries) {
    const id = e && e.id ? e.id : '(no id)';
    for (const f of REQUIRED) {
      if (e[f] === undefined || e[f] === null || e[f] === '') errors.push(`entry ${id}: missing field "${f}"`);
    }
    if (Array.isArray(e.fetch_urls) && e.fetch_urls.length === 0) errors.push(`entry ${id}: fetch_urls is empty`);
    if (e.id) {
      if (seen.has(e.id)) errors.push(`duplicate id "${e.id}"`);
      seen.add(e.id);
    }
  }
  return { ok: errors.length === 0, errors };
}

function loadManifest(p) {
  const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
  const v = validateManifest(obj);
  if (!v.ok) throw new Error(`invalid manifest:\n  ${v.errors.join('\n  ')}`);
  return obj;
}

module.exports = { loadManifest, validateManifest };
