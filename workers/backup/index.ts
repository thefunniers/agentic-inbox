import { DurableObject } from "cloudflare:workers";
import PostalMime from "postal-mime";
import type { Env } from "../types";
import { receiveEmail } from "../index";
import {
	backupMessage,
	classifyError,
	classifyForwardError,
	deliveryId,
	deliveryMode,
	FORWARD_WATCHDOG_MS,
	isAttentionState,
	MAX_ATTEMPTS,
	MAX_FORWARD_ATTEMPTS,
	retryDelay,
	type Delivery,
} from "./model";
import { isManagedMailboxAddress } from "../lib/provision-mailbox";

export interface ForwardPrepareResult {
	action: "forward" | "skip";
	attempt?: number;
	delivery: Delivery;
}

export interface ForwardFinishResult {
	shouldThrow: boolean;
	delivery: Delivery | null;
}

export class BackupDeliveryDO extends DurableObject<Env> {
	private tail: Promise<void> = Promise.resolve();
	private withLock<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.tail.then(fn, fn);
		this.tail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}
	async accept(input: Delivery, raw: ArrayBuffer) {
		await this.ctx.blockConcurrencyWhile(async () => {
			if (await this.ctx.storage.get("delivery")) return;
			await this.env.BUCKET.put(input.rawKey, raw);
			// A committed state and alarm are atomic; a crash cannot strand a pending job.
			await this.ctx.storage.transaction(async (txn) => {
				await txn.put("delivery", input);
				await txn.setAlarm(Date.now() + 1000);
			});
		});
		await this.process();
		return this.status();
	}
	async prepareForward(
		input: Delivery,
		raw: ArrayBuffer,
	): Promise<ForwardPrepareResult> {
		await this.ctx.blockConcurrencyWhile(async () => {
			if (await this.ctx.storage.get("delivery")) return;
			await this.env.BUCKET.put(input.rawKey, raw);
			await this.ctx.storage.transaction(async (txn) => {
				await txn.put("delivery", input);
				await txn.setAlarm(Date.now() + FORWARD_WATCHDOG_MS);
			});
		});
		return this.withLock(async () => {
			const d = (await this.status())!;
			if (!d.indexWritten) {
				await this.ctx.storage.setAlarm(Date.now() + 60_000);
				try {
					await this.env.BUCKET.put(
						`delivery-index/${d.mailbox}/${d.id}.json`,
						JSON.stringify({ id: d.id, mailbox: d.mailbox }),
					);
					d.indexWritten = true;
				} catch (error) {
					console.error("Backup index write during forward will retry", {
						id: d.id,
						error: String(error).slice(0, 500),
					});
				}
			}
			if (!d.inboxStored) {
				try {
					d.ingestAttempts++;
					await this.storeInInbox(d, raw);
					d.inboxStored = true;
				} catch (error) {
					d.error = `Inbox 保存失败：${String(error).slice(0, 500)}`;
					console.error("Inbox ingestion during forward will retry", {
						id: d.id,
						mailbox: d.mailbox,
						error: d.error,
					});
				}
			}
			if (d.backupDelivered || d.state === "submitted") {
				if (d.inboxStored && d.state !== "submitted") {
					d.state = "submitted";
					d.error = null;
					await this.save(d, null);
				} else {
					await this.ctx.storage.put("delivery", d);
				}
				return { action: "skip", delivery: d };
			}
			if (deliveryMode(d) !== "forward") {
				await this.ctx.storage.put("delivery", d);
				return { action: "skip", delivery: d };
			}
			if (["failed", "uncertain"].includes(d.state)) {
				await this.ctx.storage.put("delivery", d);
				return { action: "skip", delivery: d };
			}
			if (d.sending) {
				// If a concurrent attempt is still within its watchdog window, skip without clobbering it.
				if (d.nextAttempt && d.nextAttempt > Date.now()) {
					await this.ctx.storage.put("delivery", d);
					return { action: "skip", delivery: d };
				}
				d.sending = false;
				d.state = "uncertain";
				d.error =
					"上次原样转发被中断，可能已经送达。请核对目标邮箱后再决定是否发送回退副本。";
				await this.save(
					d,
					d.inboxStored && d.indexWritten !== false
						? null
						: Date.now() + 60_000,
				);
				return { action: "skip", delivery: d };
			}
			if (d.attempts >= MAX_FORWARD_ATTEMPTS) {
				d.state = "failed";
				d.error =
					d.error ||
					"原样转发重试次数已用尽。请核对目标邮箱，可下载原文或手动发送回退副本。";
				await this.save(
					d,
					d.inboxStored && d.indexWritten !== false
						? null
						: Date.now() + 60_000,
				);
				return { action: "skip", delivery: d };
			}
			d.attempts++;
			d.sending = true;
			d.state = d.attempts > 1 ? "retrying" : "pending";
			await this.save(d, Date.now() + FORWARD_WATCHDOG_MS);
			return { action: "forward", attempt: d.attempts, delivery: d };
		});
	}
	async finishForward(
		result:
			| { ok: true }
			| {
					ok: false;
					kind: "retry" | "failed" | "uncertain";
					error: string;
			  },
	): Promise<ForwardFinishResult> {
		return this.withLock(async () => {
			const d = await this.status();
			if (!d) return { shouldThrow: false, delivery: null };
			d.sending = false;
			if (result.ok) {
				d.backupDelivered = true;
				if (d.inboxStored) {
					d.state = "submitted";
					d.error = null;
					await this.save(d, null);
				} else {
					d.state = "retrying";
					d.error =
						d.error || "原样转发已提交，Inbox 入库失败，将自动重试入库。";
					await this.save(
						d,
						Date.now() + retryDelay(Math.max(1, d.ingestAttempts)),
					);
				}
				return { shouldThrow: false, delivery: d };
			}
			const shouldThrow =
				result.kind === "retry" && d.attempts < MAX_FORWARD_ATTEMPTS;
			if (shouldThrow) {
				d.state = "retrying";
				d.error = result.error;
				await this.save(d, Date.now() + FORWARD_WATCHDOG_MS);
			} else {
				d.state = result.kind === "uncertain" ? "uncertain" : "failed";
				d.error = result.error;
				const next =
					d.inboxStored && d.indexWritten !== false
						? null
						: Date.now() + retryDelay(Math.max(1, d.ingestAttempts));
				await this.save(d, next);
			}
			console.error("Backup forward requires attention", {
				id: d.id,
				mailbox: d.mailbox,
				state: d.state,
				attempts: d.attempts,
				shouldThrow,
				error: d.error,
			});
			return { shouldThrow, delivery: d };
		});
	}
	async status() {
		return (await this.ctx.storage.get<Delivery>("delivery")) || null;
	}
	async retry() {
		await this.withLock(async () => {
			const d = await this.status();
			if (!d || !["failed", "uncertain"].includes(d.state))
				throw new Error("Only failed or uncertain copies can be retried");
			if (d.backupDelivered && !d.inboxStored) {
				d.state = "retrying";
				d.sending = false;
				d.error = null;
				d.ingestAttempts = 0;
				await this.save(d, Date.now() + 1000);
				return;
			}
			if (deliveryMode(d) === "forward") {
				const fallbackFrom = d.from || this.env.BACKUP_FROM || "";
				if (!fallbackFrom)
					throw new Error("Backup fallback sender not configured");
				d.from = fallbackFrom;
				d.mode = "notification";
				d.fallbackFrom = "forward";
			}
			d.state = "pending";
			d.sending = false;
			d.error = null;
			d.attempts = 0;
			d.ingestAttempts = 0;
			await this.save(d, Date.now() + 1000);
		});
	}
	private async save(d: Delivery, next: number | null) {
		d.nextAttempt = next;
		d.history = [
			...(d.history || []),
			{
				at: new Date().toISOString(),
				state: d.state,
				attempts: d.attempts,
				error: d.error,
			},
		].slice(-100);
		// Publish attention before committing; status remains authoritative.
		// If R2 is unavailable while recording a terminal alert, retain a recovery
		// alarm so the alert is published on retry without bubbling out of email().
		let alarmTarget = next;
		const attentionKey = `delivery-attention/${d.mailbox}/${d.id}.json`;
		if (isAttentionState(d.state)) {
			try {
				await this.env.BUCKET.put(
					attentionKey,
					JSON.stringify({ id: d.id, mailbox: d.mailbox }),
				);
				d.attentionWritten = true;
			} catch (error) {
				d.attentionWritten = false;
				const retryAt = Date.now() + 60_000;
				alarmTarget =
					alarmTarget === null ? retryAt : Math.min(alarmTarget, retryAt);
				console.error("Backup attention write will retry", {
					id: d.id,
					error: String(error).slice(0, 500),
				});
			}
		} else {
			d.attentionWritten = undefined;
		}
		await this.ctx.storage.transaction(async (txn) => {
			await txn.put("delivery", d);
			// Cleanup has its own durable wakeup even though sending is complete.
			if (d.state === "submitted") await txn.setAlarm(Date.now() + 60_000);
			else if (alarmTarget !== null) await txn.setAlarm(alarmTarget);
			else await txn.deleteAlarm();
		});
		if (d.state === "submitted") await this.cleanSubmittedIndex(d);
	}
	private async cleanSubmittedIndex(d: Delivery) {
		// Rearm before I/O: repeated R2 outages must not exhaust alarm retries.
		await this.ctx.storage.setAlarm(Date.now() + 60_000);
		if (d.indexWritten === false) {
			try {
				await this.env.BUCKET.put(
					`delivery-index/${d.mailbox}/${d.id}.json`,
					JSON.stringify({ id: d.id, mailbox: d.mailbox }),
				);
				d.indexWritten = true;
				await this.ctx.storage.put("delivery", d);
			} catch (error) {
				console.error("Backup index backfill will retry", {
					id: d.id,
					error: String(error).slice(0, 500),
				});
				return;
			}
		}
		try {
			await this.env.BUCKET.delete(
				`delivery-attention/${d.mailbox}/${d.id}.json`,
			);
		} catch (error) {
			console.error("Backup index cleanup will retry", {
				id: d.id,
				error: String(error),
			});
			return;
		}
		await this.ctx.storage.deleteAlarm();
	}
	private async ensureAlertIndexes(d: Delivery): Promise<boolean> {
		const recoveryAt = Date.now() + 60_000;
		await this.ctx.storage.setAlarm(recoveryAt);
		if (d.indexWritten === false) {
			try {
				await this.env.BUCKET.put(
					`delivery-index/${d.mailbox}/${d.id}.json`,
					JSON.stringify({ id: d.id, mailbox: d.mailbox }),
				);
				d.indexWritten = true;
				await this.ctx.storage.put("delivery", d);
			} catch (error) {
				console.error("Backup index write will retry", {
					id: d.id,
					error: String(error).slice(0, 500),
				});
				return false;
			}
		}
		if (isAttentionState(d.state) && d.attentionWritten === false) {
			try {
				await this.env.BUCKET.put(
					`delivery-attention/${d.mailbox}/${d.id}.json`,
					JSON.stringify({ id: d.id, mailbox: d.mailbox }),
				);
				d.attentionWritten = true;
				await this.ctx.storage.put("delivery", d);
			} catch (error) {
				console.error("Backup attention write will retry", {
					id: d.id,
					error: String(error).slice(0, 500),
				});
				return false;
			}
		}
		return true;
	}
	protected async storeInInbox(d: Delivery, raw: ArrayBuffer) {
		await receiveEmail(
			{
				raw: new Response(raw).body!,
				rawSize: raw.byteLength,
				to: d.mailbox,
				from: d.sender,
				deliveryId: d.id,
				receivedAt: d.receivedAt,
			},
			this.env,
			this.ctx as unknown as ExecutionContext,
		);
	}
	private async ingestFromR2(d: Delivery): Promise<ArrayBuffer> {
		d.ingestAttempts++;
		const obj = await this.env.BUCKET.get(d.rawKey);
		if (!obj) throw new Error("原始 EML 不存在");
		const raw = await obj.arrayBuffer();
		if (!d.inboxStored) {
			await this.storeInInbox(d, raw);
			d.inboxStored = true;
		}
		return raw;
	}
	async alarm() {
		await this.process();
	}
	private async process() {
		return this.withLock(() => this.run());
	}
	protected async sendCopy(d: Delivery, raw: ArrayBuffer) {
		return this.env.EMAIL.send(backupMessage(d, raw) as any);
	}
	private async runForwardAlarm(d: Delivery) {
		if (!(await this.ensureAlertIndexes(d))) return;
		if (d.sending) {
			if (d.nextAttempt && d.nextAttempt > Date.now() + 1500) {
				await this.ctx.storage.setAlarm(d.nextAttempt);
				return;
			}
			d.sending = false;
			if (!d.inboxStored) {
				try {
					await this.ingestFromR2(d);
				} catch (error) {
					console.error("Inbox ingestion after interrupted forward failed", {
						id: d.id,
						error: String(error).slice(0, 500),
					});
				}
			}
			d.state = "uncertain";
			d.error =
				"上次原样转发被中断，可能已经送达。请核对目标邮箱后再决定是否发送回退副本。";
			await this.save(
				d,
				d.inboxStored
					? null
					: Date.now() + retryDelay(Math.max(1, d.ingestAttempts)),
			);
			return;
		}
		if (d.backupDelivered && !d.inboxStored) {
			if (d.nextAttempt && d.nextAttempt > Date.now() + 1500) {
				await this.ctx.storage.setAlarm(d.nextAttempt);
				return;
			}
			try {
				await this.ingestFromR2(d);
				d.state = "submitted";
				d.error = null;
				await this.save(d, null);
			} catch (error) {
				d.state = d.ingestAttempts >= MAX_ATTEMPTS ? "failed" : "retrying";
				d.error = `原样转发已提交，但 Inbox 保存失败：${String(error).slice(0, 500)}`;
				await this.save(
					d,
					d.state === "failed"
						? null
						: Date.now() + retryDelay(Math.max(1, d.ingestAttempts)),
				);
			}
			return;
		}
		if (["failed", "uncertain"].includes(d.state)) {
			if (!d.inboxStored && d.ingestAttempts < MAX_ATTEMPTS) {
				if (d.nextAttempt && d.nextAttempt > Date.now() + 1500) {
					await this.ctx.storage.setAlarm(d.nextAttempt);
					return;
				}
				try {
					await this.ingestFromR2(d);
					await this.save(d, null);
				} catch (error) {
					console.error("Inbox ingestion retry on failed forward errored", {
						id: d.id,
						error: String(error).slice(0, 500),
					});
					const next =
						d.ingestAttempts >= MAX_ATTEMPTS
							? null
							: Date.now() + retryDelay(Math.max(1, d.ingestAttempts));
					await this.save(d, next);
				}
				return;
			}
			await this.ctx.storage.deleteAlarm();
			return;
		}
		if (d.nextAttempt && d.nextAttempt > Date.now() + 1500) {
			await this.ctx.storage.setAlarm(d.nextAttempt);
			return;
		}
		// Forward watchdog expired without a subsequent platform retry.
		if (!d.inboxStored) {
			try {
				await this.ingestFromR2(d);
			} catch (error) {
				console.error("Inbox ingestion during forward timeout failed", {
					id: d.id,
					error: String(error).slice(0, 500),
				});
			}
		}
		d.state = "failed";
		d.error = d.error
			? `原样转发未收到平台后续重投（上次错误：${d.error}）。请核对目标邮箱，可下载原文或手动发送回退副本。`.slice(
					0,
					500,
				)
			: "原样转发未完成。请核对目标邮箱，可下载原文或手动发送回退副本。";
		await this.save(
			d,
			d.inboxStored
				? null
				: Date.now() + retryDelay(Math.max(1, d.ingestAttempts)),
		);
	}
	private async run() {
		const d = await this.status();
		if (!d) return;
		if (d.state === "submitted") {
			await this.cleanSubmittedIndex(d);
			return;
		}
		if (deliveryMode(d) === "forward") {
			await this.runForwardAlarm(d);
			return;
		}
		if (["failed", "uncertain"].includes(d.state)) {
			if (!(await this.ensureAlertIndexes(d))) return;
			await this.ctx.storage.deleteAlarm();
			return;
		}
		if (
			(d.attentionWritten === false || d.indexWritten === false) &&
			!(await this.ensureAlertIndexes(d))
		)
			return;
		if (d.nextAttempt && d.nextAttempt > Date.now() + 1500) {
			await this.ctx.storage.setAlarm(d.nextAttempt);
			return;
		}
		// A consumed alarm must be replaced before external I/O, independently
		// of the platform's bounded automatic retries.
		const recoveryAt = Date.now() + 60_000;
		await this.ctx.storage.setAlarm(recoveryAt);
		try {
			// Immutable index permits discovery even when Inbox ingestion fails.
			await this.env.BUCKET.put(
				`delivery-index/${d.mailbox}/${d.id}.json`,
				JSON.stringify({ id: d.id, mailbox: d.mailbox }),
			);
			d.indexWritten = true;
		} catch (error) {
			d.error = `投递索引写入失败，将自动重试：${String(error).slice(0, 500)}`;
			d.nextAttempt = recoveryAt;
			await this.ctx.storage.put("delivery", d);
			console.error("Backup index write will retry", {
				id: d.id,
				error: d.error,
			});
			return;
		}
		if (d.sending) {
			d.state = "uncertain";
			d.error = "上次发送被中断，可能已经送达。请核对目标邮箱后再重试。";
			await this.save(d, null);
			return;
		}
		let raw: ArrayBuffer;
		try {
			const hadInbox = d.inboxStored;
			raw = await this.ingestFromR2(d);
			if (!hadInbox && d.inboxStored) {
				await this.save(d, Date.now() + 1000);
			}
		} catch (error) {
			d.state = d.ingestAttempts >= MAX_ATTEMPTS ? "failed" : "retrying";
			d.error = `Inbox 保存失败：${String(error).slice(0, 500)}`;
			await this.save(
				d,
				d.state === "failed"
					? null
					: Date.now() + retryDelay(Math.max(1, d.ingestAttempts)),
			);
			return;
		}
		if (d.backupDelivered) {
			d.state = "submitted";
			d.error = null;
			await this.save(d, null);
			return;
		}
		d.attempts++;
		d.sending = true;
		// If execution dies after send, the next alarm stops for reconciliation.
		await this.save(d, Date.now() + 120_000);
		let result: { messageId: string };
		try {
			result = await this.sendCopy(d, raw);
		} catch (error) {
			const kind = classifyError(error);
			d.sending = false;
			d.state =
				kind === "retry" && d.attempts < MAX_ATTEMPTS
					? "retrying"
					: kind === "uncertain"
						? "uncertain"
						: "failed";
			d.error = String(error).slice(0, 500);
			await this.save(
				d,
				d.state === "retrying" ? Date.now() + retryDelay(d.attempts) : null,
			);
			console.error("Backup requires attention", {
				id: d.id,
				mailbox: d.mailbox,
				state: d.state,
				error: d.error,
			});
			return;
		}
		d.sending = false;
		d.backupDelivered = true;
		d.state = "submitted";
		d.providerId = result.messageId;
		d.error = null;
		await this.save(d, null);
	}
}

