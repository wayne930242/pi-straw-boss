import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, request, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { waitsForSecret } from "./ask.ts";
import { type ControlDeps, createControl, type Reply } from "./control.ts";
import type { HerdrCall } from "./herdr.ts";
import type { Hub } from "./dialogs.ts";
import { createDocs } from "./docs.ts";
import { canonical, readers } from "./history.ts";
import { createMirrors } from "./mirror.ts";
import type { Found, Net, Ref } from "./net.ts";
import { qr } from "./qr.ts";
import { type Access, cookieFor, createAccess } from "./remote.ts";
import { api, type Hub as Files, watchSession, type Watch, watchWorkspace } from "./watch.ts";

// The browser view's server: serves the built page and one live stream of the net, read-only, on 127.0.0.1 only.
// Every URL starts with a random token (/<token>/index.html, /<token>/events) and a request without it, or with another Host
// header, is refused, so other local pages cannot read the net. The only writes are POSTs under /api/sessions and /api/remote (control.ts),
// which also need the page's origin and a second secret the page carries in <meta name="sb-csrf">; every other request must be a GET.
// While remote access is on (remote.ts), paired devices of this machine's Tailscale user reach the same server through `tailscale serve`. The stream sends the full snapshot on connect and on every
// change, plus a `ping` event every 15 s so a client can tell a silent drop from a quiet net. It polls only while someone listens.
// The page has routes (/<token>/w/<workspace>[/s/<session>]): any such URL answers the same index.html, which carries a <base href>
// so its assets and the stream resolve from any depth. `events?watch=<session key>` adds that session's chat history to the stream,
// `events?watch=w:<workspace id>` the last line of each session there; /api/history and /api/entry page through a session's file.

export const BUNDLE = fileURLToPath(new URL("../dist/gui", import.meta.url));
export const VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json" };
const HEADERS = {
	"cache-control": "no-store",
	"referrer-policy": "no-referrer",
	"x-content-type-options": "nosniff",
	"cross-origin-opener-policy": "same-origin", // a page a document's link opens cannot steer this tab
	"content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; base-uri 'self'; frame-ancestors 'none'",
};

export interface Gui { url: string; port: number; token: string; csrf: string; access: Access; stop(): Promise<void> }
/** `net` is the registry behind the net reading (the allow list of session keys); without it no session can be watched. `call` reaches Herdr for input. */
/** `hub` carries answers to the dialogs bridges relay (dialogs.ts); it runs exactly as long as the server. */
/** `onRemote` turns remote access on from the page, in the session that runs the server. `onStop` takes another session's stop request (requestStop), so the owner also takes its remote entry down; without it the server stops itself. */
export interface GuiOptions { read(): Promise<Net>; net?: { lookup(key: string): Found | undefined; workspace(id: string): Ref[] }; call?: HerdrCall; hub?: Hub; dir?: string; port?: number; token?: string; csrf?: string; pollMs?: number; pingMs?: number; onStop?(asked: Asked): void; onRemote?(): Promise<void>; spawn?: ControlDeps["spawn"] }
export interface Asked { by: string; take: boolean }

