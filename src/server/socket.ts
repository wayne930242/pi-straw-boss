import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { fileOf, type Slot } from "./record.ts";

// The server's control socket (docs/specs/2026-10-26-sb-backend.md, The control socket): a Unix socket in the slot's folder, or on Windows a named pipe. Both are
// lines of JSON. Every connection starts with `hello { secret }`: a pipe's default ACL lets other local accounts connect and its name can be listed, so neither the
// name nor a file mode protects it. The secret is 32 random bytes in hex, made new at each server start and written to server.json; it is compared in constant time,
// and a connection whose first frame is not a matching hello is closed with no answer.

/** Set on a reply, `[AFTER]` runs once the reply has been written: a server that answers a stop or a restart leaves after it, not before. It is not part of what is sent. */
export const AFTER = Symbol("after");
export interface Reply { ok: boolean; error?: string; [AFTER]?: () => void; [key: string]: unknown }
export type Request = { cmd: string } & Record<string, unknown>;
/** The longest frame a connection may carry; a longer one is refused. */
export const MAX_FRAME = 1024 * 1024;
const HELLO_MS = 5000, IDLE_MS = 60_000, REFUSED_LOG_MS = 60_000;
/** The most a connection may send before its hello is complete: on Windows any local account can open the pipe, and the hello is a line of about 100 bytes. */
const PRE_HELLO_MAX = 4096;
const PROBE_MS = 1000;
/** `sun_path` is 104 bytes on macOS and 108 on Linux: a longer socket path is moved to a short folder of the user's own. */
const SOCKET_MAX = 100;

export const newSecret = () => randomBytes(32).toString("hex");
const digest = (text: string) => createHash("sha256").update(text).digest();
/** Whether `given` is the secret, compared in constant time (both are hashed first, so the length leaks nothing either). */
/**
 * What a server answers a hello's nonce with: HMAC-SHA256 keyed by the secret over the nonce and its pid. A pipe on Windows has a name that is free when its server is gone, so something else
 * could answer or refuse there; only a process that knows the secret can make this (R8-F004). The client sends a fresh nonce, so an answer cannot be replayed.
 */
export const proofOf = (secret: string, nonce: string, pid: unknown) => createHmac("sha256", secret).update(`${nonce}:${String(pid)}`).digest("hex");
export const secretMatches = (given: unknown, secret: string) => typeof given === "string" && secret.length > 0 && timingSafeEqual(digest(given), digest(secret));

/** Where the slot's server listens: `server.sock` in its folder, a short folder of the user's own when that path is too long, and on Windows a pipe with a random name. */
export function endpointFor(slot: Slot, platform: NodeJS.Platform = process.platform): string {
	if (platform === "win32") return `\\\\.\\pipe\\sb-${randomBytes(8).toString("hex")}`;
	const preferred = fileOf(slot, "socket");
	if (Buffer.byteLength(preferred) <= SOCKET_MAX) return preferred;
	const uid = process.getuid?.() ?? 0, dir = `/tmp/sb-${uid}`;
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const found = lstatSync(dir);
	if (!found.isDirectory() || found.uid !== uid || (found.mode & 0o077) !== 0) throw new Error(`${dir} is not a private folder of this user, so the control socket cannot go there (the state directory's path is too long for a socket)`);
	return join(dir, `${createHash("sha256").update(slot.dir).digest("hex").slice(0, 16)}.sock`);
}

export interface Control {
	endpoint: string;
	/** Stops accepting connections, ends the open ones, and removes the socket file. */
	close(): Promise<void>;
}
export interface ListenOptions {
	endpoint: string;
	secret: string;
	/** The facts the server answers a good hello with. */
	hello(): Record<string, unknown>;
	handle(request: Request): Promise<Reply> | Reply;
	/** A connection was closed with no answer; told at most once a minute. */
	refused?(why: string): void;
	platform?: NodeJS.Platform;
	now?: () => number;
}

