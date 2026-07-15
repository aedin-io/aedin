'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeVarietyName } = require('./variety-normalize');

test('trims whitespace', () => {
  assert.equal(normalizeVarietyName('  Solar Fire  '), 'Solar Fire');
});

test('strips surrounding single quotes (GRIN format)', () => {
  assert.equal(normalizeVarietyName("'Solar Fire'"), 'Solar Fire');
});

test('removes trademark symbols', () => {
  assert.equal(normalizeVarietyName('Solar Fire™'), 'Solar Fire');
  assert.equal(normalizeVarietyName('Solar Fire®'), 'Solar Fire');
  assert.equal(normalizeVarietyName('Solar Fire©'), 'Solar Fire');
});

test('replaces ASCII single quotes with curly right quote', () => {
  const result = normalizeVarietyName("Hill's Resistant");
  const expected = "Hill’s Resistant";
  assert.equal(result, expected);
});

test('collapses internal whitespace', () => {
  assert.equal(normalizeVarietyName('Solar  Fire   F1'), 'Solar Fire F1');
});

test('returns empty string for null/undefined/empty', () => {
  assert.equal(normalizeVarietyName(null), '');
  assert.equal(normalizeVarietyName(undefined), '');
  assert.equal(normalizeVarietyName(''), '');
});

test('idempotent: normalize(normalize(x)) === normalize(x)', () => {
  const input = "  'Solar Fire™'  ";
  assert.equal(normalizeVarietyName(normalizeVarietyName(input)), normalizeVarietyName(input));
});
