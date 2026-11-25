import {
	BackupDeliveryDO as Base,
	acceptBackup,
	acceptForwardBackup,
} from "../../workers/backup";
import { backupRoutes } from "../../workers/backup/routes";
import { backupMessage, type Delivery } from "../../workers/backup/model";
export { MailboxDO } from "../../workers/durableObject";
export { FileIndexDO } from "../../workers/fileIndex";
export class BackupDeliveryDO extends Base {
	constructor(ctx: DurableObjectState, env: any) {
		const bucket = new Proxy(env.BUCKET, {
			get(target, property) {
				if (property === "put")
					return async (key: string, ...args: any[]) => {
						const failures =
							(await ctx.storage.get<number>("indexWriteFailures")) || 0;
						if (key.startsWith("delivery-index/") && failures > 0) {
							await ctx.storage.put("indexWriteFailures", failures - 1);
							throw new Error("Injected index write outage");
						}
						const attentionFailures =
							(await ctx.storage.get<number>("attentionWriteFailures")) || 0;
						if (
							key.startsWith("delivery-attention/") &&
							attentionFailures > 0
						) {
							await ctx.storage.put(
								"attentionWriteFailures",
								attentionFailures - 1,
							);
							throw new Error("Injected attention write outage");
						}
						return target.put(key, ...args);
					};
				if (property === "delete")
					return async (key: string | string[]) => {
						const failures =
							(await ctx.storage.get<number>("cleanupFailures")) || 0;
						if (
							typeof key === "string" &&
							key.startsWith("delivery-attention/") &&
							failures > 0
						) {
							await ctx.storage.put("cleanupFailures", failures - 1);
							throw new Error("Injected R2 delete outage");
						}
						return target.delete(key);
					};
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		super(ctx, { ...env, BUCKET: bucket });
	}
	protected async storeInInbox(d: Delivery, raw: ArrayBuffer) {
		const failures =
			(await this.ctx.storage.get<number>("inboxWriteFailures")) || 0;
		if (failures > 0) {
			await this.ctx.storage.put("inboxWriteFailures", failures - 1);
			throw new Error("Injected inbox write failure");
		}
		return super.storeInInbox(d, raw);
	}
	async failIndexWrites() {
		await this.ctx.storage.put("indexWriteFailures", 8);
	}
	async failAttentionWrites(count = 2) {
		await this.ctx.storage.put("attentionWriteFailures", count);
	}
	async failInboxWrites(count = 1) {
		await this.ctx.storage.put("inboxWriteFailures", count);
	}
	async consumeAlarm() {
		if ((await this.ctx.storage.getAlarm()) === null)
			throw new Error("No durable wakeup");
		// Simulate consuming the scheduled alarm, then advance its logical due time.
		// Unlike a direct alarm() call, an old alarm cannot make this test pass.
		await this.ctx.storage.deleteAlarm();
		const delivery = await this.advance();
		return { delivery, alarm: await this.ctx.storage.getAlarm() };
	}
	async failCleanup() {
		await this.ctx.storage.put("cleanupFailures", 2);
	}
	async cleanupStatus() {
		const d = (await this.status())!;
		return {
			alarm: await this.ctx.storage.getAlarm(),
			indexed: !!(await this.env.BUCKET.head(
				`delivery-attention/${d.mailbox}/${d.id}.json`,
			)),
			discoverable: !!(await this.env.BUCKET.head(
				`delivery-index/${d.mailbox}/${d.id}.json`,
			)),
		};
	}
	async seed(d: Delivery) {
		await this.ctx.storage.put("delivery", d);
		await this.env.BUCKET.put(
			`delivery-attention/${d.mailbox}/${d.id}.json`,
			"{}",
		);
	}
	async seedLegacyNotification(d: Delivery, raw: ArrayBuffer) {
		await this.env.BUCKET.put(d.rawKey, raw);
		await this.env.BUCKET.put(
			`delivery-index/${d.mailbox}/${d.id}.json`,
			JSON.stringify({ id: d.id, mailbox: d.mailbox }),
		);
		await this.ctx.storage.put("delivery", d);
		await this.ctx.storage.setAlarm(Date.now() + 1000);
	}

	protected async sendCopy(d: Delivery, raw: ArrayBuffer) {
		if ((d.subject === "rate" && d.attempts === 1) || d.subject === "exhaust")
			throw Object.assign(new Error("rate limited"), {
				code: "E_RATE_LIMIT_EXCEEDED",
			});
		if (d.subject === "permanent")
			throw Object.assign(new Error("suppressed"), {
				code: "E_RECIPIENT_SUPPRESSED",
			});
		if (d.subject === "unknown") throw new Error("connection lost");
		const message = backupMessage(d, raw);
		await this.env.BUCKET.put(
			`capture/${d.id}`,
			JSON.stringify({
				...message,
				attachments: message.attachments.map((a) => ({
					...a,
					content: Array.from(new Uint8Array(a.content)),
				})),
			}),
		);
		return { messageId: "fixture-" + d.id };
	}
	async advance() {
		const d = await this.status();
		if (d) {
			d.nextAttempt = 0;
			await this.ctx.storage.put("delivery", d);
		}
		await this.alarm();
		return this.status();
	}
	async interrupted() {
		const d = await this.status();
		if (d) {
			d.state = "pending";
			d.sending = true;
			d.nextAttempt = null;
			await this.ctx.storage.put("delivery", d);
		}
		await this.alarm();
		return this.status();
	}
	async forceSending(futureMs: number | null) {
		const d = await this.status();
		if (d) {
			d.state = "pending";
			d.backupDelivered = false;
			d.sending = true;
			d.nextAttempt = futureMs === null ? null : Date.now() + futureMs;
			await this.ctx.storage.put("delivery", d);
		}
		return this.status();
	}
}
export default {
	async fetch(r: Request, env: any, ctx: ExecutionContext) {
		if (new URL(r.url).pathname.startsWith("/api/"))
			return backupRoutes.fetch(r, env, ctx);
		const url = new URL(r.url),
			id = url.searchParams.get("id"),
			mailbox = url.searchParams.get("mailbox") || "student@dev.jdtogo.ai";
		const stub = id
			? env.BACKUP_DELIVERY.get(
					env.BACKUP_DELIVERY.idFromName(`${mailbox}/${id}`),
				)
			: null;
		if (url.pathname === "/ingest") {
			const raw = await r.arrayBuffer();
			return Response.json(
				await acceptBackup(
					{
						to: mailbox,
						from: "school@example.com",
						raw: new Response(raw).body!,
						rawSize: raw.byteLength,
					},
					env,
				),
			);
		}
		if (url.pathname === "/forward-ingest") {
			const raw = await r.arrayBuffer();
			const behavior = url.searchParams.get("behavior") || "ok";
			const failInbox = Number(url.searchParams.get("failInbox") || "0");
			const failAttention = Number(
				url.searchParams.get("failAttention") || "0",
			);
			const preId = url.searchParams.get("preId");
			if (preId && failInbox > 0) {
				await env.BACKUP_DELIVERY.get(
					env.BACKUP_DELIVERY.idFromName(`${mailbox}/${preId}`),
				).failInboxWrites(failInbox);
			}
			if (preId && failAttention > 0) {
				await env.BACKUP_DELIVERY.get(
					env.BACKUP_DELIVERY.idFromName(`${mailbox}/${preId}`),
				).failAttentionWrites(failAttention);
			}
			const forwarded: string[] = [];
			try {
				const delivery = await acceptForwardBackup(
					{
						to: mailbox,
						from: "school@example.com",
						raw: new Response(raw).body!,
						rawSize: raw.byteLength,
						async forward(target: string) {
							forwarded.push(target);
							if (behavior === "transient")
								throw new Error("451 4.3.0 Temporary local problem");
							if (behavior === "permanent")
								throw new Error("550 5.1.1 Destination rejected");
							if (behavior === "uncertain")
								throw new Error("connection reset while forwarding");
							await env.BUCKET.put(
								`forward-capture/${mailbox}/${Date.now()}-${Math.random()}`,
								JSON.stringify({ target, bytes: raw.byteLength }),
							);
						},
					},
					env,
				);
				return Response.json({ threw: false, forwarded, delivery });
			} catch (error) {
				return Response.json({
					threw: true,
					forwarded,
					error: String(error),
				});
			}
		}
		if (url.pathname === "/seed-legacy") {
			const raw = await r.arrayBuffer();
			const legacyId = url.searchParams.get("id")!;
			const legacyStub = env.BACKUP_DELIVERY.get(
				env.BACKUP_DELIVERY.idFromName(`${mailbox}/${legacyId}`),
			);
			await legacyStub.seedLegacyNotification(
				{
					id: legacyId,
					mailbox,
					sender: "legacy-school@example.com",
					subject: "Legacy notification in flight",
					originalMessageId: "<legacy@example.com>",
					target: "dev@jdtogo.com",
					from: "inbox-notify@jdtogo.ai",
					rawKey: `originals/${mailbox}/${legacyId}.eml`,
					receivedAt: "2026-11-20T00:00:00.000Z",
					state: "retrying",
					inboxStored: true,
					attempts: 1,
					ingestAttempts: 1,
					error: "rate limited",
					nextAttempt: 0,
				},
				raw,
			);
			return Response.json({ ok: true });
		}
		if (url.pathname === "/fail-index-writes") {
			await stub.failIndexWrites();
			return Response.json({ ok: true });
		}
		if (url.pathname === "/fail-inbox-writes") {
			await stub.failInboxWrites(Number(url.searchParams.get("count") || "1"));
			return Response.json({ ok: true });
		}
		if (url.pathname === "/fail-attention-writes") {
			await stub.failAttentionWrites(
				Number(url.searchParams.get("count") || "2"),
			);
			return Response.json({ ok: true });
		}
		if (url.pathname === "/consume-alarm")
			return Response.json(await stub.consumeAlarm());
		if (url.pathname === "/fail-cleanup") {
			await stub.failCleanup();
			return Response.json({ ok: true });
		}
		if (url.pathname === "/cleanup-status")
			return Response.json(await stub.cleanupStatus());
		if (url.pathname === "/seed-stale-page") {
			const seedMailbox = "pagination@dev.jdtogo.ai";
			for (let i = 0; i < 54; i++) {
				const id = i.toString(16).padStart(64, "0");
				await env.BACKUP_DELIVERY.get(
					env.BACKUP_DELIVERY.idFromName(`${seedMailbox}/${id}`),
				).seed({
					id,
					mailbox: seedMailbox,
					state:
						i < 51
							? "submitted"
							: i === 51
								? "pending"
								: i === 52
									? "failed"
									: "uncertain",
				});
			}
			return Response.json({ ok: true });
		}
		if (url.pathname === "/advance") return Response.json(await stub.advance());
		if (url.pathname === "/interrupted")
			return Response.json(await stub.interrupted());
		if (url.pathname === "/force-sending")
			return Response.json(
				await stub.forceSending(
					url.searchParams.has("futureMs")
						? Number(url.searchParams.get("futureMs"))
						: null,
				),
			);
		if (url.pathname === "/retry") {
			await stub.retry();
			return Response.json(await stub.status());
		}
		if (url.pathname === "/capture") {
			const obj = await env.BUCKET.get(`capture/${id}`);
			return obj ? new Response(await obj.text()) : new Response("null");
		}
		if (url.pathname === "/emails")
			return Response.json(
				await env.MAILBOX.get(env.MAILBOX.idFromName(mailbox)).getEmails({
					folder: "inbox",
					limit: 100,
				}),
			);
		return Response.json(await stub.status());
	},
};
