import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import PostalMime from "postal-mime";
import { connectImap, examineInbox, fetchMessage, searchAllUids } from "./imap-client.mjs";
import { planImport, selfCheckImportRules } from "../workers/lib/import-rules.ts";

const ACCOUNTS = [
	{ user: "apply@jdtogo.com", env: "IMAP_PASS_APPLY" },
	{ user: "dev@jdtogo.com", env: "IMAP_PASS_DEV" },
];

function arg(name, fallback = undefined) {
	const index = process.argv.indexOf(name);
	if (index < 0) return fallback;
	return process.argv[index + 1];
}

function has(name) {
	return process.argv.includes(name);
}

const target = arg("--target", "preview");
const dryRun = has("--dry-run");
const force = has("--force");
const fresh = has("--fresh");
const accountFilter = arg("--account", "all");
const maxImport = Number(arg("--max-import", dryRun ? "0" : "0"));
const sink = arg("--sink", process.env.IMPORT_SINK || "");
const token = arg("--token", process.env.IMPORT_TOKEN || "");
const stateDir = path.resolve(".import-state");
const statePath = path.join(stateDir, `${target}.json`);

function emptyState(batchId) {
	return { target, batchId, accounts: {} };
}

async function loadState() {
	if (fresh) return emptyState(`import-${new Date().toISOString().replace(/[:.]/g, "-")}`);
	try {
		return JSON.parse(await readFile(statePath, "utf8"));
	} catch {
		return emptyState(`import-${new Date().toISOString().replace(/[:.]/g, "-")}`);
	}
}

async function saveState(state) {
	await mkdir(stateDir, { recursive: true });
	const tmp = `${statePath}.tmp`;
	await writeFile(tmp, JSON.stringify(state, null, 2));
	await rename(tmp, statePath);
}

function classifySkip(plan) {
	const otherCompany = plan.candidates.some((address) => address.endsWith("@jdtogo.com") && address !== plan.sourceAccount);
	if (otherCompany) return "other_jdtogo_com";
	if (plan.candidates.includes(plan.sourceAccount)) return "direct_to_backup_mailbox";
	if (plan.candidates.length === 0) return "no_address";
	return "no_managed_recipient";
}

async function sinkFetch(pathname, options = {}) {
	const response = await fetch(new URL(pathname, sink), {
		...options,
		headers: {
			authorization: `Bearer ${token}`,
			...(options.headers || {}),
		},
	});
	const text = await response.text();
	let body = null;
	try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
	if (!response.ok) {
		throw new Error(`${pathname} ${response.status} ${text.slice(0, 300)}`);
	}
	return body;
}

async function cachedMessage(account, uid, imap) {
	const dir = path.join(stateDir, "cache", account.user);
	const rawPath = path.join(dir, `${uid}.eml`);
	const metaPath = path.join(dir, `${uid}.json`);
	try {
		const raw = await readFile(rawPath);
		const meta = JSON.parse(await readFile(metaPath, "utf8"));
		return { raw, internalDate: meta.internalDate || null };
	} catch {
		const message = await fetchMessage(imap, uid);
		await mkdir(dir, { recursive: true });
		await writeFile(rawPath, message.raw);
		await writeFile(metaPath, JSON.stringify({ internalDate: message.internalDate }));
		return { raw: message.raw, internalDate: message.internalDate };
	}
}

async function verifyImported(entry) {
	const problems = [];
	for (const item of entry.mailboxes || []) {
		if (item.action !== "imported" && item.action !== "duplicate") continue;
		const email = await sinkFetch(`/v1/mailboxes/${encodeURIComponent(item.mailbox)}/emails/${encodeURIComponent(item.emailId)}`);
		if (email.folder_id !== "inbox") problems.push(`${item.emailId} folder ${email.folder_id}`);
		if (email.message_id !== entry.messageId) problems.push(`${item.emailId} message id`);
		if ((email.subject || "") !== (entry.subject || "")) problems.push(`${item.emailId} subject`);
		if ((email.attachments || []).length !== item.attachmentCount && item.action === "imported") {
			problems.push(`${item.emailId} attachments`);
		}
		if (item.action === "imported" && !email.rawBytes) problems.push(`${item.emailId} missing raw`);
		if (!email.date) problems.push(`${item.emailId} missing date`);
	}
	return problems;
}

