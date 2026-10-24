import assert from "node:assert/strict";
import test from "node:test";
import { buildSync } from "esbuild";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  base64ToBytes, bytesToBase64, getAttachmentLimitError, getAttachmentUrl,
  isValidBase64, rewriteInlineImages, sanitizeFilename,
} from "../shared/attachments.ts";

const compiled = buildSync({
  stdin: { contents: `export { app, receiveEmail } from './workers/index.ts';
    export { readComposeAttachment, storedComposeAttachments } from './app/lib/compose-attachments.ts';`, resolveDir: process.cwd() },
  bundle: true, platform: "node", format: "esm", write: false, logLevel: "silent",
});
const directory = await mkdtemp(join(tmpdir(), 'attachment-api-test-'));
test.after(() => rm(directory, { recursive: true, force: true }));
const workerPath = join(directory, 'worker.mjs');
await writeFile(workerPath, compiled.outputFiles[0].text);
const { app, receiveEmail, readComposeAttachment, storedComposeAttachments } = await import(pathToFileURL(workerPath));
const address = "test@example.com";
const base = `/api/v1/mailboxes/${address}`;
const pdfBytes = Buffer.from([0, 255, 37, 80, 68, 70, 13, 10, 128]);
const pdf = { filename: "申请材料.pdf", type: "application/pdf", content: pdfBytes.toString("base64"), disposition: "attachment" };
const png = { filename: "图片.png", type: "image/png", disposition: "inline", contentId: "<logo@example.com>", content: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=" };
const message = { to: "recipient@example.net", from: address, subject: "Attachments", text: "Attached" };

function fixture(options = {}) {
  const objects = new Map([[`mailboxes/${address}.json`, Buffer.from('{}')]]);
  const emails = new Map();
  const sent = [];
  const pending = [];
  let writes = 0;
  const bucket = {
    async put(key, content) {
      if (key.startsWith('attachments/') && ++writes === options.failWrite) throw new Error('R2 unavailable');
      objects.set(key, Buffer.from(content));
      return {};
    },
    async get(key) {
      const bytes = objects.get(key);
      if (!bytes) return null;
      return { size: bytes.length, body: new Blob([bytes]).stream(), arrayBuffer: async () => Uint8Array.from(bytes).buffer, json: async () => JSON.parse(bytes.toString()) };
    },
    async head(key) { return objects.has(key) ? { size: objects.get(key).length } : null; },
    async delete(keys) { for (const key of [keys].flat()) objects.delete(key); },
  };
  const stub = {
    async ensureFileIndex() {},
    async getEmail(id) { return emails.get(id) || null; },
    async getAttachment(id) { return [...emails.values()].flatMap(email => email.attachments).find(file => file.id === id) || null; },
    async getFolders() { return []; },
    async findThreadBySubject() { return null; },
    async markThreadRead() {},
    async checkSendRateLimit() { return null; },
    async createEmail(folder, email, attachments) {
      if (options.failDatabase) throw new Error('Database unavailable');
      emails.set(email.id, { ...email, folder_id: folder, attachments });
    },
    async saveDraft(email, attachments) {
      const old = emails.get(email.id)?.attachments || [];
      await this.createEmail('draft', email, attachments);
      return old;
    },
    async deleteEmail(id) {
      const email = emails.get(id);
      emails.delete(id);
      return email?.attachments || null;
    },
  };
  const env = { BUCKET: bucket, DOMAINS: 'example.com', EMAIL_ADDRESSES: [],
    MAILBOX: { idFromName: name => name, get: () => stub },
    EMAIL_AGENT: { idFromName: name => name, get: () => ({ fetch: async () => new Response('ok') }) },
    EMAIL: { async send(data) {
      if (options.gate) await options.gate;
      if (options.failSend) throw new Error('Delivery rejected');
      sent.push(data);
      return { messageId: 'provider-id' };
    } },
  };
  const ctx = { waitUntil: promise => pending.push(promise) };
  return {
    objects, emails, sent, env, ctx, options, stub,
    async flush() { await Promise.all(pending); },
    async request(path, data, method = 'POST') {
      return app.request(`${base}${path}`, { method, ...(data ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) } : {}) }, env, ctx);
    },
    async draft(attachments = [pdf]) {
      const response = await this.request('/drafts', { to: message.to, subject: message.subject, body: 'Draft', attachments });
      assert.equal(response.status, 201);
      return response.json();
    },
  };
}

