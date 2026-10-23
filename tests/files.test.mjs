import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const directory = await mkdtemp(join(tmpdir(), "files-test-"));
test.after(() => rm(directory, { recursive: true, force: true }));
const compiled = await build({
	stdin: { contents: `export { app } from './workers/index.ts';
		export { MailboxDO } from './workers/durableObject/index.ts';
		export { mailboxMigrations } from './workers/durableObject/migrations.ts';
		export { listGlobalFiles } from './workers/lib/global-files.ts';
		export { getFilePreviewKind } from './shared/files.ts';`, resolveDir: process.cwd() },
	bundle: true, platform: "node", format: "esm", write: false,
	plugins: [{ name: "test-durable-object-base", setup(builder) {
		builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "cloudflare:workers", namespace: "test" }));
		builder.onLoad({ filter: /.*/, namespace: "test" }, () => ({ contents: "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" }));
	} }],
});
const path = join(directory, "worker.mjs");
await writeFile(path, compiled.outputFiles[0].text);
const { app, MailboxDO, mailboxMigrations, listGlobalFiles, getFilePreviewKind } = await import(pathToFileURL(path));
const defaults = { page: 1, limit: 25, q: "", direction: "all", includeInline: false };

function fixture(t) {
	const mailboxes = new Map();
	const blobs = new Map();
	const env = {
		BUCKET: {
			async list() { return { objects: [...mailboxes.keys()].map((id) => ({ key: `mailboxes/${id}.json` })), truncated: false }; },
			async head(key) { return mailboxes.has(key.slice(10, -5)) ? {} : null; },
			async get(key) { const blob = blobs.get(key); return blob ? { body: blob.stream(), size: blob.size } : null; },
		},
		MAILBOX: { idFromName: (id) => id, get: (id) => mailboxes.get(id) },
	};
	return {
		env, mailboxes, blobs,
		mailbox(id) {
			const db = new DatabaseSync(":memory:");
			db.exec("PRAGMA foreign_keys = ON");
			t.after(() => db.close());
			const cursor = (rows) => ({ toArray: () => rows, raw: () => ({ toArray: () => rows.map((row) => Object.values(row)) }), [Symbol.iterator]: () => rows[Symbol.iterator]() });
			const storage = {
				sql: { exec(query, ...params) {
					if (!params.length && !/^\s*(SELECT|WITH)\b/i.test(query)) { db.exec(query); return cursor([]); }
					return cursor(db.prepare(query).all(...params));
				} },
				transactionSync(fn) {
					db.exec("BEGIN");
					try { const result = fn(); db.exec("COMMIT"); return result; }
					catch (error) { db.exec("ROLLBACK"); throw error; }
				},
			};
			const mailbox = new MailboxDO({ storage }, {});
			mailboxes.set(id, mailbox);
			return mailbox;
		},
		request(path) { return app.request(path, { method: "GET" }, env); },
	};
}

async function add(mailbox, id, { folder = "inbox", sender = "sender@example.net", filename = "材料.pdf", date = "2026-10-23T10:00:00Z", disposition = "attachment", subject = "申请材料", attachments = 1, recipient = "test@example.com", mimetype = "application/pdf" } = {}) {
	await mailbox.createEmail(folder, { id, subject, sender, recipient, date, body: "Private body not needed for listing" },
		Array.from({ length: attachments }, (_, i) => ({ id: `${id}-${i}`, email_id: id, filename, mimetype, size: 42, disposition, content_id: null })));
}

test("mailbox files include archived mail, filter direction after moves and exclude drafts, trash and inline images", async (t) => {
	const f = fixture(t);
	const mailbox = f.mailbox("test@example.com");
	await add(mailbox, "received");
	await add(mailbox, "archived-sent", { folder: "sent", sender: "Me <TEST@example.com>", attachments: 2 });
	await mailbox.moveEmail("archived-sent", "archive");
	await add(mailbox, "lookalike", { folder: "archive", sender: "nottest@example.com" });
	await add(mailbox, "draft", { folder: "draft" });
	await add(mailbox, "deleted", { folder: "trash" });
	await add(mailbox, "inline", { disposition: "inline" });
	const all = await (await f.request("/api/v1/mailboxes/test@example.com/files")).json();
	assert.equal(all.totalCount, 4);
	assert.equal(all.files.some((file) => "body" in file), false);
	assert.equal((await mailbox.listFiles("test@example.com", { ...defaults, direction: "sent" })).totalCount, 2);
	assert.equal((await mailbox.listFiles("test@example.com", { ...defaults, direction: "received" })).totalCount, 2);
	assert.equal((await mailbox.listFiles("test@example.com", { ...defaults, includeInline: true })).totalCount, 5);
});

