#!/usr/bin/env node
'use strict';
/**
 * acquire-sources.js — curated-manifest PDF downloader (Month-0 Task 2).
 *
 * Reads literature/sources-manifest.json, downloads any missing/changed PDFs
 * into literature/<category>/, verifies (%PDF magic + size floor + sha256),
 * and records provenance in literature/acquisition-lock.json.
 *
 * DB-free by design: this script is strictly UPSTREAM of stage-from-json.js
 * (the first writer of globi.sqlite), so it never opens the DB and is safe to
 * run concurrently with the ingestion pipeline.
 *
 * Usage:
 *   node acquire-sources.js [--source-org=<org>] [--dry-run] [--verify-only]
 */
const fs = require('node:fs');
const path = require('node:path');
const { loadManifest } = require('./lib/source-manifest');
const { sha256, skipDecision } = require('./lib/pdf-verify');
const { acquireOne } = require('./lib/fetch-fallback');

const LIT = path.join(__dirname, '..', 'literature');
const MANIFEST = path.join(LIT, 'sources-manifest.json');
const LOCK = path.join(LIT, 'acquisition-lock.json');

function parseArgs(argv) {
  const a = { sourceOrg: null, dryRun: false, verifyOnly: false };
  for (const x of argv.slice(2)) {
    if (x.startsWith('--source-org=')) a.sourceOrg = x.split('=')[1];
    else if (x === '--dry-run') a.dryRun = true;
    else if (x === '--verify-only') a.verifyOnly = true;
  }
  return a;
}
function readLock() { try { return JSON.parse(fs.readFileSync(LOCK, 'utf8')); } catch { return {}; } }
function onDiskSha(file) { try { return sha256(fs.readFileSync(file)); } catch { return null; } }

async function main() {
  const args = parseArgs(process.argv);
  const { entries } = loadManifest(MANIFEST);
  const lock = readLock();
  const rows = [];
  let failures = 0;

  for (const e of entries.filter(e => !args.sourceOrg || e.source_org === args.sourceOrg)) {
    const dir = path.join(LIT, e.category);
    const file = path.join(dir, e.filename);
    const existsSha = onDiskSha(file);
    const lockSha = lock[e.id] && lock[e.id].sha256;

    if (args.verifyOnly) {
      const status = !existsSha ? 'missing' : (lockSha && existsSha === lockSha ? 'ok' : 'drift');
      if (status !== 'ok') failures++;
      rows.push({ id: e.id, status });
      continue;
    }
    if (skipDecision({ existsSha, lockSha }) === 'skip') { rows.push({ id: e.id, status: 'skip' }); continue; }
    if (args.dryRun) { rows.push({ id: e.id, status: 'would-fetch' }); continue; }

    const r = await acquireOne(e);
    if (r.status === 'ok' || r.status === 'mirror-used') {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, r.buf);
      lock[e.id] = {
        sha256: sha256(r.buf), bytes: r.buf.length, http_status: r.http_status,
        url_used: r.url_used, canonical_url: e.canonical_url,
        fetched_at: new Date().toISOString(),
      };
    } else { failures++; }
    rows.push({ id: e.id, status: r.status });
  }

  if (!args.verifyOnly && !args.dryRun) fs.writeFileSync(LOCK, JSON.stringify(lock, null, 2) + '\n');
  for (const r of rows) console.log(`[${r.status}]`.padEnd(14), r.id);
  console.log(`\n${rows.length} entries, ${failures} need attention.`);
  process.exit(failures > 0 ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(2); });