function attachmentKeys(f) { return [...f.objects.keys()].filter(key => key.startsWith('attachments/')); }

function mimeMessage() {
  return Buffer.from([
    'From: sender@example.net', `To: ${address}`, 'Subject: Incoming attachments',
    'Message-ID: <incoming@example.net>', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="parts"', '',
    '--parts', 'Content-Type: text/html; charset=utf-8', '', '<p>Files</p><img src="cid:logo@example.com">',
    '--parts', 'Content-Type: application/pdf', `Content-Disposition: attachment; filename*=UTF-8''${encodeURIComponent(pdf.filename)}`,
    'Content-Transfer-Encoding: base64', '', pdf.content,
    '--parts', 'Content-Type: image/png', 'Content-Disposition: inline; filename="logo.png"', 'Content-ID: <logo@example.com>',
    'Content-Transfer-Encoding: base64', '', png.content,
    '--parts', 'Content-Type: application/octet-stream', 'Content-Disposition: attachment; filename="empty.bin"',
    'Content-Transfer-Encoding: base64', '', '', '--parts--', '',
  ].join('\r\n'));
}

async function receive(f) {
  const raw = mimeMessage();
  await receiveEmail({ raw: new Blob([raw]).stream(), rawSize: raw.length, to: address, from: 'sender@example.net' }, f.env, f.ctx);
  await f.flush();
  return [...f.emails.values()][0];
}

test('binary conversion preserves all byte values, large files and empty files', async () => {
  const bytes = Uint8Array.from({ length: 100000 }, (_, i) => i % 256);
  assert.deepEqual(base64ToBytes(bytesToBase64(bytes)), bytes);
  assert.equal(bytesToBase64(new Uint8Array()), '');
  const file = await readComposeAttachment(new File([bytes], '未知文件', { type: '' }));
  assert.equal(file.input.type, 'application/octet-stream');
  assert.deepEqual(base64ToBytes(file.input.content), bytes);
});

test('limits include MIME encoding, body size and count; malformed base64 is rejected', () => {
  assert.equal(getAttachmentLimitError([{ size: 3 * 1024 * 1024 }]), null);
  assert.match(getAttachmentLimitError([{ size: 4 * 1024 * 1024 }]), /5 MiB/);
  assert.match(getAttachmentLimitError([], { html: 'a'.repeat(4 * 1024 * 1024) }), /5 MiB/);
  assert.match(getAttachmentLimitError(Array.from({ length: 33 }, () => ({ size: 0 }))), /32/);
  for (const value of ['a', '====', '%%!!', 'data:image/png;base64,AAAA']) assert.equal(isValidBase64(value), false);
  for (const value of ['', 'AA==', 'AQI=', 'AQID']) assert.equal(isValidBase64(value), true);
  assert.doesNotThrow(() => encodeURIComponent(sanitizeFilename('😀'.repeat(200))));
});

test('CID rewriting handles default disposition, percent encoding and exact IDs', () => {
  const files = [{ id: '1', content_id: '<logo@example.com>' }, { id: '2', content_id: 'logo@example.com.extra' }];
  const result = rewriteInlineImages('<img src="cid:logo%40example.com"><img src="CID:logo@example.com.extra"><img src="cid:missing">', address, 'mail', files);
  assert.equal(result, `<img src="${getAttachmentUrl(address, 'mail', '1')}"><img src="${getAttachmentUrl(address, 'mail', '2')}"><img src="cid:missing">`);
});

test('receive MIME, store binary attachments and download Unicode names and empty files', async () => {
  const f = fixture();
  const incoming = await receive(f);
  assert.equal(incoming.folder_id, 'inbox');
  assert.equal(incoming.attachments.length, 3);
  const file = incoming.attachments.find(file => file.filename === pdf.filename);
  assert.equal(file.size, pdfBytes.length);
  const response = await f.request(`/emails/${incoming.id}/attachments/${file.id}`, null, 'GET');
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), pdfBytes);
  assert.match(response.headers.get('content-disposition'), /filename\*=UTF-8''%E7%94%B3/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(incoming.attachments.find(file => file.filename === 'empty.bin').size, 0);
  const image = incoming.attachments.find(file => file.mimetype === 'image/png');
  const preview = await f.request(`/emails/${incoming.id}/attachments/${image.id}`, null, 'GET');
  assert.match(preview.headers.get('content-disposition'), /^inline;/);
  const download = await f.request(`/emails/${incoming.id}/attachments/${image.id}?download=1`, null, 'GET');
  assert.match(download.headers.get('content-disposition'), /^attachment;/);
});

