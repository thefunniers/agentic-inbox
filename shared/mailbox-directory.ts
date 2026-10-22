// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export interface MailboxDirectoryEntry {
	id: string;
	email: string;
	name: string;
}

export interface MailboxDirectoryPage {
	mailboxes: MailboxDirectoryEntry[];
	totalCount: number;
	page: number;
	limit: number;
	totalPages: number;
}

export interface MailboxDirectoryOptions {
	page: number;
	limit: number;
	q: string;
	domain: string;
}
