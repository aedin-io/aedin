import { describe, it, expect, beforeEach } from 'vitest';
import { accountsDb, addUser } from './test/d1-shim';
import { balance, debit, grant, renewPeriod, unusedMonthly } from './credits';

let db: ReturnType<typeof accountsDb>;
beforeEach(() => { db = accountsDb(); addUser(db, 'u1'); });

describe('credits', () => {
  it('debits only when the balance covers it', async () => {
    await grant(db, 'u1', 100, 'topup', 'cs_1');
    expect((await debit(db, 'u1', 60, 'chat')).ok).toBe(true);
    const r = await debit(db, 'u1', 60, 'chat');
    expect(r.ok).toBe(false);
    expect(r.balance).toBe(40);
  });

  it('is idempotent on grant and debit refs', async () => {
    expect(await grant(db, 'u1', 100, 'topup', 'cs_1')).toBe(true);
    expect(await grant(db, 'u1', 100, 'topup', 'cs_1')).toBe(false);
    expect((await debit(db, 'u1', 30, 'extraction', 'job-9')).ok).toBe(true);
    const again = await debit(db, 'u1', 30, 'extraction', 'job-9');
    expect(again).toMatchObject({ ok: true, duplicate: true, balance: 70 });
  });

  it('rejects non-positive debits', async () => {
    await expect(debit(db, 'u1', 0, 'chat')).rejects.toThrow();
  });

  it('resets unused monthly credits at renewal but keeps top-ups', async () => {
    await renewPeriod(db, 'u1', 2000, 'in_1');
    await grant(db, 'u1', 1000, 'topup', 'cs_1');
    await debit(db, 'u1', 500, 'chat');
    expect(await unusedMonthly(db, 'u1')).toBe(1500);
    await renewPeriod(db, 'u1', 2000, 'in_2');
    expect(await balance(db, 'u1')).toBe(3000); // 1000 top-up + fresh 2000
  });

  it('spending past the monthly grant eats into top-ups, which then survive renewal', async () => {
    await renewPeriod(db, 'u1', 2000, 'in_1');
    await grant(db, 'u1', 1000, 'topup', 'cs_1');
    await debit(db, 'u1', 2500, 'extraction');
    expect(await unusedMonthly(db, 'u1')).toBe(0);
    await renewPeriod(db, 'u1', 2000, 'in_2');
    expect(await balance(db, 'u1')).toBe(2500);
  });

  it('renewal is idempotent per period and cancellation only writes off', async () => {
    await renewPeriod(db, 'u1', 2000, 'in_1');
    expect(await renewPeriod(db, 'u1', 2000, 'in_1')).toBe(false);
    expect(await balance(db, 'u1')).toBe(2000);
    await renewPeriod(db, 'u1', 0, 'cancel:sub_1');
    expect(await balance(db, 'u1')).toBe(0);
  });
});
