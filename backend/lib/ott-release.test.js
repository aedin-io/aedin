'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { OTT_RELEASE, verifySize, checkOttDbVersion } = require('./ott-release.js');

test('the release is pinned to 3.7, never "current"', () => {
  assert.equal(OTT_RELEASE.version, '3.7');
  assert.match(OTT_RELEASE.url, /ott3\.7\/ott3\.7\.tgz$/);
  assert.doesNotMatch(OTT_RELEASE.url, /current/);
  assert.equal(OTT_RELEASE.bytes, 111219034);
});

test('verifySize accepts the exact byte count and rejects anything else', () => {
  assert.deepEqual(verifySize(111219034), { ok: true });
  assert.equal(verifySize(111219033).ok, false);
  assert.match(verifySize(49364992).reason, /incomplete/i);
  assert.match(verifySize(999999999).reason, /larger/i);
});

test('resumeMode: 206 with partial bytes → append (server honored Range)', () => {
  const { resumeMode } = require('./ott-release.js');
  assert.equal(resumeMode(206, 50000), 'append');
});

test('resumeMode: 200 with partial bytes → restart (server ignored Range, must truncate)', () => {
  const { resumeMode } = require('./ott-release.js');
  assert.equal(resumeMode(200, 50000), 'restart');
});

test('resumeMode: 200 with zero bytes → append (fresh download)', () => {
  const { resumeMode } = require('./ott-release.js');
  assert.equal(resumeMode(200, 0), 'append');
});

test('resumeMode: 206 with zero bytes → append (edge case, but valid)', () => {
  const { resumeMode } = require('./ott-release.js');
  assert.equal(resumeMode(206, 0), 'append');
});

test('checkOttDbVersion: matching version → ok', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE ott_meta (key TEXT PRIMARY KEY, value TEXT);`);
  db.prepare('INSERT INTO ott_meta (key, value) VALUES (?, ?)').run('version', OTT_RELEASE.version);
  const v = checkOttDbVersion(db);
  assert.equal(v.ok, true);
  assert.equal(v.found, OTT_RELEASE.version);
});

test('checkOttDbVersion: mismatched version → not ok, reports what was found', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE ott_meta (key TEXT PRIMARY KEY, value TEXT);`);
  db.prepare('INSERT INTO ott_meta (key, value) VALUES (?, ?)').run('version', '3.6');
  const v = checkOttDbVersion(db);
  assert.equal(v.ok, false);
  assert.equal(v.found, '3.6');
});

test('checkOttDbVersion: no version row → not ok, found is null (incomplete-load signal)', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE ott_meta (key TEXT PRIMARY KEY, value TEXT);`);
  const v = checkOttDbVersion(db);
  assert.equal(v.ok, false);
  assert.equal(v.found, null);
});

test('checkOttDbVersion: ott_meta table entirely absent (stale/foreign sqlite) → not ok, no throw', () => {
  const db = new Database(':memory:');
  const v = checkOttDbVersion(db);
  assert.equal(v.ok, false);
  assert.equal(v.found, null);
});
