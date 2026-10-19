// Shared planning rules for the one-off historical importer.
// The live receive path keeps its own envelope handling; this module decides
// which controlled mailbox a Tencent backup copy belongs to.

export const SOURCE_DOMAIN: Record<string, string> = {
	"apply@jdtogo.com": "jdtogo.ai",
	"dev@jdtogo.com": "dev.jdtogo.ai",
};

const SYSTEM_LOCALS = new Set([
	"postmaster",
	"abuse",
	"mailer-daemon",
	"bounce",
	"cf-bounce",
]);

const ADDRESS_RE = /([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/;
const RECEIVED_FOR_RE =
	/(?:^|[^\w])for\s+<?([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})>?/gi;

export interface AddressLike {
	address?: string;
	group?: AddressLike[];
}

export interface ImportPlanInput {
	to?: Array<string | AddressLike | undefined> | null;
	cc?: Array<string | AddressLike | undefined> | null;
	bcc?: Array<string | AddressLike | undefined> | null;
	deliveredTo?: string | null;
	headers?: { key: string; value: string }[] | null;
	messageId?: string | null;
	inReplyTo?: string | null;
	references?: string | null;
	from?: string | AddressLike | null;
	subject?: string | null;
	date?: string | null;
}

export interface ImportPlan {
	sourceAccount: string;
	allowedDomain: string;
	mailboxes: string[];
	messageId: string | null;
	inReplyTo: string | null;
	references: string[];
	from: string;
	to: string[];
	cc: string[];
	bcc: string[];
	subject: string;
	date: string | null;
	candidates: string[];
	reason: "ok" | "no_managed_recipient" | "unknown_source";
}

export function extractMessageId(value: string | null | undefined): string | null {
	if (!value) return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	const match = trimmed.match(/<([^>]+)>/);
	return match ? match[1] : trimmed.split(/\s+/)[0] || null;
}

export function normalizeAddress(value: string | null | undefined): string | null {
	if (!value) return null;
	const match = value.match(ADDRESS_RE);
	return match ? match[1].toLowerCase() : null;
}

export function domainOf(address: string): string {
	const at = address.lastIndexOf("@");
	return at >= 0 ? address.slice(at + 1) : "";
}

export function flattenAddresses(
	list: Array<string | AddressLike | undefined> | null | undefined,
): string[] {
	const out: string[] = [];
	for (const item of list || []) {
		if (!item) continue;
		if (typeof item === "string") {
			const address = normalizeAddress(item);
			if (address) out.push(address);
			continue;
		}
		if (item.address) {
			const address = normalizeAddress(item.address);
			if (address) out.push(address);
		}
		if (item.group) out.push(...flattenAddresses(item.group));
	}
	return [...new Set(out)];
}

function headerValues(
	headers: { key: string; value: string }[] | null | undefined,
	name: string,
): string[] {
	const key = name.toLowerCase();
	return (headers || []).filter((header) => header.key.toLowerCase() === key).map((header) => header.value);
}

export function collectCandidates(input: ImportPlanInput): string[] {
	const found = [
		...flattenAddresses(input.to),
		...flattenAddresses(input.cc),
		...flattenAddresses(input.bcc),
	];
	const delivered = [
		input.deliveredTo || "",
		...headerValues(input.headers, "delivered-to"),
		...headerValues(input.headers, "x-original-to"),
		...headerValues(input.headers, "envelope-to"),
		...headerValues(input.headers, "x-delivered-to"),
	];
	for (const value of delivered) {
		const address = normalizeAddress(value);
		if (address) found.push(address);
	}
	for (const received of headerValues(input.headers, "received")) {
		RECEIVED_FOR_RE.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = RECEIVED_FOR_RE.exec(received))) {
			const address = normalizeAddress(match[1]);
			if (address) found.push(address);
		}
	}
	return [...new Set(found)];
}

export function isSystemAddress(address: string): boolean {
	const local = address.slice(0, address.indexOf("@")).toLowerCase();
	return SYSTEM_LOCALS.has(local);
}

export function importDate(headerDate: string | null | undefined, internalDate: string | null | undefined): string {
	for (const value of [headerDate, internalDate]) {
		if (!value) continue;
		const parsed = Date.parse(value);
		if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
		const imap = parseImapInternalDate(value);
		if (imap) return imap;
	}
	return new Date().toISOString();
}