async function runAccount(account, state) {
	const password = process.env[account.env];
	if (!password) throw new Error(`missing ${account.env}`);
	const imap = await connectImap(account.user, password);
	try {
		const box = await examineInbox(imap);
		const uids = (await searchAllUids(imap)).sort((a, b) => Number(a) - Number(b));
		const prior = state.accounts[account.user];
		if (prior && prior.uidValidity && prior.uidValidity !== box.uidValidity) {
			throw new Error(`${account.user} UIDVALIDITY changed from ${prior.uidValidity} to ${box.uidValidity}`);
		}
		const record = prior && !fresh ? prior : { uidValidity: box.uidValidity, uids: {} };
		record.uidValidity = box.uidValidity;
		state.accounts[account.user] = record;
		let imported = 0;
		const summary = { examined: 0, imported: 0, duplicate: 0, skipped: 0, failed: 0, skipReasons: {} };
		for (const uid of uids) {
			if (!/^\d+$/.test(uid)) throw new Error(`unexpected UID ${uid}`);
			const done = record.uids[uid];
			const settled = done && !["failed", "planned"].includes(done.status);
			if (settled && !force) {
				summary[done.status] = (summary[done.status] || 0) + 1;
				continue;
			}
			if (maxImport > 0 && imported >= maxImport) break;
			summary.examined++;
			const message = await cachedMessage(account, uid, imap);
			const parsed = await new PostalMime().parse(message.raw);
			const plan = planImport({ ...parsed, date: parsed.date || null }, account.user);
			if (plan.reason !== "ok") {
				const reason = classifySkip(plan);
				summary.skipped++;
				summary.skipReasons[reason] = (summary.skipReasons[reason] || 0) + 1;
				record.uids[uid] = {
					status: "skipped",
					reason,
					subject: plan.subject,
					to: plan.to,
					messageId: plan.messageId,
				};
				await saveState(state);
				continue;
			}
			if (dryRun) {
				summary.imported++;
				imported++;
				record.uids[uid] = {
					status: "planned",
					subject: plan.subject,
					mailboxes: plan.mailboxes,
					messageId: plan.messageId,
					attachmentCount: parsed.attachments.length,
					date: parsed.date || message.internalDate,
				};
				await saveState(state);
				continue;
			}
			try {
				const result = await sinkFetch("/v1/ingest", {
					method: "POST",
					headers: {
						"content-type": "message/rfc822",
						"x-source-account": account.user,
						"x-source-uid": uid,
						"x-batch-id": state.batchId,
						...(message.internalDate ? { "x-internal-date": message.internalDate } : {}),
					},
					body: message.raw,
				});
				const action = result.status === "imported" ? "imported" : result.status === "duplicate" ? "duplicate" : result.status;
				const entry = {
					status: action,
					subject: result.subject,
					messageId: result.messageId,
					mailboxes: result.mailboxes,
					date: result.date || null,
				};
				const problems = await verifyImported(entry);
				if (problems.length) {
					entry.status = "failed";
					entry.error = problems.join("; ");
					summary.failed++;
				} else if (action === "imported" || action === "duplicate") {
					imported++;
					summary[action]++;
				} else {
					summary.skipped++;
				}
				record.uids[uid] = entry;
			} catch (error) {
				summary.failed++;
				record.uids[uid] = { status: "failed", error: error.message, subject: plan.subject };
			}
			await saveState(state);
		}
		return { user: account.user, exists: box.exists, uidCount: uids.length, ...summary };
	} finally {
		imap.close();
	}
}

selfCheckImportRules();
if (!["preview", "production"].includes(target)) throw new Error("--target must be preview or production");
if (!dryRun && (!sink || !token)) throw new Error("import needs --sink and --token");

const selected = ACCOUNTS.filter((account) => accountFilter === "all" || account.user.startsWith(`${accountFilter}@`));
if (selected.length === 0) throw new Error(`unknown --account ${accountFilter}`);

if (!dryRun) {
	const health = await fetch(new URL("/v1/health", sink)).then((response) => response.json());
	if (!health.ok) throw new Error("import sink is not healthy");
	if (health.hasEmailBinding) throw new Error("import sink has an email binding; refusing to run");
	if ((health.target || "preview") !== target) {
		throw new Error(`sink target ${health.target} does not match --target ${target}`);
	}
}

const state = await loadState();
const results = [];
for (const account of selected) results.push(await runAccount(account, state));
if (!dryRun) {
	await sinkFetch("/v1/manifest", {
		method: "PUT",
		headers: { "content-type": "application/json", "x-batch-id": state.batchId },
		body: JSON.stringify({ batchId: state.batchId, target, finishedAt: new Date().toISOString(), results }, null, 2),
	});
}
console.log(JSON.stringify({ batchId: state.batchId, dryRun, target, results }, null, 2));
