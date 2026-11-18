import { BackupDeliveryDO as Base, acceptBackup } from "../../workers/backup";
import { backupRoutes } from "../../workers/backup/routes";
import { backupMessage, type Delivery } from "../../workers/backup/model";
export { MailboxDO } from "../../workers/durableObject";
export { FileIndexDO } from "../../workers/fileIndex";
export class BackupDeliveryDO extends Base {
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
