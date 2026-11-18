import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { ProxyAgent, setGlobalDispatcher } from "undici";
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
if (proxy) setGlobalDispatcher(new ProxyAgent(proxy));
const base = "https://inbox-dev.jdtogo.ai";
const token = (await readFile(".import-state/dev-test-token", "utf8")).trim();
const headers = { authorization: `Bearer ${token}` };
const raw = Buffer.from(
	'From: Dev Fixture <fixture@example.com>\r\nSubject: DEV backup EML BCC test 20261118\r\nMessage-ID: <dev-backup-20261118-v1@example.com>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="fixture"\r\n\r\n--fixture\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n仅用于 dev 验证，不是学校来信。\r\n--fixture\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="bytes.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\nAAECA//+\r\n--fixture--\r\n',
);
const request = async (path, options = {}) =>
	fetch(base + path, {
		...options,
		headers: { ...headers, ...options.headers },
	});
assert.equal((await fetch(base + "/api/v1/deliveries")).status, 403);
const ingest = async () => {
	const r = await request("/api/dev/inbound", {
		method: "POST",
		headers: {
			"X-Envelope-To": "backup-test@dev.jdtogo.ai",
			"X-Envelope-From": "fixture@example.com",
		},
		body: raw,
	});
	assert.equal(r.status, 202, await r.clone().text());
	return r.json();
};
const first = await ingest();
console.log(JSON.stringify(first));
assert.equal(first.inboxStored, true);
assert.equal(first.state, "submitted");
const list = await request("/api/v1/deliveries?attention=false&cursor=");
assert.equal(list.status, 200, await list.clone().text());
assert.ok((await list.json()).deliveries.some((d) => d.id === first.id));
const duplicate = await ingest();
assert.equal(first.id, duplicate.id);
assert.equal(first.attempts, duplicate.attempts);
const stored = await request(
	`/api/v1/deliveries/backup-test%40dev.jdtogo.ai/${first.id}/original`,
);
assert.equal(stored.status, 200);
assert.deepEqual(Buffer.from(await stored.arrayBuffer()), raw);
const inbox = await (
	await request(
		"/api/v1/mailboxes/backup-test%40dev.jdtogo.ai/emails?folder=inbox",
	)
).json();
assert.equal(inbox.totalCount, 1);
const forbidden = await request("/api/dev/inbound", {
	method: "POST",
	headers: {
		"X-Envelope-To": "student@jdtogo.ai",
		"X-Envelope-From": "fixture@example.com",
	},
	body: raw,
});
assert.equal(forbidden.status, 400);
await mkdir(".import-state/backup-dev", { recursive: true });
await writeFile(
	".import-state/backup-dev/receipt.json",
	JSON.stringify(
		{
			first,
			duplicate,
			originalBytesMatch: true,
			inboxCount: inbox.totalCount,
			unauthenticatedStatus: 403,
			productionRecipientStatus: 400,
		},
		null,
		2,
	),
);
await writeFile(".import-state/backup-dev/original.eml", raw);
console.log(
	"DEV checks: original EML exact, deduplication, inbox preservation, auth and recipient isolation passed.",
);
