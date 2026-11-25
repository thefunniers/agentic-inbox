import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Env } from "../types";
import { acceptBackup, acceptForwardBackup } from "./index";
import {
	deliveryMode,
	isAttentionState,
	type Delivery,
	type DeliveryMode,
} from "./model";
import { isManagedMailboxAddress } from "../lib/provision-mailbox";
export const backupRoutes = new Hono<{ Bindings: Env }>();
backupRoutes.get("/api/v1/deliveries", async (c) => {
	if (!c.env.BACKUP_DELIVERY) return c.json({ deliveries: [], cursor: null });
	const mailbox = c.req.query("mailbox");
	if (mailbox && !isManagedMailboxAddress(mailbox, c.env))
		return c.json({ error: "Invalid mailbox" }, 400);
	const modeParam = c.req.query("mode");
	if (modeParam && modeParam !== "forward" && modeParam !== "notification")
		return c.json({ error: "Invalid mode" }, 400);
	const modeFilter = modeParam as DeliveryMode | undefined;
	const attention = c.req.query("attention") === "true";
	const prefix = attention ? "delivery-attention/" : "delivery-index/";
	const deliveries: Delivery[] = [];
	let cursor = c.req.query("cursor") || undefined;
	do {
		const page = await c.env.BUCKET.list({
			prefix: `${prefix}${mailbox ? mailbox + "/" : ""}`,
			limit: 50 - deliveries.length,
			cursor,
		});
		const states = await Promise.all(
			page.objects.map(async (o) => {
				const name = o.key.slice(prefix.length, -".json".length);
				return c.env.BACKUP_DELIVERY.get(
					c.env.BACKUP_DELIVERY.idFromName(name),
				).status();
			}),
		);
		for (const d of states) {
			if (
				d &&
				(!attention || isAttentionState(d.state)) &&
				(!modeFilter || deliveryMode(d) === modeFilter)
			) {
				deliveries.push(d);
			}
		}
		cursor = page.truncated ? page.cursor : undefined;
		// Stale derived keys must not occupy the page or conceal later failures.
	} while (cursor && deliveries.length < 50);
	return c.json({ deliveries, cursor: cursor || null });
});
backupRoutes.post("/api/v1/deliveries/:mailbox/:id/retry", async (c) => {
	if (!c.env.BACKUP_DELIVERY) return c.notFound();
	const { mailbox, id } = c.req.param();
	if (!isManagedMailboxAddress(mailbox, c.env) || !/^[a-f0-9]{64}$/.test(id))
		return c.json({ error: "Invalid delivery" }, 400);
	const d = c.env.BACKUP_DELIVERY.get(
		c.env.BACKUP_DELIVERY.idFromName(`${mailbox}/${id}`),
	);
	try {
		await d.retry();
		return c.json({ status: "pending" });
	} catch (e) {
		return c.json({ error: String(e) }, 409);
	}
});
backupRoutes.get("/api/v1/deliveries/:mailbox/:id/original", async (c) => {
	if (!c.env.BACKUP_DELIVERY) return c.notFound();
	const { mailbox, id } = c.req.param();
	if (!isManagedMailboxAddress(mailbox, c.env) || !/^[a-f0-9]{64}$/.test(id))
		return c.text("Invalid delivery", 400);
	const obj = await c.env.BUCKET.get(`originals/${mailbox}/${id}.eml`);
	return obj
		? new Response(obj.body, {
				headers: {
					"Content-Type": "message/rfc822",
					"Content-Disposition": 'attachment; filename="original.eml"',
					"Cache-Control": "private, no-store",
				},
			})
		: c.notFound();
});
// Test ingestion is unavailable in production, authenticated by the app's dev middleware.
backupRoutes.post(
	"/api/dev/inbound",
	bodyLimit({ maxSize: 25 * 1024 * 1024 }),
	async (c) => {
		if (c.env.DEPLOYMENT_ENV !== "dev") return c.notFound();
		const to = c.req.header("X-Envelope-To") || "";
		const from = c.req.header("X-Envelope-From") || "";
		if (!to.endsWith("@dev.jdtogo.ai") || !from || /[\r\n]/.test(from))
			return c.text("Invalid envelope", 400);
		const raw = await c.req.arrayBuffer();
		const simForward = c.req.header("X-Dev-Forward-Result");
		if (simForward) {
			try {
				const result = await acceptForwardBackup(
					{
						raw: new Response(raw).body!,
						rawSize: raw.byteLength,
						to,
						from,
						async forward() {
							if (simForward === "ok") return;
							if (simForward === "transient")
								throw new Error("451 4.3.0 Temporary local problem");
							if (simForward === "permanent")
								throw new Error("550 5.1.1 Destination rejected");
							throw new Error("connection reset during forward");
						},
					},
					c.env,
				);
				return c.json(result, 202);
			} catch (error) {
				return c.json({ retriable: true, error: String(error) }, 503);
			}
		}
		const result = await acceptBackup(
			{ raw: new Response(raw).body!, rawSize: raw.byteLength, to, from },
			c.env,
		);
		return c.json(result, 202);
	},
);
