'use strict';

/**
 * Cost-guard for LLM dispatch loops.
 *
 * The Pass-10 incident: a recoverable-looking error fired against every row,
 * each row burned its 4-attempt retry budget, and the outer concurrency mapper
 * kept dispatching new rows. ~1000 rows × 4 attempts × parallel workers =
 * ~$80 burned in 10 seconds.
 *
 * This module is the durable fix. Wire it into any script that calls the
 * Anthropic API in a loop. Three layered protections:
 *
 *   1. Pre-flight estimate + confirm: before any LLM call, print "N rows ×
 *      ~T tokens × $model = estimated $X. Press Enter to proceed or --yes
 *      to bypass." Hard-aborts if estimate exceeds --max-spend.
 *
 *   2. Hard spend ceiling: accumulates real input+output token cost from each
 *      successful response and aborts the run when it crosses --max-spend
 *      (default $2). A runaway can't exceed the ceiling no matter what.
 *
 *   3. Cascading-failure circuit breaker: aborts after N consecutive failures
 *      (default 5). Catches auth errors, bad-request errors, and any other
 *      systemic failure that would otherwise burn the retry budget on every
 *      row before failing.
 *
 * Plus a fourth protection that doesn't need module state:
 *
 *   4. Error-class filter: isNonRetryable(err) returns true for HTTP 400/401/
 *      403/404/422 and Anthropic SDK Authentication/BadRequest/PermissionDenied/
 *      NotFound error names. Callers should check this BEFORE retrying. A
 *      malformed prompt or bad API key fails 4 times under the original retry
 *      logic; with this check, it fails once.
 *
 * Subscription-mode dispatch (Agent tool, no API spend) can use mode='sub'
 * to get only the circuit breaker — the spend ceiling becomes a no-op.
 *
 * Usage:
 *   const { parseFlags, preflightConfirm, createBudgetGuard, isNonRetryable } = require('./lib/cost-guard');
 *   const flags = parseFlags(process.argv.slice(2));
 *   await preflightConfirm({ rowCount: workItems.length, model: 'claude-haiku-4-5-20251001', flags });
 *   const guard = createBudgetGuard({ ...flags, mode: 'api' });
 *
 *   // inside dispatch loop:
 *   for (const w of workItems) {
 *     guard.checkBeforeCall();  // throws if ceiling crossed or circuit broken
 *     try {
 *       const resp = await client.messages.create(...);
 *       guard.recordSuccess(resp.model, resp.usage.input_tokens, resp.usage.output_tokens);
 *     } catch (e) {
 *       guard.recordFailure();
 *       if (isNonRetryable(e)) throw e;  // skip retries on auth/bad-request
 *       // ...retry logic...
 *     }
 *   }
 *   console.log('[cost-guard] final report:', guard.getReport());
 */

// Anthropic pricing per 1M tokens as of 2026-05.
// If a model isn't listed, we fall back to Sonnet-tier (more conservative
// for the estimate, errs on the side of overestimating cost).
const TOKEN_PRICES_USD_PER_M = {
  'claude-haiku-4-5-20251001':    { input: 1.00,  output: 5.00 },
  'claude-haiku-4-5':              { input: 1.00,  output: 5.00 },
  'claude-sonnet-4-6':             { input: 3.00,  output: 15.00 },
  'claude-sonnet-4-5':             { input: 3.00,  output: 15.00 },
  'claude-opus-4-7':               { input: 15.00, output: 75.00 },
  'claude-opus-4-6':               { input: 15.00, output: 75.00 },
  default:                         { input: 3.00,  output: 15.00 },
};

function tokenCostUSD(model, inputTokens, outputTokens) {
  const p = TOKEN_PRICES_USD_PER_M[model] || TOKEN_PRICES_USD_PER_M.default;
  return ((inputTokens || 0) * p.input + (outputTokens || 0) * p.output) / 1_000_000;
}

function parseFlags(argv) {
  function flag(name, def) {
    const a = argv.find(s => s.startsWith(`--${name}=`));
    return a ? a.split('=', 2)[1] : def;
  }
  return {
    maxSpend: parseFloat(flag('max-spend', '2')),
    maxConsecutiveFailures: parseInt(flag('max-consecutive-failures', '5'), 10),
    estPerRowTokens: parseInt(flag('est-per-row-tokens', '4000'), 10),
    yes: argv.includes('--yes'),
  };
}

const NON_RETRYABLE_STATUSES = new Set([400, 401, 403, 404, 422]);

function isNonRetryable(err) {
  if (!err) return false;
  if (typeof err.status === 'number' && NON_RETRYABLE_STATUSES.has(err.status)) return true;
  const name = err.name || err.constructor?.name || '';
  if (name.includes('Authentication') || name.includes('BadRequest')
      || name.includes('PermissionDenied') || name.includes('NotFound')) {
    return true;
  }
  return false;
}