export function listenControl({ endpoint, secret, hello, handle, refused, platform = process.platform, now = Date.now }: ListenOptions): Promise<Control> {
	const sockets = new Set<Socket>();
	let lastTold = -Infinity;
	const refuse = (conn: Socket, why: string) => {
		conn.destroy();
		if (now() - lastTold >= REFUSED_LOG_MS) {
			lastTold = now();
			refused?.(why);
		}
	};
	const server: Server = createServer((conn) => {
		sockets.add(conn);
		conn.on("close", () => sockets.delete(conn));
		conn.on("error", () => {});
		conn.setEncoding("utf8").setTimeout(IDLE_MS, () => conn.destroy());
		let buffer = "", authed = false, work: Promise<void> = Promise.resolve();
		const wait = setTimeout(() => !authed && refuse(conn, "no hello"), HELLO_MS);
		wait.unref();
		conn.on("close", () => clearTimeout(wait));
		conn.on("data", (chunk: string) => {
			buffer += chunk;
			if (buffer.length > MAX_FRAME) return refuse(conn, "frame too long");
			if (!authed && buffer.length > PRE_HELLO_MAX && !buffer.includes("\n")) return refuse(conn, "no hello within a few KB");
			for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
				const line = buffer.slice(0, at);
				buffer = buffer.slice(at + 1);
				let frame: Record<string, unknown>;
				try {
					const parsed: unknown = JSON.parse(line);
					if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
					frame = parsed as Record<string, unknown>;
				} catch {
					return refuse(conn, "frame is not JSON");
				}
				if (!authed) {
					if (frame.cmd !== "hello" || !secretMatches(frame.secret, secret)) return refuse(conn, frame.cmd === "hello" ? "wrong secret" : "first frame is not hello");
					authed = true;
					clearTimeout(wait);
					const facts = hello(), nonce = typeof frame.nonce === "string" && frame.nonce.length > 0 && frame.nonce.length <= 128 ? frame.nonce : undefined;
					conn.write(`${JSON.stringify({ ok: true, ...facts, ...(nonce ? { proof: proofOf(secret, nonce, facts.pid) } : {}) })}\n`);
					continue;
				}
				// Requests on one connection are answered in order, each with one line.
				work = work.then(async () => {
					let reply: Reply;
					try {
						reply = typeof frame.cmd === "string" ? await handle(frame as Request) : { ok: false, error: "a request needs a cmd" };
					} catch (error) {
						reply = { ok: false, error: (error as Error).message };
					}
					if (!conn.destroyed) conn.write(`${JSON.stringify(reply)}\n`, () => reply[AFTER]?.());
					else reply[AFTER]?.();
				});
			}
		});
	});
	return acceptsConnections(endpoint, platform).then((live) => new Promise<Control>((resolve, reject) => {
		// A socket file that accepts a connection is a server that runs, whatever server.json says: it is never unlinked from under it. What nobody listens at is what a server that died left.
		if (live) return reject(new Error(`a live server already listens at ${endpoint}`));
		if (platform !== "win32") rmSync(endpoint, { force: true });
		server.once("error", reject);
		server.listen(endpoint, () => {
			server.off("error", reject);
			if (platform !== "win32") chmodSync(endpoint, 0o600);
			resolve({
				endpoint,
				close: () => new Promise<void>((done) => {
					for (const conn of sockets) conn.destroy();
					server.close(() => done());
					if (platform !== "win32") rmSync(endpoint, { force: true });
				}),
			});
		});
	}));
}

/** Whether something accepts a connection at the endpoint (a pipe on Windows has a random name that nothing else holds, so it is not asked). */
function acceptsConnections(endpoint: string, platform: NodeJS.Platform): Promise<boolean> {
	if (platform === "win32") return Promise.resolve(false);
	return new Promise((resolve) => {
		const conn = createConnection(endpoint).setTimeout(PROBE_MS);
		conn.on("connect", () => (conn.destroy(), resolve(true)));
		conn.on("timeout", () => (conn.destroy(), resolve(true)));
		conn.on("error", () => resolve(false));
	});
}

