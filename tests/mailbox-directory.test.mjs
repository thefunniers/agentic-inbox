import assert from "node:assert/strict";
import test from "node:test";
import { listMailboxes, listMailboxDirectory, MailboxDirectoryQuery } from "../workers/lib/mailbox-directory.ts";

function fixture(addresses, { batchSize = 1000, extraKeys = [] } = {}) {
	const keys = [...addresses.map(address => `mailboxes/${address}.json`), ...extraKeys].sort();
	const calls = [];
	return {
		calls,
		async list(options) {
			calls.push(options);
			const filtered = keys.filter(key => key.startsWith(options.prefix));
			const offset = options.cursor ? Number(options.cursor.slice("offset:".length)) : 0;
			const size = Math.min(options.limit, batchSize);
			const objects = filtered.slice(offset, offset + size).map(key => ({ key }));
			const next = offset + objects.length;
			return next < filtered.length
				? { objects, truncated: true, cursor: `offset:${next}` }
				: { objects, truncated: false };
		},
		async get() { assert.fail("Directory queries must not fetch settings or messages"); },
	};
}

test("all directory pages cover more than 1000 mailboxes exactly once", async () => {
	const addresses = Array.from({ length: 1037 }, (_, index) => `user-${String(index).padStart(4, "0")}@jdtogo.ai`);
	const bucket = fixture(addresses);
	const seen = [];
	for (let page = 1; page <= 42; page++) {
		const result = await listMailboxDirectory(bucket, { page, limit: 25 });
		assert.equal(result.totalCount, 1037);
		assert.equal(result.totalPages, 42);
		assert.equal(result.page, page);
		assert.equal(result.mailboxes.length, page === 42 ? 12 : 25);
		seen.push(...result.mailboxes.map(mailbox => mailbox.id));
	}
	assert.deepEqual(seen, addresses);
	assert.ok(bucket.calls.some(call => call.cursor === "offset:1000"));
	assert.ok(bucket.calls.every(call => call.limit <= 1000));
});

test("address search finds a match beyond the first R2 page and ignores case and surrounding spaces", async () => {
	const addresses = Array.from({ length: 1100 }, (_, index) => `a-${String(index).padStart(4, "0")}@jdtogo.ai`);
	addresses.push("z-findme@dev.jdtogo.ai");
	const result = await listMailboxDirectory(fixture(addresses), { q: "  Z-FINDME@DEV  " });
	assert.deepEqual(result.mailboxes.map(mailbox => mailbox.email), ["z-findme@dev.jdtogo.ai"]);
	assert.equal(result.totalCount, 1);
});

test("search and exact domain filters apply before pagination and counts", async () => {
	const bucket = fixture([
		"app-1@jdtogo.ai", "app-2@jdtogo.ai", "app-3@jdtogo.ai",
		"app-1@dev.jdtogo.ai", "app-2@dev.jdtogo.ai", "other@jdtogo.ai",
	], { batchSize: 2 });
	const first = await listMailboxDirectory(bucket, { q: "app-", domain: " JDTOGO.AI ", limit: 2 });
	const second = await listMailboxDirectory(bucket, { q: "app-", domain: "jdtogo.ai", page: 2, limit: 2 });
	assert.equal(first.totalCount, 3);
	assert.equal(first.totalPages, 2);
	assert.deepEqual(first.mailboxes.map(mailbox => mailbox.email), ["app-1@jdtogo.ai", "app-2@jdtogo.ai"]);
	assert.deepEqual(second.mailboxes.map(mailbox => mailbox.email), ["app-3@jdtogo.ai"]);
	assert.equal(second.totalCount, first.totalCount);
});

test("address search treats punctuation as literal text", async () => {
	const addresses = ["a_b@jdtogo.ai", "a-b@jdtogo.ai", "100%box@jdtogo.ai", "1000box@jdtogo.ai", "o'brien@jdtogo.ai"];
	for (const [q, expected] of [["_", addresses[0]], ["%", addresses[2]], ["o'brien", addresses[4]]]) {
		const result = await listMailboxDirectory(fixture(addresses), { q });
		assert.deepEqual(result.mailboxes.map(mailbox => mailbox.email), [expected]);
	}
});

test("empty search results and stale page numbers return a valid page", async () => {
	const bucket = fixture(["alpha@jdtogo.ai", "bravo@jdtogo.ai", "charlie@jdtogo.ai"]);
	const empty = await listMailboxDirectory(bucket, { page: 999, q: "missing" });
	assert.deepEqual(empty, { mailboxes: [], totalCount: 0, page: 1, limit: 25, totalPages: 1 });
	const last = await listMailboxDirectory(bucket, { page: 999, limit: 2 });
	assert.equal(last.page, 2);
	assert.deepEqual(last.mailboxes.map(mailbox => mailbox.email), ["charlie@jdtogo.ai"]);
	assert.equal((await listMailboxDirectory(fixture([]), {})).totalCount, 0);
});

test("configured address mode preserves the allowlist without listing private mailbox metadata", async () => {
	const bucket = fixture(["hidden@jdtogo.ai"]);
	const result = await listMailboxDirectory(bucket, { q: "allowed", limit: 1 }, [
		"allowed-2@dev.jdtogo.ai", "ALLOWED-1@JDTOGO.AI", "allowed-1@jdtogo.ai",
	]);
	assert.equal(result.totalCount, 2);
	assert.deepEqual(result.mailboxes.map(mailbox => mailbox.email), ["allowed-1@jdtogo.ai"]);
	assert.equal(bucket.calls.length, 0);
});

test("legacy listing exhausts short R2 batches and ignores non-mailbox objects", async () => {
	const bucket = fixture(["a.json.name@jdtogo.ai", "bravo@jdtogo.ai"], {
		batchSize: 1,
		extraKeys: ["mailboxes/", "mailboxes/notes.txt", "mailboxes/nested/not-a-mailbox.json", "attachments/file.json"],
	});
	assert.deepEqual(await listMailboxes(bucket), [
		{ id: "a.json.name@jdtogo.ai", email: "a.json.name@jdtogo.ai" },
		{ id: "bravo@jdtogo.ai", email: "bravo@jdtogo.ai" },
	]);
});

test("invalid page, limit, and oversized search parameters are rejected", () => {
	assert.deepEqual(MailboxDirectoryQuery.parse({ page: "2", limit: "50" }), { page: 2, limit: 50, q: "", domain: "" });
	for (const input of [
		{ page: "0" }, { page: "-1" }, { page: "1.5" }, { page: "NaN" }, { page: "Infinity" },
		{ page: "9007199254740992" }, { limit: "0" }, { limit: "101" }, { limit: "2.5" },
		{ q: "a".repeat(321) }, { domain: "a".repeat(254) },
	]) assert.equal(MailboxDirectoryQuery.safeParse(input).success, false);
});

test("storage errors and non-advancing cursors fail instead of returning an incomplete directory", async () => {
	await assert.rejects(listMailboxDirectory({ async list() { throw new Error("R2 unavailable"); } }, {}), /R2 unavailable/);
	let count = 0;
	await assert.rejects(listMailboxes({ async list() {
		count++;
		return { objects: [], truncated: true, cursor: "stuck" };
	} }), /did not advance/);
	assert.equal(count, 2);
});
