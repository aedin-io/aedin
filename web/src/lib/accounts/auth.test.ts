// Drives Better Auth end to end against d1/accounts.sql through the D1 shim,
// proving the hand-written schema matches what Better Auth reads and writes.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { accountsDb } from './test/d1-shim';
import { createAuth, enabledProviders } from './auth';

const BASE = 'http://localhost:3000';
let db: ReturnType<typeof accountsDb>;
let mail: string[];

beforeEach(() => {
  db = accountsDb();
  mail = [];
  vi.spyOn(console, 'log').mockImplementation((m: unknown) => { mail.push(String(m)); });
});

function auth() {
  return createAuth({ ACCOUNTS: db, BETTER_AUTH_SECRET: 'test-secret-test-secret-test-secret', BETTER_AUTH_URL: BASE });
}

async function signInByMagicLink(email: string) {
  const a = auth();
  const res = await a.handler(new Request(`${BASE}/api/auth/sign-in/magic-link`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: BASE },
    body: JSON.stringify({ email, callbackURL: '/account' }),
  }));
  expect(res.status).toBe(200);
  const link = mail.join('\n').match(/https?:\/\/\S+verify\S+/)?.[0];
  expect(link).toBeTruthy();
  const verify = await a.handler(new Request(link!, { headers: { origin: BASE } }));
  expect([200, 302]).toContain(verify.status);
  const cookie = verify.headers.get('set-cookie') ?? '';
  expect(cookie).toContain('session_token');
  return { a, cookie: cookie.split(';')[0] };
}

describe('auth (Better Auth on the accounts schema)', () => {
  it('magic link creates a verified user and a usable session', async () => {
    const { a, cookie } = await signInByMagicLink('grower@example.org');
    const session = await a.api.getSession({ headers: new Headers({ cookie }) });
    expect(session?.user.email).toBe('grower@example.org');
    expect(session?.user.emailVerified).toBe(true);
    expect((session?.user as any).role).toBe('user');
    expect((session?.user as any).academicVerified).toBe(false);
  });

  it('marks academic emails verified on sign-in', async () => {
    const { a, cookie } = await signInByMagicLink('prof@uog.edu');
    const row = db.raw.prepare('SELECT academicVerified FROM "user" WHERE email = ?').get('prof@uog.edu') as any;
    expect(row.academicVerified).toBe(1);
    const session = await a.api.getSession({ headers: new Headers({ cookie }) });
    expect(session?.user.id).toBeTruthy();
  });

  it('only offers providers that have credentials', () => {
    expect(enabledProviders({ GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'y' })).toEqual({ google: true, microsoft: false, orcid: false });
  });
});
