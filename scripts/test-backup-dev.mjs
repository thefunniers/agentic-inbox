import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { ProxyAgent, setGlobalDispatcher } from "undici";
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
if (proxy) setGlobalDispatcher(new ProxyAgent(proxy));
const base = "https://inbox-dev.jdtogo.ai";
const tokenPath =
	process.env.DEV_TEST_TOKEN_PATH || ".import-state/dev-test-token";
const token = (await readFile(tokenPath, "utf8")).trim();
const headers = { authorization: `Bearer ${token}` };
const raw = Buffer.from(
	'From: Dev Fixture <fixture@example.com>\r\nSubject: DEV forward mode check 20261125\r\nMessage-ID: <dev-forward-20261125-v1@example.com>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="fixture"\r\n\r\n--fixture\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n仅用于 dev 原样转发与失败告警回归验证，不是学校来信。\r\n--fixture\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="bytes.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\nAAECA//+\r\n--fixture--\r\n',
);
const request = async (path, options = {}) =>
	fetch(base + path, {
		...options,
		headers: { ...headers, ...options.headers },
	});
assert.equal((await fetch(base + "/api/v1/deliveries")).status, 403);
const ingestForward = async (resultHeader) => {
	const r = await request("/api/dev/inbound", {
		method: "POST",
		headers: {
			"X-Envelope-To": "forward-test@dev.jdtogo.ai",
			"X-Envelope-From": "fixture@example.com",
			"X-Dev-Forward-Result": resultHeader,
		},
		body: raw,
	});
	return { status: r.status, body: await r.json() };
};
const first = await ingestForward("ok");
assert.equal(first.status, 202, JSON.stringify(first));
assert.equal(first.body.mode, "forward");
assert.equal(first.body.inboxStored, true);
assert.equal(first.body.state, "submitted");
const listFwd = await request(
	"/api/v1/deliveries?attention=false&mode=forward&cursor=",
);
assert.equal(listFwd.status, 200, await listFwd.clone().text());
assert.ok(
	(await listFwd.json()).deliveries.some((d) => d.id === first.body.id),
);
const listNotif = await request(
	"/api/v1/deliveries?attention=false&mode=notification&cursor=",
);
assert.equal(listNotif.status, 200, await listNotif.clone().text());
assert.ok(
	!(await listNotif.json()).deliveries.some((d) => d.id === first.body.id),
);
const duplicate = await ingestForward("ok");
assert.equal(duplicate.status, 202);
assert.equal(first.body.id, duplicate.body.id);
assert.equal(first.body.attempts, duplicate.body.attempts);
const stored = await request(
	`/api/v1/deliveries/forward-test%40dev.jdtogo.ai/${first.body.id}/original`,
);
assert.equal(stored.status, 200);
assert.deepEqual(Buffer.from(await stored.arrayBuffer()), raw);
const inbox = await (
	await request(
		"/api/v1/mailboxes/forward-test%40dev.jdtogo.ai/emails?folder=inbox",
	)
).json();
assert.equal(inbox.totalCount, 1);
const forbidden = await request("/api/dev/inbound", {
	method: "POST",
	headers: {
		"X-Envelope-To": "student@jdtogo.ai",
		"X-Envelope-From": "fixture@example.com",
		"X-Dev-Forward-Result": "ok",
	},
	body: raw,
});
assert.equal(forbidden.status, 400);
await mkdir(".import-state/backup-dev", { recursive: true });
await writeFile(
	".import-state/backup-dev/receipt-forward-20261125.json",
	JSON.stringify(
		{
			first: first.body,
			duplicate: duplicate.body,
			originalBytesMatch: true,
			inboxCount: inbox.totalCount,
			unauthenticatedStatus: 403,
			productionRecipientStatus: 400,
		},
		null,
		2,
	),
);
console.log(
	"DEV forward checks: mode filter, original EML exact, deduplication, inbox preservation, auth and recipient isolation passed.",
);
