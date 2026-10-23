// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file.

// https://developers.cloudflare.com/email-service/platform/limits/
export const MAX_OUTGOING_EMAIL_BYTES = 5 * 1024 * 1024;
export const MAX_ATTACHMENTS = 32;

export interface EncodedAttachment {
	content: string;
	filename: string;
	type: string;
	disposition: "attachment" | "inline";
	contentId?: string;
}

export interface AttachmentReference {
	emailId: string;
	attachmentId: string;
	disposition?: "attachment" | "inline";
}

export type AttachmentInput = EncodedAttachment | AttachmentReference;

export function sanitizeFilename(filename: string): string {
	const clean = new TextDecoder().decode(new TextEncoder().encode(filename || "untitled"));
	return Array.from(clean.replace(/[\/\\:*?"<>|\x00-\x1f\x7f]/g, "_").trim()).slice(0, 180).join("") || "untitled";
}

export function normalizeMimeType(type: string): string {
	const value = type.split(";")[0].trim().toLowerCase();
	return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(value)
		? value : "application/octet-stream";
}

export function isPreviewableImage(type: string): boolean {
	return /^image\/(png|jpeg|gif|webp|avif|bmp|x-icon|vnd.microsoft.icon)$/.test(normalizeMimeType(type));
}

export function normalizeContentId(value: string): string {
	return value.trim().replace(/^<|>$/g, "");
}

export function base64ByteLength(content: string): number {
	return content.length / 4 * 3 - (content.endsWith("==") ? 2 : content.endsWith("=") ? 1 : 0);
}

export function isValidBase64(content: string): boolean {
	// Empty files are valid. Do not accept data URLs or silently discard invalid bytes.
	return content.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(content)
		&& (content.length === 0 || content.length >= 4);
}

export function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
	}
	return btoa(binary);
}

export function base64ToBytes(content: string): Uint8Array {
	const binary = atob(content);
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** Allow room for MIME headers, encoding and line wrapping, not just raw file sizes. */
export function estimateEmailBytes(
	attachments: { size: number; filename?: string }[],
	body: { html?: string; text?: string; subject?: string } = {},
): number {
	const encodedSize = (size: number) => {
		const base64Size = Math.ceil(size / 3) * 4;
		return base64Size + Math.ceil(base64Size / 76) * 2;
	};
	const encoder = new TextEncoder();
	return 16 * 1024 + encodedSize(encoder.encode((body.html || "") + (body.text || "") + (body.subject || "")).length)
		+ attachments.reduce((total, file) => total + encodedSize(file.size) + 1024 + encoder.encode(file.filename || "").length * 3, 0);
}

export function getAttachmentLimitError(
	attachments: { size: number; filename?: string }[],
	body?: { html?: string; text?: string; subject?: string },
): string | null {
	if (attachments.length > MAX_ATTACHMENTS) return `You can attach up to ${MAX_ATTACHMENTS} files.`;
	if (estimateEmailBytes(attachments, body) > MAX_OUTGOING_EMAIL_BYTES) {
		return "This email exceeds the 5 MiB sending limit after encoding. Remove an attachment or shorten the message.";
	}
	return null;
}

export function getAttachmentUrl(mailboxId: string, emailId: string, attachmentId: string, download = false): string {
	return `/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/emails/${encodeURIComponent(emailId)}/attachments/${encodeURIComponent(attachmentId)}${download ? "?download=1" : ""}`;
}

export function rewriteInlineImages(
	body: string,
	mailboxId: string,
	emailId: string,
	attachments?: { id: string; content_id?: string | null }[],
): string {
	if (!body || !attachments?.length) return body;
	const urls = new Map(attachments.filter((file) => file.content_id).map((file) => [
		normalizeContentId(file.content_id!), getAttachmentUrl(mailboxId, emailId, file.id),
	]));
	return body.replace(/cid:([^\s"'<>\)]+)/gi, (match, value: string) => {
		let cid = value.replace(/&amp;/g, "&");
		try { cid = decodeURIComponent(cid); } catch { /* Some senders use literal percent signs. */ }
		return urls.get(normalizeContentId(cid)) || match;
	});
}
