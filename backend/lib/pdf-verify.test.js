'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isPdfMagic, meetsSizeFloor, sha256, skipDecision } = require('./pdf-verify');

test('PDF magic detected', () => {
  assert.equal(isPdfMagic(Buffer.from('%PDF-1.7\n...')), true);
});
test('HTML placeholder rejected', () => {
  assert.equal(isPdfMagic(Buffer.from('<!DOCTYPE html>')), false);
});
test('size floor: under floor fails', () => {
  assert.equal(meetsSizeFloor(Buffer.alloc(100), 10240), false);
});
test('size floor: at floor passes', () => {
  assert.equal(meetsSizeFloor(Buffer.alloc(10240), 10240), true);
});
test('sha256 is stable hex', () => {
  assert.equal(sha256(Buffer.from('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
test('skip when on-disk hash matches lock', () => {
  assert.equal(skipDecision({ existsSha: 'aa', lockSha: 'aa' }), 'skip');
});
test('fetch when hash differs', () => {
  assert.equal(skipDecision({ existsSha: 'aa', lockSha: 'bb' }), 'fetch');
});
test('fetch when no on-disk file', () => {
  assert.equal(skipDecision({ existsSha: null, lockSha: 'bb' }), 'fetch');
});