test('new mail delivers and archives the same binary attachments, including attachment-only mail', async () => {
  const f = fixture();
  const response = await f.request('/emails', { ...message, text: '', attachments: [pdf, png, { ...pdf, filename: 'empty.bin', content: '' }] });
  assert.equal(response.status, 202);
  const email = f.emails.get((await response.json()).id);
  assert.equal(email.folder_id, 'sent');
  assert.equal(email.attachments.length, 3);
  assert.deepEqual(Buffer.from(f.sent[0].attachments[0].content), pdfBytes);
  assert.equal(f.sent[0].attachments[1].contentId, 'logo@example.com');
  assert.equal(f.sent[0].text, ' ');
});

test('provider receives original attachment bytes for Unicode, binary, images and empty files', async () => {
  const f = fixture();
  const originals = [
    Buffer.from('附件中文内容\nUTF-8 ✓', 'utf8'),
    Buffer.from(Array.from({ length: 256 }, (_, index) => index)),
    Buffer.from(png.content, 'base64'),
    Buffer.alloc(0),
  ];
  const response = await f.request('/emails', {
    ...message,
    attachments: originals.map((bytes, index) => ({ ...pdf, filename: `file-${index}`, content: bytes.toString('base64') })),
  });
  assert.equal(response.status, 202);
  const email = f.emails.get((await response.json()).id);
  for (const [index, original] of originals.entries()) {
    const deliveredBytes = Buffer.from(f.sent[0].attachments[index].content);
    assert.deepEqual(deliveredBytes, original);
    const file = email.attachments[index];
    const download = await f.request(`/emails/${email.id}/attachments/${file.id}`, null, 'GET');
    assert.deepEqual(deliveredBytes, Buffer.from(await download.arrayBuffer()));
  }
});

test('draft saves retain one ID, preserve attachments, remove files and clean replaced blobs', async () => {
  const f = fixture();
  const first = await f.draft([pdf, png]);
  const refs = storedComposeAttachments(first.id, first.attachments).map(file => file.input);
  const secondResponse = await f.request('/drafts', { draft_id: first.id, body: 'Edited', attachments: refs });
  assert.equal(secondResponse.status, 201);
  const second = await secondResponse.json();
  await f.flush();
  assert.equal(second.id, first.id);
  assert.equal(f.emails.size, 1);
  assert.equal(attachmentKeys(f).length, 2);
  const third = await f.request('/drafts', { draft_id: second.id, body: 'No files', attachments: [] });
  assert.equal(third.status, 201);
  await f.flush();
  assert.equal(attachmentKeys(f).length, 0);
});

for (const route of ['/emails', '/emails/original/reply', '/emails/original/forward']) {
  test(`${route} can send stored files without reuploading bytes`, async () => {
    const f = fixture();
    const draft = await f.draft([pdf, png]);
    f.emails.set('original', { id: 'original', folder_id: 'inbox', message_id: 'original@example.net', thread_id: 'original', attachments: [] });
    const refs = storedComposeAttachments(draft.id, draft.attachments, route.endsWith('forward')).map(file => file.input);
    const response = await f.request(route, { ...message, attachments: refs });
    assert.equal(response.status, 202);
    assert.deepEqual(Buffer.from(f.sent[0].attachments[0].content), pdfBytes);
    if (route.endsWith('forward')) assert.ok(f.sent[0].attachments.every(file => file.disposition === 'attachment'));
    await f.request(`/emails/${draft.id}`, null, 'DELETE');
    const sent = f.emails.get((await response.json()).id);
    const download = await f.request(`/emails/${sent.id}/attachments/${sent.attachments[0].id}`, null, 'GET');
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), pdfBytes);
  });
}

test('invalid, oversized and excessive attachments fail without sending or storing', async () => {
  for (const attachments of [[{ ...pdf, content: 'not base64!' }], Array.from({ length: 33 }, () => pdf), [{ ...pdf, content: Buffer.alloc(4 * 1024 * 1024).toString('base64') }]]) {
    const f = fixture();
    const response = await f.request('/emails', { ...message, attachments });
    assert.ok([400, 413].includes(response.status));
    assert.equal(f.sent.length, 0);
    assert.equal(f.emails.size, 0);
    assert.equal(attachmentKeys(f).length, 0);
  }
});

