// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { z } from "zod";
import type { MailboxDirectoryPage } from "../../shared/mailbox-directory";

const MAILBOX_PREFIX = "mailboxes/";

export const MailboxDirectoryQuery = z.object({
	page: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).default(1),
	limit: z.coerce.number().int().min(1).max(100).default(25),
	q: z.string().trim().max(320).default(""),
	domain: z.string().trim().toLowerCase().max(253).default(""),
});

/** Read every R2 listing page, without fetching mailbox settings or mail. */
export async function listMailboxes(
	bucket: Pick<R2Bucket, "list">,
): Promise<{ id: string; email: string }[]> {
	const mailboxes: { id: string; email: string }[] = [];
	let cursor: string | undefined;
	do {
		const result = await bucket.list({ prefix: MAILBOX_PREFIX, limit: 1000, cursor });
		for (const object of result.objects) {
			if (!object.key.startsWith(MAILBOX_PREFIX) || !object.key.endsWith(".json")) continue;
			const id = object.key.slice(MAILBOX_PREFIX.length, -".json".length);
			if (id && !id.includes("/")) mailboxes.push({ id, email: id });
		}
		if (!result.truncated) break;
		if (!result.cursor || result.cursor === cursor) {
			throw new Error("Mailbox listing did not advance");
		}
		cursor = result.cursor;
	} while (cursor);
	return mailboxes;
}

export async function listMailboxDirectory(
	bucket: Pick<R2Bucket, "list">,
	input: z.input<typeof MailboxDirectoryQuery>,
	configuredAddresses: readonly string[] = [],
): Promise<MailboxDirectoryPage> {
	const { page: requestedPage, limit, q, domain } = MailboxDirectoryQuery.parse(input);
	// Configured-address installations already show these addresses before
	// provisioning completes. Keep that behavior, including their allowlist.
	const all = configuredAddresses.length > 0
		? [...new Set(configuredAddresses.map((email) => email.trim().toLowerCase()))]
			.map((email) => ({ id: email, email }))
		: await listMailboxes(bucket);
	const query = q.toLowerCase();
	const matches = all.filter(({ email }) => {
		const address = email.toLowerCase();
		return address.includes(query) && (!domain || address.slice(address.lastIndexOf("@") + 1) === domain);
	}).sort((a, b) => a.email < b.email ? -1 : a.email > b.email ? 1 : 0);
	const totalCount = matches.length;
	const totalPages = Math.max(1, Math.ceil(totalCount / limit));
	// A deleted last row or a stale bookmarked page should still show a valid page.
	const page = Math.min(requestedPage, totalPages);
	return {
		mailboxes: matches.slice((page - 1) * limit, page * limit)
			.map((mailbox) => ({ ...mailbox, name: mailbox.id })),
		totalCount,
		page,
		limit,
		totalPages,
	};
}
