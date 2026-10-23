// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Env } from "../types";
import {
	base64ByteLength, base64ToBytes, bytesToBase64, getAttachmentLimitError,
	isPreviewableImage, normalizeContentId, normalizeMimeType, sanitizeFilename,
	type AttachmentInput, type EncodedAttachment,
} from "../../shared/attachments";

export interface StoredAttachment {
	id: string;
	email_id: string;
	filename: string;
	mimetype: string;
	size: number;
	content_id: string | null;
	disposition: string | null;
}

export class AttachmentError extends Error {
	status: 400 | 404 | 413 | 502;
	constructor(message: string, status: 400 | 404 | 413 | 502 = 400) {
		super(message);
		this.status = status;
	}
}

export function attachmentKey(file: Pick<StoredAttachment, "email_id" | "id" | "filename">): string {
	return `attachments/${file.email_id}/${file.id}/${file.filename}`;
}

export async function deleteAttachments(bucket: Env["BUCKET"], files: Pick<StoredAttachment, "email_id" | "id" | "filename">[]) {
	if (files.length) await bucket.delete(files.map(attachmentKey));
}

/** Resolve references within the current mailbox, never through arbitrary R2 keys. */
export async function resolveAttachments(
	bucket: Env["BUCKET"],
	mailbox: { getAttachment(id: string): Promise<StoredAttachment | null> },
	inputs: AttachmentInput[] = [],
	body?: { html?: string; text?: string; subject?: string },
): Promise<EncodedAttachment[]> {
	const files: { input: AttachmentInput; stored?: StoredAttachment; size: number; filename: string }[] = [];
	for (const input of inputs) {
		if ("content" in input) {
			files.push({ input, size: base64ByteLength(input.content), filename: input.filename });
		} else {
			const stored = await mailbox.getAttachment(input.attachmentId);
			if (!stored || stored.email_id !== input.emailId) {
				throw new AttachmentError("An attachment is no longer available in this mailbox. Remove it and attach the file again.", 404);
			}
			files.push({ input, stored, size: stored.size, filename: stored.filename });
		}
	}
	const limitError = getAttachmentLimitError(files, body);
	if (limitError) throw new AttachmentError(limitError, 413);

	const result: EncodedAttachment[] = [];
	for (const file of files) {
		if ("content" in file.input) {
			result.push({ ...file.input, filename: sanitizeFilename(file.input.filename), type: normalizeMimeType(file.input.type),
				contentId: file.input.contentId ? normalizeContentId(file.input.contentId) : undefined });
		} else if (file.stored) {
			const object = await bucket.get(attachmentKey(file.stored));
			if (!object) throw new AttachmentError(`Attachment file "${file.filename}" is missing. Attach the file again.`, 404);
			if (object.size !== file.size) throw new AttachmentError(`Attachment file "${file.filename}" has changed. Attach the file again.`, 400);
			result.push({
				content: bytesToBase64(new Uint8Array(await object.arrayBuffer())),
				filename: sanitizeFilename(file.stored.filename), type: normalizeMimeType(file.stored.mimetype),
				disposition: file.input.disposition || (file.stored.disposition === "inline" ? "inline" : "attachment"),
				contentId: file.stored.content_id ? normalizeContentId(file.stored.content_id) : undefined,
			});
		}
	}
	return result;
}

/** Roll back partial R2 writes if storage fails. */
export async function storeBinaryAttachments(
	bucket: Env["BUCKET"],
	emailId: string,
	files: { content: Uint8Array; filename: string; type: string; disposition?: string | null; contentId?: string | null }[],
): Promise<StoredAttachment[]> {
	const stored: StoredAttachment[] = [];
	try {
		for (const file of files) {
			const attachment: StoredAttachment = {
				id: crypto.randomUUID(), email_id: emailId, filename: sanitizeFilename(file.filename),
				mimetype: normalizeMimeType(file.type), size: file.content.byteLength,
				content_id: file.contentId ? normalizeContentId(file.contentId) : null,
				disposition: file.disposition === "inline" ? "inline" : "attachment",
			};
			stored.push(attachment);
			await bucket.put(attachmentKey(attachment), file.content, { httpMetadata: { contentType: attachment.mimetype } });
		}
		return stored;
	} catch (error) {
		await deleteAttachments(bucket, stored).catch((cleanupError) => console.error("Attachment cleanup failed:", cleanupError));
		throw error;
	}
}

export async function storeAttachments(bucket: Env["BUCKET"], emailId: string, files: EncodedAttachment[] = []) {
	return storeBinaryAttachments(bucket, emailId, files.map((file) => ({ ...file, content: base64ToBytes(file.content) })));
}

export function attachmentHeaders(file: StoredAttachment, download: boolean): Headers {
	const filename = sanitizeFilename(file.filename);
	// Keep Unicode in RFC 5987 filename*, with an ASCII fallback for HTTP headers.
	const asciiName = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
	const encodedName = encodeURIComponent(filename).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
	const disposition = !download && isPreviewableImage(file.mimetype) ? "inline" : "attachment";
	return new Headers({
		"Content-Type": normalizeMimeType(file.mimetype),
		"Content-Length": String(file.size),
		"Content-Disposition": `${disposition}; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
		"X-Content-Type-Options": "nosniff",
		"Content-Security-Policy": "default-src 'none'; sandbox",
		"Cache-Control": "private, no-store",
	});
}
