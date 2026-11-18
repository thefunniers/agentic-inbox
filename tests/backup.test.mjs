import test from "node:test";
import assert from "node:assert/strict";
import { unstable_dev } from "wrangler";
import { classifyError } from "../workers/backup/model.ts";
test("classification stops ambiguous deliveries; transient throttling retries", () => {
	assert.equal(classifyError(new Error("timeout")), "uncertain");
	assert.equal(classifyError({ code: "E_RATE_LIMIT_EXCEEDED" }), "retry");
	assert.equal(classifyError({ code: "E_RECIPIENT_SUPPRESSED" }), "failed");
	assert.equal(classifyError({ code: "E_INTERNAL_SERVER_ERROR" }), "uncertain");
});
test(
	"workerd: BCC identity, exact EML, duplicate ingestion, retry, permanent and ambiguous failure",
	{ timeout: 60000 },
	async (t) => {
		const w = await unstable_dev("tests/fixtures/backup-worker.ts", {
			config: "tests/fixtures/wrangler.backup.jsonc",
			local: true,
			persist: false,
			ip: "127.0.0.1",
			port: 0,
			inspectorPort: 0,
			logLevel: "error",
			experimental: {
				disableExperimentalWarning: true,
				disableDevRegistry: true,
				watch: false,
			},
		});
		t.after(() => w.stop());
		const call = async (path, body) => {
			const r = await w.fetch(path, { method: body ? "POST" : "GET", body });
			assert.ok(r.ok, await r.clone().text());
			return r.json();
		};
		const raw = (subject) =>
			`From: School <school@example.com>\r\nSubject: ${subject}\r\nMessage-ID: <${subject}@example.com>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n密送测试\r\n`;
		const first = await call("/ingest", raw("normal"));
		assert.equal(first.state, "submitted");
		assert.equal(first.inboxStored, true);
		const copy = await call("/capture?id=" + first.id);
		assert.equal(copy.to, "dev@jdtogo.com");
		assert.equal(copy.from.email, "inbox-notify@jdtogo.ai");
		assert.match(copy.text, /student@dev.jdtogo.ai/);
		assert.match(copy.text, /school@example.com/);
		assert.equal(
			Buffer.from(copy.attachments[0].content).toString(),
			raw("normal"),
		);
		const again = await call("/ingest", raw("normal"));
		assert.equal(again.id, first.id);
		assert.equal(again.attempts, 1);
		assert.equal((await call("/emails")).length, 1);
		const second = await call(
			"/ingest?mailbox=other@dev.jdtogo.ai",
			raw("normal"),
		);
		assert.notEqual(second.id, first.id);
		const rate = await call("/ingest", raw("rate"));
		assert.equal(rate.state, "retrying");
		assert.equal(rate.inboxStored, true);
		const retried = await call("/advance?id=" + rate.id);
		assert.equal(retried.state, "submitted");
		assert.equal(retried.attempts, 2);
		let exhausted = await call("/ingest", raw("exhaust"));
		for (let i = 1; i < 5; i++)
			exhausted = await call("/advance?id=" + exhausted.id);
		assert.equal(exhausted.state, "failed");
		assert.equal(exhausted.attempts, 5);
		assert.equal(exhausted.nextAttempt, null);
		const permanent = await call("/ingest", raw("permanent"));
		assert.equal(permanent.state, "failed");
		assert.equal(permanent.inboxStored, true);
		const uncertain = await call("/ingest", raw("unknown"));
		assert.equal(uncertain.state, "uncertain");
		assert.equal((await call("/advance?id=" + uncertain.id)).attempts, 1);
		const interrupted = await call("/interrupted?id=" + first.id);
		assert.equal(interrupted.state, "uncertain");
		const manual = await call("/retry?id=" + permanent.id);
		assert.equal(manual.state, "pending");
		const alerts = await call("/api/v1/deliveries?attention=true&cursor=");
		assert.ok(alerts.deliveries.some((d) => d.id === uncertain.id));
		assert.ok(!alerts.deliveries.some((d) => d.id === rate.id));
		assert.ok(
			alerts.deliveries.find((d) => d.id === exhausted.id).history.length >= 5,
		);
		const original = await w.fetch(
			`/api/v1/deliveries/student%40dev.jdtogo.ai/${rate.id}/original`,
		);
		assert.equal(await original.text(), raw("rate"));
		assert.equal(
			(
				await w.fetch(
					"/api/v1/deliveries/student%40dev.jdtogo.ai/invalid/original",
				)
			).status,
			400,
		);
		const denied = await w.fetch("/ingest?mailbox=student@jdtogo.ai", {
			method: "POST",
			body: raw("prod"),
		});
		assert.equal(denied.status, 500);
	},
);
