import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
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
import { api, type Hub as Files, image, watchSession, type Watch, watchWorkspace } from "./watch.ts";

// The browser view's server: serves the built page and one live stream of the net, read-only, on 127.0.0.1 only.
// Two loopback listeners share one handler. The local one is for this computer's browser; the remote one is the only target `tailscale serve`
// points at, and every request on it is remote whatever its Host or headers say (remote.ts), so the split never rests on a proxy's headers.
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
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json", ".woff2": "font/woff2", ".mp3": "audio/mpeg" };
const HEADERS = {
	"cache-control": "no-store",
	"referrer-policy": "no-referrer",
	"x-content-type-options": "nosniff",
	"cross-origin-opener-policy": "same-origin", // a page a document's link opens cannot steer this tab
	"content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; media-src 'self'; connect-src 'self'; frame-src 'self'; base-uri 'self'; frame-ancestors 'none'",
};

export interface Gui { url: string; port: number; remotePort: number; token: string; csrf: string; access: Access; stop(): Promise<void> }
/** `net` is the registry behind the net reading (the allow list of session keys); without it no session can be watched. `call` reaches Herdr for input. */
/** `hub` carries answers to the dialogs bridges relay (dialogs.ts); it runs exactly as long as the server. */
/** `onRemote` turns remote access on from the page, in the session that runs the server. `onStop` takes another session's stop request (requestStop), so the owner also takes its remote entry down; without it the server stops itself. */
export interface GuiOptions { read(): Promise<Net>; net?: { lookup(key: string): Found | undefined; workspace(id: string): Ref[] }; call?: HerdrCall; hub?: Hub; dir?: string; port?: number; remotePort?: number; token?: string; csrf?: string; pollMs?: number; pingMs?: number; onStop?(asked: Asked): void; onRemote?(): Promise<void>; spawn?: ControlDeps["spawn"]; close?: ControlDeps["close"] }
export interface Asked { by: string; take: boolean }

/** Starts the server. A preferred `port` and `remotePort` (with the `token` and `csrf`) are reused when free, so a restarted server keeps the URL and the page an open tab already has. */
export async function startGui({ read, net, call, hub, dir = BUNDLE, port = 0, remotePort = 0, token = randomBytes(16).toString("hex"), csrf = randomBytes(16).toString("hex"), pollMs = 2000, pingMs = 15_000, onStop, onRemote, spawn, close }: GuiOptions): Promise<Gui> {
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
	const control = createControl({ lookup: (key) => net?.lookup(key), call, csrf, canonical, pair, remoteOn: onRemote, spawn, close: close && (async (kind, json) => (await tick(), close(kind, json))), mirrors, stop, secret: waitsForSecret, answers: hub && { replay: hub.replay, ended: hub.ended, send: hub.send, probe: hub.probe, commands: hub.commands, target: async (key) => (await tick(), hub.target(key)) } });
	let last: string | undefined, problem: string | undefined, inflight: Promise<void> | undefined;
	let poll: ReturnType<typeof setInterval> | undefined, beat: ReturnType<typeof setInterval> | undefined;
	const send = (to: ServerResponse, data: string, event?: string) => to.writableEnded || to.write(`${event ? `event: ${event}\n` : ""}data: ${data}\n\n`); // a reading in flight at stop ends after the streams
	const push = (data: string, event?: string) => clients.forEach((_, c) => send(c, data, event));
	// One reading at a time; a caller that arrives meanwhile waits for the one in flight.
	const tick = () => (inflight ??= (async () => {
		try {
			const net = await read(), json = JSON.stringify(net);
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
	const listen = (srv: Server, at: number) => new Promise<void>((done, fail) => {
		srv.once("error", fail);
		srv.listen(at, "127.0.0.1", () => (srv.off("error", fail), done()));
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
	// One handler per listener: `kind` is the listener a request arrived on, which alone decides whether it may count as local.
	const handler = (kind: "local" | "remote", own: () => Server) => (req: IncomingMessage, res: ServerResponse) => {
		const url = new URL(req.url ?? "/", "http://local"), pathname = url.pathname;
		const [, given, ...path] = pathname.split("/");
		const fail = (code: number) => res.writeHead(code, { ...HEADERS, "content-type": "text/plain" }).end(code === 403 ? "forbidden" : "not found");
		const answer = ({ status, body }: Reply) => res.writeHead(status, { ...HEADERS, "content-type": TYPES[".json"] }).end(JSON.stringify(body));
		const who = access.check(req, kind, (own().address() as AddressInfo).port, given, path);
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
			if (["sessions", "remote", "server", "dirs", "open", "close"].includes(parts[0]!)) return void control(req, who.origin, parts).then(answer, () => answer({ status: 500, body: { error: "internal", reason: "The request could not be handled." } }));
			// An entry never changes once written, so its image is cached for a day; the token in the URL keeps it to this page.
			if (req.method === "GET" && parts[0] === "image") return void image(files, parts.slice(1)).then((p) => (p ? res.writeHead(200, { ...HEADERS, "content-type": p.type, "cache-control": "private, max-age=86400" }).end(p.bytes) : fail(404)), () => fail(404));
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
		// A font's or sound's name carries its content hash, so a phone keeps it instead of fetching it on every page load.
		const keep = /\.(woff2|mp3)$/.test(file) ? { "cache-control": "private, max-age=31536000, immutable" } : {};
		res.writeHead(200, { ...HEADERS, ...keep, "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(body);
	};
	const server: Server = createServer(handler("local", () => server)), remoteServer: Server = createServer(handler("remote", () => remoteServer));
	// A preferred port is kept when free; otherwise any free one. The remote listener is bound second, so it can never share the local port.
	const bind = async (srv: Server, preferred: number) => {
		try {
			await listen(srv, preferred);
		} catch (error) {
			if (!preferred || (error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
			await listen(srv, 0);
		}
		return (srv.address() as AddressInfo).port;
	};
	let bound: number, boundRemote: number;
	try {
		bound = await bind(server, port);
		boundRemote = await bind(remoteServer, remotePort);
	} catch (error) {
		server.close();
		throw error;
	}
	hub?.start(() => void (clients.size && tick())); // a relayed dialog shows at once, not at the next poll; the net is read only while a page listens
	function halt() {
		return new Promise<void>((done) => {
			hub?.stop();
			mirrors.stop();
			clearInterval(poll);
			clearInterval(beat);
			clients.forEach((_, c) => c.end());
			let open = 2;
			for (const srv of [server, remoteServer]) {
				srv.close(() => --open || done());
				srv.closeAllConnections();
			}
		});
	}
	return {
		url: `http://127.0.0.1:${bound}/${token}/`, port: bound, remotePort: boundRemote, token, csrf, access, stop: halt,
	};
}

/** Opens the default browser; rejects when the platform command fails, so the caller can show the URL instead. */
export const openBrowser = (url: string) =>
	new Promise<void>((done, fail) => {
		const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
		execFile(cmd!, args as string[], (error) => (error ? fail(error) : done()));
	});
