import { BackupDeliveryDO as Base, acceptBackup } from "../../workers/backup";
import { backupRoutes } from "../../workers/backup/routes";
import { backupMessage, type Delivery } from "../../workers/backup/model";
export { MailboxDO } from "../../workers/durableObject";
export { FileIndexDO } from "../../workers/fileIndex";
export class BackupDeliveryDO extends Base {
	constructor(ctx: DurableObjectState, env: any) {
		const bucket = new Proxy(env.BUCKET, {
			get(target, property) {
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
		};
	}
	async seed(d: Delivery) {
		await this.ctx.storage.put("delivery", d);
		await this.env.BUCKET.put(
			`delivery-attention/${d.mailbox}/${d.id}.json`,
			"{}",
		);
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
			await this.ctx.storage.put("delivery", d);
		}
		await this.alarm();
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
		if (url.pathname === "/retry") {
			await stub.retry();
			return Response.json(await stub.status());
		}
		if (url.pathname === "/capture")
			return new Response(await (await env.BUCKET.get(`capture/${id}`)).text());
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
