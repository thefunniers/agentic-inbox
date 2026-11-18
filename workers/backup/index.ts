import { DurableObject } from "cloudflare:workers";
import PostalMime from "postal-mime";
import type { Env } from "../types";
import { receiveEmail } from "../index";
import {
	backupMessage,
	classifyError,
	deliveryId,
	MAX_ATTEMPTS,
	retryDelay,
	type Delivery,
} from "./model";
import { isManagedMailboxAddress } from "../lib/provision-mailbox";

export class BackupDeliveryDO extends DurableObject<Env> {
	private busy: Promise<void> | null = null;
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
	async status() {
		return (await this.ctx.storage.get<Delivery>("delivery")) || null;
	}
	async retry() {
		await this.ctx.blockConcurrencyWhile(async () => {
			const d = await this.status();
			if (!d || !["failed", "uncertain"].includes(d.state))
				throw new Error("Only failed or uncertain copies can be retried");
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
		const attentionKey = `delivery-attention/${d.mailbox}/${d.id}.json`;
		if (["failed", "uncertain", "retrying"].includes(d.state)) {
			await this.env.BUCKET.put(
				attentionKey,
				JSON.stringify({ id: d.id, mailbox: d.mailbox }),
			);
		}
		await this.ctx.storage.transaction(async (txn) => {
			await txn.put("delivery", d);
			if (next !== null) await txn.setAlarm(next);
			else await txn.deleteAlarm();
		});
		if (d.state === "submitted")
			await this.env.BUCKET.delete(attentionKey).catch(() => {});
	}
	async alarm() {
		await this.process();
	}
	private async process() {
		if (this.busy) return this.busy;
		this.busy = this.run().finally(() => {
			this.busy = null;
		});
		return this.busy;
	}
	protected async sendCopy(d: Delivery, raw: ArrayBuffer) {
		return this.env.EMAIL.send(backupMessage(d, raw) as any);
	}
	private async run() {
		const d = await this.status();
		if (!d) return;
		// Immutable index permits discovery even when Inbox ingestion has failed.
		await this.env.BUCKET.put(
			`delivery-index/${d.mailbox}/${d.id}.json`,
			JSON.stringify({ id: d.id, mailbox: d.mailbox }),
		);
		if (["submitted", "failed", "uncertain"].includes(d.state)) return;
		if (d.sending) {
			d.state = "uncertain";
			d.error = "上次发送被中断，可能已经送达。请核对目标邮箱后再重试。";
			await this.save(d, null);
			return;
		}
		if (d.nextAttempt && d.nextAttempt > Date.now() + 1500) return;
		let raw: ArrayBuffer;
		try {
			d.ingestAttempts++;
			const obj = await this.env.BUCKET.get(d.rawKey);
			if (!obj) throw new Error("原始 EML 不存在");
			raw = await obj.arrayBuffer();
			if (!d.inboxStored) {
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
				d.inboxStored = true;
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
		d.state = "submitted";
		d.providerId = result.messageId;
		d.error = null;
		await this.save(d, null);
	}
}

export async function acceptBackup(
	message: { raw: ReadableStream; rawSize: number; to: string; from: string },
	env: Env,
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
		? env.BACKUP_DEV_EMAIL
		: env.BACKUP_EMAIL;
	if (!target || !env.BACKUP_FROM)
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
		from: env.BACKUP_FROM,
		rawKey: `originals/${mailbox}/${id}.eml`,
		receivedAt: new Date().toISOString(),
		state: "pending",
		inboxStored: false,
		attempts: 0,
		ingestAttempts: 0,
		error: null,
		nextAttempt: Date.now() + 1000,
	};
	return env.BACKUP_DELIVERY.get(
		env.BACKUP_DELIVERY.idFromName(`${mailbox}/${id}`),
	).accept(d, raw);
}
