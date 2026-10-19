// Local-only sink for the historical IMAP importer.
// It is not mounted by the production email worker and it has no send binding.

import PostalMime from "postal-mime";
import { MailboxDO } from "./durableObject";
import {
	importDate,
	planImport,
	threadIdForImport,
	type ImportPlan,
} from "./lib/import-rules";
import { ensureMailbox } from "./lib/provision-mailbox";

export { MailboxDO };

const MAX_EMAIL_SIZE = 25 * 1024 * 1024;

interface StoredEmail {
	id: string;
	folder_id: string;
	subject: string | null;
	sender: string | null;
	recipient: string | null;
	cc: string | null;
	date: string | null;
	thread_id: string | null;
	message_id: string | null;
	body: string | null;
	attachments?: { id: string; filename: string; mimetype: string; size: number }[];
}

interface MailboxStub {
	getFolders(): Promise<unknown>;
	getEmail(id: string): Promise<StoredEmail | null>;
	findEmailByMessageId(messageId: string): Promise<{ id: string } | null>;
	createEmail(
		folder: string,
		email: {
			id: string;
			subject: string;
			sender: string;
			recipient: string;
			cc: string | null;
			bcc: string | null;
			date: string;
			read: boolean;
			body: string;
			in_reply_to: string | null;
			email_references: string | null;
			thread_id: string;
			message_id: string | null;
			raw_headers: string;
		},
		attachments: {
			id: string;
			email_id: string;
			filename: string;
			mimetype: string;
			size: number;
			content_id: string | null;
			disposition: string;
		}[],
	): Promise<void>;
	countEmails(options?: { folder?: string }): Promise<number>;
}

interface ImportEnv {
	BUCKET: R2Bucket;
	MAILBOX: {
		idFromName(name: string): DurableObjectId;
		get(id: DurableObjectId): MailboxStub;
	};
	DOMAINS: string;
	IMPORT_TOKEN: string;
	TARGET?: string;
	EMAIL?: unknown;
}

function authorized(request: Request, env: ImportEnv): boolean {
	const expected = env.IMPORT_TOKEN || "";
	if (!expected) return false;
	const header = request.headers.get("authorization") || "";
	const token = header.startsWith("Bearer ") ? header.slice(7) : "";
	if (token.length !== expected.length) return false;
	let diff = 0;
	for (let i = 0; i < token.length; i++) diff |= token.charCodeAt(i) ^ expected.charCodeAt(i);
	return diff === 0;
}

async function sha256Hex(bytes: BufferSource): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function stubFor(env: ImportEnv, mailboxId: string): MailboxStub {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
}

function safeFilename(name: string | null | undefined): string {
	return (name || "untitled").replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_");
}

async function ingest(request: Request, env: ImportEnv): Promise<Response> {
	const sourceAccount = request.headers.get("x-source-account") || "";
	const sourceUid = request.headers.get("x-source-uid") || "";
	const batchId = request.headers.get("x-batch-id") || "";
	const internalDate = request.headers.get("x-internal-date");
	if (!sourceAccount || !sourceUid || !batchId) {
		return Response.json({ error: "missing import headers" }, { status: 400 });
	}

	const raw = new Uint8Array(await request.arrayBuffer());
	if (raw.byteLength === 0 || raw.byteLength > MAX_EMAIL_SIZE) {
		return Response.json({ error: "invalid email size", bytes: raw.byteLength }, { status: 400 });
	}

	const parsed = await new PostalMime().parse(raw);
	const plan = planImport(parsed, sourceAccount);
	const messageKey = plan.messageId || `synthetic:${await sha256Hex(raw)}`;
	const dated = importDate(plan.date, internalDate);
	if (plan.reason !== "ok") {
		return Response.json({
			status: "skipped",
			reason: plan.reason,
			subject: plan.subject,
			messageId: messageKey,
			from: plan.from,
			to: plan.to,
			cc: plan.cc,
			candidates: plan.candidates,
			mailboxes: [],
		});
	}

	type StoredMailbox = {
		mailbox: string;
		action: "imported" | "duplicate";
		emailId: string;
		attachmentCount: number;
		threadId?: string;
		date?: string;
	};
	const mailboxes: StoredMailbox[] = [];
	for (const mailboxId of plan.mailboxes) {
		mailboxes.push(await storeOne(env, {
			raw,
			plan,
			mailboxId,
			messageKey,
			dated,
			batchId,
			sourceAccount,
			sourceUid,
			parsed,
		}));
	}
	const imported = mailboxes.filter((item) => item.action === "imported").length;
	return Response.json({
		status: imported > 0 ? "imported" : "duplicate",
		reason: null,
		subject: plan.subject,
		messageId: messageKey,
		from: plan.from,
		to: plan.to,
		cc: plan.cc,
		date: dated,
		mailboxes,
	});
}

