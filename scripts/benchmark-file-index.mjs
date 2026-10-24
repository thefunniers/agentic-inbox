// Synthetic, in-memory SQLite benchmark. Does not contact Cloudflare or use mail.
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { FILE_INDEX_SCHEMA, FileIndexStore } from "../workers/lib/file-index.ts";

const count = Number(process.argv[2] || 100_000);
if (!Number.isSafeInteger(count) || count < 1000 || count > 1_000_000) throw new Error("Use between 1000 and 1000000 files");
const db = new DatabaseSync(":memory:");
const storage = {
	sql: { exec(query, ...params) { return db.prepare(query).all(...params); } },
	transactionSync(fn) {
		db.exec("BEGIN");
		try { const value = fn(); db.exec("COMMIT"); return value; }
		catch (error) { db.exec("ROLLBACK"); throw error; }
	},
};
db.exec(FILE_INDEX_SCHEMA);
db.exec("UPDATE file_discovery SET complete=1");
const index = new FileIndexStore(storage);
const started = performance.now();
for (let offset = 0; offset < count; offset += 500) {
	const mailboxId = `mailbox-${Math.floor(offset / 500)}@example.com`;
	const changes = Array.from({ length: Math.min(500, count - offset) }, (_, i) => {
		const number = offset + i;
		const id = `email-${String(number).padStart(7, "0")}`;
		return { emailId: id, revision: i + 1, files: [{
			attachment_id: `attachment-${id}`, email_id: id,
			filename: `${number === 777 ? "特定录取通知" : "申请材料"}-${id}.pdf`, mimetype: "application/pdf", size: 200_000,
			subject: `Application ${number}`, sender: "admissions@example.org", recipient: mailboxId,
			date: new Date(Date.UTC(2026, 0, 1) + number * 60_000).toISOString(), folder_id: "inbox", thread_id: id,
			disposition: number % 10 === 0 ? "inline" : "attachment", direction: number % 3 === 0 ? "sent" : "received",
		}] };
	});
	index.apply({ mailboxId, generation: 1, enabled: true, through: changes.length, complete: true, changes });
}
const seedMs = performance.now() - started;
const total = index.list({ limit: 50 }).totalCount;
const deepPage = Math.max(1, Math.floor(total / 50) - 2);
const deepCursor = index.list({ page: deepPage, limit: 50 }).nextCursor;
const cases = [
	["global_first_50", { limit: 50 }],
	["mailbox_first_50", { limit: 50 }, "mailbox-1@example.com"],
	["received_first_50", { limit: 50, direction: "received" }],
	["chinese_substring", { q: "特定录取通知" }],
	["short_no_match", { q: "找无" }],
	["deep_cursor", { cursor: deepCursor, limit: 50 }],
];
const results = cases.map(([name, options, mailbox]) => {
	for (let i = 0; i < 5; i++) index.list(options, mailbox);
	const times = [];
	for (let i = 0; i < 50; i++) {
		const time = performance.now();
		index.list(options, mailbox);
		times.push(performance.now() - time);
	}
	times.sort((a, b) => a - b);
	return { name, medianMs: +times[25].toFixed(3), p95Ms: +times[47].toFixed(3) };
});
console.log(JSON.stringify({ engine: "local Node SQLite (no network)", files: count, mailboxes: Math.ceil(count / 500), seedMs: Math.round(seedMs), results }, null, 2));
db.close();
