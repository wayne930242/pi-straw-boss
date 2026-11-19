import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { fileOf, type Slot } from "./record.ts";

// The server's control socket (docs/specs/2026-10-26-sb-backend.md, The control socket): a Unix socket in the slot's folder, or on Windows a named pipe. Both are
// lines of JSON. A pipe's default ACL lets other local accounts connect and its name can be listed, and a freed name or a stale socket path can be taken by something else,
// so neither the name nor a file mode protects it. The secret is 32 random bytes in hex, made new at each server start and written to a file only its owner reads. It never
// crosses the wire: the two sides prove they know it to each other (protocol 2). The client sends `hello { v, nonce }`; the server answers a nonce of its own and an HMAC of both
// nonces under a label for the server; the client checks that, and only then sends `auth { proof }` (an HMAC under a label for the client) and its request; the server acts only
// once that proof checks, and then answers the hello's facts. Both proofs are compared in constant time, and a connection that does not follow this is closed with no answer.

/** Set on a reply, `[AFTER]` runs once the reply has been written: a server that answers a stop or a restart leaves after it, not before. It is not part of what is sent. */
export const AFTER = Symbol("after");
export interface Reply { ok: boolean; error?: string; [AFTER]?: () => void; [key: string]: unknown }
export type Request = { cmd: string } & Record<string, unknown>;
/** The longest frame a connection may carry; a longer one is refused. */
export const MAX_FRAME = 1024 * 1024;
const HELLO_MS = 5000, IDLE_MS = 60_000, REFUSED_LOG_MS = 60_000;
/** The most a connection may send before its hello is complete: on Windows any local account can open the pipe, and the hello is a line of about 100 bytes. */
const PRE_HELLO_MAX = 4096;
/** The most a client reads from a peer that has not proved the secret yet. */
const PRE_PROOF_MAX = 4096;
const PROBE_MS = 1000;
/** `sun_path` is 104 bytes on macOS and 108 on Linux: a longer socket path is moved to a short folder of the user's own. */
const SOCKET_MAX = 100;

/** The version of this handshake. A peer that speaks another one is told so (an older client sends no `v`) and nothing else; there is no fallback to an older handshake, which sent the secret in clear. */
export const PROTOCOL = 2;
export const newSecret = () => randomBytes(32).toString("hex");
const digest = (text: string) => createHash("sha256").update(text).digest();
/**
 * What one side sends to prove it knows the secret: HMAC-SHA256 keyed by the secret over a label for the direction and purpose and the two fresh nonces (the client's, then the server's). The
 * label keeps one side's proof from being replayed as the other's; the nonces keep a proof from one connection from serving another (R8-F004, R13-F001). A pipe on Windows has a name that is free
 * when its server is gone, and a socket path can be left stale, so something else can answer there: it learns nothing here that it can use again.
 */
export const proofOf = (secret: string, side: "server" | "client", clientNonce: string, serverNonce: string) => createHmac("sha256", secret).update(`sb-control ${side}|${clientNonce}|${serverNonce}`).digest("hex");
const nonceOf = (value: unknown) => (typeof value === "string" && /^[0-9a-f]{1,128}$/.test(value) ? value : undefined);
const mismatch = (theirs: unknown) => `control protocol mismatch: this side speaks protocol ${PROTOCOL}, the other speaks ${typeof theirs === "number" ? theirs : 1}; they come from different pi-straw-boss versions. Reload pi (/reload) in the session that runs the older package; a session of the newer package restarts an older sb server on its own`;
/** Whether `given` is the secret, compared in constant time (both are hashed first, so the length leaks nothing either). */
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
	/** Stops accepting connections, ends the open ones, and removes the socket file. With `graceful`, the open ones are ended after what is already written is flushed (a reply to the request that is stopping the server still arrives), and destroyed a second later. */
	close(graceful?: boolean): Promise<void>;
}
export interface ListenOptions {
	endpoint: string;
	secret: string;
	/** The facts the server answers a good hello with. */
	hello(): Record<string, unknown>;
	handle(request: Request): Promise<Reply> | Reply;
	/** A connection was closed with no answer; told at most once a minute. */
	refused?(why: string): void;
	/** How long a connection may sit without traffic before it is closed (default one minute). */
	idleMs?: number;
	platform?: NodeJS.Platform;
	now?: () => number;
}