async function storeOne(
	env: ImportEnv,
	args: {
		raw: Uint8Array;
		plan: ImportPlan;
		mailboxId: string;
		messageKey: string;
		dated: string;
		batchId: string;
		sourceAccount: string;
		sourceUid: string;
		parsed: Awaited<ReturnType<PostalMime["parse"]>>;
	},
) {
	const { mailboxId, messageKey, plan } = args;
	await ensureMailbox(env, mailboxId);
	const stub = stubFor(env, mailboxId);
	const existing = await stub.findEmailByMessageId(messageKey);
	if (existing) {
		const rawKey = `raw/${mailboxId}/${existing.id}.eml`;
		if (!(await env.BUCKET.head(rawKey))) {
			await env.BUCKET.put(rawKey, args.raw, {
				httpMetadata: { contentType: "message/rfc822" },
				customMetadata: {
					batchId: args.batchId,
					sourceUid: args.sourceUid,
					folder: "inbox",
				},
			});
		}
		return { mailbox: mailboxId, action: "duplicate" as const, emailId: existing.id, attachmentCount: 0 };
	}

	const emailId = `imp_${(await sha256Hex(new TextEncoder().encode(`${mailboxId}\n${messageKey}`))).slice(0, 32)}`;
	const already = await stub.getEmail(emailId);
	if (already) {
		return { mailbox: mailboxId, action: "duplicate" as const, emailId, attachmentCount: already.attachments?.length || 0 };
	}

	const rawKey = `raw/${mailboxId}/${emailId}.eml`;
	await env.BUCKET.put(rawKey, args.raw, {
		httpMetadata: { contentType: "message/rfc822" },
		customMetadata: {
			batchId: args.batchId,
			sourceUid: args.sourceUid,
			folder: "inbox",
		},
	});

	const attachmentData: {
		id: string;
		email_id: string;
		filename: string;
		mimetype: string;
		size: number;
		content_id: string | null;
		disposition: string;
	}[] = [];
	for (let index = 0; index < args.parsed.attachments.length; index++) {
		const att = args.parsed.attachments[index];
		const filename = safeFilename(att.filename);
		const attachmentId = `att_${(await sha256Hex(new TextEncoder().encode(`${emailId}\n${index}\n${filename}`))).slice(0, 32)}`;
		const bytes = typeof att.content === "string" ? new TextEncoder().encode(att.content) : new Uint8Array(att.content);
		await env.BUCKET.put(`attachments/${emailId}/${attachmentId}/${filename}`, bytes);
		attachmentData.push({
			id: attachmentId,
			email_id: emailId,
			filename,
			mimetype: att.mimeType || "application/octet-stream",
			size: bytes.byteLength,
			content_id: att.contentId || null,
			disposition: att.disposition || "attachment",
		});
	}

	const recipients = [...new Set([mailboxId, ...plan.to])];
	await stub.createEmail("inbox", {
		id: emailId,
		subject: plan.subject,
		sender: plan.from,
		recipient: recipients.join(", "),
		cc: plan.cc.length > 0 ? plan.cc.join(", ") : null,
		bcc: plan.bcc.length > 0 ? plan.bcc.join(", ") : null,
		date: args.dated,
		read: false,
		body: args.parsed.html || args.parsed.text || "",
		in_reply_to: plan.inReplyTo,
		email_references: plan.references.length > 0 ? JSON.stringify(plan.references) : null,
		thread_id: threadIdForImport(plan, emailId),
		message_id: messageKey,
		raw_headers: JSON.stringify(args.parsed.headers),
	}, attachmentData);

	const dedupKey = `imports/dedup/${mailboxId}/${await sha256Hex(new TextEncoder().encode(messageKey))}`;
	await env.BUCKET.put(dedupKey, JSON.stringify({
		emailId,
		batchId: args.batchId,
		sourceAccount: args.sourceAccount,
		sourceUid: args.sourceUid,
		messageId: messageKey,
		folder: "inbox",
		rawKey,
	}));
	await env.BUCKET.put(`imports/${args.batchId}/${encodeURIComponent(args.sourceAccount)}/${args.sourceUid}/${mailboxId}.json`, JSON.stringify({
		emailId,
		mailbox: mailboxId,
		messageId: messageKey,
		subject: plan.subject,
		date: args.dated,
		folder: "inbox",
		attachmentCount: attachmentData.length,
		rawKey,
	}));

	return {
		mailbox: mailboxId,
		action: "imported" as const,
		emailId,
		attachmentCount: attachmentData.length,
		threadId: threadIdForImport(plan, emailId),
		date: args.dated,
	};
}

