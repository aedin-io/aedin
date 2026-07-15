#!/usr/bin/env node
'use strict';
/**
 * overnight-ingest.js — gated, single-unit, resumable driver for the overnight
 * auto-resume ingestion harness (Phase 2 of the corpus plan).
 *
 * Each invocation does AT MOST one unit of work, then exits — so a token-window
 * reset between firings is always safe (the next firing recomputes the next unit
 * from durable state). The arming loop (see docs/OVERNIGHT-INGEST-RESUME.md)
 * re-enters this script on an interval.
 *
 * Safety gates, in order, BEFORE the DB is opened:
 *   1. Nightly window (20:00–06:00 local) — else exit 3, reschedule.
 *   2. WAL quiescence — if another writer (e.g. the Data Flow chat) has touched
 *      aedin.sqlite-wal recently, exit 4 and back off.
 * The DB is opened READ-ONLY here: this driver only DECIDES the next unit and
 * journals it. The actual extract→stage→multi-critic→promote pipeline is
 * subscription-only (Agent-dispatched) and is run by the executor per the
 * playbook — that is where the single DB write for the unit happens.
 *
 * Exit codes: 0 did-a-unit-or-nothing-to-do | 2 error | 3 outside-window | 4 db-busy
 */
const path = require('node:path');
const fs = require('node:fs');
const { loadManifest } = require('./lib/source-manifest');
const { isWithinWindow, walQuiescent } = require('./lib/ingest-window');
const { nextUnit } = require('./lib/ingest-checkpoint');

const { CORPUS_DB } = require('./lib/db-paths.cjs');

const LIT = path.join(__dirname, '..', 'literature');
// DB split (2026-06-19): the AEDIN knowledge-base tables (sources/claims/entities/
// staging) live in CORPUS_DB (aedin.sqlite); RAW_DB (globi.sqlite) is raw-GloBI-only.
// Ingestion reads + writes CORPUS_DB, so that is also the WAL we guard against.
// Use the canonical shared path module so any future relocation is tracked.
const DB = CORPUS_DB;
const WAL = DB + '-wal';
const MANIFEST = path.join(LIT, 'sources-manifest.json');
const LOCK = path.join(LIT, 'acquisition-lock.json');
const LOG = path.join(LIT, 'overnight-ingest.log');

function journal(msg) {
  try { fs.appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`); } catch { /* log best-effort */ }
  console.log(msg);
}

async function ingestedIdSet() {
  const sqlite3 = require('sqlite3');
  const { open } = require('sqlite');
  const db = await open({ filename: DB, driver: sqlite3.Database, mode: sqlite3.OPEN_READONLY });
  await db.exec('PRAGMA query_only=1;');
  const rows = await db.all('SELECT file_path FROM sources WHERE file_path IS NOT NULL');
  await db.close();
  // sources.file_path basename (sans .pdf) == manifest id by construction (Task 5).
  return new Set(rows.map((r) => path.basename(r.file_path, '.pdf')));
}

async function main() {
  const now = new Date();
  if (!isWithinWindow(now)) { journal('outside window 20:00-06:00 — no-op'); process.exit(3); }
  if (!walQuiescent(WAL, now.getTime())) { journal('WAL active — another writer present, backing off'); process.exit(4); }

  if (!fs.existsSync(LOCK)) { journal('no acquisition-lock.json — run acquire-sources.js first'); process.exit(0); }
  const { entries } = loadManifest(MANIFEST);
  const lock = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
  const ingestedIds = await ingestedIdSet();
  const unit = nextUnit({ manifestEntries: entries, lock, ingestedIds });

  if (unit.kind === 'none') { journal('no acquired-but-un-ingested units — done for now'); process.exit(0); }

  journal(`next unit: extract ${unit.entry.id} (${unit.entry.filename})`);
  // --- ONE unit of the EXISTING subscription-only pipeline ---
  // The extract + multi-critic stages are Agent-dispatched (no API spend); the
  // executor wires pdf-chunk.js → extractor Agent → stage-from-json.js →
  // multi-critic-batch-{prepare,import}.js → promote-staged-claims.js per
  // docs/phase-3-passlog.md + docs/OVERNIGHT-INGEST-RESUME.md. The driver's
  // contract: surface exactly ONE unit, journal it, then exit so the loop
  // (and any token-reset) resumes cleanly from recomputed state.
  journal(`(executor runs the existing pipeline for ${unit.entry.id}, commits, then re-fires)`);
  process.exit(0);
}
main().catch((e) => { journal('ERROR ' + e.message); process.exit(2); });