export function listenControl({ endpoint, secret, hello, handle, refused, idleMs = IDLE_MS, platform = process.platform, now = Date.now }: ListenOptions): Promise<Control> {
	const sockets = new Set<Socket>();
	let lastTold = -Infinity;
	const refuse = (conn: Socket, why: string, destroy = true) => {
		if (destroy) conn.destroy();
		if (now() - lastTold >= REFUSED_LOG_MS) {
			lastTold = now();
			refused?.(why);
		}
	};
	const server: Server = createServer((conn) => {
		sockets.add(conn);
		conn.on("close", () => sockets.delete(conn));
		conn.on("error", () => {});
		// Idle means no request in flight: a `landed` or `received` check may fetch a base for minutes, and closing its connection loses the answer while the check goes on (0.80.15 FE2).
		let buffer = "", state: "new" | "challenged" | "authed" | "closed" = "new", clientNonce = "", work: Promise<void> = Promise.resolve(), inFlight = 0;
		conn.setEncoding("utf8").setTimeout(idleMs, () => inFlight === 0 && conn.destroy());
		const serverNonce = randomBytes(16).toString("hex");
		const wait = setTimeout(() => state !== "authed" && refuse(conn, "no proof"), HELLO_MS);
		wait.unref();
		conn.on("close", () => clearTimeout(wait));
		conn.on("data", (chunk: string) => {
			buffer += chunk;
			if (buffer.length > MAX_FRAME) return refuse(conn, "frame too long");
			if (state !== "authed" && buffer.length > PRE_HELLO_MAX && !buffer.includes("\n")) return refuse(conn, "no hello within a few KB");
			for (let at = buffer.indexOf("\n"); at >= 0 && state !== "closed"; at = buffer.indexOf("\n")) {
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
				if (state === "new") {
					if (frame.cmd !== "hello") return refuse(conn, "first frame is not hello");
					if (frame.v !== PROTOCOL) {
						// An older client (no `v`) is told why and gets nothing else: its hello held the secret, and it is not looked at.
						state = "closed";
						conn.end(`${JSON.stringify({ ok: false, protocol: PROTOCOL, error: mismatch(frame.v) })}\n`);
						return refuse(conn, "protocol mismatch", false);
					}
					clientNonce = nonceOf(frame.nonce) ?? "";
					if (!clientNonce) return refuse(conn, "hello without a nonce");
					state = "challenged";
					conn.write(`${JSON.stringify({ ok: true, v: PROTOCOL, nonce: serverNonce, proof: proofOf(secret, "server", clientNonce, serverNonce) })}\n`);
					continue;
				}
				if (state === "challenged") {
					if (frame.cmd !== "auth" || !secretMatches(frame.proof, proofOf(secret, "client", clientNonce, serverNonce))) return refuse(conn, frame.cmd === "auth" ? "wrong proof" : "second frame is not auth");
					state = "authed";
					clearTimeout(wait);
					conn.write(`${JSON.stringify({ ok: true, ...hello() })}\n`);
					continue;
				}
				// Requests on one connection are answered in order, each with one line.
				inFlight++;
				work = work.then(async () => {
					let reply: Reply;
					try {
						reply = typeof frame.cmd === "string" ? await handle(frame as Request) : { ok: false, error: "a request needs a cmd" };
					} catch (error) {
						reply = { ok: false, error: (error as Error).message };
					}
					inFlight--;
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
				close: (graceful = false) => new Promise<void>((done) => {
					for (const conn of sockets) {
						if (!graceful) conn.destroy();
						else (conn.end(), setTimeout(() => conn.destroy(), 1000).unref());
					}
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

/** `denied`: the endpoint is there and this process may not open it (access denied on the pipe or socket: a server started from an elevated shell, reached from a filtered token of the same user). `protocol`: the peer says it speaks another handshake. */
export type ControlFailure = "no-server" | "refused" | "timeout" | "error" | "denied" | "protocol";
export class ControlError extends Error {
	failure: ControlFailure;
	/** Whether the request was written before this failed: if so, it may still have been carried out, and the caller must not send it again. */
	sent: boolean;
	constructor(failure: ControlFailure, message: string, sent = false) {
		super(message);
		this.failure = failure;
		this.sent = sent;
	}
}

/**
 * One exchange with a server (protocol 2, the top of this file): `hello` with a nonce, then, once the answer has proved that its sender knows the secret, `auth` with this side's proof and the
 * request when there is one. The secret is never sent. Resolves with the hello's facts and the request's answer. Rejects with a ControlError: `no-server` when nothing listens, `refused` when the
 * peer closed the connection without an answer or did not prove itself (nothing was written but the hello), `protocol` when it says it speaks another handshake, `timeout`. A failure with `sent`
 * set came after the request was written.
 */
export function callControl(endpoint: string, secret: string, request: Request | undefined, timeoutMs = 10_000): Promise<{ hello: Reply; reply?: Reply }> {
	return new Promise((resolve, reject) => {
		const want = request ? 2 : 1, got: Reply[] = [];
		let buffer = "", done = false, sent = false, proven = false, lines = 0;
		const clientNonce = randomBytes(16).toString("hex");
		const conn = createConnection(endpoint).setEncoding("utf8").setTimeout(timeoutMs);
		const finish = (error?: ControlError) => {
			if (done) return;
			done = true;
			clearTimeout(early);
			conn.destroy();
			if (error) reject(error);
			else resolve({ hello: got[0]!, ...(got[1] ? { reply: got[1] } : {}) });
		};
		// Until the answer has proved itself, a peer that says nothing is given the hello's few seconds and not the command's whole wait (a squatter that never answers is no reason to wait a minute).
		const early = setTimeout(() => finish(new ControlError("timeout", `nothing answered the hello within ${Math.min(timeoutMs, HELLO_MS) / 1000} s`)), Math.min(timeoutMs, HELLO_MS));
		early.unref();
		conn.on("connect", () => conn.write(`${JSON.stringify({ cmd: "hello", v: PROTOCOL, nonce: clientNonce })}\n`));
		conn.on("data", (chunk: string) => {
			buffer += chunk;
			if (!proven && buffer.length > PRE_PROOF_MAX && !buffer.includes("\n")) return finish(new ControlError("refused", "the answer to the hello is too long to be a challenge"));
			for (let at = buffer.indexOf("\n"); at >= 0 && !done; at = buffer.indexOf("\n")) {
				const line = buffer.slice(0, at);
				buffer = buffer.slice(at + 1);
				let frame: Reply;
				try {
					const parsed: unknown = JSON.parse(line);
					// `null` and the other JSON that is no object are no frame either (and `null.ok` would throw in this handler).
					if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
					frame = parsed as Reply;
				} catch {
					// Before the proof not a byte of the peer is shown (R13c-F002): whatever sits at the name can write what it likes into this side's errors. After it, the peer is the server.
					return finish(new ControlError(proven ? "error" : "refused", proven ? `the server answered ${line.slice(0, 80)}` : "the answer to the hello is not JSON", sent));
				}
				if (!proven) {
					lines++;
					// Nothing a peer says before it has proved the secret is echoed (an unproven peer can write what it likes into the caller's context): the protocol number, at most, and words of this side's own.
					if (!frame.ok) return finish(typeof frame.protocol === "number" ? new ControlError("protocol", mismatch(frame.protocol)) : new ControlError("refused", "the server refused the hello"));
					// The challenge must prove that its sender knows the secret (nothing, or a wrong proof, is what something else at a free pipe name or a stale path gives). Only then does anything but the hello go out.
					const serverNonce = nonceOf(frame.nonce);
					if (!serverNonce || frame.v !== PROTOCOL || !secretMatches(frame.proof, proofOf(secret, "server", clientNonce, serverNonce))) return finish(new ControlError("refused", "the answer does not prove that its sender knows the secret"));
					proven = true;
					clearTimeout(early);
					sent = Boolean(request);
					conn.write(`${JSON.stringify({ cmd: "auth", proof: proofOf(secret, "client", clientNonce, serverNonce) })}\n${request ? `${JSON.stringify(request)}\n` : ""}`);
					continue;
				}
				got.push(frame);
				if (got.length === 1 && !frame.ok) return finish(new ControlError("refused", String(frame.error ?? "the server refused"), sent));
				if (got.length >= want) return finish();
			}
		});
		conn.on("timeout", () => finish(new ControlError("timeout", `no answer within ${timeoutMs} ms`, sent)));
		conn.on("error", (error) => {
			const code = (error as NodeJS.ErrnoException).code ?? "";
			finish(new ControlError(["ENOENT", "ECONNREFUSED"].includes(code) ? "no-server" : ["EACCES", "EPERM"].includes(code) ? "denied" : "error", error.message, sent));
		});
		conn.on("close", () => finish(sent ? new ControlError("error", "the connection closed after the request was written, with no answer", true) : new ControlError("refused", lines === 0 ? "the server closed the connection without an answer (a server of an older pi-straw-boss, which speaks an older control protocol, closes the hello it does not know like this; so does one that holds another secret)" : "the server closed the connection before it had answered the hello")));
	});
}

/** Like `helloOf`, and says when the endpoint refused this process for lack of permission (`denied`: not "no server"). */
export async function helloWhy(endpoint: string, secret: string, ms = 2000): Promise<{ hello?: Reply; denied: boolean; failure?: ControlFailure }> {
	try {
		return { hello: (await callControl(endpoint, secret, undefined, ms)).hello, denied: false };
	} catch (error) {
		const failure = error instanceof ControlError ? error.failure : undefined;
		return { denied: failure === "denied", ...(failure ? { failure } : {}) };
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
