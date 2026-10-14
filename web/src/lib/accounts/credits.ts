// Credit ledger. One currency for API calls, extraction, chat and review
// (prices in plans.ts). The ledger is append-only and balance = SUM(delta).
//
// Monthly plan credits reset each billing period: spending draws from the
// current period's monthly grant first, and at renewal (or cancellation) the
// unused part of it is written off with a 'period_reset' row. Top-up credits
// never expire.
import type { D1Like } from './db';
import { nowIso } from './db';

export type SpendReason = 'extraction' | 'chat' | 'api' | 'review';
export type GrantReason = 'monthly_grant' | 'topup' | 'adjustment';

const isUniqueViolation = (e: unknown) => /UNIQUE constraint failed/i.test(String((e as Error)?.message ?? e));

export async function balance(db: D1Like, userId: string): Promise<number> {
  const row = await db.prepare('SELECT COALESCE(SUM(delta), 0) AS b FROM credit_ledger WHERE user_id = ?')
    .bind(userId).first<{ b: number }>();
  return row?.b ?? 0;
}

/**
 * Atomically spend `amount` credits if the balance covers it. The balance
 * check and the insert are one SQL statement, so concurrent requests can't
 * overspend. With a `ref`, the same charge is applied at most once
 * (a retry returns ok with `duplicate: true`).
 */
export async function debit(
  db: D1Like, userId: string, amount: number, reason: SpendReason, ref: string | null = null,
): Promise<{ ok: boolean; duplicate?: boolean; balance: number }> {
  if (!Number.isInteger(amount) || amount <= 0) throw new Error(`debit: invalid amount ${amount}`);
  try {
    const r = await db.prepare(
      `INSERT INTO credit_ledger (user_id, delta, reason, ref, created_at)
       SELECT ?, ?, ?, ?, ?
        WHERE (SELECT COALESCE(SUM(delta), 0) FROM credit_ledger WHERE user_id = ?) >= ?`,
    ).bind(userId, -amount, reason, ref, nowIso(), userId, amount).run();
    return { ok: (r.meta?.changes ?? 0) === 1, balance: await balance(db, userId) };
  } catch (e) {
    if (ref && isUniqueViolation(e)) return { ok: true, duplicate: true, balance: await balance(db, userId) };
    throw e;
  }
}

/** Add credits. Idempotent per (reason, ref); returns false if already granted. */
export async function grant(
  db: D1Like, userId: string, amount: number, reason: GrantReason, ref: string | null = null,
): Promise<boolean> {
  if (!Number.isInteger(amount) || amount === 0) throw new Error(`grant: invalid amount ${amount}`);
  if (reason !== 'adjustment' && amount < 0) throw new Error('grant: only adjustments may be negative');
  const r = await db.prepare(
    `INSERT OR IGNORE INTO credit_ledger (user_id, delta, reason, ref, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).bind(userId, amount, reason, ref, nowIso()).run();
  return (r.meta?.changes ?? 0) === 1;
}

/**
 * Unused credits left from the latest monthly grant: the grant minus
 * everything spent since it, capped by the current balance (so a negative
 * adjustment can't make us write off top-up credits).
 */
export async function unusedMonthly(db: D1Like, userId: string): Promise<number> {
  const g = await db.prepare(
    `SELECT id, delta FROM credit_ledger WHERE user_id = ? AND reason = 'monthly_grant' ORDER BY id DESC LIMIT 1`,
  ).bind(userId).first<{ id: number; delta: number }>();
  if (!g) return 0;
  const spent = await db.prepare(
    `SELECT COALESCE(-SUM(delta), 0) AS s FROM credit_ledger
      WHERE user_id = ? AND id > ? AND delta < 0 AND reason NOT IN ('period_reset', 'adjustment')`,
  ).bind(userId, g.id).first<{ s: number }>();
  const reset = await db.prepare(
    `SELECT COUNT(*) AS n FROM credit_ledger WHERE user_id = ? AND id > ? AND reason = 'period_reset'`,
  ).bind(userId, g.id).first<{ n: number }>();
  if ((reset?.n ?? 0) > 0) return 0; // already written off
  return Math.max(0, Math.min(await balance(db, userId), g.delta - (spent?.s ?? 0)));
}

/**
 * Start a new billing period: write off unused monthly credits, then grant
 * `amount`. Idempotent per `periodRef` (e.g. Stripe invoice id). Pass amount 0
 * on cancellation to only write off.
 */
export async function renewPeriod(db: D1Like, userId: string, amount: number, periodRef: string): Promise<boolean> {
  const done = await db.prepare(
    `SELECT 1 FROM credit_ledger WHERE user_id = ? AND reason IN ('monthly_grant', 'period_reset') AND ref = ?`,
  ).bind(userId, periodRef).first();
  if (done) return false;
  const leftover = await unusedMonthly(db, userId);
  const now = nowIso();
  const stmts = [];
  if (leftover > 0) {
    stmts.push(db.prepare(`INSERT INTO credit_ledger (user_id, delta, reason, ref, created_at) VALUES (?, ?, 'period_reset', ?, ?)`)
      .bind(userId, -leftover, periodRef, now));
  }
  if (amount > 0) {
    stmts.push(db.prepare(`INSERT INTO credit_ledger (user_id, delta, reason, ref, created_at) VALUES (?, ?, 'monthly_grant', ?, ?)`)
      .bind(userId, amount, periodRef, now));
  }
  if (stmts.length) await db.batch(stmts);
  return true;
}

export async function recentEntries(db: D1Like, userId: string, limit = 20) {
  const r = await db.prepare(
    `SELECT delta, reason, ref, created_at FROM credit_ledger WHERE user_id = ? ORDER BY id DESC LIMIT ?`,
  ).bind(userId, limit).all<{ delta: number; reason: string; ref: string | null; created_at: string }>();
  return r.results ?? [];
}
