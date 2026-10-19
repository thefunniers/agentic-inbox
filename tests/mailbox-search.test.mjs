import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { mailboxMigrations } from "../workers/durableObject/migrations.ts";
import { buildSearchConditions } from "../workers/lib/search.ts";

function fixture(t) {
	const db = new DatabaseSync(":memory:");
	t.after(() => db.close());
	for (const migration of mailboxMigrations) db.exec(migration.sql);
	return db;
}

function insert(db, overrides) {
	const row = { id: "email", folder_id: "inbox", subject: "Subject", body: "Body", sender: "sender@example.com",
		recipient: "recipient@example.com", cc: null, bcc: null, date: "2026-10-20T10:00:00.000Z", read: 0, starred: 0, ...overrides };
	db.prepare(`INSERT INTO emails (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
}

function bindings(params) {
	return Object.fromEntries(params.map((value, i) => [String(i + 1), value]));
}

function search(db, options, { limit = 100, offset = 0 } = {}) {
	const { conditions, params } = buildSearchConditions({ query: "", ...options }, "e");
	const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
	const rows = db.prepare(`SELECT e.id FROM emails e ${where} ORDER BY e.date DESC LIMIT ?${params.length + 1} OFFSET ?${params.length + 2}`)
		.all(bindings([...params, limit, offset]));
	const count = buildSearchConditions({ query: "", ...options });
	const countWhere = count.conditions.length ? `WHERE ${count.conditions.join(" AND ")}` : "";
	const { total } = db.prepare(`SELECT COUNT(*) AS total FROM emails ${countWhere}`).get(bindings(count.params));
	return { ids: rows.map(row => row.id), total };
}

for (const [label, needle] of [
	["48 ASCII bytes", "A".repeat(48)], ["49 ASCII bytes", "B".repeat(49)],
	["500 ASCII bytes", "abcdeABCDE".repeat(50)], ["long Chinese", "大学申请录取通知".repeat(10)],
	["multibyte emoji", "🎉".repeat(30)],
]) {
	test(`all text filters accept ${label}`, t => {
		const db = fixture(t);
		for (const field of ["subject", "body", "sender", "recipient", "cc", "bcc"]) {
			insert(db, { id: field, [field]: `prefix ${needle} suffix` });
		}
		insert(db, { id: "unrelated" });
		assert.equal(search(db, { query: needle }).total, 6);
		assert.deepEqual(search(db, { subject: needle }), { ids: ["subject"], total: 1 });
		assert.deepEqual(search(db, { from: needle }), { ids: ["sender"], total: 1 });
		assert.deepEqual(search(db, { to: needle }).ids.sort(), ["bcc", "cc", "recipient"]);
	});
}

test("search uses literal percent, underscore, quotes and backslashes", t => {
	const db = fixture(t);
	const needles = ["100%", "a_b", "O'Brien", '"quoted"', "path\\file", "%' OR 1=1 --"];
	for (const [index, needle] of needles.entries()) insert(db, { id: String(index), subject: needle });
	insert(db, { id: "wildcard-decoy", subject: "1000 aZb" });
	for (const [index, needle] of needles.entries()) {
		assert.deepEqual(search(db, { subject: needle }), { ids: [String(index)], total: 1 });
	}
});

test("ASCII case-insensitive matching and null recipients retain expected behavior", t => {
	const db = fixture(t);
	insert(db, { id: "match", subject: "Admission OFFER", cc: null, bcc: null });
	assert.deepEqual(search(db, { query: "admission offer" }), { ids: ["match"], total: 1 });
	assert.deepEqual(search(db, { to: "RECIPIENT@EXAMPLE.COM" }), { ids: ["match"], total: 1 });
	assert.deepEqual(search(db, { to: "missing" }), { ids: [], total: 0 });
});

test("combined filters, pagination and counts agree with and without table alias", t => {
	const db = fixture(t);
	for (let i = 1; i <= 3; i++) {
		insert(db, { id: `match-${i}`, subject: "Offer", date: `2026-10-0${i}T10:00:00.000Z`, starred: 1 });
		db.prepare("INSERT INTO attachments (id, email_id, filename, mimetype, size) VALUES (?, ?, ?, ?, ?)")
			.run(`attachment-${i}`, `match-${i}`, "offer.pdf", "application/pdf", 10);
	}
	insert(db, { id: "read", subject: "Offer", read: 1, starred: 1 });
	insert(db, { id: "no-attachment", subject: "Offer", starred: 1 });
	insert(db, { id: "wrong-folder", folder_id: "sent", subject: "Offer", starred: 1 });
	const options = { query: "Body", subject: "offer", from: "sender", to: "recipient", folder: "Inbox",
		date_start: "2026-10-01", date_end: "2026-10-04", is_read: false, is_starred: true, has_attachment: true };
	assert.deepEqual(search(db, options, { limit: 2 }), { ids: ["match-3", "match-2"], total: 3 });
	assert.deepEqual(search(db, options, { limit: 2, offset: 2 }), { ids: ["match-1"], total: 3 });
	assert.deepEqual(search(db, { ...options, folder: "inbox" }).total, 3);
	assert.deepEqual(search(db, { ...options, is_starred: false }), { ids: [], total: 0 });
});
