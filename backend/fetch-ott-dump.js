#!/usr/bin/env node
'use strict';
/**
 * fetch-ott-dump.js — download and extract the pinned OTT release.
 *
 * Resumable: the 111MB download takes ~10 minutes, so a one-shot request gets
 * killed by tool timeouts. Re-running continues from wherever the file stopped
 * via an HTTP Range request.
 *
 *   node fetch-ott-dump.js            # download (resumes if partial), then extract
 *   node fetch-ott-dump.js --verify   # check an existing download, extract only
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');
const { OTT_RELEASE, verifySize, resumeMode } = require('./lib/ott-release.js');

function sizeOf(p) { try { return fs.statSync(p).size; } catch { return 0; } }

function download() {
  return new Promise((resolve, reject) => {
    const have = sizeOf(OTT_RELEASE.tarballPath);
    if (have >= OTT_RELEASE.bytes) return resolve(have);
    const headers = have > 0 ? { Range: `bytes=${have}-` } : {};
    if (have > 0) console.log(`resuming at ${have} / ${OTT_RELEASE.bytes} bytes`);
    https.get(OTT_RELEASE.url, { headers }, (res) => {
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      // Guard against server ignoring Range header and returning full body.
      // If we have partial bytes and get 200 (not 206), must truncate and restart.
      const mode = resumeMode(res.statusCode, have);
      if (mode === 'restart') {
        console.log(`server ignored Range header; restarting download`);
        // Truncate the file and re-download from the start
        const out = fs.createWriteStream(OTT_RELEASE.tarballPath, { flags: 'w' });
        res.pipe(out);
        out.on('finish', () => resolve(sizeOf(OTT_RELEASE.tarballPath)));
        out.on('error', reject);
      } else {
        // mode === 'append': safe to append (either fresh download or server honored Range)
        const out = fs.createWriteStream(OTT_RELEASE.tarballPath, { flags: 'a' });
        res.pipe(out);
        out.on('finish', () => resolve(sizeOf(OTT_RELEASE.tarballPath)));
        out.on('error', reject);
      }
    }).on('error', reject);
  });
}

(async () => {
  fs.mkdirSync(OTT_RELEASE.dir, { recursive: true });
  const verifyOnly = process.argv.includes('--verify');

  const bytes = verifyOnly ? sizeOf(OTT_RELEASE.tarballPath) : await download();
  const check = verifySize(bytes);
  if (!check.ok) {
    console.error(`FAIL — ${check.reason}`);
    console.error('Re-run to resume the download.');
    process.exit(1);
  }
  console.log(`tarball OK: ${bytes} bytes (OTT ${OTT_RELEASE.version})`);

  execFileSync('tar', ['-xzf', OTT_RELEASE.tarballPath, '-C', OTT_RELEASE.dir,
    `ott${OTT_RELEASE.version}/taxonomy.tsv`, `ott${OTT_RELEASE.version}/synonyms.tsv`,
    `ott${OTT_RELEASE.version}/version.txt`], { stdio: 'inherit' });

  for (const p of [OTT_RELEASE.taxonomyPath, OTT_RELEASE.synonymsPath]) {
    console.log(`  ${path.basename(p)}: ${sizeOf(p)} bytes`);
  }
  console.log('Next: node build-ott-db.js');
})().catch(e => { console.error(e); process.exit(1); });
