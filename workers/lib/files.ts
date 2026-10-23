// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file.

import { z } from "zod";
import type { FileListOptions } from "../../shared/files";

export const FileListQuery = z.object({
	page: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).default(1),
	limit: z.coerce.number().int().min(1).max(100).default(25),
	q: z.string().trim().max(320).default(""),
	direction: z.enum(["all", "received", "sent"]).default("all"),
	includeInline: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
});

/** Shared row/count filters; do not load mail bodies or R2 objects to list files. */
export function buildFileQuery(mailboxId: string, options: FileListOptions) {
	// New mail keeps its original direction even after folder moves. Older
	// archived mail falls back to an exact sender address, including Name <email>.
	const source = `WITH files AS (
		SELECT a.id, a.email_id, a.filename, a.mimetype, a.size, a.disposition,
			e.subject, e.sender, e.recipient, e.date, e.folder_id,
			CASE WHEN e.direction IN ('sent', 'received') THEN e.direction
			WHEN e.folder_id = 'sent' THEN 'sent'
			WHEN e.folder_id IN ('inbox', 'spam') THEN 'received'
			WHEN LOWER(TRIM(
				CASE WHEN INSTR(e.sender, '<') > 0 AND INSTR(e.sender, '>') > INSTR(e.sender, '<')
					THEN SUBSTR(e.sender, INSTR(e.sender, '<') + 1, INSTR(e.sender, '>') - INSTR(e.sender, '<') - 1)
					ELSE e.sender END
			)) = ? THEN 'sent' ELSE 'received' END AS direction
		FROM attachments a JOIN emails e ON e.id = a.email_id
		WHERE e.folder_id NOT IN ('draft', 'trash')
	)`;
	const conditions: string[] = [];
	const params: (string | number)[] = [mailboxId.trim().toLowerCase()];
	if (!options.includeInline) conditions.push("LOWER(COALESCE(disposition, '')) != 'inline'");
	if (options.direction !== "all") {
		conditions.push("direction = ?");
		params.push(options.direction);
	}
	if (options.q) {
		// INSTR avoids the Workers SQLite LIKE pattern length limit and treats
		// percent signs, underscores and quotes literally.
		conditions.push(`(${["filename", "subject", "sender", "recipient"].map((field) => `INSTR(LOWER(${field}), LOWER(?)) > 0`).join(" OR ")})`);
		params.push(options.q, options.q, options.q, options.q);
	}
	const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
	return { source, where, params };
}
