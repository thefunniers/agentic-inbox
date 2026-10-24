import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";
import type { FileListOptions } from "../../shared/files";
import { applyMigrations } from "../durableObject/migrations";
import { FILE_INDEX_SCHEMA, FileIndexStore, type FileIndexBatch } from "../lib/file-index";

/** A single metadata index serves global and mailbox-scoped file queries. */
export class FileIndexDO extends DurableObject<Env> {
	private index: FileIndexStore;
	private started = false;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		applyMigrations(ctx.storage.sql, [{ name: "1_unified_files", sql: FILE_INDEX_SCHEMA }], ctx.storage);
		this.index = new FileIndexStore(ctx.storage);
	}

	async listFiles(options: FileListOptions, mailboxId?: string) {
		// Validate the query before scheduling work. Never fan out on the read path.
		const result = this.index.list(options, mailboxId);
		let queued = false;
		if (mailboxId) {
			const known = [...this.ctx.storage.sql.exec<{ generation: number }>("SELECT generation FROM file_mailboxes WHERE mailbox_id=?", mailboxId)][0];
			if (!known || known.generation === 0) {
				this.enqueue(mailboxId);
				// A requested mailbox takes priority over the historical catalogue.
				// Keep failure backoff intact when the page polls for progress.
				this.ctx.storage.sql.exec("UPDATE file_discovery_jobs SET retry_at=-1 WHERE mailbox_id=? AND attempts=0", mailboxId);
				queued = true;
			}
		}
		if (!this.started || queued) {
			this.started = true;
			await this.ctx.storage.setAlarm(Date.now() + 100);
		}
		return result;
	}

	async applyChanges(batch: FileIndexBatch) {
		this.index.apply(batch);
		// Keep discovery work durable until the source confirms its last batch,
		// rather than considering an alarm scheduled at the source "finished".
		this.ctx.storage.sql.exec(`DELETE FROM file_discovery_jobs WHERE mailbox_id=? AND EXISTS(
			SELECT 1 FROM file_mailboxes WHERE mailbox_id=? AND (complete=1 OR enabled=0)
		)`, batch.mailboxId, batch.mailboxId);
	}

	private enqueue(mailboxId: string) {
		this.ctx.storage.sql.exec("INSERT OR IGNORE INTO file_mailboxes(mailbox_id) VALUES(?)", mailboxId);
		this.ctx.storage.sql.exec(`INSERT OR IGNORE INTO file_discovery_jobs(mailbox_id)
			SELECT mailbox_id FROM file_mailboxes WHERE mailbox_id=? AND enabled=1 AND complete=0`, mailboxId);
	}

	async alarm() {
		// Pre-arm retries so a crash/RPC failure cannot strand the discovery queue.
		await this.ctx.storage.setAlarm(Date.now() + 30_000);
		const sql = this.ctx.storage.sql;
		const discovery = [...sql.exec<{ cursor: string | null; complete: number }>("SELECT * FROM file_discovery WHERE id=1")][0];
		if (!discovery.complete) {
			const page = await this.env.BUCKET.list({ prefix: "mailboxes/", cursor: discovery.cursor || undefined, limit: 100 });
			if (page.truncated && (!page.cursor || page.cursor === discovery.cursor)) throw new Error("File discovery cursor did not advance");
			this.ctx.storage.transactionSync(() => {
				for (const object of page.objects) {
					if (!object.key.endsWith(".json")) continue;
					const mailboxId = object.key.slice("mailboxes/".length, -5);
					if (mailboxId && !mailboxId.includes("/")) this.enqueue(mailboxId);
				}
				sql.exec("UPDATE file_discovery SET cursor=?, complete=? WHERE id=1", page.truncated ? page.cursor : null, Number(!page.truncated));
			});
		}
		const jobs = [...sql.exec<{ mailbox_id: string; attempts: number }>("SELECT mailbox_id, attempts FROM file_discovery_jobs WHERE retry_at<=? ORDER BY retry_at, mailbox_id LIMIT 5", Date.now())];
		await Promise.all(jobs.map(async (job) => {
			try {
				// The directory can change while discovery runs. Do not revive deleted mailboxes.
				if (await this.env.BUCKET.head(`mailboxes/${job.mailbox_id}.json`)) {
					await this.env.MAILBOX.get(this.env.MAILBOX.idFromName(job.mailbox_id)).ensureFileIndex(job.mailbox_id);
					sql.exec("UPDATE file_discovery_jobs SET retry_at=? WHERE mailbox_id=?", Date.now() + 30_000, job.mailbox_id);
				} else {
					sql.exec("DELETE FROM file_mailboxes WHERE mailbox_id=? AND generation=0", job.mailbox_id);
					sql.exec("DELETE FROM file_discovery_jobs WHERE mailbox_id=?", job.mailbox_id);
				}
			} catch (error) {
				console.error("File index mailbox discovery failed", job.mailbox_id, error);
				sql.exec("UPDATE file_discovery_jobs SET attempts=attempts+1, retry_at=? WHERE mailbox_id=?",
					Date.now() + Math.min(300_000, 1000 * 2 ** Math.min(job.attempts, 8)), job.mailbox_id);
			}
		}));
		const next = [...sql.exec<{ retry_at: number | null }>("SELECT MIN(retry_at) AS retry_at FROM file_discovery_jobs")][0].retry_at;
		const complete = [...sql.exec<{ complete: number }>("SELECT complete FROM file_discovery WHERE id=1")][0].complete;
		if (!complete || next !== null) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, complete ? next! : 0));
		else await this.ctx.storage.deleteAlarm();
	}
}
