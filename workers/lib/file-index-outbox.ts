import type { FileIndexBatch, IndexStorage } from "./file-index";
import { FILE_DIRECTION_SQL } from "./files.ts";

interface SyncState extends Record<string, SqlStorageValue> {
	mailbox_id: string;
	generation: number;
	enabled: number;
	backfill_cursor: string;
	backfill_done: number;
	ack_revision: number;
}

/** The journal and source mutations share a SQLite transaction via triggers. */
export class FileIndexOutbox {
	private storage: IndexStorage;
	constructor(storage: IndexStorage) { this.storage = storage; }

	state() {
		return [...this.storage.sql.exec<SyncState>("SELECT * FROM file_index_state WHERE id = 1")][0];
	}

	initialize(mailboxId: string, reactivate = false) {
		const state = this.state();
		if (state && state.mailbox_id !== mailboxId) throw new Error("Mailbox index identity mismatch");
		if (!state) this.storage.sql.exec("INSERT INTO file_index_state(id, mailbox_id) VALUES(1, ?)", mailboxId);
		else if (!state.enabled && reactivate) {
			this.storage.sql.exec("UPDATE file_index_state SET enabled=1, generation=generation+1, backfill_cursor='', backfill_done=0 WHERE id=1");
		}
	}

	disable() {
		this.storage.sql.exec("UPDATE file_index_state SET enabled=0, generation=generation+1 WHERE id=1 AND enabled=1");
	}

	pending() {
		const state = this.state();
		return !!state?.enabled && (!state.backfill_done || [...this.storage.sql.exec("SELECT 1 FROM file_index_outbox LIMIT 1")].length > 0);
	}

	nextBatch(limit = 25): FileIndexBatch | null {
		const state = this.state();
		if (!state) return null;
		const { sql } = this.storage;
		return this.storage.transactionSync(() => {
			// Backfill only attachment metadata, with a durable keyset checkpoint.
			// New arrivals before the checkpoint are already captured by triggers.
			if (state.enabled && !state.backfill_done) {
				const rows = [...sql.exec<{ email_id: string }>("SELECT DISTINCT email_id FROM attachments WHERE email_id > ? ORDER BY email_id LIMIT ?", state.backfill_cursor, limit)];
				for (const row of rows) sql.exec("INSERT OR IGNORE INTO file_index_outbox(email_id) VALUES(?)", row.email_id);
				sql.exec("UPDATE file_index_state SET backfill_cursor=?, backfill_done=? WHERE id=1",
					rows.at(-1)?.email_id ?? state.backfill_cursor, Number(rows.length < limit));
			}
			const entries = state.enabled ? [...sql.exec<{ revision: number; email_id: string }>("SELECT * FROM file_index_outbox ORDER BY revision LIMIT ?", limit)] : [];
			const through = entries.at(-1)?.revision ?? state.ack_revision;
			const changes = entries.map((entry) => ({
				revision: entry.revision,
				emailId: entry.email_id,
				files: [...sql.exec<{
					email_id: string; attachment_id: string; filename: string; mimetype: string; size: number;
					subject: string; sender: string; recipient: string; date: string; folder_id: string; thread_id: string | null; disposition: string | null; direction: "received" | "sent";
				}>(`SELECT a.email_id, a.id AS attachment_id, a.filename, a.mimetype, a.size, a.disposition, ${FILE_DIRECTION_SQL} AS direction,
					COALESCE(e.subject, '') AS subject, COALESCE(e.sender, '') AS sender,
					COALESCE(e.recipient, '') AS recipient, COALESCE(e.date, '') AS date, e.folder_id, e.thread_id
					FROM attachments a JOIN emails e ON e.id = a.email_id
					WHERE a.email_id = ? AND e.folder_id NOT IN ('draft', 'trash')`, state.mailbox_id.trim().toLowerCase(), entry.email_id)],
			}));
			const remaining = [...sql.exec("SELECT 1 FROM file_index_outbox WHERE revision > ? LIMIT 1", through)].length > 0;
			return { mailboxId: state.mailbox_id, generation: state.generation, enabled: !!state.enabled,
				through, complete: !!this.state().backfill_done && !remaining, changes };
		});
	}

	acknowledge(batch: FileIndexBatch) {
		if (this.state()?.generation !== batch.generation || !batch.enabled) return;
		this.storage.transactionSync(() => {
			this.storage.sql.exec("DELETE FROM file_index_outbox WHERE revision <= ?", batch.through);
			this.storage.sql.exec("UPDATE file_index_state SET ack_revision=MAX(ack_revision, ?) WHERE id=1", batch.through);
		});
	}
}
