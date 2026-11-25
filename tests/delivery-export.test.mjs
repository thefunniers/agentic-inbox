import assert from "node:assert/strict";
import test from "node:test";
import {
	csvCell,
	formatDeliveriesCsv,
	formatDeliveriesJson,
} from "../app/lib/delivery-export.ts";

/** Minimal RFC 4180 CSV parser supporting quoted fields, doubled quotes, and embedded newlines. */
function parseCsv(csv) {
	const rows = [];
	let row = [];
	let cell = "";
	let inQuotes = false;
	for (let i = 0; i < csv.length; i++) {
		const ch = csv[i];
		if (inQuotes) {
			if (ch === '"') {
				if (csv[i + 1] === '"') {
					cell += '"';
					i++;
				} else {
					inQuotes = false;
				}
			} else {
				cell += ch;
			}
		} else if (ch === '"') {
			inQuotes = true;
		} else if (ch === ",") {
			row.push(cell);
			cell = "";
		} else if (ch === "\r" || ch === "\n") {
			if (ch === "\r" && csv[i + 1] === "\n") i++;
			row.push(cell);
			rows.push(row);
			row = [];
			cell = "";
		} else {
			cell += ch;
		}
	}
	row.push(cell);
	rows.push(row);
	return rows;
}

const DANGEROUS_PREFIX = /^(?:[\t\r\n]|[\s\u0000-\u001f\ufeff]*[=+\-@])/;

function makeDelivery(overrides = {}) {
	return {
		id: "delivery-1",
		mailbox: "student@jdtogo.ai",
		target: "apply@jdtogo.com",
		sender: "admissions@university.edu",
		subject: "Offer Letter",
		receivedAt: "2026-11-20T10:00:00.000Z",
		rawKey: "backup/student@jdtogo.ai/delivery-1.eml",
		state: "submitted",
		mode: "notification",
		attempts: 1,
		inboxStored: true,
		originalMessageId: "<msg-1@university.edu>",
		...overrides,
	};
}

test("csvCell neutralizes dangerous spreadsheet formula prefixes and preserves RFC 4180 quoting", () => {
	const payloads = [
		'=HYPERLINK("https://evil.example","Click here")',
		"+1+1",
		"-2+3",
		"@SUM(1,2)",
		"\t=1+1",
		"\r=1+1",
		"\n=1+1",
		"  =HYPERLINK(\"https://evil.example\",\"padded\")",
		"\u0000=1+1",
		"\ufeff=1+1",
		"\tleading tab text",
		"\r\nleading crlf text",
	];

	for (const payload of payloads) {
		const encoded = csvCell(payload);
		assert.ok(encoded.startsWith('"') && encoded.endsWith('"'), `expected quoted cell for ${JSON.stringify(payload)}`);
		const [[parsed]] = parseCsv(encoded);
		assert.equal(parsed, `'${payload}`);
		assert.equal(DANGEROUS_PREFIX.test(parsed), false, `parsed cell must not retain formula prefix: ${JSON.stringify(parsed)}`);
	}
});

test("csvCell leaves normal text, numbers, booleans, and embedded quotes/commas/newlines intact", () => {
	assert.equal(csvCell("Offer Letter"), "Offer Letter");
	assert.equal(csvCell("2026-11-20T10:00:00.000Z"), "2026-11-20T10:00:00.000Z");
	assert.equal(csvCell("student@jdtogo.ai"), "student@jdtogo.ai");
	assert.equal(csvCell(2), "2");
	assert.equal(csvCell(true), "true");
	assert.equal(csvCell(null), "");
	assert.equal(csvCell(undefined), "");

	const quoted = csvCell('Offer, "Fall 2026"\nLine 2');
	assert.equal(quoted, '"Offer, ""Fall 2026""\nLine 2"');
	assert.deepEqual(parseCsv(quoted), [['Offer, "Fall 2026"\nLine 2']]);
});

test("formatDeliveriesCsv neutralizes attacker-controlled email fields while formatDeliveriesJson keeps raw values", () => {
	const malicious = makeDelivery({
		id: "del-malicious",
		receivedAt: "2026-11-21T08:00:00.000Z",
		mailbox: "=student@jdtogo.ai",
		sender: "+attacker@evil.example",
		subject: '=HYPERLINK("https://evil.example","Verify")',
		originalMessageId: "@formula-id@evil.example",
		fallbackFrom: "forward",
	});
	const normal = makeDelivery({
		id: "del-normal",
		receivedAt: "2026-11-19T08:00:00.000Z",
		subject: 'Admission, "Round 1"',
	});
	const input = [normal, malicious];

	const csv = formatDeliveriesCsv(input);
	assert.equal(input[0].id, "del-normal", "export must not mutate caller array");

	const rows = parseCsv(csv);
	assert.equal(rows.length, 3);
	assert.deepEqual(rows[0], [
		"receivedAt",
		"mailbox",
		"sender",
		"subject",
		"target",
		"state",
		"attempts",
		"inboxStored",
		"fallbackFrom",
		"originalMessageId",
		"id",
	]);

	// Sorted newest first: malicious row first, normal row second
	const [maliciousRow, normalRow] = rows.slice(1);
	assert.equal(maliciousRow[0], "2026-11-21T08:00:00.000Z");
	assert.equal(maliciousRow[1], "'=student@jdtogo.ai");
	assert.equal(maliciousRow[2], "'+attacker@evil.example");
	assert.equal(maliciousRow[3], `'=HYPERLINK("https://evil.example","Verify")`);
	assert.equal(maliciousRow[8], "forward");
	assert.equal(maliciousRow[9], "'@formula-id@evil.example");
	assert.equal(maliciousRow[10], "del-malicious");
	for (const cell of maliciousRow) {
		assert.equal(DANGEROUS_PREFIX.test(cell), false, `cell retained dangerous prefix: ${JSON.stringify(cell)}`);
	}

	assert.equal(normalRow[0], "2026-11-19T08:00:00.000Z");
	assert.equal(normalRow[3], 'Admission, "Round 1"');
	assert.equal(normalRow[8], "");
	assert.equal(normalRow[10], "del-normal");

	// JSON export keeps raw values intact without leading single-quote escaping
	const parsedJson = JSON.parse(formatDeliveriesJson(input, "2026-11-25T00:00:00.000Z"));
	assert.equal(parsedJson.exportedAt, "2026-11-25T00:00:00.000Z");
	assert.equal(parsedJson.totalCount, 2);
	assert.equal(parsedJson.items[0].id, "del-malicious");
	assert.equal(parsedJson.items[0].mailbox, "=student@jdtogo.ai");
	assert.equal(parsedJson.items[0].sender, "+attacker@evil.example");
	assert.equal(parsedJson.items[0].subject, '=HYPERLINK("https://evil.example","Verify")');
	assert.equal(parsedJson.items[0].originalMessageId, "@formula-id@evil.example");
	assert.equal(parsedJson.items[0].fallbackFrom, "forward");
	assert.equal(parsedJson.items[1].fallbackFrom, null);
});
