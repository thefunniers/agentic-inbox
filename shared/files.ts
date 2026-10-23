// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file.

import { isPreviewableImage, normalizeMimeType } from "./attachments";

export type FileDirection = "all" | "received" | "sent";

export interface FileListOptions {
	page: number;
	limit: number;
	q: string;
	direction: FileDirection;
	includeInline: boolean;
}

export interface MailboxFile {
	id: string;
	email_id: string;
	filename: string;
	mimetype: string;
	size: number;
	disposition: string | null;
	subject: string | null;
	sender: string | null;
	recipient: string | null;
	date: string | null;
	folder_id: string;
	direction: Exclude<FileDirection, "all">;
}

export interface FileListPage {
	files: MailboxFile[];
	totalCount: number;
	totalPages: number;
	page: number;
	limit: number;
}

export interface GlobalFile extends MailboxFile {
	mailboxId: string;
}

export interface GlobalFileListPage extends Omit<FileListPage, "files"> {
	files: GlobalFile[];
	mailboxCount: number;
}

export function getFilePreviewKind(mimetype: string): "image" | "pdf" | "text" | null {
	const type = normalizeMimeType(mimetype);
	if (isPreviewableImage(type)) return "image";
	if (type === "application/pdf") return "pdf";
	// These formats are shown as escaped text, never inserted as HTML.
	if (type.startsWith("text/") || ["application/json", "application/xml", "application/csv"].includes(type)) return "text";
	return null;
}

export const MAX_FILE_PREVIEW_BYTES = 25 * 1024 * 1024;
export const MAX_TEXT_PREVIEW_BYTES = 200 * 1024;
