import { z } from "zod";
import type { GlobalFileListPage, GlobalFile } from "../../shared/files";
import { FileListQuery } from "./files.ts";
export { FileListQuery };

export const FILE_INDEX_NAME = "files-v1";

export interface IndexedFile {
	mailbox_id: string; email_id: string; attachment_id: string;
	filename: string; mimetype: string; size: number;
	subject: string; sender: string; recipient: string; date: string;
	folder_id: string; thread_id: string | null;
	disposition: string | null; direction: "received" | "sent";
}

export interface FileChange {
	revision: number;
	emailId: string;
	files: Omit<IndexedFile, "mailbox_id">[];
}

export interface FileIndexBatch {
	mailboxId: string;
	generation: number;
	enabled: boolean;
	through: number;
	complete: boolean;
	changes: FileChange[];
}

export interface IndexStorage {
	sql: Pick<SqlStorage, "exec">;
	transactionSync<T>(closure: () => T): T;
}

export const FILE_INDEX_SCHEMA = `
	CREATE TABLE file_mailboxes (
		mailbox_id TEXT PRIMARY KEY,
		generation INTEGER NOT NULL DEFAULT 0,
		enabled INTEGER NOT NULL DEFAULT 1,
		complete INTEGER NOT NULL DEFAULT 0,
		revision INTEGER NOT NULL DEFAULT 0
	);
	CREATE INDEX idx_file_mailboxes_progress ON file_mailboxes(enabled, complete);
	CREATE TABLE file_versions (
		mailbox_id TEXT NOT NULL,
		email_id TEXT NOT NULL,
		revision INTEGER NOT NULL,
		PRIMARY KEY(mailbox_id, email_id)
	);
	CREATE TABLE files (
		id INTEGER PRIMARY KEY,
		mailbox_id TEXT NOT NULL,
		email_id TEXT NOT NULL,
		attachment_id TEXT NOT NULL,
		filename TEXT NOT NULL,
		mimetype TEXT NOT NULL,
		size INTEGER NOT NULL,
		disposition TEXT,
		direction TEXT NOT NULL,
		is_inline INTEGER NOT NULL,
		subject TEXT NOT NULL,
		sender TEXT NOT NULL,
		recipient TEXT NOT NULL,
		date TEXT NOT NULL,
		folder_id TEXT NOT NULL,
		thread_id TEXT,
		search_text TEXT NOT NULL,
		UNIQUE(mailbox_id, attachment_id)
	);
	${[
		["date", ""], ["mailbox_date", "mailbox_id, "],
		["direction_date", "direction, "], ["mailbox_direction_date", "mailbox_id, direction, "],
	].flatMap(([name, prefix]) => [
		`CREATE INDEX idx_files_${name} ON files(${prefix}date DESC, ${prefix.includes("mailbox_id") ? "" : "mailbox_id DESC, "}email_id DESC, attachment_id DESC);`,
		`CREATE INDEX idx_files_visible_${name} ON files(${prefix}date DESC, ${prefix.includes("mailbox_id") ? "" : "mailbox_id DESC, "}email_id DESC, attachment_id DESC) WHERE is_inline=0;`,
	]).join("\n")}
	CREATE INDEX idx_files_email ON files(mailbox_id, email_id);
	CREATE VIRTUAL TABLE files_fts USING fts5(search_text, content='files', content_rowid='id', tokenize='trigram case_sensitive 1');
	CREATE TRIGGER files_ai AFTER INSERT ON files BEGIN
		INSERT INTO files_fts(rowid, search_text) VALUES(new.id, new.search_text);
	END;
	CREATE TRIGGER files_ad AFTER DELETE ON files BEGIN
		INSERT INTO files_fts(files_fts, rowid, search_text) VALUES('delete', old.id, old.search_text);
	END;
	CREATE TABLE file_discovery (
		id INTEGER PRIMARY KEY CHECK(id = 1),
		cursor TEXT,
		complete INTEGER NOT NULL DEFAULT 0
	);
	INSERT INTO file_discovery(id) VALUES(1);
	CREATE TABLE file_discovery_jobs (
		mailbox_id TEXT PRIMARY KEY,
		retry_at INTEGER NOT NULL DEFAULT 0,
		attempts INTEGER NOT NULL DEFAULT 0
	);
	CREATE INDEX idx_file_discovery_jobs_retry ON file_discovery_jobs(retry_at);
`;

