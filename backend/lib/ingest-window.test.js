'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isWithinWindow, msUntilWindowStart, walQuiescent } = require('./ingest-window');

const at = (h) => new Date(2026, 5, 19, h, 0, 0); // local-time constructor

test('21:00 is within 20-06 window', () => { assert.equal(isWithinWindow(at(21)), true); });
test('05:00 is within (wraps midnight)', () => { assert.equal(isWithinWindow(at(5)), true); });
test('20:00 boundary is inside', () => { assert.equal(isWithinWindow(at(20)), true); });
test('06:00 boundary is outside', () => { assert.equal(isWithinWindow(at(6)), false); });
test('12:00 is outside', () => { assert.equal(isWithinWindow(at(12)), false); });
test('msUntilWindowStart at 18:00 is 2h', () => {
  assert.equal(msUntilWindowStart(at(18)), 2 * 3600 * 1000);
});
test('msUntilWindowStart inside window is 0', () => {
  assert.equal(msUntilWindowStart(at(22)), 0);
});
test('msUntilWindowStart at 06:00 (just outside) is 14h', () => {
  assert.equal(msUntilWindowStart(at(6)), 14 * 3600 * 1000);
});

test('walQuiescent: missing WAL means no writer', () => {
  assert.equal(walQuiescent('/no/such/file-wal', Date.now()), true);
});
test('walQuiescent: fresh WAL mtime means busy', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const p = path.join(os.tmpdir(), `wal-test-${process.pid}.wal`);
  fs.writeFileSync(p, 'x');
  const now = fs.statSync(p).mtimeMs + 1000; // 1s after mtime
  assert.equal(walQuiescent(p, now, 120000), false);
  fs.unlinkSync(p);
});
test('walQuiescent: stale WAL mtime means quiescent', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const p = path.join(os.tmpdir(), `wal-test2-${process.pid}.wal`);
  fs.writeFileSync(p, 'x');
  const now = fs.statSync(p).mtimeMs + 200000; // 200s after mtime
  assert.equal(walQuiescent(p, now, 120000), true);
  fs.unlinkSync(p);
});
