// Local-only integration fixture. Never imported by the application entrypoint.
import { app } from "../../workers/index";
import type { Env } from "../../workers/types";
export { MailboxDO } from "../../workers/durableObject";
export { FileIndexDO } from "../../workers/fileIndex";

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);
		if (url.pathname === "/__fixture/seed") {
			const { mailboxId, count = 1, initialize = true, prefix = "mail", inline = false } = await request.json() as {
				mailboxId: string; count?: number; initialize?: boolean; prefix?: string; inline?: boolean;
			};
			await env.BUCKET.put(`mailboxes/${mailboxId}.json`, "{}");
			const mailbox = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
			if (initialize) await mailbox.ensureFileIndex(mailboxId, true);
			for (let i = 0; i < count; i++) {
				const id = `${prefix}-${i}`;
				const filename = `录取通知-${id}-100%.pdf`;
				await env.BUCKET.put(`attachments/${id}/att-${id}/${filename}`, "fixture bytes");
				await mailbox.createEmail("inbox", { id, subject: `Offer ${id}`, sender: "sender@example.org", recipient: mailboxId,
					date: "2026-10-24T00:00:00.000Z", body: "Secret body text", thread_id: `thread-${id}` },
				[{ id: `att-${id}`, email_id: id, filename, mimetype: "application/pdf", size: 13, disposition: inline ? "inline" : "attachment" }]);
			}
			return Response.json({ ok: true });
		}
		return app.fetch(request, env, ctx);
	},
};
