// better-sqlite3 → D1 shim for unit tests (same prepare/bind/first/all/run/batch shape).
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { D1Like, D1Statement } from '../db';

class Stmt implements D1Statement {
  constructor(private db: Database.Database, private sql: string, private params: unknown[] = []) {}
  bind(...values: unknown[]) { return new Stmt(this.db, this.sql, values); }
  private p() { return this.params.map(v => (typeof v === 'boolean' ? (v ? 1 : 0) : v)); }
  async first<T>() { return (this.db.prepare(this.sql).get(...this.p()) as T) ?? null; }
  async all<T>() { return this.exec<T>(); }
  async run() {
    const r = this.db.prepare(this.sql).run(...this.p());
    return { meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } };
  }
  // D1's all() accepts writes too and always returns meta (Better Auth relies on this).
  exec<T>() {
    const st = this.db.prepare(this.sql);
    if (st.reader) return { results: st.all(...this.p()) as T[], meta: { changes: 0 } };
    const r = st.run(...this.p());
    return { results: [] as T[], meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } };
  }
}

export function accountsDb(): D1Like & { raw: Database.Database; exec(sql: string): Promise<void> } {
  const raw = new Database(':memory:');
  raw.pragma('foreign_keys = ON'); // D1 enforces foreign keys
  raw.exec(readFileSync(fileURLToPath(new URL('../../../../d1/accounts.sql', import.meta.url)), 'utf8'));
  return {
    raw,
    prepare: (sql: string) => new Stmt(raw, sql),
    async exec(sql: string) { raw.exec(sql); },
    async batch(stmts: D1Statement[]) {
      const tx = raw.transaction(() => stmts.map(s => (s as Stmt).exec()));
      return tx();
    },
  };
}

export function addUser(db: { raw: Database.Database }, id = 'u1', email = 'a@example.org') {
  const now = new Date().toISOString();
  db.raw.prepare(`INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)`)
    .run(id, 'Test', email, now, now);
  return id;
}