const IMAP_MONTHS: Record<string, number> = {
	jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
	jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

export function parseImapInternalDate(value: string): string | null {
	const match = value.match(
		/^(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/,
	);
	if (!match) return null;
	const month = IMAP_MONTHS[match[2].toLowerCase()];
	if (month === undefined) return null;
	const day = Number(match[1]);
	const year = Number(match[3]);
	const hour = Number(match[4]);
	const minute = Number(match[5]);
	const second = Number(match[6]);
	const sign = match[7] === "-" ? -1 : 1;
	const offsetMinutes = sign * (Number(match[8]) * 60 + Number(match[9]));
	const utc = Date.UTC(year, month, day, hour, minute, second) - offsetMinutes * 60_000;
	return new Date(utc).toISOString();
}

export function planImport(input: ImportPlanInput, sourceAccount: string): ImportPlan {
	const account = sourceAccount.trim().toLowerCase();
	const allowedDomain = SOURCE_DOMAIN[account];
	const to = flattenAddresses(input.to);
	const cc = flattenAddresses(input.cc);
	const bcc = flattenAddresses(input.bcc);
	const from = flattenAddresses(input.from ? [input.from] : [])[0] || "";
	const references = (input.references || "")
		.split(/\s+/)
		.filter(Boolean)
		.map((value) => extractMessageId(value))
		.filter((value): value is string => Boolean(value));
	const messageId = extractMessageId(input.messageId);
	const inReplyTo = extractMessageId(input.inReplyTo);
	const candidates = collectCandidates(input);
	if (!allowedDomain) {
		return {
			sourceAccount: account,
			allowedDomain: "",
			mailboxes: [],
			messageId,
			inReplyTo,
			references,
			from,
			to,
			cc,
			bcc,
			subject: input.subject || "",
			date: input.date || null,
			candidates,
			reason: "unknown_source",
		};
	}
	const mailboxes = candidates.filter((address) => {
		if (domainOf(address) !== allowedDomain) return false;
		if (isSystemAddress(address)) return false;
		const local = address.slice(0, address.indexOf("@"));
		return /^[^\s<>@,;:]+$/.test(local);
	});
	return {
		sourceAccount: account,
		allowedDomain,
		mailboxes: [...new Set(mailboxes)],
		messageId,
		inReplyTo,
		references,
		from,
		to,
		cc,
		bcc,
		subject: input.subject || "",
		date: input.date || null,
		candidates,
		reason: mailboxes.length > 0 ? "ok" : "no_managed_recipient",
	};
}

export function threadIdForImport(plan: ImportPlan, internalId: string): string {
	return plan.references[0] || plan.inReplyTo || plan.messageId || internalId;
}

export function selfCheckImportRules(): void {
	const applyAi = planImport({
		to: ["jiahongjiang001@jdtogo.ai", "apply-nz@51liucheng.com"],
		headers: [],
		messageId: "<abc@example>",
	}, "apply@jdtogo.com");
	assert(applyAi.mailboxes.join() === "jiahongjiang001@jdtogo.ai", "apply keeps root domain");

	const fromReceived = planImport({
		to: ["o.y.gafari@southampton.ac.uk"],
		headers: [{ key: "received", value: "by cloudflare id x for <xinyu001@jdtogo.ai>; Tue, 06 Oct 2026" }],
		messageId: "<id@example>",
	}, "apply@jdtogo.com");
	assert(fromReceived.mailboxes.join() === "xinyu001@jdtogo.ai", "received for");

	const company = planImport({
		to: ["qizhao001@jdtogo.com"],
		headers: [{ key: "received", value: "for <qizhao001@jdtogo.com>" }],
	}, "apply@jdtogo.com");
	assert(company.reason === "no_managed_recipient", "jdtogo.com is not a mailbox domain");

	const direct = planImport({
		to: ["apply@jdtogo.com"],
		headers: [{ key: "received", value: "for <apply@jdtogo.com>" }],
	}, "apply@jdtogo.com");
	assert(direct.reason === "no_managed_recipient", "backup mailbox is not imported as itself");

	const dev = planImport({
		to: ["KarlLiu001@dev.jdtogo.ai"],
		messageId: " <MN2@outlook.com>",
	}, "dev@jdtogo.com");
	assert(dev.mailboxes.join() === "karlliu001@dev.jdtogo.ai", "dev domain");
	assert(dev.messageId === "MN2@outlook.com", "message id brackets");

	const crossed = planImport({
		to: ["karlliu001@dev.jdtogo.ai"],
		headers: [{ key: "received", value: "for <karlliu001@dev.jdtogo.ai>" }],
	}, "apply@jdtogo.com");
	assert(crossed.mailboxes.length === 0, "root backup must not create dev mailboxes");

	const system = planImport({
		to: ["postmaster@jdtogo.ai", "student@jdtogo.ai"],
	}, "apply@jdtogo.com");
	assert(system.mailboxes.join() === "student@jdtogo.ai", "system local is skipped");

	const thread = threadIdForImport({
		...applyAi,
		references: ["root@example"],
		inReplyTo: "parent@example",
	}, "internal");
	assert(thread === "root@example", "thread uses first reference");

	const imapDate = parseImapInternalDate("07-Sep-2026 06:59:21 +0800");
	assert(imapDate === "2026-09-06T22:59:21.000Z", `imap date ${imapDate}`);
}

function assert(condition: unknown, message: string): void {
	if (!condition) throw new Error(`import rule check failed: ${message}`);
}
