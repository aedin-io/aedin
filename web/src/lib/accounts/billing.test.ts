import { describe, it, expect, beforeEach } from 'vitest';
import Stripe from 'stripe';
import { accountsDb, addUser } from './test/d1-shim';
import { handleEvent, planForPrice, priceIdFor, getSubscription, verifyWebhook } from './billing';
import { balance, debit } from './credits';

const env = {
  STRIPE_SECRET_KEY: 'sk_test_x',
  STRIPE_WEBHOOK_SECRET: 'whsec_test',
  STRIPE_PRICE_RESEARCHER_MONTHLY: 'price_rm',
  STRIPE_PRICE_RESEARCHER_ANNUAL: 'price_ra',
  STRIPE_PRICE_RESEARCHER_MONTHLY_ACADEMIC: 'price_rm_edu',
  STRIPE_PRICE_PRO_MONTHLY: 'price_pm',
  STRIPE_PRICE_TOPUP_1000: 'price_topup',
};
let db: ReturnType<typeof accountsDb>;
let n = 0;
const ev = (type: string, object: any) => ({ id: `evt_${++n}`, type, data: { object } });
const invoice = (id: string, price: string, userId = 'u1') => ({
  id, customer: 'cus_1', lines: { data: [{ amount: 1500, pricing: { price_details: { price } } }] },
  parent: { subscription_details: { subscription: 'sub_1', metadata: { userId } } },
});

beforeEach(() => { db = accountsDb(); addUser(db, 'u1'); });

describe('price mapping', () => {
  it('picks academic prices and falls back to standard', () => {
    expect(priceIdFor(env, 'researcher', 'monthly', true)).toBe('price_rm_edu');
    expect(priceIdFor(env, 'researcher', 'annual', true)).toBe('price_ra');
    expect(priceIdFor(env, 'institutional', 'annual', false)).toBeNull();
    expect(planForPrice(env, 'price_rm_edu')).toEqual({ plan: 'researcher', interval: 'monthly' });
    expect(planForPrice(env, 'price_unknown')).toBeNull();
  });
});

describe('webhook handling', () => {
  it('grants top-up credits once', async () => {
    const e = ev('checkout.session.completed', { id: 'cs_1', mode: 'payment', payment_status: 'paid', metadata: { userId: 'u1', kind: 'topup', credits: '2000' } });
    expect(await handleEvent(env, db, e)).toBe('topup granted');
    expect(await handleEvent(env, db, e)).toBe('duplicate');
    await handleEvent(env, db, { ...e, id: 'evt_other' }); // same session, new event id
    expect(await balance(db, 'u1')).toBe(2000);
  });

  it('grants monthly credits per paid invoice and resets unused ones', async () => {
    await handleEvent(env, db, ev('invoice.paid', invoice('in_1', 'price_rm')));
    expect(await balance(db, 'u1')).toBe(2000);
    expect((await getSubscription(db, 'u1')).plan).toBe('researcher');
    await debit(db, 'u1', 500, 'chat');
    await handleEvent(env, db, ev('invoice.paid', invoice('in_2', 'price_rm')));
    expect(await balance(db, 'u1')).toBe(2000);
  });

  it('gives annual plans twelve months of credits', async () => {
    await handleEvent(env, db, ev('invoice.paid', invoice('in_1', 'price_ra')));
    expect(await balance(db, 'u1')).toBe(24000);
  });

  it('follows portal plan changes and cancellations', async () => {
    await handleEvent(env, db, ev('checkout.session.completed', { id: 'cs_2', mode: 'subscription', customer: 'cus_1', subscription: 'sub_1', metadata: { userId: 'u1' } }));
    await handleEvent(env, db, ev('customer.subscription.updated', {
      id: 'sub_1', customer: 'cus_1', status: 'active', metadata: {},
      items: { data: [{ price: { id: 'price_pm' }, current_period_end: 1893456000 }] },
    }));
    let sub = await getSubscription(db, 'u1');
    expect(sub).toMatchObject({ plan: 'pro', seats: 3, status: 'active', current_period_end: '2030-01-01T00:00:00.000Z' });
    await handleEvent(env, db, ev('invoice.paid', invoice('in_1', 'price_pm')));
    await handleEvent(env, db, ev('customer.subscription.deleted', { id: 'sub_1', customer: 'cus_1', metadata: {} }));
    sub = await getSubscription(db, 'u1');
    expect(sub).toMatchObject({ plan: 'free', status: 'canceled' });
    expect(await balance(db, 'u1')).toBe(0);
  });

  it('acknowledges events for unknown users instead of failing', async () => {
    const out = await handleEvent(env, db, ev('invoice.paid', invoice('in_9', 'price_rm', 'ghost')));
    expect(out).toMatch(/unresolved/);
    expect(await handleEvent(env, db, ev('checkout.session.completed', { id: 'cs_9', mode: 'payment', payment_status: 'paid', metadata: { userId: 'ghost', kind: 'topup' } }))).toMatch(/unknown user/);
  });

  it('verifies Stripe signatures', async () => {
    const payload = JSON.stringify({ id: 'evt_sig', type: 'invoice.paid', data: { object: {} } });
    const header = new Stripe('sk_test_x').webhooks.generateTestHeaderString({ payload, secret: env.STRIPE_WEBHOOK_SECRET });
    expect((await verifyWebhook(env, payload, header)).id).toBe('evt_sig');
    await expect(verifyWebhook({ ...env, STRIPE_WEBHOOK_SECRET: 'whsec_other' }, payload, header)).rejects.toThrow();
    await expect(verifyWebhook(env, payload + ' ', header)).rejects.toThrow();
  });
});
