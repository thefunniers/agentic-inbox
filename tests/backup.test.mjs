import test from "node:test";
import assert from "node:assert/strict";
import { unstable_dev } from "wrangler";
import {
	classifyError,
	classifyForwardError,
	deliveryId,
	deliveryMode,
} from "../workers/backup/model.ts";

test("classification stops ambiguous deliveries; transient throttling retries", () => {
	assert.equal(classifyError(new Error("timeout")), "uncertain");
	assert.equal(classifyError({ code: "E_RATE_LIMIT_EXCEEDED" }), "retry");
	assert.equal(classifyError({ code: "E_RECIPIENT_SUPPRESSED" }), "failed");
	assert.equal(classifyError({ code: "E_INTERNAL_SERVER_ERROR" }), "uncertain");
	assert.equal(
		classifyForwardError(new Error("451 4.3.0 Temporary local problem")),
		"retry",
	);
	assert.equal(
		classifyForwardError(new Error("421 Try again later")),
		"retry",
	);
	assert.equal(
		classifyForwardError(new Error("550 5.1.1 Unverified destination")),
		"failed",
	);
	assert.equal(
		classifyForwardError(new Error("destination address not verified")),
		"failed",
	);
	assert.equal(
		classifyForwardError(new Error("connection reset while forwarding")),
		"uncertain",
	);
	assert.equal(deliveryMode({}), "notification");
	assert.equal(deliveryMode({ mode: "forward" }), "forward");
});