async function parseAndPrepareDelivery(
	message: { raw: ReadableStream; rawSize: number; to: string; from: string },
	env: Env,
	mode: "forward" | "notification",
) {
	const mailbox = message.to.trim().toLowerCase();
	if (!isManagedMailboxAddress(mailbox, env))
		throw new Error("Unmanaged recipient");
	const allowed = ((env.EMAIL_ADDRESSES as string[]) || []).map((a) =>
		a.toLowerCase(),
	);
	if (allowed.length && !allowed.includes(mailbox))
		throw new Error("Recipient not allowed");
	if (message.rawSize > 25 * 1024 * 1024) throw new Error("Email too large");
	const raw = await new Response(message.raw).arrayBuffer();
	if (raw.byteLength > 25 * 1024 * 1024) throw new Error("Email too large");
	const parsed = await PostalMime.parse(raw);
	const id = await deliveryId(
		mailbox,
		message.from.toLowerCase(),
		parsed.messageId,
		raw,
	);
	const target = mailbox.endsWith("@dev.jdtogo.ai")
		? env.BACKUP_DEV_EMAIL || env.BACKUP_EMAIL
		: env.BACKUP_EMAIL;
	const from = (env.BACKUP_FROM as string | undefined) || "";
	if (!target || (mode === "notification" && !from))
		throw new Error("Backup sender/recipient not configured");
	if (
		env.DEPLOYMENT_ENV === "dev" &&
		(!mailbox.endsWith("@dev.jdtogo.ai") || target !== "dev@jdtogo.com")
	)
		throw new Error("Dev delivery isolation violation");
	const d: Delivery = {
		id,
		mailbox,
		sender: parsed.from?.address || message.from,
		subject: parsed.subject || "(无主题)",
		originalMessageId: parsed.messageId || null,
		target,
		from,
		rawKey: `originals/${mailbox}/${id}.eml`,
		receivedAt: new Date().toISOString(),
		mode,
		backupDelivered: false,
		indexWritten: false,
		state: "pending",
		inboxStored: false,
		attempts: 0,
		ingestAttempts: 0,
		error: null,
		nextAttempt: Date.now() + (mode === "forward" ? FORWARD_WATCHDOG_MS : 1000),
	};
	return { d, raw };
}

