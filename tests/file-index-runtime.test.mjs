import assert from "node:assert/strict";
import test from "node:test";
import { unstable_dev } from "wrangler";

test("workerd: backfill, FTS, scoped APIs, alarms, source mappings and deletion", { timeout: 60_000 }, async (t) => {
	const worker = await unstable_dev("tests/fixtures/file-index-worker.ts", {
		config: "tests/fixtures/wrangler.files.jsonc", local: true, persist: false,
		ip: "127.0.0.1", port: 0, inspectorPort: 0, logLevel: "error",
		experimental: { disableExperimentalWarning: true, disableDevRegistry: true, watch: false },
	});
	t.after(() => worker.stop());
	const fetch = (path, method = "GET", body) => worker.fetch(path, { method, ...(body ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}) });
	const json = async (path, method, body) => {
		const response = await fetch(path, method, body);
		assert.ok(response.ok, `${path}: ${response.status} ${response.ok ? "" : await response.text()}`);
		return response.json();
	};
	const eventually = async (path, predicate) => {
		for (let i = 0; i < 100; i++) {
			const value = await json(path);
			if (predicate(value)) return value;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		assert.fail(`Index did not converge: ${path}`);
	};
	await json("/__fixture/seed", "POST", { mailboxId: "legacy@example.com", count: 62, initialize: false });
	const first = await json("/api/v1/files");
	assert.equal(first.index.state, "building");
	const page = await eventually("/api/v1/files?limit=50", (value) => value.index.state === "ready");
	assert.equal(page.files.length, 50);
	assert.equal(page.index.state, "ready");
	const tail = await json(`/api/v1/files?limit=50&cursor=${encodeURIComponent(page.nextCursor)}`);
	assert.equal(tail.files.length, 12);
	assert.equal(new Set([...page.files, ...tail.files].map((f) => f.id)).size, 62);
	assert.equal(tail.nextCursor, null);
	const search = await json(`/api/v1/files?q=${encodeURIComponent("录取通知")}&limit=100`);
	assert.equal(search.files.length, 62);
	assert.equal((await json(`/api/v1/files?q=${encodeURIComponent("100%")}&limit=50`)).files.length, 50);
	assert.equal((await json("/api/v1/files?q=Secret%20body")).files.length, 0);
	assert.equal((await fetch("/api/v1/files?limit=1000")).status, 400);
	assert.equal((await fetch("/api/v1/files?cursor=invalid")).status, 400);
	assert.equal((await fetch("/api/v1/mailboxes/missing@example.com/files")).status, 404);
	assert.equal((await fetch(`/api/v1/mailboxes/legacy@example.com/files?cursor=${encodeURIComponent(page.nextCursor)}`)).status, 400);

	await json("/__fixture/seed", "POST", { mailboxId: "new@example.com", prefix: "new" });
	const scoped = await eventually("/api/v1/mailboxes/new@example.com/files", (value) => value.files.length === 1);
	assert.equal(scoped.files.length, 1, "durable alarm must deliver new attachments");
	assert.equal(scoped.files[0].mailboxId, "new@example.com");
	assert.equal((await json("/api/v1/files?limit=100")).files.length, 63);
	const file = scoped.files[0];
	const source = await json(`/api/v1/mailboxes/new@example.com/emails/${file.email_id}`);
	assert.equal(source.attachments[0].id, file.id);
	const download = await fetch(`/api/v1/mailboxes/new@example.com/emails/${file.email_id}/attachments/${file.id}`);
	assert.equal(await download.text(), "fixture bytes");
	assert.equal((await fetch(`/api/v1/mailboxes/new@example.com/emails/wrong-email/attachments/${file.id}`)).status, 404);
	await json(`/api/v1/mailboxes/new@example.com/emails/${file.email_id}/move`, "POST", { folderId: "archive" });
	await eventually("/api/v1/mailboxes/new@example.com/files", (value) => value.files[0]?.folder_id === "archive");
	assert.equal((await fetch(`/api/v1/mailboxes/new@example.com/emails/${file.email_id}`, "DELETE")).status, 204);
	await eventually("/api/v1/mailboxes/new@example.com/files", (value) => value.files.length === 0);
	assert.equal((await fetch("/api/v1/mailboxes/legacy@example.com", "DELETE")).status, 204);
	assert.equal((await json("/api/v1/files")).files.length, 0);
});
