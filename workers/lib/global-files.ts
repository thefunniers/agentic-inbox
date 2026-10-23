// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file.

import type { FileListOptions, FileListPage, GlobalFile, GlobalFileListPage } from "../../shared/files";
import { listMailboxes } from "./mailbox-directory";

interface FileSource {
	BUCKET: Pick<R2Bucket, "list">;
	MAILBOX: {
		idFromName(name: string): DurableObjectId;
		get(id: DurableObjectId): { listFiles(mailboxId: string, options: FileListOptions): Promise<FileListPage> };
	};
}

function compareFiles(a: GlobalFile, b: GlobalFile): number {
	for (const [left, right, order] of [
		[a.date, b.date, -1], [a.mailboxId, b.mailboxId, 1],
		[a.email_id, b.email_id, -1], [a.id, b.id, -1],
	] as const) {
		if (left === right) continue;
		if (left === null) return 1;
		if (right === null) return -1;
		return (left < right ? -1 : 1) * order;
	}
	return 0;
}

/** Merge sorted mailbox pages with bounded concurrency and no email-body reads. */
export async function listGlobalFiles(env: FileSource, options: FileListOptions): Promise<GlobalFileListPage> {
	const mailboxes = await listMailboxes(env.BUCKET);
	const sources: { id: string; data: FileListPage; index: number }[] = [];
	const load = (id: string, page: number) => env.MAILBOX.get(env.MAILBOX.idFromName(id))
		.listFiles(id, { ...options, page });
	let nextMailbox = 0;
	// Each source initially contributes one bounded page. Failed sources fail the
	// entire request, so a partial result is never presented as the global total.
	await Promise.all(Array.from({ length: Math.min(6, mailboxes.length) }, async () => {
		while (nextMailbox < mailboxes.length) {
			const { id } = mailboxes[nextMailbox++];
			sources.push({ id, data: await load(id, 1), index: 0 });
		}
	}));
	const totalCount = sources.reduce((total, source) => total + source.data.totalCount, 0);
	const totalPages = Math.max(1, Math.ceil(totalCount / options.limit));
	const page = Math.min(options.page, totalPages);
	const start = (page - 1) * options.limit;
	const end = Math.min(start + options.limit, totalCount);
	const files: GlobalFile[] = [];
	for (let position = 0; position < end; position++) {
		let selected: typeof sources[number] | undefined;
		let first: GlobalFile | undefined;
		for (const source of sources) {
			const file = source.data.files[source.index];
			if (!file) continue;
			const candidate = { ...file, mailboxId: source.id };
			if (!first || compareFiles(candidate, first) < 0) {
				selected = source;
				first = candidate;
			}
		}
		if (!selected || !first) break;
		if (position >= start) files.push(first);
		selected.index++;
		// Only the mailbox whose current page was consumed needs another read.
		if (position + 1 < end && selected.index === selected.data.files.length && selected.data.page < selected.data.totalPages) {
			const nextPage = selected.data.page + 1;
			selected.data = await load(selected.id, nextPage);
			selected.index = 0;
			// A deletion during pagination may shrink the source. Do not replay its
			// last page if the mailbox endpoint clamped the requested page.
			if (selected.data.page < nextPage) selected.index = selected.data.files.length;
		}
	}
	return { files, totalCount, totalPages, page, limit: options.limit, mailboxCount: mailboxes.length };
}