const proves = (reply: Reply, secret: string, nonce: string) => typeof reply.proof === "string" && secretMatches(reply.proof, proofOf(secret, nonce, reply.pid));
/** `denied`: the endpoint is there and this process may not open it (access denied on the pipe or socket: a server started from an elevated shell, reached from a filtered token of the same user). */
export type ControlFailure = "no-server" | "refused" | "timeout" | "error" | "denied";
export class ControlError extends Error {
	failure: ControlFailure;
	constructor(failure: ControlFailure, message: string) {
		super(message);
		this.failure = failure;
	}
}

/**
 * One exchange with a server: `hello` with the secret, then the request when there is one. Resolves with the hello's answer and the request's. Rejects with a
 * ControlError: `no-server` when nothing listens, `refused` when the server closed the connection without answering (a wrong secret), `timeout`.
 */
export function callControl(endpoint: string, secret: string, request: Request | undefined, timeoutMs = 10_000): Promise<{ hello: Reply; reply?: Reply }> {
	return new Promise((resolve, reject) => {
		const want = request ? 2 : 1, got: Reply[] = [];
		let buffer = "", done = false;
		const nonce = randomBytes(16).toString("hex");
		const conn = createConnection(endpoint).setEncoding("utf8").setTimeout(timeoutMs);
		const finish = (error?: ControlError) => {
			if (done) return;
			done = true;
			conn.destroy();
			if (error) reject(error);
			else resolve({ hello: got[0]!, ...(got[1] ? { reply: got[1] } : {}) });
		};
		conn.on("connect", () => conn.write(`${JSON.stringify({ cmd: "hello", secret, nonce })}\n${request ? `${JSON.stringify(request)}\n` : ""}`));
		conn.on("data", (chunk: string) => {
			buffer += chunk;
			for (let at = buffer.indexOf("\n"); at >= 0 && !done; at = buffer.indexOf("\n")) {
				const line = buffer.slice(0, at);
				buffer = buffer.slice(at + 1);
				try {
					got.push(JSON.parse(line) as Reply);
				} catch {
					return finish(new ControlError("error", `the server answered ${line.slice(0, 80)}`));
				}
				if (got.length === 1 && !got[0]!.ok) return finish(new ControlError("refused", String(got[0]!.error ?? "the server refused")));
				// The answer must prove that its sender knows the secret (a reply with no proof, or a wrong one, is what something else at a free pipe name would give).
				if (got.length === 1 && !proves(got[0]!, secret, nonce)) return finish(new ControlError("refused", "the answer does not prove that its sender knows the secret"));
				if (got.length >= want) return finish();
			}
		});
		conn.on("timeout", () => finish(new ControlError("timeout", `no answer within ${timeoutMs} ms`)));
		conn.on("error", (error) => {
			const code = (error as NodeJS.ErrnoException).code ?? "";
			finish(new ControlError(["ENOENT", "ECONNREFUSED"].includes(code) ? "no-server" : ["EACCES", "EPERM"].includes(code) ? "denied" : "error", error.message));
		});
		conn.on("close", () => finish(new ControlError("refused", "the server closed the connection without an answer")));
	});
}

/** Like `helloOf`, and says when the endpoint refused this process for lack of permission (`denied`: not "no server"). */
export async function helloWhy(endpoint: string, secret: string, ms = 2000): Promise<{ hello?: Reply; denied: boolean }> {
	try {
		return { hello: (await callControl(endpoint, secret, undefined, ms)).hello, denied: false };
	} catch (error) {
		return { denied: error instanceof ControlError && error.failure === "denied" };
	}
}
/** Whether a server answers hello at `endpoint` within `ms`; its facts when it does. */
export async function helloOf(endpoint: string, secret: string, ms = 2000): Promise<Reply | undefined> {
	try {
		return (await callControl(endpoint, secret, undefined, ms)).hello;
	} catch {
		return undefined;
	}
}
