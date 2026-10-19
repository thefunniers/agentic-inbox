// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export interface SearchFilterOptions {
	query: string;
	folder?: string;
	from?: string;
	to?: string;
	subject?: string;
	date_start?: string;
	date_end?: string;
	is_read?: boolean;
	is_starred?: boolean;
	has_attachment?: boolean;
}

/** Build the same filters for search results and their pagination count. */
export function buildSearchConditions(
	options: SearchFilterOptions,
	tableAlias: "" | "e" = "",
): { conditions: string[]; params: (string | number)[] } {
	const { query, folder, from, to, subject, date_start, date_end, is_read, is_starred, has_attachment } = options;
	const prefix = tableAlias ? `${tableAlias}.` : "";
	const conditions: string[] = [];
	const params: (string | number)[] = [];
	const addParam = (value: string | number) => {
		params.push(value);
		return `?${params.length}`;
	};
	// Durable Objects limit LIKE/GLOB patterns to 50 bytes. INSTR searches for
	// a literal substring of any length; LOWER retains ASCII-insensitive search.
	const contains = (columns: string[], value: string) => {
		const param = addParam(value);
		conditions.push(`(${columns.map((column) =>
			`INSTR(LOWER(${prefix}${column}), LOWER(${param})) > 0`,
		).join(" OR ")})`);
	};

	if (query) contains(["subject", "body", "sender", "recipient", "cc", "bcc"], query);
	if (folder) {
		const p = addParam(folder);
		conditions.push(`${prefix}folder_id = (SELECT id FROM folders WHERE name = ${p} OR id = ${p} LIMIT 1)`);
	}
	if (from) contains(["sender"], from);
	if (to) contains(["recipient", "cc", "bcc"], to);
	if (subject) contains(["subject"], subject);
	if (date_start) { const p = addParam(date_start); conditions.push(`${prefix}date >= ${p}`); }
	if (date_end) { const p = addParam(date_end); conditions.push(`${prefix}date <= ${p}`); }
	if (is_read !== undefined) { const p = addParam(is_read ? 1 : 0); conditions.push(`${prefix}read = ${p}`); }
	if (is_starred !== undefined) { const p = addParam(is_starred ? 1 : 0); conditions.push(`${prefix}starred = ${p}`); }
	if (has_attachment) conditions.push(`${prefix}id IN (SELECT DISTINCT email_id FROM attachments)`);

	return { conditions, params };
}
