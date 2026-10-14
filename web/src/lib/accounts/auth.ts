// Better Auth instance, built per request from the Worker env (bindings and
// secrets only exist inside a request on Cloudflare Pages).
//
// Sign-in: email magic link, Google, Microsoft (personal + school/work, tenant
// "common"). ORCID is link-only (its public API returns no email, which every
// account needs): a signed-in user links their iD from /account, and can then
// sign in with ORCID too. Linking ORCID marks the user academic-verified.
// Providers without credentials in env are simply not offered.
import { betterAuth } from 'better-auth';
import { magicLink } from 'better-auth/plugins/magic-link';
import { genericOAuth } from 'better-auth/plugins/generic-oauth';
import type { D1Like } from './db';
import { isAcademicEmail } from './academic';
import { sendEmail, magicLinkEmail, type MailEnv } from './email';

export interface AuthEnv extends MailEnv {
  ACCOUNTS: D1Like;
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
  GOOGLE_CLIENT_ID?: string; GOOGLE_CLIENT_SECRET?: string;
  MICROSOFT_CLIENT_ID?: string; MICROSOFT_CLIENT_SECRET?: string;
  ORCID_CLIENT_ID?: string; ORCID_CLIENT_SECRET?: string;
  /** Set to "sandbox" to use sandbox.orcid.org while testing. */
  ORCID_ENV?: string;
}

export function enabledProviders(env: Partial<AuthEnv>) {
  return {
    google: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    microsoft: !!(env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET),
    orcid: !!(env.ORCID_CLIENT_ID && env.ORCID_CLIENT_SECRET),
  };
}

async function markAcademic(db: D1Like, userId: string) {
  await db.prepare('UPDATE "user" SET academicVerified = 1 WHERE id = ? AND academicVerified = 0').bind(userId).run();
}

export function createAuth(env: AuthEnv) {
  const on = enabledProviders(env);
  const orcidHost = env.ORCID_ENV === 'sandbox' ? 'https://sandbox.orcid.org' : 'https://orcid.org';
  const db = env.ACCOUNTS;

  return betterAuth({
    appName: 'AEDIN',
    baseURL: env.BETTER_AUTH_URL,
    basePath: '/api/auth',
    secret: env.BETTER_AUTH_SECRET,
    database: db as any, // D1 is detected natively by Better Auth's Kysely adapter
    user: {
      additionalFields: {
        role: { type: 'string', defaultValue: 'user', input: false },
        academicVerified: { type: 'boolean', defaultValue: false, input: false },
      },
    },
    session: { expiresIn: 60 * 60 * 24 * 30, updateAge: 60 * 60 * 24 },
    account: {
      accountLinking: {
        enabled: true,
        // Google only: Microsoft multi-tenant email claims are not verified unless
        // the app requests the verified_primary_email optional claim, and trusting
        // them enables "nOAuth" account takeover. Better Auth still links a
        // Microsoft sign-in to an existing account when it reports the email verified.
        trustedProviders: ['google'],
        // ORCID returns no email, so linking it to a signed-in user needs this.
        // Only an already-authenticated user can link, so it can't take over accounts.
        allowDifferentEmails: true,
      },
    },
    socialProviders: {
      ...(on.google ? { google: { clientId: env.GOOGLE_CLIENT_ID!, clientSecret: env.GOOGLE_CLIENT_SECRET! } } : {}),
      ...(on.microsoft ? {
        microsoft: { clientId: env.MICROSOFT_CLIENT_ID!, clientSecret: env.MICROSOFT_CLIENT_SECRET!, tenantId: 'common' },
      } : {}),
    },
    plugins: [
      magicLink({
        expiresIn: 60 * 10,
        sendMagicLink: async ({ email, url }) => {
          const m = magicLinkEmail(url);
          await sendEmail(env, email, m.subject, m.html, m.text);
        },
      }),
      ...(on.orcid ? [genericOAuth({
        config: [{
          providerId: 'orcid',
          name: 'ORCID',
          clientId: env.ORCID_CLIENT_ID!,
          clientSecret: env.ORCID_CLIENT_SECRET!,
          discoveryUrl: `${orcidHost}/.well-known/openid-configuration`,
          scopes: ['openid'],
          disableSignUp: true, // link-only; see header comment
          mapProfileToUser: (p: any) => ({
            name: [p.given_name, p.family_name].filter(Boolean).join(' ') || p.name || 'ORCID user',
            email: `${p.sub}@orcid.invalid`,
            emailVerified: false,
          }),
        }],
      })] : []),
    ],
    databaseHooks: {
      account: {
        create: {
          after: async (account: { providerId: string; userId: string }) => {
            if (account.providerId === 'orcid') await markAcademic(db, account.userId);
          },
        },
      },
      session: {
        create: {
          // Re-checked at every sign-in, so a user who later verifies a school
          // email (e.g. via magic link) gets picked up.
          after: async (session: { userId: string }) => {
            const u = await db.prepare('SELECT email, emailVerified, academicVerified FROM "user" WHERE id = ?')
              .bind(session.userId).first<{ email: string; emailVerified: number; academicVerified: number }>();
            if (u && !u.academicVerified && u.emailVerified && isAcademicEmail(u.email)) await markAcademic(db, session.userId);
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
