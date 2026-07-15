'use strict';
const crypto = require('node:crypto');

function isPdfMagic(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 4 && buf.subarray(0, 4).toString('latin1') === '%PDF';
}
function meetsSizeFloor(buf, floor = 10240) {
  return Buffer.isBuffer(buf) && buf.length >= floor;
}
function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}
function skipDecision({ existsSha, lockSha }) {
  return existsSha && lockSha && existsSha === lockSha ? 'skip' : 'fetch';
}
module.exports = { isPdfMagic, meetsSizeFloor, sha256, skipDecision };
