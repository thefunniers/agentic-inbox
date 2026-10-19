import tls from "node:tls";

const HOST = process.env.IMAP_HOST || "imap.exmail.qq.com";
const PORT = Number(process.env.IMAP_PORT || 993);

function readLine(buf, start) {
	const idx = buf.indexOf("\r\n", start);
	if (idx < 0) return null;
	return { line: buf.subarray(start, idx).toString("utf8"), next: idx + 2 };
}

function parseUntilTag(buf, tag) {
	let pos = 0;
	const lines = [];
	while (pos < buf.length) {
		const line = readLine(buf, pos);
		if (!line) return null;
		lines.push(line.line);
		pos = line.next;
		const lit = line.line.match(/\{(\d+)\}$/);
		if (lit) {
			const size = Number(lit[1]);
			if (buf.length < pos + size) return null;
			lines.push({ literal: Buffer.from(buf.subarray(pos, pos + size)) });
			pos += size;
			continue;
		}
		if (line.line.startsWith(`${tag} `)) {
			return { consumed: pos, value: { lines, status: line.line } };
		}
	}
	return null;
}

function quoteImap(value) {
	if (/[^\x20-\x7e]/.test(value) || /["\\]/.test(value)) {
		throw new Error("IMAP value contains characters this client will not send");
	}
	return `"${value}"`;
}

export function connectImap(user, password) {
	return new Promise((resolve, reject) => {
		const socket = tls.connect({ host: HOST, port: PORT, servername: HOST });
		const imap = new Imap(socket);
		const fail = (error) => {
			socket.destroy();
			reject(error);
		};
		socket.once("error", fail);
		imap.waiters.push({
			tryParse: (buf) => {
				const line = readLine(buf, 0);
				if (!line) return null;
				return { consumed: line.next, value: line.line };
			},
			resolve: async () => {
				socket.off("error", fail);
				socket.on("error", (error) => imap.fail(error));
				try {
					const login = await imap.send(`LOGIN ${quoteImap(user)} ${quoteImap(password)}`);
					if (!login.status.includes("OK")) throw new Error(`IMAP login failed for ${user}`);
					resolve(imap);
				} catch (error) {
					socket.destroy();
					reject(error);
				}
			},
			reject: fail,
		});
	});
}

class Imap {
	constructor(socket) {
		this.socket = socket;
		this.buf = Buffer.alloc(0);
		this.waiters = [];
		this.tag = 0;
		this.timer = null;
		socket.on("data", (chunk) => {
			this.buf = Buffer.concat([this.buf, chunk]);
			this.pump();
		});
	}

	fail(error) {
		if (this.timer) clearTimeout(this.timer);
		const waiter = this.waiters.shift();
		if (waiter) waiter.reject(error);
	}

	pump() {
		while (this.waiters.length) {
			const waiter = this.waiters[0];
			const got = waiter.tryParse(this.buf);
			if (!got) return;
			this.buf = this.buf.subarray(got.consumed);
			this.waiters.shift();
			waiter.resolve(got.value);
		}
	}

	send(command) {
		const tag = `A${++this.tag}`;
		return new Promise((resolve, reject) => {
			this.waiters.push({
				tryParse: (buf) => parseUntilTag(buf, tag),
				resolve: (value) => {
					if (this.timer) clearTimeout(this.timer);
					resolve(value);
				},
				reject: (error) => {
					if (this.timer) clearTimeout(this.timer);
					reject(error);
				},
			});
			this.socket.write(`${tag} ${command}\r\n`);
			if (this.timer) clearTimeout(this.timer);
			this.timer = setTimeout(() => this.fail(new Error("IMAP timeout")), 60_000);
			this.pump();
		});
	}

	close() {
		if (this.timer) clearTimeout(this.timer);
		this.socket.end();
	}
}

export async function examineInbox(imap) {
	const examined = await imap.send('EXAMINE "INBOX"');
	if (!examined.status.includes("OK")) throw new Error(examined.status);
	const lines = examined.lines.filter((line) => typeof line === "string");
	const uidValidity = (lines.find((line) => line.includes("UIDVALIDITY")) || "").match(/UIDVALIDITY (\d+)/)?.[1] || "";
	const exists = Number((lines.find((line) => line.includes("EXISTS")) || "").match(/\* (\d+) EXISTS/)?.[1] || 0);
	return { uidValidity, exists };
}

export async function searchAllUids(imap) {
	const searched = await imap.send("UID SEARCH ALL");
	if (!searched.status.includes("OK")) throw new Error(searched.status);
	const line = searched.lines.find((item) => typeof item === "string" && item.startsWith("* SEARCH")) || "* SEARCH";
	return line.replace("* SEARCH", "").trim().split(/\s+/).filter(Boolean);
}

export async function fetchMessage(imap, uid) {
	const fetched = await imap.send(`UID FETCH ${uid} (UID INTERNALDATE BODY.PEEK[])`);
	if (!fetched.status.includes("OK")) throw new Error(fetched.status);
	const text = fetched.lines.filter((line) => typeof line === "string").join("\n");
	const internalDate = text.match(/INTERNALDATE "([^"]+)"/)?.[1] || null;
	const literal = fetched.lines.find((line) => line && typeof line === "object" && line.literal);
	if (!literal) throw new Error(`UID ${uid} did not include a message body`);
	return { uid, internalDate, raw: literal.literal };
}
