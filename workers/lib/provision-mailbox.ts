// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

const SYSTEM_LOCALS = new Set([
	"postmaster",
	"abuse",
	"mailer-daemon",
	"bounce",
	"cf-bounce",
]);

interface MailboxProvisionEnv {
	BUCKET: R2Bucket;
	MAILBOX: {
		idFromName(name: string): DurableObjectId;
		get(id: DurableObjectId): { getFolders(): Promise<unknown> };
	};
	DOMAINS?: string;
}

export function configuredDomains(env: { DOMAINS?: string }): string[] {
	return (env.DOMAINS || "")
		.split(",")
		.map((domain) => domain.trim().toLowerCase())
		.filter(Boolean);
}

export function isManagedMailboxAddress(address: string, env: { DOMAINS?: string }): boolean {
	const at = address.lastIndexOf("@");
	if (at <= 0 || at === address.length - 1) return false;
	const localPart = address.slice(0, at);
	const domain = address.slice(at + 1);
	if (!/^[^\s<>@,;:]+$/.test(localPart)) return false;
	if (!configuredDomains(env).includes(domain)) return false;
	return !SYSTEM_LOCALS.has(localPart);
}

export async function ensureMailbox(env: MailboxProvisionEnv, mailboxId: string): Promise<void> {
	const key = `mailboxes/${mailboxId}.json`;
	if (!(await env.BUCKET.head(key))) {
		const localPart = mailboxId.slice(0, mailboxId.indexOf("@"));
		await env.BUCKET.put(key, JSON.stringify({
			fromName: localPart,
			status: "unassigned",
			autoCreated: true,
			createdAt: new Date().toISOString(),
			forwarding: { enabled: false, email: "" },
			signature: { enabled: false, text: "" },
			autoReply: { enabled: false, subject: "", message: "" },
		}));
	}
	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
	await stub.getFolders();
}