test(
	"workerd: forward mode durability, retries, fallback, and legacy notification compatibility",
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

		// 1. Forward happy path + deduplication + exact original EML stored
		const fwdMailbox = "forward-ok@dev.jdtogo.ai";
		const okRes = await call(
			`/forward-ingest?mailbox=${fwdMailbox}&behavior=ok`,
			raw("fwd-ok"),
		);
		assert.equal(okRes.threw, false);
		assert.deepEqual(okRes.forwarded, ["dev@jdtogo.com"]);
		assert.equal(okRes.delivery.mode, "forward");
		assert.equal(okRes.delivery.state, "submitted");
		assert.equal(okRes.delivery.backupDelivered, true);
		assert.equal(okRes.delivery.inboxStored, true);
		assert.equal(okRes.delivery.attempts, 1);
		assert.equal((await call(`/emails?mailbox=${fwdMailbox}`)).length, 1);
		// Duplicate delivery does not forward twice or duplicate Inbox
		const dupRes = await call(
			`/forward-ingest?mailbox=${fwdMailbox}&behavior=ok`,
			raw("fwd-ok"),
		);
		assert.equal(dupRes.threw, false);
		assert.deepEqual(dupRes.forwarded, []);
		assert.equal(dupRes.delivery.attempts, 1);
		assert.equal((await call(`/emails?mailbox=${fwdMailbox}`)).length, 1);
		const origOk = await w.fetch(
			`/api/v1/deliveries/${encodeURIComponent(fwdMailbox)}/${okRes.delivery.id}/original`,
		);
		assert.equal(await origOk.text(), raw("fwd-ok"));

		// 2. Transient forward failures throw on attempts 1 & 2, recover on attempt 3 without duplicating Inbox
		const retryMailbox = "forward-retry@dev.jdtogo.ai";
		const retryRaw = raw("fwd-transient-recover");
		const retryId = await deliveryId(
			retryMailbox,
			"school@example.com",
			"<fwd-transient-recover@example.com>",
			new TextEncoder().encode(retryRaw).buffer,
		);
		const try1 = await call(
			`/forward-ingest?mailbox=${retryMailbox}&behavior=transient`,
			retryRaw,
		);
		assert.equal(try1.threw, true);
		assert.deepEqual(try1.forwarded, ["dev@jdtogo.com"]);
		const afterTry1 = await call(`/status?mailbox=${retryMailbox}&id=${retryId}`);
		assert.equal(afterTry1.state, "retrying");
		assert.equal(afterTry1.attempts, 1);
		assert.equal(afterTry1.inboxStored, true);
		const try2 = await call(
			`/forward-ingest?mailbox=${retryMailbox}&behavior=transient`,
			retryRaw,
		);
		assert.equal(try2.threw, true);
		const afterTry2 = await call(`/status?mailbox=${retryMailbox}&id=${retryId}`);
		assert.equal(afterTry2.state, "retrying");
		assert.equal(afterTry2.attempts, 2);
		const try3 = await call(
			`/forward-ingest?mailbox=${retryMailbox}&behavior=ok`,
			retryRaw,
		);
		assert.equal(try3.threw, false);
		assert.equal(try3.delivery.state, "submitted");
		assert.equal(try3.delivery.attempts, 3);
		assert.equal(try3.delivery.backupDelivered, true);
		assert.equal((await call(`/emails?mailbox=${retryMailbox}`)).length, 1);
		assert.deepEqual(
			await call(`/cleanup-status?mailbox=${retryMailbox}&id=${retryId}`),
			{ alarm: null, indexed: false, discoverable: true },
		);

		// 3. Transient forward failures exhausted on attempt 3 do NOT throw (prevent bounce), alert, and allow manual fallback
		const exhaustMailbox = "forward-exhaust@dev.jdtogo.ai";
		const exhaustRaw = raw("fwd-transient-exhaust");
		const exhaustId = await deliveryId(
			exhaustMailbox,
			"school@example.com",
			"<fwd-transient-exhaust@example.com>",
			new TextEncoder().encode(exhaustRaw).buffer,
		);
		assert.equal(
			(
				await call(
					`/forward-ingest?mailbox=${exhaustMailbox}&behavior=transient`,
					exhaustRaw,
				)
			).threw,
			true,
		);
		assert.equal(
			(
				await call(
					`/forward-ingest?mailbox=${exhaustMailbox}&behavior=transient`,
					exhaustRaw,
				)
			).threw,
			true,
		);
		const exhaust3 = await call(
			`/forward-ingest?mailbox=${exhaustMailbox}&behavior=transient`,
			exhaustRaw,
		);
		assert.equal(exhaust3.threw, false);
		assert.equal(exhaust3.delivery.state, "failed");
		assert.equal(exhaust3.delivery.attempts, 3);
		assert.equal(exhaust3.delivery.inboxStored, true);
		const exhaustAlerts = await call(
			`/api/v1/deliveries?attention=true&mailbox=${encodeURIComponent(exhaustMailbox)}`,
		);
		assert.equal(exhaustAlerts.deliveries.length, 1);
		assert.equal(exhaustAlerts.deliveries[0].id, exhaustId);
		assert.equal(exhaustAlerts.deliveries[0].mode, "forward");
		// Manual fallback switches to notification mode and delivers original.eml
		const fallbackPending = await call(
			`/retry?mailbox=${exhaustMailbox}&id=${exhaustId}`,
		);
		assert.equal(fallbackPending.mode, "notification");
		assert.equal(fallbackPending.fallbackFrom, "forward");
		assert.equal(fallbackPending.state, "pending");
		const fallbackSent = await call(
			`/advance?mailbox=${exhaustMailbox}&id=${exhaustId}`,
		);
		assert.equal(fallbackSent.state, "submitted");
		assert.equal(fallbackSent.mode, "notification");
		const fallbackCopy = await call(`/capture?id=${exhaustId}`);
		assert.equal(fallbackCopy.to, "dev@jdtogo.com");
		assert.equal(
			Buffer.from(fallbackCopy.attachments[0].content).toString(),
			exhaustRaw,
		);
		assert.equal((await call(`/emails?mailbox=${exhaustMailbox}`)).length, 1);

		// 4. Forward watchdog expires when platform never sends retry #2 -> fails with alert
		const wdMailbox = "forward-watchdog@dev.jdtogo.ai";
		const wdRaw = raw("fwd-watchdog");
		const wdId = await deliveryId(
			wdMailbox,
			"school@example.com",
			"<fwd-watchdog@example.com>",
			new TextEncoder().encode(wdRaw).buffer,
		);
		assert.equal(
			(
				await call(
					`/forward-ingest?mailbox=${wdMailbox}&behavior=transient`,
					wdRaw,
				)
			).threw,
			true,
		);
		const wdExpired = await call(`/consume-alarm?mailbox=${wdMailbox}&id=${wdId}`);
		assert.equal(wdExpired.delivery.state, "failed");
		assert.match(wdExpired.delivery.error, /未收到平台后续重投/);
		assert.equal(wdExpired.alarm, null);

		// 5. Permanent and uncertain forward errors never throw (no bounce) and alert immediately
		const permMailbox = "forward-perm@dev.jdtogo.ai";
		const permRes = await call(
			`/forward-ingest?mailbox=${permMailbox}&behavior=permanent`,
			raw("fwd-perm"),
		);
		assert.equal(permRes.threw, false);
		assert.equal(permRes.delivery.state, "failed");
		assert.equal(permRes.delivery.attempts, 1);
		const uncMailbox = "forward-uncertain@dev.jdtogo.ai";
		const uncRes = await call(
			`/forward-ingest?mailbox=${uncMailbox}&behavior=uncertain`,
			raw("fwd-unc"),
		);
		assert.equal(uncRes.threw, false);
		assert.equal(uncRes.delivery.state, "uncertain");
		assert.equal(uncRes.delivery.attempts, 1);

		// 6. Concurrent duplicate while in-flight does not clobber active forward; crashed mid-forward becomes uncertain on alarm
		const inflightMailbox = "forward-inflight@dev.jdtogo.ai";
		const inflightRaw = raw("fwd-inflight");
		const inflightOk = await call(
			`/forward-ingest?mailbox=${inflightMailbox}&behavior=ok`,
			inflightRaw,
		);
		await call(
			`/force-sending?mailbox=${inflightMailbox}&id=${inflightOk.delivery.id}&futureMs=120000`,
		);
		const concurrentDup = await call(
			`/forward-ingest?mailbox=${inflightMailbox}&behavior=ok`,
			inflightRaw,
		);
		assert.deepEqual(concurrentDup.forwarded, []);
		assert.equal(concurrentDup.delivery.sending, true);
		assert.equal(concurrentDup.delivery.state, "pending");
		const crashed = await call(
			`/advance?mailbox=${inflightMailbox}&id=${inflightOk.delivery.id}`,
		);
		assert.equal(crashed.state, "uncertain");
		assert.equal(crashed.sending, false);

		// 7. Forward succeeds while Inbox write fails -> alarm retries Inbox ONLY without resending or duplicating forward
		const inboxFailMailbox = "forward-inbox-fail@dev.jdtogo.ai";
		const inboxFailRaw = raw("fwd-inbox-fail");
		const inboxFailId = await deliveryId(
			inboxFailMailbox,
			"school@example.com",
			"<fwd-inbox-fail@example.com>",
			new TextEncoder().encode(inboxFailRaw).buffer,
		);
		const inboxFailRes = await call(
			`/forward-ingest?mailbox=${inboxFailMailbox}&behavior=ok&preId=${inboxFailId}&failInbox=5`,
			inboxFailRaw,
		);
		assert.equal(inboxFailRes.threw, false);
		assert.deepEqual(inboxFailRes.forwarded, ["dev@jdtogo.com"]);
		assert.equal(inboxFailRes.delivery.backupDelivered, true);
		assert.equal(inboxFailRes.delivery.inboxStored, false);
		assert.equal(inboxFailRes.delivery.state, "retrying");
		let afterInboxRetry = inboxFailRes.delivery;
		for (let i = 1; i < 5; i++) {
			afterInboxRetry = await call(
				`/advance?mailbox=${inboxFailMailbox}&id=${inboxFailId}`,
			);
		}
		assert.equal(afterInboxRetry.state, "failed");
		assert.equal(afterInboxRetry.backupDelivered, true);
		assert.equal(afterInboxRetry.inboxStored, false);
		// Manual retry retries Inbox ONLY and does NOT send a notification copy!
		await call(`/retry?mailbox=${inboxFailMailbox}&id=${inboxFailId}`);
		const inboxRecovered = await call(
			`/advance?mailbox=${inboxFailMailbox}&id=${inboxFailId}`,
		);
		assert.equal(inboxRecovered.state, "submitted");
		assert.equal(inboxRecovered.mode, "forward");
		assert.equal(inboxRecovered.inboxStored, true);
		assert.equal((await call(`/emails?mailbox=${inboxFailMailbox}`)).length, 1);
		assert.equal(await call(`/capture?id=${inboxFailId}`), null);

		// 8. Attention write outage during terminal failure recovers via alarm without bouncing
		const attnMailbox = "forward-attn-outage@dev.jdtogo.ai";
		const attnRaw = raw("fwd-attn-outage");
		const attnId = await deliveryId(
			attnMailbox,
			"school@example.com",
			"<fwd-attn-outage@example.com>",
			new TextEncoder().encode(attnRaw).buffer,
		);
		const attnFail = await call(
			`/forward-ingest?mailbox=${attnMailbox}&behavior=permanent&preId=${attnId}&failAttention=2`,
			attnRaw,
		);
		assert.equal(attnFail.threw, false);
		assert.equal(attnFail.delivery.state, "failed");
		assert.equal(attnFail.delivery.attentionWritten, false);
		await call(`/consume-alarm?mailbox=${attnMailbox}&id=${attnId}`);
		const attnTick2 = await call(
			`/consume-alarm?mailbox=${attnMailbox}&id=${attnId}`,
		);
		assert.equal(attnTick2.delivery.attentionWritten, true);
		assert.equal(attnTick2.alarm, null);
		assert.equal(
			(
				await call(
					`/api/v1/deliveries?attention=true&mailbox=${encodeURIComponent(attnMailbox)}`,
				)
			).deliveries.length,
			1,
		);

		// 9. Legacy pre-cutover notification record (mode undefined) continues to finish cleanly and shows under mode=notification
		const legacyMailbox = "legacy-notif@dev.jdtogo.ai";
		const legacyRaw = raw("legacy-notif");
		const legacyId = "a".repeat(64);
		await call(
			`/seed-legacy?mailbox=${legacyMailbox}&id=${legacyId}`,
			legacyRaw,
		);
		const legacyDone = await call(
			`/advance?mailbox=${legacyMailbox}&id=${legacyId}`,
		);
		assert.equal(legacyDone.state, "submitted");
		const onlyNotif = await call(
			`/api/v1/deliveries?attention=false&mode=notification&mailbox=${encodeURIComponent(legacyMailbox)}`,
		);
		assert.equal(onlyNotif.deliveries.length, 1);
		assert.equal(onlyNotif.deliveries[0].id, legacyId);
		const onlyFwd = await call(
			`/api/v1/deliveries?attention=false&mode=forward&mailbox=${encodeURIComponent(legacyMailbox)}`,
		);
		assert.equal(onlyFwd.deliveries.length, 0);
		assert.equal(
			(await w.fetch("/api/v1/deliveries?mode=bogus")).status,
			400,
		);
	},
);