const Cursor = z.object({
	v: z.literal(1),
	q: z.string(),
	direction: z.string(),
	includeInline: z.boolean(),
	page: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
	scope: z.string(),
	date: z.string().max(100),
	mailbox: z.string().max(320),
	attachment: z.string().max(500),
	email: z.string().max(500),
});

function encodeCursor(value: z.infer<typeof Cursor>): string {
	return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))))
		.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function buildFileQuery(input: z.input<typeof FileListQuery>, mailboxId?: string) {
	const options = FileListQuery.parse(input);
	const q = options.q.toLowerCase();
	const scope = mailboxId || "";
	const params: (string | number)[] = [];
	const conditions: string[] = [];
	const bind = (value: string | number) => { params.push(value); return "?"; };
	if (mailboxId) conditions.push(`f.mailbox_id = ${bind(mailboxId)}`);
	if (!options.includeInline) conditions.push("f.is_inline = 0");
	if (options.direction !== "all") conditions.push(`f.direction = ${bind(options.direction)}`);
	if (q) {
		// MATCH is a quoted literal, including punctuation and FTS operators.
		// Short searches scan metadata only; trigram needs 3 Unicode codepoints.
		if ([...q].length >= 3) conditions.push(`f.id IN (SELECT rowid FROM files_fts WHERE files_fts MATCH ${bind(`"${q.replace(/"/g, '""')}"`)})`);
		conditions.push(`instr(f.search_text, ${bind(q)}) > 0`);
	}
	const countWhere = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
	const countQuery = `SELECT COUNT(*) AS total FROM files f ${countWhere}`;
	const countParams = [...params];
	if (options.cursor) {
		let cursor: z.infer<typeof Cursor>;
		try {
			const bytes = Uint8Array.from(atob(options.cursor.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
			cursor = Cursor.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
		} catch { throw new Error("Invalid file cursor"); }
		if (cursor.scope !== scope || cursor.q !== q || cursor.direction !== options.direction || cursor.includeInline !== options.includeInline) throw new Error("File cursor does not match filters");
		options.page = cursor.page;
		conditions.push(`(f.date, f.mailbox_id, f.email_id, f.attachment_id) < (${bind(cursor.date)}, ${bind(cursor.mailbox)}, ${bind(cursor.email)}, ${bind(cursor.attachment)})`);
	}
	const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
	// Old bookmarked numeric pages remain valid; normal next/previous navigation
	// carries a cursor and seeks through the composite index without OFFSET.
	const offset = !options.cursor && options.page > 1;
	return {
		query: `SELECT f.mailbox_id AS mailboxId, f.email_id, f.attachment_id AS id, f.filename, f.mimetype, f.size,
			f.disposition, f.direction, f.subject, f.sender, f.recipient, f.date, f.folder_id, f.thread_id
			FROM files f ${where} ORDER BY f.date DESC, f.mailbox_id DESC, f.email_id DESC, f.attachment_id DESC LIMIT ?${offset ? " OFFSET ?" : ""}`,
		params: [...params, options.limit + 1, ...(offset ? [(options.page - 1) * options.limit] : [])],
		countQuery, countParams, options,
		cursorFor: (file: GlobalFile) => encodeCursor({ v: 1, scope, q, direction: options.direction, includeInline: options.includeInline,
			page: options.page + 1, date: file.date || "", mailbox: file.mailboxId, email: file.email_id, attachment: file.id }),
	};
}

/** Shared by both scopes. No R2 or mailbox RPCs run on the read path. */
export class FileIndexStore {
	private storage: IndexStorage;
	constructor(storage: IndexStorage) { this.storage = storage; }

	apply(batch: FileIndexBatch) {
		const { sql } = this.storage;
		return this.storage.transactionSync(() => {
			const current = [...sql.exec<{ generation: number; revision: number }>(
				"SELECT generation, revision FROM file_mailboxes WHERE mailbox_id = ?", batch.mailboxId,
			)][0];
			if (current && current.generation > batch.generation) return;
			if (!current || current.generation < batch.generation) {
				sql.exec("DELETE FROM files WHERE mailbox_id = ?", batch.mailboxId);
				sql.exec("DELETE FROM file_versions WHERE mailbox_id = ?", batch.mailboxId);
				sql.exec(`INSERT INTO file_mailboxes(mailbox_id, generation, enabled) VALUES(?, ?, ?)
					ON CONFLICT(mailbox_id) DO UPDATE SET generation=excluded.generation, enabled=excluded.enabled, complete=0, revision=0`,
					batch.mailboxId, batch.generation, Number(batch.enabled));
			}
			if (!batch.enabled) return;
			for (const change of batch.changes) {
				const version = [...sql.exec<{ revision: number }>("SELECT revision FROM file_versions WHERE mailbox_id = ? AND email_id = ?", batch.mailboxId, change.emailId)][0];
				if (version && version.revision >= change.revision) continue;
				sql.exec("DELETE FROM files WHERE mailbox_id = ? AND email_id = ?", batch.mailboxId, change.emailId);
				for (const file of change.files) {
					if (file.email_id !== change.emailId) throw new Error("File/email mapping mismatch");
					const searchText = [file.filename, file.subject, file.sender, file.recipient, batch.mailboxId].join("\n").toLowerCase();
					sql.exec(`INSERT INTO files(mailbox_id, email_id, attachment_id, filename, mimetype, size, disposition, direction, is_inline, subject, sender, recipient, date, folder_id, thread_id, search_text)
						VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
						batch.mailboxId, change.emailId, file.attachment_id, file.filename, file.mimetype, file.size,
						file.disposition, file.direction, Number(file.disposition?.toLowerCase() === "inline"), file.subject, file.sender, file.recipient, file.date, file.folder_id, file.thread_id, searchText);
				}
				sql.exec(`INSERT INTO file_versions(mailbox_id, email_id, revision) VALUES(?, ?, ?)
					ON CONFLICT(mailbox_id, email_id) DO UPDATE SET revision=excluded.revision`, batch.mailboxId, change.emailId, change.revision);
			}
			sql.exec("UPDATE file_mailboxes SET complete = ?, revision = ? WHERE mailbox_id = ? AND revision <= ?",
				Number(batch.complete), batch.through, batch.mailboxId, batch.through);
		});
	}

	list(input: z.input<typeof FileListQuery>, mailboxId?: string): GlobalFileListPage {
		let built = buildFileQuery(input, mailboxId);
		const total = [...this.storage.sql.exec<{ total: number }>(built.countQuery, ...built.countParams)][0].total;
		const totalPages = Math.max(1, Math.ceil(total / built.options.limit));
		if (built.options.page > totalPages) built = buildFileQuery({ ...built.options, page: totalPages, cursor: undefined }, mailboxId);
		const { query, params, options, cursorFor } = built;
		const rows = [...this.storage.sql.exec<GlobalFile & Record<string, SqlStorageValue>>(query, ...params)];
		const files = rows.slice(0, options.limit);
		const progress = [...this.storage.sql.exec<{ total: number; completed: number }>(
			`SELECT COUNT(*) AS total, COALESCE(SUM(complete), 0) AS completed FROM file_mailboxes WHERE enabled = 1${mailboxId ? " AND mailbox_id = ?" : ""}`,
			...(mailboxId ? [mailboxId] : []),
		)][0];
		const discoveryComplete = [...this.storage.sql.exec<{ complete: number }>("SELECT complete FROM file_discovery WHERE id = 1")][0].complete;
		const building = mailboxId ? !progress.total || progress.completed < progress.total : !discoveryComplete || progress.completed < progress.total;
		return {
			files, totalCount: total, totalPages, page: options.page, limit: options.limit, mailboxCount: progress.total,
			nextCursor: rows.length > options.limit ? cursorFor(files[files.length - 1]) : null,
			index: { state: building ? "building" : "ready", discoveredMailboxes: progress.total, completedMailboxes: progress.completed },
		};
	}
}
