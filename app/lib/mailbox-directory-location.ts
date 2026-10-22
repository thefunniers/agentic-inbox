// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

const STORAGE_KEY = "agentic-inbox:mailbox-directory";
let lastDirectoryUrl = "/";

/** Keep the directory filters in this tab when the operator opens a mailbox. */
export function rememberMailboxDirectory(url: string) {
	lastDirectoryUrl = url;
	try {
		window.sessionStorage.setItem(STORAGE_KEY, url);
	} catch {
		// Navigation still works when browser storage is unavailable.
	}
}

export function mailboxDirectoryUrl(): string {
	try {
		const stored = window.sessionStorage.getItem(STORAGE_KEY);
		if (stored === "/" || stored?.startsWith("/?")) return stored;
	} catch {
		// Fall back to the current session's in-memory location.
	}
	return lastDirectoryUrl;
}