test('references cannot read a different email, mailbox, or a missing blob', async () => {
  const f = fixture();
  const draft = await f.draft();
  const file = draft.attachments[0];
  assert.equal((await f.request(`/emails/wrong/attachments/${file.id}`, null, 'GET')).status, 404);
  for (const ref of [{ emailId: 'wrong', attachmentId: file.id }, { emailId: draft.id, attachmentId: 'other-mailbox-file' }]) {
    assert.equal((await f.request('/emails', { ...message, attachments: [ref] })).status, 404);
  }
  f.objects.delete(attachmentKeys(f)[0]);
  assert.equal((await f.request('/emails', { ...message, attachments: [{ emailId: draft.id, attachmentId: file.id }] })).status, 404);
  assert.equal(f.sent.length, 0);
});

for (const route of ['/emails', '/emails/original/reply', '/emails/original/forward']) {
  test(`${route} reports provider failure, retains the draft and removes failed sent attachments`, async () => {
    const f = fixture({ failSend: true });
    const draft = await f.draft();
    f.emails.set('original', { id: 'original', folder_id: 'inbox', message_id: 'original@example.net', attachments: [] });
    const response = await f.request(route, { ...message, attachments: [{ emailId: draft.id, attachmentId: draft.attachments[0].id }] });
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /not sent/);
    assert.equal(f.emails.size, 2);
    assert.equal(f.emails.get(draft.id).attachments.length, 1);
    assert.equal(attachmentKeys(f).length, 1);
  });
}

test('send success waits for the email provider acknowledgment', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ gate });
  let completed = false;
  const response = f.request('/emails', { ...message, attachments: [pdf] }).then(value => { completed = true; return value; });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(completed, false);
  release();
  assert.equal((await response).status, 202);
});

test('R2 and database errors clean partial writes and preserve the previous draft', async () => {
  for (const options of [{ failWrite: 2 }, { failDatabase: true }]) {
    const f = fixture(options);
    const response = await f.request('/emails', { ...message, attachments: [pdf, png] });
    assert.equal(response.status, 500);
    assert.equal(attachmentKeys(f).length, 0);
    assert.equal(f.sent.length, 0);
  }
  const f = fixture();
  const draft = await f.draft();
  f.options.failDatabase = true;
  const response = await f.request('/drafts', { draft_id: draft.id, body: 'Replacement', attachments: [png] });
  assert.equal(response.status, 500);
  assert.equal(f.emails.get(draft.id).attachments[0].filename, pdf.filename);
  assert.equal(attachmentKeys(f).length, 1);
});

test('incoming storage failure rolls back partial attachment objects', async () => {
  const f = fixture({ failWrite: 2 });
  await assert.rejects(receive(f), /R2 unavailable/);
  assert.equal(f.emails.size, 0);
  assert.equal(attachmentKeys(f).length, 0);
});

test('active attachment types are forced to download even when labeled inline', async () => {
  const f = fixture();
  const draft = await f.draft([{ ...pdf, type: 'text/html', filename: 'file.html', disposition: 'inline' }]);
  const response = await f.request(`/emails/${draft.id}/attachments/${draft.attachments[0].id}`, null, 'GET');
  assert.match(response.headers.get('content-disposition'), /^attachment;/);
  assert.match(response.headers.get('content-security-policy'), /sandbox/);
});

test('omitting attachments when updating a draft preserves files; an empty array removes them', async () => {
  const f = fixture();
  const draft = await f.draft();
  const response = await f.request('/drafts', { draft_id: draft.id, body: 'Text-only edit' });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).attachments.length, 1);
  await f.flush();
  assert.equal(attachmentKeys(f).length, 1);
});

test('forward API includes source attachments by default and honors an explicit empty selection', async () => {
  const f = fixture();
  const source = await f.draft([pdf, png]);
  const defaultResponse = await f.request(`/emails/${source.id}/forward`, message);
  assert.equal(defaultResponse.status, 202);
  assert.equal(f.sent[0].attachments.length, 2);
  const emptyResponse = await f.request(`/emails/${source.id}/forward`, { ...message, attachments: [] });
  assert.equal(emptyResponse.status, 202);
  assert.equal(f.sent[1].attachments, undefined);
});
