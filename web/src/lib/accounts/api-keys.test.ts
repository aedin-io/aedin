import { describe, it, expect, beforeEach } from 'vitest';
import { accountsDb, addUser } from './test/d1-shim';
import { createKey, listKeys, revokeKey, verifyKey } from './api-keys';
import { isAcademicEmail } from './academic';

let db: ReturnType<typeof accountsDb>;
beforeEach(() => { db = accountsDb(); addUser(db, 'u1'); });

describe('api keys', () => {
  it('creates, verifies and revokes; stores only a hash', async () => {
    const { key, prefix } = await createKey(db, 'u1', 'laptop');
    expect(key).toMatch(/^aedin_[0-9a-f]{40}$/);
    expect(key.startsWith(prefix)).toBe(true);
    expect(JSON.stringify(db.raw.prepare('SELECT * FROM api_key').all())).not.toContain(key);
    expect(await verifyKey(db, key)).toBe('u1');
    const [k] = await listKeys(db, 'u1');
    expect(k.last_used_at).not.toBeNull();
    expect(await revokeKey(db, 'u1', k.id)).toBe(true);
    expect(await verifyKey(db, key)).toBeNull();
  });

  it('rejects malformed and other users\' keys', async () => {
    addUser(db, 'u2', 'b@example.org');
    const { key } = await createKey(db, 'u1', 'x');
    expect(await verifyKey(db, 'aedin_nope')).toBeNull();
    const [k] = await listKeys(db, 'u1');
    expect(await revokeKey(db, 'u2', k.id)).toBe(false);
    expect(await verifyKey(db, key)).toBe('u1');
  });
});

describe('isAcademicEmail', () => {
  it.each([
    ['x@uog.edu', true], ['x@mail.harvard.edu', true], ['x@ox.ac.uk', true],
    ['x@unimelb.edu.au', true], ['x@wur.nl', true], ['x@sub.cgiar.org', true],
    ['x@gmail.com', false], ['x@edu.example.com', false], ['x@education.com', false], ['bad', false],
  ])('%s → %s', (email, expected) => expect(isAcademicEmail(email)).toBe(expected));
});