test("self-addressed received mail and sent mail retain original directions after folder moves", async (t) => {
	const f = fixture(t);
	const mailbox = f.mailbox("test@example.com");
	await add(mailbox, "self-received", { sender: "test@example.com" });
	await mailbox.moveEmail("self-received", "sent");
	await add(mailbox, "sent-to-inbox", { sender: "test@example.com", folder: "sent" });
	await mailbox.moveEmail("sent-to-inbox", "inbox");
	assert.deepEqual((await mailbox.listFiles("test@example.com", { ...defaults, direction: "received" })).files.map(file => file.email_id), ["self-received"]);
	assert.deepEqual((await mailbox.listFiles("test@example.com", { ...defaults, direction: "sent" })).files.map(file => file.email_id), ["sent-to-inbox"]);
	// Pre-migration archive rows have no original direction. Keep exact-address
	// inference so they remain available under the appropriate historical filter.
	mailbox.ctx.storage.sql.exec("UPDATE emails SET folder_id = 'archive', direction = NULL, sender = 'Me <TEST@example.com>' WHERE id = 'sent-to-inbox'");
	assert.equal((await mailbox.listFiles("test@example.com", { ...defaults, direction: "sent" })).totalCount, 1);
});

test("direction migration preserves historical message and attachment data", (t) => {
	const db = new DatabaseSync(":memory:");
	t.after(() => db.close());
	for (const migration of mailboxMigrations.slice(0, -1)) db.exec(migration.sql);
	for (const folder of ["inbox", "sent", "archive", "draft", "trash"]) {
		db.prepare("INSERT INTO emails (id, folder_id, subject, body) VALUES (?, ?, ?, ?)").run(folder, folder, "original", "unchanged");
	}
	db.prepare("INSERT INTO attachments (id, email_id, filename, mimetype, size) VALUES ('file', 'inbox', 'original.txt', 'text/plain', 42)").run();
	db.exec(mailboxMigrations.at(-1).sql);
	assert.deepEqual(db.prepare("SELECT id, direction FROM emails ORDER BY id").all().map(row => [row.id, row.direction]), [
		["archive", null], ["draft", null], ["inbox", "received"], ["sent", "sent"], ["trash", null],
	]);
	assert.equal(db.prepare("SELECT COUNT(*) AS count FROM emails WHERE subject = 'original' AND body = 'unchanged'").get().count, 5);
	assert.equal(db.prepare("SELECT size FROM attachments WHERE id = 'file'").get().size, 42);
});

test("file search handles Unicode, long names, literal wildcard characters, subjects and participants", async (t) => {
	const f = fixture(t);
	const mailbox = f.mailbox("test@example.com");
	const filename = "录取材料_100%_' OR 1=1 --".repeat(5);
	await add(mailbox, "match", { filename, subject: "Admission offer", recipient: "Contact@example.net" });
	await add(mailbox, "other", { filename: "录取材料X1000.pdf" });
	for (const q of [filename, "100%", "_", "' OR 1=1 --", "admission", "CONTACT@EXAMPLE.NET"]) {
		const result = await mailbox.listFiles("test@example.com", { ...defaults, q });
		assert.deepEqual(result.files.map((file) => file.email_id), ["match"]);
	}
});

test("global pagination merges entire mailbox pages, handles equal IDs and dates and clamps stale pages", async (t) => {
	const f = fixture(t);
	for (const address of ["b@example.com", "a@example.com", "empty@example.com"]) {
		const mailbox = f.mailbox(address);
		if (address.startsWith("empty")) continue;
		for (let i = 0; i < 34; i++) await add(mailbox, `id-${String(i).padStart(2, "0")}`, { date: `2026-10-${i < 26 ? "23" : "22"}T10:00:00Z` });
	}
	const all = [];
	for (let page = 1; page <= 3; page++) {
		const response = await f.request(`/api/v1/files?page=${page}`);
		assert.equal(response.status, 200);
		const data = await response.json();
		assert.equal(data.totalCount, 68);
		assert.equal(data.mailboxCount, 3);
		assert.equal(data.page, page);
		all.push(...data.files);
	}
	assert.equal(new Set(all.map((file) => `${file.mailboxId}/${file.id}`)).size, 68);
	assert.equal(all[0].mailboxId, "a@example.com");
	assert.equal(all[0].id, "id-25-0");
	assert.equal(all[25].mailboxId, "a@example.com");
	assert.equal(all[26].mailboxId, "b@example.com");
	assert.ok(all.every((file, i) => i === 0 || all[i - 1].date >= file.date));
	const stale = await (await f.request("/api/v1/files?page=999999999999")).json();
	assert.equal(stale.page, 3);
	assert.deepEqual(stale.files, all.slice(50));
});

