import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { mailboxMigrations } from "../workers/durableObject/migrations.ts";
import { FileIndexOutbox } from "../workers/lib/file-index-outbox.ts";
import { FILE_INDEX_SCHEMA, FileIndexStore, FileListQuery, buildFileQuery } from "../workers/lib/file-index.ts";

function database(t) {
	const db = new DatabaseSync(":memory:");
	db.exec("PRAGMA foreign_keys=ON");
	t.after(() => db.close());
	return {
		db,
		sql: { exec(query, ...params) { return db.prepare(query).all(...params); } },
		transactionSync(fn) {
			db.exec("BEGIN");
			try { const result = fn(); db.exec("COMMIT"); return result; }
			catch (error) { db.exec("ROLLBACK"); throw error; }
		},
	};
}

function fixture(t, { legacy = false } = {}) {
	const source = database(t);
	const destination = database(t);
	for (const migration of mailboxMigrations.slice(0, legacy ? -1 : undefined)) source.db.exec(migration.sql);
	destination.db.exec(FILE_INDEX_SCHEMA);
	destination.db.exec("UPDATE file_discovery SET complete=1");
	const outbox = new FileIndexOutbox(source);
	if (!legacy) outbox.initialize("one@example.com");
	return { source, destination, outbox, index: new FileIndexStore(destination) };
}

function insert(source, id, { filename = `${id}.pdf`, disposition = null, subject = "大学录取通知 Offer", date = "2026-10-01T01:00:00.000Z", folder = "inbox" } = {}) {
	source.sql.exec(`INSERT INTO emails(id, folder_id, subject, sender, recipient, date, body, thread_id)
		VALUES(?, ?, ?, 'sender@example.org', 'one@example.com', ?, 'private-body-not-indexed', 'thread-one')`, id, folder, subject, date);
	source.sql.exec("INSERT INTO attachments(id, email_id, filename, mimetype, size, disposition) VALUES(?, ?, ?, 'application/pdf', 123, ?)", `att-${id}`, id, filename, disposition);
}

function drain(outbox, index, limit = 25) {
	let batches = 0;
	do {
		const batch = outbox.nextBatch(limit);
		index.apply(batch);
		outbox.acknowledge(batch);
		assert.ok(++batches < 1000, "backfill must converge");
	} while (outbox.pending());
	return batches;
}

test("legacy backfill is bounded, resumes after restart, excludes inline files, and indexes mappings without bodies", (t) => {
	const { source, destination, outbox, index } = fixture(t, { legacy: true });
	for (let i = 0; i < 83; i++) insert(source, `email-${String(i).padStart(3, "0")}`);
	insert(source, "inline", { disposition: "inline" });
	source.db.exec(mailboxMigrations.at(-1).sql);
	outbox.initialize("one@example.com");
	const first = outbox.nextBatch(7);
	assert.equal(first.changes.length, 7);
	assert.equal(first.complete, false);
	index.apply(first);
	// A crash after the remote commit and before ACK replays the same journal.
	const restarted = new FileIndexOutbox(source);
	const replay = restarted.nextBatch(7);
	assert.deepEqual(replay.changes, first.changes);
	index.apply(replay);
	restarted.acknowledge(replay);
	drain(restarted, index, 7);
	const page = index.list({ limit: 100 });
	assert.equal(page.files.length, 83);
	assert.equal(page.index.state, "ready");
	assert.equal(index.list({ q: "private-body-not-indexed" }).files.length, 0);
	assert.equal(page.files[0].thread_id, "thread-one");
	assert.equal(page.files[0].email_id, page.files[0].id.slice(4));
	assert.equal(destination.sql.exec("SELECT COUNT(*) AS n FROM files_fts")[0].n, 84);
});

test("new arrivals, updates during delivery, lost acknowledgements and late deletes converge", (t) => {
	const { source, outbox, index } = fixture(t);
	insert(source, "mail");
	const original = outbox.nextBatch();
	source.sql.exec("UPDATE emails SET folder_id='archive', subject='Updated subject' WHERE id='mail'");
	index.apply(original);
	outbox.acknowledge(original);
	assert.equal(outbox.pending(), true);
	drain(outbox, index);
	assert.equal(index.list({}).files[0].folder_id, "archive");
	assert.equal(index.list({ q: "Updated" }).files.length, 1);
	assert.equal(index.list({ q: "Offer" }).files.length, 0);
	index.apply(original);
	assert.equal(index.list({}).files[0].folder_id, "archive");
	source.sql.exec("DELETE FROM emails WHERE id='mail'");
	drain(outbox, index);
	index.apply(original);
	assert.deepEqual(index.list({}).files, []);
});

test("attachment changes and folder cascades remove search entries atomically", (t) => {
	const { source, outbox, index } = fixture(t);
	source.sql.exec("INSERT INTO folders(id, name) VALUES('custom', 'Custom')");
	insert(source, "file", { folder: "custom", filename: "original.pdf" });
	drain(outbox, index);
	source.sql.exec("UPDATE attachments SET filename='renamed.pdf' WHERE id='att-file'");
	drain(outbox, index);
	assert.equal(index.list({ q: "original" }).files.length, 0);
	assert.equal(index.list({ q: "renamed" }).files.length, 1);
	source.sql.exec("DELETE FROM folders WHERE id='custom'");
	drain(outbox, index);
	assert.deepEqual(index.list({ q: "renamed" }).files, []);
});