export async function acceptBackup(
	message: { raw: ReadableStream; rawSize: number; to: string; from: string },
	env: Env,
) {
	const { d, raw } = await parseAndPrepareDelivery(message, env, "notification");
	return env.BACKUP_DELIVERY.get(
		env.BACKUP_DELIVERY.idFromName(`${d.mailbox}/${d.id}`),
	).accept(d, raw);
}

export async function acceptForwardBackup(
	message: {
		raw: ReadableStream;
		rawSize: number;
		to: string;
		from: string;
		forward: (recipient: string) => Promise<unknown>;
	},
	env: Env,
) {
	const { d, raw } = await parseAndPrepareDelivery(message, env, "forward");
	const stub = env.BACKUP_DELIVERY.get(
		env.BACKUP_DELIVERY.idFromName(`${d.mailbox}/${d.id}`),
	);
	const prep = await stub.prepareForward(d, raw);
	if (prep.action !== "forward") return prep.delivery;
	try {
		await message.forward(d.target);
	} catch (error) {
		const outcome = await stub.finishForward({
			ok: false,
			kind: classifyForwardError(error),
			error: String(error).slice(0, 500),
		});
		if (outcome.shouldThrow) throw error;
		return outcome.delivery;
	}
	const outcome = await stub.finishForward({ ok: true });
	return outcome.delivery;
}