test(
	"workerd: notification mode BCC identity, exact EML, duplicate ingestion, retry, index/cleanup outages",
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
		const outageMailbox = "index-outage@dev.jdtogo.ai";
		const outage = await call(`/ingest?mailbox=${outageMailbox}`, raw("rate"));
		assert.equal(outage.state, "retrying");
		const outageQuery = `?mailbox=${outageMailbox}&id=${outage.id}`;
		await call("/fail-index-writes" + outageQuery);
		for (let i = 0; i < 8; i++) {
			const tick = await call("/consume-alarm" + outageQuery);
			assert.equal(tick.delivery.state, "retrying");
			assert.equal(tick.delivery.attempts, 1);
			assert.equal(tick.delivery.inboxStored, true);
			assert.match(tick.delivery.error, /索引写入失败/);
			assert.ok(Number.isFinite(tick.alarm));
			assert.equal(tick.delivery.nextAttempt, tick.alarm);
		}
		const resumed = await call("/consume-alarm" + outageQuery);
		assert.equal(resumed.delivery.state, "submitted");
		assert.equal(resumed.delivery.attempts, 2);
		assert.equal(resumed.delivery.error, null);
		assert.equal(resumed.alarm, null);
		assert.equal((await call(`/emails?mailbox=${outageMailbox}`)).length, 1);
		assert.equal((await call("/capture?id=" + outage.id)).to, "dev@jdtogo.com");
		const rate = await call("/ingest", raw("rate"));
		assert.equal(rate.state, "retrying");
		assert.equal(rate.inboxStored, true);
		const notDue = await call("/ingest", raw("rate"));
		assert.equal(notDue.state, "retrying");
		assert.equal(notDue.attempts, 1);
		assert.equal(notDue.nextAttempt, rate.nextAttempt);
		await call("/fail-cleanup?id=" + rate.id);
		const retried = await call("/advance?id=" + rate.id);
		assert.equal(retried.state, "submitted");
		assert.equal(retried.attempts, 2);
		const cleanupPending = await call("/cleanup-status?id=" + rate.id);
		assert.ok(cleanupPending.alarm > Date.now());
		assert.equal(cleanupPending.indexed, true);
		await call("/advance?id=" + rate.id);
		const stillPending = await call("/cleanup-status?id=" + rate.id);
		assert.ok(stillPending.alarm > Date.now());
		assert.equal(stillPending.indexed, true);
		const cleaned = await call("/advance?id=" + rate.id);
		assert.equal(cleaned.state, "submitted");
		assert.equal(cleaned.attempts, 2);
		assert.equal(cleaned.providerId, retried.providerId);
		assert.deepEqual(await call("/cleanup-status?id=" + rate.id), {
			alarm: null,
			indexed: false,
			discoverable: true,
		});
		await call("/seed-stale-page");
		const beyondStale = await call(
			"/api/v1/deliveries?attention=true&mailbox=pagination%40dev.jdtogo.ai",
		);
		assert.deepEqual(
			beyondStale.deliveries.map((d) => d.state),
			["failed", "uncertain"],
		);
		assert.equal(beyondStale.cursor, null);

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
