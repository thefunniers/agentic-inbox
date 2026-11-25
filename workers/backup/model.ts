export type DeliveryMode = "forward" | "notification";
export type DeliveryState =
	| "pending"
	| "retrying"
	| "submitted"
	| "failed"
	| "uncertain";
export interface Delivery {
	id: string;
	mailbox: string;
	sender: string;
	subject: string;
	originalMessageId: string | null;
	target: string;
	from: string;
	rawKey: string;
	receivedAt: string;
	mode?: DeliveryMode;
	fallbackFrom?: "forward";
	backupDelivered?: boolean;
	indexWritten?: boolean;
	attentionWritten?: boolean;
	state: DeliveryState;
	inboxStored: boolean;
	attempts: number;
	ingestAttempts: number;
	history?: {
		at: string;
		state: DeliveryState;
		attempts: number;
		error: string | null;
	}[];
	error: string | null;
	nextAttempt: number | null;
	providerId?: string;
	sending?: boolean;
}
export const MAX_ATTEMPTS = 5;
export const MAX_FORWARD_ATTEMPTS = 3;
export const FORWARD_WATCHDOG_MS = 180_000;
export function deliveryMode(d: Pick<Delivery, "mode">): DeliveryMode {
	return d.mode || "notification";
}
export function retryDelay(attempt: number) {
	return Math.min(60_000 * 2 ** (attempt - 1), 3_600_000);
}
export function classifyError(
	error: unknown,
): "retry" | "failed" | "uncertain" {
	const code = (error as { code?: string })?.code || "";
	if (
		[
			"E_RATE_LIMIT_EXCEEDED",
			"E_DAILY_LIMIT_EXCEEDED",
			"E_EMAIL_SENDING_NOT_READY",
		].includes(code)
	)
		return "retry";
	if (
		error instanceof TypeError ||
		/^E_(VALIDATION|FIELD|TOO_MANY|SENDER|RECIPIENT|ACCOUNT|CONTENT|HEADER)/.test(
			code,
		)
	)
		return "failed";
	// Transport errors and generic delivery/internal failures may follow acceptance.
	return "uncertain";
}
export function classifyForwardError(
	error: unknown,
): "retry" | "failed" | "uncertain" {
	const base = classifyError(error);
	if (base !== "uncertain") return base;
	const message = error instanceof Error ? error.message : String(error ?? "");
	if (
		/\b4(?:21|50|51|52)\b|rate[\s_-]*limit|throttl|temporar|try again|unavailable|quota|busy|overload/i.test(
			message,
		)
	)
		return "retry";
	if (
		/\b5\d\d\b|unverified|not verified|invalid|rejected|permanent|suppressed|loop|too large|not allowed|disabled|forbidden|cannot forward|no such user|unknown user/i.test(
			message,
		)
	)
		return "failed";
	// Transport drops, timeouts, or opaque internal errors may follow acceptance.
	return "uncertain";
}
export async function deliveryId(
	mailbox: string,
	from: string,
	messageId: string | undefined,
	raw: ArrayBuffer,
) {
	const input = messageId
		? new TextEncoder().encode(`${mailbox}\n${from}\n${messageId}`)
		: new Uint8Array(raw);
	const digest = await crypto.subtle.digest("SHA-256", input);
	return [...new Uint8Array(digest)]
		.map((n) => n.toString(16).padStart(2, "0"))
		.join("");
}
export function backupMessage(d: Delivery, raw: ArrayBuffer) {
	return {
		from: { email: d.from, name: "Inbox 来信副本" },
		to: d.target,
		subject: `[来信副本 · ${d.mailbox}] ${d.subject}`.slice(0, 900),
		text: `这是一封 Inbox 来信副本通知。\n\n学生邮箱：${d.mailbox}\n原发件人：${d.sender}\n原主题：${d.subject}\n收信时间：${d.receivedAt}\n原 Message-ID：${d.originalMessageId || "未提供"}\n副本编号：${d.id}\n\n原始邮件附于 original.eml，请在邮件客户端中打开查看正文和附件。原邮件可能通过密送送达，以上学生地址来自实际投递地址。\n请通过 Inbox 回复学校；不要回复此通知。`,
		attachments: [
			{
				filename: "original.eml",
				type: "message/rfc822",
				disposition: "attachment",
				content: raw,
			},
		],
		headers: {
			"X-Inbox-Delivery-ID": d.id,
			"X-Original-Recipient": d.mailbox,
			"Auto-Submitted": "auto-generated",
		},
	};
}

export function isAttentionState(state: DeliveryState) {
	return state === "failed" || state === "uncertain" || state === "retrying";
}