/**
 * Print a pre-flight estimate and (unless --yes) wait for the user to press
 * Enter. Hard-aborts the process if the estimate exceeds maxSpend so the user
 * can't accidentally proceed with a too-large run.
 *
 * estPerRowTokens is split 70/30 input/output, which roughly matches our
 * vouch + critic prompt shape (long input, short JSON output).
 */
async function preflightConfirm({ rowCount, model, flags }) {
  const { maxSpend, estPerRowTokens, yes } = flags;
  const estInput = rowCount * estPerRowTokens * 0.7;
  const estOutput = rowCount * estPerRowTokens * 0.3;
  const estCost = tokenCostUSD(model, estInput, estOutput);
  console.log('[cost-guard] dispatch plan:');
  console.log(`[cost-guard]   rows:    ${rowCount}`);
  console.log(`[cost-guard]   model:   ${model}`);
  console.log(`[cost-guard]   tokens:  ~${estPerRowTokens} per row (split 70/30 in/out)`);
  console.log(`[cost-guard]   estimated spend: $${estCost.toFixed(4)}`);
  console.log(`[cost-guard]   hard ceiling:    $${maxSpend.toFixed(2)} (--max-spend to override)`);
  if (estCost > maxSpend) {
    console.error(`[cost-guard] ABORT: estimate $${estCost.toFixed(4)} exceeds ceiling $${maxSpend.toFixed(2)}.`);
    console.error(`[cost-guard] Re-run with --max-spend=${Math.ceil(estCost * 1.5)} if intentional.`);
    process.exit(1);
  }
  if (yes) {
    console.log('[cost-guard] --yes passed; skipping confirm prompt.');
    return;
  }
  if (!process.stdin.isTTY) {
    console.error('[cost-guard] ABORT: stdin is not a TTY and --yes was not passed. Refusing to dispatch.');
    process.exit(1);
  }
  process.stdout.write('[cost-guard] Press Enter to proceed, Ctrl-C to abort > ');
  await new Promise(resolve => {
    process.stdin.resume();
    process.stdin.once('data', () => { process.stdin.pause(); resolve(); });
  });
}

/**
 * Create a stateful guard. Call checkBeforeCall() before each LLM dispatch,
 * recordSuccess/recordFailure after. The guard throws a fatal error when
 * either the spend ceiling or the consecutive-failure ceiling is crossed —
 * the calling script should let that propagate to top-level so the whole
 * run aborts.
 *
 * mode='api' tracks spend; mode='sub' (subscription) skips spend tracking
 * but keeps the circuit breaker.
 */
function createBudgetGuard({ maxSpend, maxConsecutiveFailures, mode = 'api' }) {
  let consecutiveFailures = 0;
  let cumulativeCostUSD = 0;
  let totalSuccesses = 0;
  let totalFailures = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  return {
    checkBeforeCall() {
      if (mode === 'api' && cumulativeCostUSD >= maxSpend) {
        const e = new Error(
          `[cost-guard] HARD SPEND CEILING REACHED: $${cumulativeCostUSD.toFixed(4)} >= $${maxSpend.toFixed(2)}. ` +
          `Aborting run. (totalSuccesses=${totalSuccesses}, totalFailures=${totalFailures})`
        );
        e.fatal = true;
        throw e;
      }
      if (consecutiveFailures >= maxConsecutiveFailures) {
        const e = new Error(
          `[cost-guard] CIRCUIT BREAKER: ${consecutiveFailures} consecutive failures ` +
          `(threshold=${maxConsecutiveFailures}). Aborting run. ` +
          `(totalSuccesses=${totalSuccesses}, totalFailures=${totalFailures})`
        );
        e.fatal = true;
        throw e;
      }
    },
    recordSuccess(model, inputTokens, outputTokens) {
      totalInputTokens += inputTokens || 0;
      totalOutputTokens += outputTokens || 0;
      if (mode === 'api') {
        cumulativeCostUSD += tokenCostUSD(model, inputTokens, outputTokens);
      }
      consecutiveFailures = 0;
      totalSuccesses++;
    },
    recordFailure() {
      consecutiveFailures++;
      totalFailures++;
    },
    isNonRetryable,
    getReport() {
      return {
        mode,
        cumulativeCostUSD: Number(cumulativeCostUSD.toFixed(4)),
        totalSuccesses,
        totalFailures,
        consecutiveFailures,
        totalInputTokens,
        totalOutputTokens,
        maxSpend,
        maxConsecutiveFailures,
      };
    },
  };
}

/**
 * isFatalGuardError(e) — true if a thrown error came from the guard (so the
 * outer concurrency mapper knows to short-circuit instead of catching it as
 * a per-row error).
 */
function isFatalGuardError(e) {
  return Boolean(e && e.fatal);
}

module.exports = {
  parseFlags,
  preflightConfirm,
  createBudgetGuard,
  tokenCostUSD,
  isNonRetryable,
  isFatalGuardError,
};