test("deleted mailboxes cannot be resurrected by delayed batches; explicit recreation reindexes", (t) => {
	const { source, outbox, index } = fixture(t);
	insert(source, "file");
	const old = outbox.nextBatch();
	index.apply(old);
	outbox.disable();
	const removed = outbox.nextBatch();
	index.apply(removed);
	index.apply(old);
	assert.deepEqual(index.list({}).files, []);
	outbox.initialize("one@example.com");
	assert.equal(outbox.state().enabled, 0, "background discovery must not reactivate a deleted mailbox");
	outbox.initialize("one@example.com", true);
	drain(outbox, index);
	index.apply(removed);
	assert.equal(index.list({}).files.length, 1);
});

test("mailbox/attachment identity is composite; search supports Unicode, punctuation, case and long text", (t) => {
	const { source, outbox, index } = fixture(t);
	const needles = ["100%", "a_b", '"quoted"', "O'Brien", "path\\file", "%' OR 1=1 --", "大学录取", "中文", "🎉🎉🎉", "[a]*?", "x".repeat(100)];
	for (let i = 0; i < needles.length; i++) insert(source, `m-${i}`, { filename: `${needles[i]}.pdf`, subject: "Subject" });
	insert(source, "decoy", { filename: "1000 aZb.pdf", subject: "Subject" });
	drain(outbox, index);
	for (const needle of needles) assert.equal(index.list({ q: needle }).files.length, 1, needle);
	assert.equal(index.list({ q: "SUBJECT" }).files.length, 12);
	assert.equal(index.list({ q: "sender@example.org" }).files.length, 12);
	const file = index.list({ q: "a_b" }).files[0];
	index.apply({ mailboxId: "two@example.com", generation: 1, enabled: true, through: 1, complete: true,
		changes: [{ revision: 1, emailId: file.email_id, files: [{ ...file, attachment_id: file.id }] }] });
	assert.equal(index.list({ q: "a_b" }).files.length, 2);
	assert.equal(index.list({ q: "a_b" }, "two@example.com").files.length, 1);
	assert.equal(index.list({ direction: "sent" }).files.length, 0);
});

test("keyset pages cover ties exactly once and resist insertions, deletions and wrong-filter cursors", (t) => {
	const { source, outbox, index } = fixture(t);
	for (let i = 0; i < 117; i++) insert(source, `m-${String(i).padStart(3, "0")}`);
	drain(outbox, index);
	let page = index.list({ limit: 10 });
	const seen = page.files.map((f) => f.id);
	const cursor = page.nextCursor;
	insert(source, "new-arrival", { date: "2026-10-24T00:00:00.000Z" });
	source.sql.exec("DELETE FROM emails WHERE id=?", page.files[0].email_id);
	drain(outbox, index);
	while (page.nextCursor) {
		page = index.list({ limit: 10, cursor: page.nextCursor });
		seen.push(...page.files.map((f) => f.id));
	}
	assert.equal(seen.length, 117);
	assert.equal(new Set(seen).size, 117);
	assert.throws(() => index.list({ cursor, q: "pdf" }), /filters/);
	assert.throws(() => index.list({ cursor }, "other@example.com"), /filters/);
	assert.throws(() => index.list({ cursor: "invalid" }), /cursor/);
	assert.equal(index.list({ limit: 1 }).files[0].email_id, "new-arrival");
});

test("index transaction failures preserve previous data and leave the journal retryable", (t) => {
	const { source, outbox, index } = fixture(t);
	insert(source, "mail");
	const batch = outbox.nextBatch();
	index.apply(batch);
	const bad = structuredClone(batch);
	bad.changes[0].revision++;
	bad.changes[0].files[0].email_id = "wrong-email";
	assert.throws(() => index.apply(bad), /mapping mismatch/);
	assert.equal(index.list({}).files.length, 1);
	assert.equal(outbox.pending(), true);
	drain(outbox, index);
	assert.equal(index.list({}).files.length, 1);
});

test("queries use date, mailbox/direction and FTS indexes without OFFSET or loading email bodies", (t) => {
	const { destination } = fixture(t);
	for (const [options, scope, expected] of [
		[{}, undefined, "idx_files_visible_date"], [{}, "one@example.com", "idx_files_visible_mailbox_date"],
		[{ direction: "received" }, undefined, "idx_files_visible_direction_date"],
		[{ direction: "received" }, "one@example.com", "idx_files_visible_mailbox_direction_date"],
		[{ q: "录取通知书" }, undefined, "VIRTUAL TABLE INDEX"],
	]) {
		const { query, params } = buildFileQuery(options, scope);
		const plan = destination.sql.exec(`EXPLAIN QUERY PLAN ${query}`, ...params).map((r) => r.detail).join("\n");
		assert.ok(plan.includes(expected), plan);
		assert.doesNotMatch(query, /OFFSET|\bbody\b/i);
		if (!options.q) assert.doesNotMatch(plan, /USE TEMP B-TREE/);
	}
});

test("file query validation rejects oversized or invalid input", () => {
	for (const options of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { direction: "sql" }, { q: "x".repeat(321) }, { q: "a\0b" }, { cursor: "x".repeat(4097) }]) {
		assert.equal(FileListQuery.safeParse(options).success, false);
	}
});
