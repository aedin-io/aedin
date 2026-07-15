import test from 'node:test';
import assert from 'node:assert/strict';
import { siblingGroupKey, siblingMembersByGroup, isListShapedQuote } from './sibling-list.ts';

const mk = (o) => ({ sourceId: 6, category: 'pest_pressure', effectDirection: 'negative', direction: 'out', partnerName: null, partnerSlug: null, partnerCommon: null, ...o });

test('group key ignores partner, splits on source/category/effect/direction', () => {
  assert.equal(siblingGroupKey(mk({ partnerName: 'A' })), siblingGroupKey(mk({ partnerName: 'B' })));
  assert.notEqual(siblingGroupKey(mk({ sourceId: 6 })), siblingGroupKey(mk({ sourceId: 7 })));
  assert.notEqual(siblingGroupKey(mk({ direction: 'out' })), siblingGroupKey(mk({ direction: 'in' })));
  assert.notEqual(siblingGroupKey(mk({ effectDirection: 'negative' })), siblingGroupKey(mk({ effectDirection: 'positive' })));
});

test('siblingMembersByGroup groups + dedups + prefers common name', () => {
  const rows = [
    mk({ partnerName: 'Cucumis sativus', partnerCommon: 'cucumber', partnerSlug: 'cucumis-sativus' }),
    mk({ partnerName: 'Cucurbita pepo', partnerCommon: 'squash', partnerSlug: 'cucurbita-pepo' }),
    mk({ partnerName: 'Cucurbita pepo', partnerCommon: 'squash', partnerSlug: 'cucurbita-pepo' }), // dup
    mk({ partnerName: 'Other', partnerCommon: 'other', partnerSlug: 'other', sourceId: 99 }),       // other group
  ];
  const map = siblingMembersByGroup(rows);
  const members = map.get(siblingGroupKey(rows[0]));
  assert.deepEqual(members.map(m => m.name), ['cucumber', 'squash']);
});

test('isListShapedQuote detects ellipsis, connectors, and 3+ comma lists', () => {
  assert.equal(isListShapedQuote('Host crop: Cucurbits: … bottle gourd'), true);
  assert.equal(isListShapedQuote('major insect pest of cucurbit crops, which include squash'), true);
  assert.equal(isListShapedQuote('flowers, strawberries, raspberries, grapes'), true);
  assert.equal(isListShapedQuote('Pumpkin beetle attacks bottle gourd'), false);
  assert.equal(isListShapedQuote(null), false);
});