test("global mailbox filter is exact, combined filters apply before totals and missing mailboxes fail closed", async (t) => {
	const f = fixture(t);
	const a = f.mailbox("test@example.com");
	const b = f.mailbox("test@dev.example.com");
	await add(a, "sent", { folder: "sent", filename: "target.txt" });
	await add(a, "received", { filename: "target.txt" });
	await add(b, "sent", { folder: "sent", filename: "target.txt" });
	const response = await f.request("/api/v1/files?mailbox=TEST%40example.com&direction=sent&q=target");
	assert.equal(response.status, 200);
	const data = await response.json();
	assert.equal(data.totalCount, 1);
	assert.equal(data.files[0].mailboxId, "test@example.com");
	assert.equal((await f.request("/api/v1/files?mailbox=missing@example.com")).status, 404);
	assert.equal((await f.request("/api/v1/mailboxes/missing@example.com/files")).status, 404);
	for (const query of ["page=0", "page=NaN", "limit=101", "direction=garbage", "includeInline=yes", "mailbox=not-an-address", `q=${"x".repeat(321)}`]) {
		assert.equal((await f.request(`/api/v1/files?${query}`)).status, 400, query);
	}
});

test("empty global view returns an empty first page; a failed mailbox never appears as a complete partial result", async (t) => {
	const f = fixture(t);
	const empty = await (await f.request("/api/v1/files?page=40")).json();
	assert.deepEqual(empty, { files: [], totalCount: 0, totalPages: 1, page: 1, limit: 25, mailboxCount: 0 });
	await add(f.mailbox("good@example.com"), "file");
	f.mailboxes.set("failed@example.com", { async listFiles() { throw new Error("Unavailable"); } });
	assert.equal((await f.request("/api/v1/files")).status, 503);
});

test("global listing covers more than 1000 mailboxes and bounds concurrent DO requests", async () => {
	let active = 0;
	let peak = 0;
	const seen = new Set();
	const result = await listGlobalFiles({
		BUCKET: { async list({ cursor }) {
			const start = cursor ? 1000 : 0;
			const end = cursor ? 1003 : 1000;
			return { objects: Array.from({ length: end - start }, (_, i) => ({ key: `mailboxes/${start + i}@example.com.json` })), truncated: !cursor, cursor: cursor ? undefined : "next" };
		} },
		MAILBOX: { idFromName: (name) => name, get: (id) => ({ async listFiles() {
			seen.add(id);
			peak = Math.max(peak, ++active);
			await new Promise((resolve) => setImmediate(resolve));
			active--;
			return { files: id === "1002@example.com" ? [{ id: "last", email_id: "email", date: "2026-10-23" }] : [], totalCount: id === "1002@example.com" ? 1 : 0, totalPages: 1, page: 1, limit: 25 };
		} }) },
	}, defaults);
	assert.equal(seen.size, 1003);
	assert.ok(peak <= 6 && peak > 1);
	assert.equal(result.files[0].mailboxId, "1002@example.com");
});

test("global preview and download use the owning mailbox and enforce email ownership", async (t) => {
	const f = fixture(t);
	await add(f.mailbox("a@example.com"), "a");
	f.mailbox("b@example.com");
	f.blobs.set("attachments/a/a-0/材料.pdf", new Blob(["PDF bytes"]));
	assert.equal((await f.request("/api/v1/mailboxes/a@example.com/emails/a/attachments/a-0?download=1")).status, 200);
	assert.equal((await f.request("/api/v1/mailboxes/b@example.com/emails/a/attachments/a-0")).status, 404);
	assert.equal((await f.request("/api/v1/mailboxes/a@example.com/emails/wrong/attachments/a-0")).status, 404);
});

test("preview types allow images, PDFs and escaped text, with download fallback for executable formats", () => {
	assert.equal(getFilePreviewKind("image/png"), "image");
	assert.equal(getFilePreviewKind("application/pdf"), "pdf");
	assert.equal(getFilePreviewKind("text/html; charset=utf-8"), "text");
	assert.equal(getFilePreviewKind("application/json"), "text");
	for (const type of ["image/svg+xml", "application/javascript", "application/octet-stream", "application/zip"]) assert.equal(getFilePreviewKind(type), null);
});
