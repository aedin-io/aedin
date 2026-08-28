'use strict';
/**
 * ott-release.js — the pinned Open Tree Taxonomy release.
 *
 * PINNED, never "current": a citable corpus must be able to say which reference
 * it reconciled against, and "current" is not reproducible. Bumping the version
 * is a deliberate edit here, followed by a re-run of the loader.
 *
 * Byte count verified against the live server 2026-08-25.
 */
const path = require('path');
const { BACKEND_DIR } = require('./db-paths.cjs');

const VERSION = '3.7';
const DIR = path.join(BACKEND_DIR, 'ott-dump');

const OTT_RELEASE = Object.freeze({
  version: VERSION,
  url: `https://files.opentreeoflife.org/ott/ott${VERSION}/ott${VERSION}.tgz`,
  bytes: 111219034,
  dir: DIR,
  tarballPath: path.join(DIR, `ott${VERSION}.tgz`),
  taxonomyPath: path.join(DIR, `ott${VERSION}`, 'taxonomy.tsv'),
  synonymsPath: path.join(DIR, `ott${VERSION}`, 'synonyms.tsv'),
});

/**
 * @param {number} actualBytes
 * @returns {{ok: boolean, reason?: string}}
 */
function verifySize(actualBytes) {
  if (actualBytes === OTT_RELEASE.bytes) return { ok: true };
  if (actualBytes < OTT_RELEASE.bytes) {
    return { ok: false, reason: `incomplete: ${actualBytes} of ${OTT_RELEASE.bytes} bytes` };
  }
  return { ok: false, reason: `larger than expected: ${actualBytes} vs ${OTT_RELEASE.bytes} bytes` };
}

/**
 * Decide whether to append, restart, or error when resuming a download.
 *
 * Guard against the case where a server ignores HTTP Range requests and
 * returns the full file body (HTTP 200) even when we sent a partial Range
 * (bytes=N-). Without this check, the code would append the full body onto
 * the partial bytes, corrupting the tarball permanently.
 *
 * @param {number} statusCode - HTTP response status code
 * @param {number} bytesAlready - Bytes already on disk (0 = fresh download)
 * @returns {'append' | 'restart'} - 'append' if safe to append to existing file,
 *          'restart' if must truncate and re-download
 */
function resumeMode(statusCode, bytesAlready) {
  // Fresh download (zero bytes): safe to append regardless of status code
  if (bytesAlready === 0) return 'append';

  // Resuming: must verify server honored the Range request (206 Partial Content)
  // If server returns 200 (full body), we must NOT append — restart instead
  if (statusCode === 206) return 'append';
  if (statusCode === 200) return 'restart';

  // Shouldn't reach here (caller should check status codes), but be safe
  return 'restart';
}

/**
 * Assert an opened ott.sqlite carries the pinned release's ott_meta.version.
 *
 * build-ott-db.js documents that consumers MUST treat a missing
 * ott_meta.version as an incomplete-load signal; this is the (previously
 * unwritten) check that makes that documentation true. Also catches a
 * *different* release's ott.sqlite left over on disk — same missing-check
 * hazard, since a mismatched version reads as valid data with no signal.
 *
 * @param {import('better-sqlite3').Database} ottDb
 * @returns {{ok: boolean, found: string|null}} found is null when the row
 *   (or the ott_meta table itself) is absent.
 */
function checkOttDbVersion(ottDb) {
  let found = null;
  try {
    const row = ottDb.prepare("SELECT value FROM ott_meta WHERE key = 'version'").get();
    found = row ? row.value : null;
  } catch (e) {
    found = null; // e.g. ott_meta doesn't exist at all — treat as absent
  }
  return { ok: found === OTT_RELEASE.version, found };
}

module.exports = { OTT_RELEASE, verifySize, resumeMode, checkOttDbVersion };
