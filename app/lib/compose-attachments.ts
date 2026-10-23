import { bytesToBase64, normalizeMimeType, type AttachmentInput } from "../../shared/attachments";
import type { Attachment } from "../types";

export interface ComposeAttachment {
	id: string;
	filename: string;
	size: number;
	input: AttachmentInput;
}

export function storedComposeAttachments(emailId: string, attachments: Attachment[] = [], forwarding = false): ComposeAttachment[] {
	return attachments.map((file) => ({
		id: file.id, filename: file.filename, size: file.size,
		input: { emailId, attachmentId: file.id, ...(forwarding ? { disposition: "attachment" as const } : {}) },
	}));
}

export async function readComposeAttachment(file: File): Promise<ComposeAttachment> {
	return {
		id: crypto.randomUUID(), filename: file.name, size: file.size,
		input: {
			filename: file.name, content: bytesToBase64(new Uint8Array(await file.arrayBuffer())),
			type: normalizeMimeType(file.type), disposition: "attachment",
		},
	};
}
