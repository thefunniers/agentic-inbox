import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const directory = await mkdtemp(join(tmpdir(), 'attachment-do-test-'));
test.after(() => rm(directory, { recursive: true, force: true }));
const compiled = await build({
  entryPoints: ['workers/durableObject/index.ts'], bundle: true, platform: 'node', format: 'esm', write: false,
  plugins: [{ name: 'test-durable-object-base', setup(builder) {
    builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'cloudflare:workers', namespace: 'test' }));
    builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }' }));
  } }],
});
const path = join(directory, 'worker.mjs');
await writeFile(path, compiled.outputFiles[0].text);
const { MailboxDO } = await import(pathToFileURL(path));

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  t.after(() => db.close());
  const cursor = rows => ({
    toArray: () => rows,
    raw: () => ({ toArray: () => rows.map(row => Object.values(row)) }),
    [Symbol.iterator]: () => rows[Symbol.iterator](),
  });
  const storage = {
    sql: { exec(query, ...params) {
      if (!params.length && !/^\s*(SELECT|WITH)\b/i.test(query)) { db.exec(query); return cursor([]); }
      return cursor(db.prepare(query).all(...params));
    } },
    transactionSync(fn) {
      db.exec('BEGIN');
      try { const result = fn(); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  };
  return { mailbox: new MailboxDO({ storage }, {}), db };
}
const email = { id: 'draft', subject: 'Keep me', sender: 'test@example.com', recipient: 'a@example.com', body: 'Original body', date: '2026-10-23T00:00:00Z' };
const attachment = { id: 'file', email_id: 'draft', filename: '附件.pdf', mimetype: 'application/pdf', size: 12, content_id: null, disposition: 'attachment' };

test('draft updates replace attachments atomically and return only old blobs for cleanup', async t => {
  const { mailbox, db } = fixture(t);
  await mailbox.createEmail('draft', email, [attachment]);
  const old = await mailbox.saveDraft({ ...email, subject: 'Updated' }, [{ ...attachment, id: 'new' }]);
  assert.equal(old.length, 1);
  assert.equal(old[0].id, 'file');
  const saved = await mailbox.getEmail(email.id);
  assert.equal(saved.subject, 'Updated');
  assert.equal(saved.attachments[0].id, 'new');
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM emails').get().total, 1);
  await mailbox.saveDraft(email, []);
  assert.equal((await mailbox.getEmail(email.id)).attachments.length, 0);
});

test('failed attachment insertion rolls back new messages and restores overwritten drafts', async t => {
  const { mailbox, db } = fixture(t);
  await mailbox.createEmail('draft', email, [attachment]);
  const invalid = [{ ...attachment, id: 'duplicate' }, { ...attachment, id: 'duplicate' }];
  await assert.rejects(mailbox.saveDraft({ ...email, subject: 'Must roll back' }, invalid));
  assert.equal((await mailbox.getEmail(email.id)).subject, email.subject);
  assert.equal((await mailbox.getEmail(email.id)).attachments[0].id, 'file');
  await assert.rejects(mailbox.createEmail('sent', { ...email, id: 'sent' }, invalid.map(file => ({ ...file, email_id: 'sent' }))));
  assert.equal(await mailbox.getEmail('sent'), null);
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM attachments').get().total, 1);
});

test('draft save cannot overwrite received or sent email', async t => {
  const { mailbox } = fixture(t);
  await mailbox.createEmail('inbox', email, [attachment]);
  await assert.rejects(mailbox.saveDraft({ ...email, subject: 'Do not replace' }, []), /Only drafts/);
  assert.equal((await mailbox.getEmail(email.id)).folder_id, 'inbox');
  assert.equal((await mailbox.getEmail(email.id)).attachments.length, 1);
});