export default {
	async fetch(request: Request, env: ImportEnv): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/v1/health") {
			return Response.json({
				ok: true,
				target: env.TARGET || "preview",
				hasEmailBinding: env.EMAIL !== undefined,
			});
		}
		if (!authorized(request, env)) return new Response("unauthorized", { status: 401 });

		if (url.pathname === "/v1/ingest" && request.method === "POST") {
			try {
				return await ingest(request, env);
			} catch (error) {
				return Response.json({ error: (error as Error).message }, { status: 500 });
			}
		}

		if (url.pathname === "/v1/manifest" && request.method === "PUT") {
			const batchId = request.headers.get("x-batch-id");
			if (!batchId) return Response.json({ error: "missing batch" }, { status: 400 });
			await env.BUCKET.put(`imports/${batchId}/manifest.json`, await request.arrayBuffer(), {
				httpMetadata: { contentType: "application/json" },
			});
			return Response.json({ status: "stored" });
		}

		const countMatch = url.pathname.match(/^\/v1\/mailboxes\/([^/]+)\/count$/);
		if (countMatch && request.method === "GET") {
			const mailbox = decodeURIComponent(countMatch[1]);
			const count = await stubFor(env, mailbox).countEmails({ folder: "inbox" });
			return Response.json({ mailbox, count });
		}

		const emailMatch = url.pathname.match(/^\/v1\/mailboxes\/([^/]+)\/emails\/([^/]+)$/);
		if (emailMatch && request.method === "GET") {
			const mailbox = decodeURIComponent(emailMatch[1]);
			const emailId = decodeURIComponent(emailMatch[2]);
			const email = await stubFor(env, mailbox).getEmail(emailId);
			if (!email) return Response.json({ error: "not found" }, { status: 404 });
			const raw = await env.BUCKET.head(`raw/${mailbox}/${emailId}.eml`);
			return Response.json({
				id: email.id,
				folder_id: email.folder_id,
				subject: email.subject,
				sender: email.sender,
				recipient: email.recipient,
				cc: email.cc,
				date: email.date,
				thread_id: email.thread_id,
				message_id: email.message_id,
				bodyLength: email.body?.length || 0,
				attachments: email.attachments || [],
				rawBytes: raw?.size ?? 0,
			});
		}

		return new Response("not found", { status: 404 });
	},
};