/** Starts the server. A preferred `port` (with its `token` and `csrf`) is reused when free, so a restarted server keeps the URL and the page an open tab already has. */
export async function startGui({ read, net, call, hub, dir = BUNDLE, port = 0, token = randomBytes(16).toString("hex"), csrf = randomBytes(16).toString("hex"), pollMs = 2000, pingMs = 15_000, onStop, onRemote, spawn }: GuiOptions): Promise<Gui> {
	try {
		if (!statSync(join(dir, "index.html")).isFile()) throw new Error();
	} catch {
		throw new Error(`The GUI bundle is missing (${dir}); build it with npm run gui:build`);
	}
	// The whole bundle is read once: a package update replaces dist/gui under a running server, whose page names the old assets.
	const bundle = new Map(readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) => statSync(join(dir, f)).isFile()).map((f) => [f.split("\\").join("/"), readFileSync(join(dir, f))]));
	// `build` names this bundle in the page and in each stream's hello: a page from another build, reconnecting to this server, reloads itself.
	const html = bundle.get("index.html")!, build = createHash("sha256").update(html).digest("hex").slice(0, 16);
	const page = html.toString("utf8").replace("<head>", `<head>\n<base href="/${token}/">\n<meta name="sb-csrf" content="${csrf}">\n<meta name="sb-build" content="${build}">`);
	const files: Files = { lookup: (key) => net?.lookup(key), workspace: (id) => net?.workspace(id) ?? [], readers: readers() };
	// Turning remote access off ends the streams of remote pages; their next request finds the cookie void.
	const clients = new Map<ServerResponse, Watch | undefined>(), remotes = new Set<ServerResponse>(), access = createAccess(token, () => remotes.forEach((c) => c.end()));
	const pair = (code = access.pair(), host = access.remote?.host, url = `https://${host}/${token}/pair/${code}`) => (code && host ? { url, rows: qr(url).map((row) => row.map(Number).join("")) } : undefined);
	const mirrors = createMirrors({ call, lookup: (key) => net?.lookup(key), secret: waitsForSecret, canonical }), docs = hub && createDocs(hub, (key) => net?.lookup(key)?.name ?? key);
	const stop = (asked: Asked) => void setTimeout(() => (onStop ? onStop(asked) : void halt()), 10); // after the reply has gone out
	const control = createControl({ lookup: (key) => net?.lookup(key), call, csrf, canonical, pair, remoteOn: onRemote, spawn, mirrors, stop, secret: waitsForSecret, answers: hub && { replay: hub.replay, ended: hub.ended, send: hub.send, probe: hub.probe, commands: hub.commands, target: async (key) => (await tick(), hub.target(key)) } });
	let last: string | undefined, problem: string | undefined, inflight: Promise<void> | undefined;
	let poll: ReturnType<typeof setInterval> | undefined, beat: ReturnType<typeof setInterval> | undefined;
	const send = (to: ServerResponse, data: string, event?: string) => to.writableEnded || to.write(`${event ? `event: ${event}\n` : ""}data: ${data}\n\n`); // a reading in flight at stop ends after the streams
	const push = (data: string, event?: string) => clients.forEach((_, c) => send(c, data, event));
	// One reading at a time; a caller that arrives meanwhile waits for the one in flight.
	const tick = () => (inflight ??= (async () => {
		try {
			const json = JSON.stringify(await read());
			if (json !== last || problem) push((last = json));
			problem = undefined;
			await Promise.all([...clients.values()].map((w) => w?.refresh().catch(() => {})));
		} catch (error) {
			// The stream stays up and says why the net is unreadable, once per distinct reason.
			const message = (error as Error).message;
			if (message !== problem) push(JSON.stringify(message), "problem");
			problem = message;
		}
	})().finally(() => (inflight = undefined)));
	const listen = (at: number) => new Promise<void>((done, fail) => {
		server.once("error", fail);
		server.listen(at, "127.0.0.1", () => (server.off("error", fail), done()));
	});
	const events = (req: IncomingMessage, res: ServerResponse, target: string | null, remote: boolean) => {
		res.writeHead(200, { ...HEADERS, "content-type": "text/event-stream", connection: "keep-alive" });
		if (remote) remotes.add(res);
		// `hello` names this stream for the terminal mirrors it attaches (mirror.ts), which end with it; before the net's first reading, after it.
		const to = (event: string, data: unknown) => send(res, JSON.stringify(data), event), stream = randomBytes(16).toString("hex"), hello = () => to("hello", { stream, build });
		mirrors.open(stream, to);
		if (last) hello();
		const watch = target?.startsWith("w:") ? watchWorkspace(files, target.slice(2), to) : target ? watchSession(files, target, to) : undefined;
		clients.set(res, watch);
		if (last) res.write(`data: ${last}\n\n`);
		if (clients.size === 1) {
			poll = setInterval(() => void tick(), pollMs).unref();
			beat = setInterval(() => push("", "ping"), pingMs).unref();
		}
		// The registry is filled by reading the net, so a watched page starts once a reading exists, and an attach finds its session then.
		const first = !last;
		void (clients.size === 1 || first ? tick() : watch?.refresh())?.catch(() => {}).finally(() => first && hello());
		req.on("close", () => {
			clients.delete(res);
			remotes.delete(res);
			mirrors.close(stream);
			watch?.stop();
			if (!clients.size) (clearInterval(poll), clearInterval(beat));
		});
	};
	const server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://local"), pathname = url.pathname;
		const [, given, ...path] = pathname.split("/");
		const fail = (code: number) => res.writeHead(code, { ...HEADERS, "content-type": "text/plain" }).end(code === 403 ? "forbidden" : "not found");
		const answer = ({ status, body }: Reply) => res.writeHead(status, { ...HEADERS, "content-type": TYPES[".json"] }).end(JSON.stringify(body));
		const who = access.check(req, (server.address() as AddressInfo).port, given, path);
		if ("status" in who) return void (who.status === 403 ? fail(403) : res.writeHead(401, { ...HEADERS, "content-type": "text/plain" }).end("This device is not paired: scan a new QR code from /boss gui remote."));
		// A pairing code was just exchanged: the cookie is set, and the page reloads itself, so the cookie also rides on a same-site navigation.
		if ("cookie" in who) return void res.writeHead(200, { ...HEADERS, "content-type": TYPES[".html"], "set-cookie": cookieFor(token, who.cookie) }).end(`<!doctype html><meta http-equiv="refresh" content="0;url=/${token}/"><p>Paired. Opening the straw net…</p>`);
		if (path[0] === "doc") return void (docs ? docs.serve(req, res, path.slice(1), who.origin).catch(() => res.destroy()) : fail(404)); // the documents sessions show (docs.ts)
		if (path[0] === "api") {
			let parts: string[];
			try {
				parts = path.slice(1).map(decodeURIComponent);
			} catch {
				return void fail(404);
			}
			if ((parts[0] === "server" || parts.join("/") === "remote/on") && who.remote) return void fail(403); // only this machine stops the server or opens it to the tailnet
			if (["sessions", "remote", "server", "dirs", "open"].includes(parts[0]!)) return void control(req, who.origin, parts).then(answer, () => answer({ status: 500, body: { error: "internal", reason: "The request could not be handled." } }));
			if (req.method === "GET") return void (parts[0] === "doc" && docs ? answer(docs.text(parts[1] ?? "")) : api(files, parts, url.searchParams).then(answer, () => fail(404)));
		}
		if (req.method !== "GET") return void fail(403);
		// The page loads its assets and the stream relative to its own URL, so that URL must end with a slash.
		if (path.length === 0) return void res.writeHead(308, { ...HEADERS, location: `${pathname}/` }).end();
		if (path.join("/") === "events") return events(req, res, url.searchParams.get("watch"), who.remote);
		if (path[0] === "w") return void res.writeHead(200, { ...HEADERS, "content-type": TYPES[".html"] }).end(page);
		let file: string;
		try {
			file = decodeURIComponent(path.join("/")) || "index.html";
		} catch {
			return void fail(404);
		}
		if (file === "index.html") return void res.writeHead(200, { ...HEADERS, "content-type": TYPES[".html"] }).end(page);
		const body = bundle.get(file);
		if (!body) return void fail(404);
		res.writeHead(200, { ...HEADERS, "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(body);
	});
	try {
		await listen(port);
	} catch (error) {
		if (!port || (error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
		await listen(0);
	}
	const bound = (server.address() as AddressInfo).port;
	hub?.start(() => void (clients.size && tick())); // a relayed dialog shows at once, not at the next poll; the net is read only while a page listens
	function halt() {
		return new Promise<void>((done) => {
			hub?.stop();
			mirrors.stop();
			clearInterval(poll);
			clearInterval(beat);
			clients.forEach((_, c) => c.end());
			server.close(() => done());
			server.closeAllConnections();
		});
	}
	return {
		url: `http://127.0.0.1:${bound}/${token}/`, port: bound, token, csrf, access, stop: halt,
	};
}

// One server per machine. gui.json in the state directory records the running server (pid, port, token, owner session), and
// gui.lock makes the check-and-start atomic, so a second /boss gui, from this session or another, opens the running server
// instead of starting one. A dead server's port and token are reused, so a page left open reconnects to its successor. Any session reaches
// the running one: it asks it to stop (requestStop), or takes it over, stopping it and starting its own on the same URL. A session whose
// pi-straw-boss is newer takes it over unasked, so an update reaches every open page once one session has reloaded.
/** `ownerSession` is the owner's intercom session id: bridges follow it to the server's dialog channel. `reload` marks a server its owner's /reload stopped. */
export interface GuiRecord { pid: number; port: number; token: string; csrf?: string; owner: string; ownerSession?: string; version?: string; reload?: boolean }
/** `stale`: the running server is older and could not be taken over. */
export interface Shared { url: string; owner: string; mine?: Gui; stale?: boolean }

/** Whether version `a` is newer than `b`; a server that recorded none predates the handover. */
export function newer(a: string, b?: string) {
	const [x, y] = [a, b ?? "0"].map((v) => [...v.split(/[.-]/).slice(0, 3).map(Number), 0, 0].slice(0, 3)) as [number[], number[]];
	const i = x.findIndex((n, j) => n !== y[j]);
	return i >= 0 && x[i]! > y[i]!;
}
export const urlOf = (r: GuiRecord) => `http://127.0.0.1:${r.port}/${r.token}/`;

export function readRecord(dir: string): GuiRecord | undefined {
	try {
		return JSON.parse(readFileSync(join(dir, "gui.json"), "utf8")) as GuiRecord;
	} catch {
		return undefined;
	}
}

/** Marks this session's record, so the extension that loads after its /reload starts the server again on the same URL. */
export function markReload(dir: string, session: string) {
	const record = readRecord(dir);
	if (record?.ownerSession === session) writeFileSync(join(dir, "gui.json"), JSON.stringify({ ...record, reload: true }), { mode: 0o600 });
}

/** Asks a recorded server to stop, as its own page would, and waits until it is gone; false when it refused (a server from before 0.11.0) or stayed up. */
export async function requestStop(r: GuiRecord, asked: Asked, sleep: (ms: number) => Promise<void>) {
	const body = JSON.stringify(asked), origin = `http://127.0.0.1:${r.port}`;
	const status = await new Promise<number>((done) => {
		const headers = { host: `127.0.0.1:${r.port}`, origin, "content-type": "application/json", "x-sb-csrf": r.csrf ?? "", "content-length": Buffer.byteLength(body) };
		const req = request({ host: "127.0.0.1", port: r.port, path: `/${r.token}/api/server/stop`, method: "POST", headers, agent: false, timeout: 2000 }, (res) => (res.resume(), done(res.statusCode ?? 0)));
		req.on("error", () => done(0)).on("timeout", () => (req.destroy(), done(0)));
		req.end(body);
	});
	for (const end = Date.now() + 5000; status === 202 && Date.now() < end; await sleep(100)) if (!(await answers(r))) return true;
	return false;
}

/** Whether a recorded server answers its own page. */
export const answers = (r: GuiRecord) =>
	new Promise<boolean>((done) => {
		const req = request({ host: "127.0.0.1", port: r.port, path: `/${r.token}/`, headers: { host: `127.0.0.1:${r.port}` }, agent: false, timeout: 1000 }, (res) => {
			res.resume();
			done(res.statusCode === 200);
		});
		req.on("error", () => done(false)).on("timeout", () => (req.destroy(), done(false)));
		req.end();
	});

/** `take` takes the running server over whatever its version; a newer `version` takes it over anyway. */
export async function sharedGui(dir: string, [owner, ownerSession]: [string, string], start: (prefer: { port?: number; token?: string; csrf?: string }) => Promise<Gui>, sleep: (ms: number) => Promise<void>, { version = VERSION, take = false } = {}): Promise<Shared> {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const lock = join(dir, "gui.lock");
	for (let tries = 0; ; tries++) {
		try {
			writeFileSync(lock, String(process.pid), { flag: "wx" });
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			// A lock older than 10 s was left by a session that died while starting the server.
			const age = Date.now() - (statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
			if (age > 10_000) rmSync(lock, { force: true });
			else if (tries >= 50) throw new Error("Another session is starting the straw net GUI; try again");
			else await sleep(200);
		}
	}
	try {
		const record = readRecord(dir);
		const theirs = record && (await answers(record)) && { url: urlOf(record), owner: record.owner };
		if (theirs && !(take || newer(version, record.version))) return theirs;
		if (theirs && !(await requestStop(record, { by: owner, take: true }, sleep))) return { ...theirs, stale: true };
		const gui = await start(record ? { port: record.port, token: record.token, csrf: record.csrf } : {});
		writeFileSync(join(dir, "gui.json"), JSON.stringify({ pid: process.pid, port: gui.port, token: gui.token, csrf: gui.csrf, owner, ownerSession, version }), { mode: 0o600 });
		return { url: gui.url, owner, mine: gui };
	} finally {
		rmSync(lock, { force: true });
	}
}

/** Opens the default browser; rejects when the platform command fails, so the caller can show the URL instead. */
export const openBrowser = (url: string) =>
	new Promise<void>((done, fail) => {
		const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
		execFile(cmd!, args as string[], (error) => (error ? fail(error) : done()));
	});
