'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  parseFlags,
  createBudgetGuard,
  tokenCostUSD,
  isNonRetryable,
  isFatalGuardError,
} = require('./cost-guard');

test('parseFlags returns documented defaults when no flags passed', () => {
  const f = parseFlags([]);
  assert.equal(f.maxSpend, 2);
  assert.equal(f.maxConsecutiveFailures, 5);
  assert.equal(f.estPerRowTokens, 4000);
  assert.equal(f.yes, false);
});

test('parseFlags honors --max-spend, --max-consecutive-failures, --yes, --est-per-row-tokens', () => {
  const f = parseFlags(['--max-spend=10', '--max-consecutive-failures=3', '--yes', '--est-per-row-tokens=90000']);
  assert.equal(f.maxSpend, 10);
  assert.equal(f.maxConsecutiveFailures, 3);
  assert.equal(f.yes, true);
  assert.equal(f.estPerRowTokens, 90000);
});

test('tokenCostUSD uses Haiku pricing for haiku model', () => {
  // claude-haiku-4-5: $1/M input, $5/M output
  // 1M input + 1M output = $6
  const cost = tokenCostUSD('claude-haiku-4-5-20251001', 1_000_000, 1_000_000);
  assert.equal(cost, 6.0);
});

test('tokenCostUSD uses Sonnet pricing for sonnet model', () => {
  // $3/M input + $15/M output, 100K + 100K = 0.3 + 1.5 = $1.80
  const cost = tokenCostUSD('claude-sonnet-4-6', 100_000, 100_000);
  assert.equal(Number(cost.toFixed(4)), 1.8);
});

test('tokenCostUSD falls back to default (Sonnet-tier) for unknown model', () => {
  const known = tokenCostUSD('claude-sonnet-4-6', 100_000, 100_000);
  const unknown = tokenCostUSD('claude-future-model-9000', 100_000, 100_000);
  assert.equal(known, unknown);
});

test('isNonRetryable returns true for HTTP 400/401/403/404/422', () => {
  for (const status of [400, 401, 403, 404, 422]) {
    assert.equal(isNonRetryable({ status }), true, `status ${status} should be non-retryable`);
  }
});

test('isNonRetryable returns false for HTTP 429/500/503/network', () => {
  for (const status of [429, 500, 502, 503, 504]) {
    assert.equal(isNonRetryable({ status }), false, `status ${status} should retry`);
  }
  assert.equal(isNonRetryable({}), false);
  assert.equal(isNonRetryable(null), false);
});

test('isNonRetryable detects Anthropic SDK error class names', () => {
  assert.equal(isNonRetryable({ name: 'AuthenticationError' }), true);
  assert.equal(isNonRetryable({ name: 'BadRequestError' }), true);
  assert.equal(isNonRetryable({ name: 'PermissionDeniedError' }), true);
  assert.equal(isNonRetryable({ name: 'NotFoundError' }), true);
  assert.equal(isNonRetryable({ name: 'RateLimitError' }), false);
  assert.equal(isNonRetryable({ name: 'InternalServerError' }), false);
});

test('createBudgetGuard: hard spend ceiling trips when cumulative cost crosses maxSpend', () => {
  const guard = createBudgetGuard({ maxSpend: 0.10, maxConsecutiveFailures: 5, mode: 'api' });

  // First call is fine: no spend yet
  assert.doesNotThrow(() => guard.checkBeforeCall());

  // Record a success that pushes us under the ceiling
  guard.recordSuccess('claude-haiku-4-5-20251001', 10_000, 10_000); // 10K*$1/M + 10K*$5/M = $0.01 + $0.05 = $0.06
  assert.doesNotThrow(() => guard.checkBeforeCall(), 'should not trip at $0.06 under $0.10 ceiling');

  // Push spend over the ceiling
  guard.recordSuccess('claude-haiku-4-5-20251001', 10_000, 10_000); // total now $0.12

  let thrown;
  try { guard.checkBeforeCall(); } catch (e) { thrown = e; }
  assert.ok(thrown, 'should have thrown');
  assert.ok(isFatalGuardError(thrown), 'error must be a fatal guard error');
  assert.match(thrown.message, /HARD SPEND CEILING/);
});

test('createBudgetGuard: circuit breaker trips after maxConsecutiveFailures', () => {
  const guard = createBudgetGuard({ maxSpend: 100, maxConsecutiveFailures: 3, mode: 'api' });

  guard.recordFailure();
  guard.recordFailure();
  assert.doesNotThrow(() => guard.checkBeforeCall(), '2 failures should not trip threshold=3');

  guard.recordFailure();
  let thrown;
  try { guard.checkBeforeCall(); } catch (e) { thrown = e; }
  assert.ok(thrown, '3 failures should trip');
  assert.ok(isFatalGuardError(thrown));
  assert.match(thrown.message, /CIRCUIT BREAKER/);
});

test('createBudgetGuard: success resets the consecutive-failure counter', () => {
  const guard = createBudgetGuard({ maxSpend: 100, maxConsecutiveFailures: 3, mode: 'api' });

  guard.recordFailure();
  guard.recordFailure();
  guard.recordSuccess('claude-haiku-4-5-20251001', 100, 100); // resets to 0
  guard.recordFailure();
  guard.recordFailure();
  assert.doesNotThrow(() => guard.checkBeforeCall(), 'success in middle should reset counter');
});

test('createBudgetGuard mode="sub" ignores spend ceiling (subscription mode)', () => {
  const guard = createBudgetGuard({ maxSpend: 0.001, maxConsecutiveFailures: 5, mode: 'sub' });

  // Even huge token counts shouldn't trip the ceiling in sub mode
  guard.recordSuccess('claude-opus-4-7', 10_000_000, 10_000_000);
  assert.doesNotThrow(() => guard.checkBeforeCall(), 'subscription mode skips spend tracking');

  // But the circuit breaker still works
  for (let i = 0; i < 5; i++) guard.recordFailure();
  assert.throws(() => guard.checkBeforeCall(), /CIRCUIT BREAKER/);
});

test('createBudgetGuard.getReport returns accurate snapshot', () => {
  const guard = createBudgetGuard({ maxSpend: 1, maxConsecutiveFailures: 5, mode: 'api' });
  guard.recordSuccess('claude-haiku-4-5-20251001', 1000, 500);
  guard.recordSuccess('claude-haiku-4-5-20251001', 2000, 1000);
  guard.recordFailure();
  const r = guard.getReport();
  assert.equal(r.totalSuccesses, 2);
  assert.equal(r.totalFailures, 1);
  assert.equal(r.consecutiveFailures, 1);
  assert.equal(r.totalInputTokens, 3000);
  assert.equal(r.totalOutputTokens, 1500);
  // 3000*$1/M + 1500*$5/M = $0.003 + $0.0075 = $0.0105
  assert.equal(Number(r.cumulativeCostUSD.toFixed(6)), 0.0105);
});

test('isFatalGuardError discriminates guard errors from generic errors', () => {
  assert.equal(isFatalGuardError(new Error('random thing')), false);
  const guard = createBudgetGuard({ maxSpend: 0, maxConsecutiveFailures: 5, mode: 'api' });
  guard.recordSuccess('claude-haiku-4-5-20251001', 1000, 1000); // pushes over $0 ceiling
  try { guard.checkBeforeCall(); }
  catch (e) { assert.equal(isFatalGuardError(e), true); return; }
  assert.fail('should have thrown');
});
