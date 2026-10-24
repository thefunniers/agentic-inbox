import { z } from "zod";

export const FileListQuery = z.object({
	page: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).default(1),
	limit: z.coerce.number().int().min(1).max(100).default(25),
	q: z.string().trim().max(320).refine((value) => !value.includes("\0")).default(""),
	direction: z.enum(["all", "received", "sent"]).default("all"),
	includeInline: z.union([z.boolean(), z.enum(["true", "false"])]).default(false).transform((value) => value === true || value === "true"),
	cursor: z.string().max(4096).optional(),
});

/** Mailbox address is bound, never interpolated into SQL. */
export const FILE_DIRECTION_SQL = `CASE WHEN e.direction IN ('sent', 'received') THEN e.direction
			WHEN e.folder_id = 'sent' THEN 'sent'
			WHEN e.folder_id IN ('inbox', 'spam') THEN 'received'
			WHEN LOWER(TRIM(
				CASE WHEN INSTR(e.sender, '<') > 0 AND INSTR(e.sender, '>') > INSTR(e.sender, '<')
					THEN SUBSTR(e.sender, INSTR(e.sender, '<') + 1, INSTR(e.sender, '>') - INSTR(e.sender, '<') - 1)
					ELSE e.sender END
			)) = ? THEN 'sent' ELSE 'received' END`;
