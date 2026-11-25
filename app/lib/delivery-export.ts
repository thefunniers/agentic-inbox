import type { Delivery } from "../../workers/backup/model";

const FORMULA_PREFIX = /^(?:[\t\r\n]|[\s\u0000-\u001f\ufeff]*[=+\-@])/;

const CSV_HEADERS = [
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
] as const;

/**
 * Encode a CSV cell per RFC 4180 and neutralize leading spreadsheet formula
 * triggers (=, +, -, @, tab/CR/LF, or leading whitespace/control chars before
 * =/+/-/@) with a leading single quote so spreadsheet apps treat it as text.
 */
export function csvCell(value: unknown): string {
	const raw = String(value ?? "");
	const safe = FORMULA_PREFIX.test(raw) ? `'${raw}` : raw;
	return safe !== raw || /[",\r\n]/.test(safe)
		? `"${safe.replaceAll('"', '""')}"`
		: safe;
}

function sortDeliveriesNewestFirst(deliveries: readonly Delivery[]): Delivery[] {
	return [...deliveries].sort((a, b) =>
		b.receivedAt.localeCompare(a.receivedAt),
	);
}

export function formatDeliveriesCsv(deliveries: readonly Delivery[]): string {
	const sorted = sortDeliveriesNewestFirst(deliveries);
	return [
		CSV_HEADERS.join(","),
		...sorted.map((d) =>
			[
				d.receivedAt,
				d.mailbox,
				d.sender,
				d.subject,
				d.target,
				d.state,
				d.attempts,
				d.inboxStored,
				d.fallbackFrom || "",
				d.originalMessageId || "",
				d.id,
			]
				.map(csvCell)
				.join(","),
		),
	].join("\n");
}

export function formatDeliveriesJson(
	deliveries: readonly Delivery[],
	exportedAt = new Date().toISOString(),
): string {
	const sorted = sortDeliveriesNewestFirst(deliveries);
	return JSON.stringify(
		{
			exportedAt,
			totalCount: sorted.length,
			items: sorted.map((d) => ({
				id: d.id,
				receivedAt: d.receivedAt,
				mailbox: d.mailbox,
				sender: d.sender,
				subject: d.subject,
				target: d.target,
				state: d.state,
				attempts: d.attempts,
				inboxStored: d.inboxStored,
				originalMessageId: d.originalMessageId,
				fallbackFrom: d.fallbackFrom || null,
			})),
		},
		null,
		2,
	);
}
