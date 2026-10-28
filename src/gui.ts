import { execFileExe } from "./exe.mjs";
import { system32, system32Path } from "./winpath.ts";
import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type RequestListener, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join } from "node:path";
import { waitsForLinkRequest, waitsForSecret } from "./ask.ts";
import { type ControlDeps, createControl, type Reply } from "./control.ts";
import type { HerdrCall } from "./herdr.ts";
import type { Hub } from "./dialogs.ts";
import { createDocs } from "./docs.ts";
import { canonical, readers } from "./history.ts";
import { createMirrors } from "./mirror.ts";
import type { Found, Net, Ref } from "./net.ts";
import { qr } from "./qr.ts";
import { type Access, cookieFor, createAccess } from "./remote.ts";
import { packageRoot, VERSION as PACKAGE_VERSION } from "./server/version.ts";
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

// Both come from the package folder, not from this file's place: the sb server bundles this module into dist/server, where "../dist/gui" and "../package.json" are not the package's.
export const BUNDLE = join(packageRoot(), "dist", "gui");
export const VERSION: string = PACKAGE_VERSION;
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json", ".woff2": "font/woff2", ".mp3": "audio/mpeg", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const HEADERS = {
	"cache-control": "no-store",
	"referrer-policy": "no-referrer",
	"x-content-type-options": "nosniff",
	"cross-origin-opener-policy": "same-origin", // a page a document's link opens cannot steer this tab
	"content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; media-src 'self'; manifest-src 'self'; connect-src 'self'; frame-src 'self'; base-uri 'self'; frame-ancestors 'none'",
};

/** What a page at a dead address says: the same words as the open page's banner. */
const REPLACED = "This address does not work here (the sb server may have restarted, or the link expired): on this computer open /boss gui; on a phone scan a new QR code.";
const REPLACED_ZH = "這個網址在這裡無法使用（sb server 可能重新啟動過，或連結已過期）：在這台電腦請開啟 /boss gui；在手機請重新掃描新的 QR code。";
export interface Gui { url: string; port: number; remotePort: number; token: string; csrf: string; access: Access; stop(): Promise<void> }
/** `net` is the registry behind the net reading (the allow list of session keys); without it no session can be watched. `call` reaches Herdr for input. */
/** `hub` carries answers to the dialogs bridges relay (dialogs.ts); it runs exactly as long as the server. */
/** `onRemote` and `onRemoteOff` turn remote access on and off from the page, in the session that runs the server. `onStop` takes another session's stop request (requestStop), so the owner also takes its remote entry down; without it the server stops itself. */
export interface GuiOptions { read(): Promise<Net>; net?: { lookup(key: string): Found | undefined; workspace(id: string): Ref[]; dismiss?(key: string): boolean; dismissAll?(): number }; call?: HerdrCall; hub?: Hub; dir?: string; paired?: string; port?: number; remotePort?: number; pollMs?: number; idleMs?: number; pingMs?: number; onStop?(asked: Asked): void; /** A takeover is refused with 409 (the sb server is never taken over by a session of an older build, which then leaves its GUI alone). */ refuseTake?: boolean; onRemote?(): Promise<void>; onRemoteOff?(): Promise<void>; onSaveFailed?(reason: string): void; spawn?: ControlDeps["spawn"]; close?: ControlDeps["close"]; trust?: { answer: NonNullable<ControlDeps["trust"]>; watch(poke: () => void): () => void }; link?: ControlDeps["link"]; server?: ControlDeps["server"]; tower?: ControlDeps["tower"]; /** How long a preferred port that is still held (by the server this one replaces) is retried before another is taken. */ bindWaitMs?: number; /** The server runs with the desk switch (STRAW_BOSS_DESK=1): the page carries `<meta name="sb-desk">` and hides GUI remote access and stash (gui/desk.ts). */ desk?: boolean }
export interface Asked { by: string; take: boolean }

/** Starts the server. A preferred `port` and `remotePort` are reused when free. The token and the CSRF secret are drawn anew for every listener that starts: a page an open tab already has, or whatever else holds the old ones, opens nothing here. */
export async function startGui({ read, net, call, hub, dir = BUNDLE, paired, port = 0, remotePort = 0, pollMs = 2000, idleMs = 10_000, pingMs = 15_000, onStop, refuseTake, onRemote, onRemoteOff, onSaveFailed, spawn, close, trust, link, server: panel, tower, bindWaitMs = 0, desk = false }: GuiOptions): Promise<Gui> {
	try {
		if (!statSync(join(dir, "index.html")).isFile()) throw new Error();
	} catch {
		throw new Error(`The GUI bundle is missing (${dir}); build it with npm run gui:build`);
	}
	// The whole bundle is read once: a package update replaces dist/gui under a running server, whose page names the old assets.
	const bundle = new Map(readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) => statSync(join(dir, f)).isFile()).map((f) => [f.split("\\").join("/"), readFileSync(join(dir, f))]));
	// `build` names this bundle in the page and in each stream's hello: a page from another build, reconnecting to this server, reloads itself.
	const html = bundle.get("index.html")!, build = createHash("sha256").update(html).digest("hex").slice(0, 16);
	// The token and the CSRF secret belong to this listener alone, whether or not its ports are the earlier GUI's: another account may have bound a port in the gap between two servers, and an open page of the earlier GUI
	// reconnects to whatever answers there with the token in its URL and the CSRF secret in its requests, so a token that outlived its listener could be one that process holds (RC3-F002). The local listener answers while the remote
	// one binds, and a request is refused until the routes are set.
	let routes: { local: RequestListener; remote: RequestListener } | undefined;
	const refuse: RequestListener = (_req, res) => void res.writeHead(503, { ...HEADERS, "content-type": "text/plain" }).end("starting");
	const server: Server = createServer((req, res) => (routes?.local ?? refuse)(req, res)), remoteServer: Server = createServer((req, res) => (routes?.remote ?? refuse)(req, res));
	const listen = (srv: Server, at: number) => new Promise<void>((done, fail) => {
		srv.once("error", fail);
		srv.listen(at, "127.0.0.1", () => (srv.off("error", fail), done()));
	});
	// A preferred port is kept when free; otherwise any free one. The remote listener is bound second, so it can never share the local port.
	// A restart's new server asks for the port the old one is still letting go: it is retried for `bindWaitMs` before another is taken.
	const bind = async (srv: Server, preferred: number) => {
		for (const end = Date.now() + bindWaitMs; ; ) {
			try {
				await listen(srv, preferred);
				break;
			} catch (error) {
				if (!preferred || (error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
				if (Date.now() < end) {
					await new Promise((r) => setTimeout(r, 100));
					continue;
				}
				await listen(srv, 0);
				break;
			}
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
	const token = randomBytes(16).toString("hex"), csrf = randomBytes(16).toString("hex");
	const page = html.toString("utf8").replace("<head>", `<head>\n<base href="/${token}/">\n<meta name="sb-csrf" content="${csrf}">${desk ? '\n<meta name="sb-desk" content="1">' : ""}\n<meta name="sb-build" content="${build}">`);
	const files: Files = { lookup: (key) => net?.lookup(key), workspace: (id) => net?.workspace(id) ?? [], readers: readers() };
	// Turning remote access off ends the streams of remote pages, and unpairing a device ends that device's (`remotes` names each stream's device); their next request finds the cookie void.
	const clients = new Map<ServerResponse, Watch | undefined>(), remotes = new Map<ServerResponse, string>(), access = createAccess(token, (device) => remotes.forEach((d, c) => (!device || d === device) && c.end()), paired);
	const pair = (code = access.pair(), host = access.remote?.host, url = `https://${host}/${token}/pair/${code}`) => (code && host ? { url, rows: qr(url).map((row) => row.map(Number).join("")) } : undefined);
	const mirrors = createMirrors({ call, lookup: (key) => net?.lookup(key), secret: waitsForSecret, canonical }), docs = hub && createDocs(hub, (key) => net?.lookup(key)?.name ?? key);
	const stop = (asked: Asked) => (refuseTake && asked.take ? false : (setTimeout(() => (onStop ? onStop(asked) : void halt()), 10), true)); // after the reply has gone out
	const dismissAll = async () => {
		const n = net?.dismissAll?.() ?? 0;
		if (n) await tick();
		return n;
	};
	const control = createControl({ link, server: panel, tower, lookup: (key) => net?.lookup(key), call, csrf, canonical, pair, remoteOn: onRemote, remoteOff: onRemoteOff, paired: { on: () => Boolean(access.remote), ...access.devices, unsaved: access.unsaved }, saveFailed: onSaveFailed, spawn, close: close && (async (kind, json) => (await tick(), close(kind, json, tick))), dismiss: async (key) => typeof key === "string" && Boolean(net?.dismiss?.(key)) && (await tick(), true), dismissAll, mirrors, stop, secret: waitsForSecret, linkRequest: waitsForLinkRequest, trust: trust?.answer, answers: hub && { has: hub.has, replay: hub.replay, ended: hub.ended, send: hub.send, probe: hub.probe, commands: hub.commands, pull: hub.pull, target: async (key) => (await tick(), hub.target(key)) } });
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
	const events = (req: IncomingMessage, res: ServerResponse, target: string | null, device?: string) => {
		res.writeHead(200, { ...HEADERS, "content-type": "text/event-stream", connection: "keep-alive" });
		if (device !== undefined) remotes.set(res, device);
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
			if (!clients.size) {
				clearInterval(poll);
				clearInterval(beat);
			}
		});
	};
	// One handler per listener: `kind` is the listener a request arrived on, which alone decides whether it may count as local.
	const handler = (kind: "local" | "remote", own: () => Server) => (req: IncomingMessage, res: ServerResponse) => {
		const url = new URL(req.url ?? "/", "http://local"), pathname = url.pathname;
		const [, given, ...path] = pathname.split("/");
		const fail = (code: number) => res.writeHead(code, { ...HEADERS, "content-type": "text/plain" }).end(code === 403 ? "forbidden" : "not found");
		const answer = ({ status, body }: Reply) => res.writeHead(status, { ...HEADERS, "content-type": TYPES[".json"] }).end(JSON.stringify(body));
		const who = access.check(req, kind, (own().address() as AddressInfo).port, given, path);
		if ("status" in who) {
			// A page load at a dead address (the token was replaced by a restart) says so, without a secret in it; a script's request gets the plain refusal.
			if (who.status === 403) return void (req.method === "GET" && req.headers["sec-fetch-dest"] === "document" ? res.writeHead(403, { ...HEADERS, "content-type": TYPES[".html"] }).end(`<!doctype html><meta charset="utf-8"><p>${/^\s*zh-(?:tw|hk|mo|hant)\b/i.test(String(req.headers["accept-language"] ?? "")) ? REPLACED_ZH : REPLACED}</p>`) : fail(403));
			// The SameSite=Strict cookie stays behind on a navigation from another site, and Android counts launching the installed app as one: such a
			// page load reloads itself once, a same-origin navigation that carries the cookie when this device has one. Sec-Fetch-Site decides, so the
			// reload never loops, and a browser that sends no Sec-Fetch-Site gets the plain refusal.
			const site = req.headers["sec-fetch-site"];
			if (req.method === "GET" && req.headers["sec-fetch-dest"] === "document" && typeof site === "string" && site !== "same-origin") return void res.writeHead(401, { ...HEADERS, "content-type": TYPES[".html"] }).end(`<!doctype html><meta http-equiv="refresh" content="0"><p><a href="">Open the straw net</a></p><p>If it does not open, this device is not paired: scan a new QR code from /boss gui remote.</p>`); // the link, same-origin too, for a browser that blocks refresh
			return void res.writeHead(401, { ...HEADERS, "content-type": "text/plain" }).end("This device is not paired. Scan a new QR code from /boss gui remote with this device's camera; it opens in the browser. An app installed from Chrome on Android shares the browser's pairing, so open it again after pairing. On iOS, pair in Safari, then delete the app and add it to the Home Screen again.");
		}
		if ("reissue" in who && who.reissue) res.setHeader("set-cookie", cookieFor(token, who.reissue)); // a use renewed the pairing: the browser's cookie lasts 90 days from now
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
			// Only this machine stops, restarts, or reads the log of the server, opens it to the tailnet or closes it, and lists or unpairs devices.
			if ((parts[0] === "server" || parts[0] === "remote") && who.remote) return void answer({ status: 403, body: { error: "local_only", reason: "This is done on this computer's own page." } });
			if (["sessions", "remote", "server", "dirs", "open", "close", "dismiss", "trust", "link", "tower"].includes(parts[0]!)) return void control(req, who.origin, parts, who.remote).then(answer, () => answer({ status: 500, body: { error: "internal", reason: "The request could not be handled." } }));
			// An entry never changes once written, so its image is cached for a day; the token in the URL keeps it to this page.
			if (req.method === "GET" && parts[0] === "image") return void image(files, parts.slice(1)).then((p) => (p ? res.writeHead(200, { ...HEADERS, "content-type": p.type, "cache-control": "private, max-age=86400" }).end(p.bytes) : fail(404)), () => fail(404));
			if (req.method === "GET") return void (parts[0] === "doc" && docs ? answer(docs.text(parts[1] ?? "")) : api(files, parts, url.searchParams).then(answer, () => fail(404)));
		}
		if (req.method !== "GET") return void fail(403);
		// The page loads its assets and the stream relative to its own URL, so that URL must end with a slash.
		if (path.length === 0) return void res.writeHead(308, { ...HEADERS, location: `${pathname}/` }).end();
		if (path.join("/") === "events") return events(req, res, url.searchParams.get("watch"), who.remote ? (who.device ?? "") : undefined);
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
	routes = { local: handler("local", () => server), remote: handler("remote", () => remoteServer) };
	hub?.start(() => void (clients.size && tick())); // a relayed dialog shows at once, not at the next poll
	const unwatch = trust?.watch(() => void (clients.size && tick())); // and so does a trust question
	// With no page listening the net is still read every `idleMs`, so its activity (activity.ts) is kept for the page that comes next: a phone that sleeps
	// drops its stream, and without this everything done meanwhile was a fresh start with no events (a gap over activity.ts GAP_MS is one).
	const idle = setInterval(() => clients.size || void tick(), idleMs).unref();
	function halt() {
		return new Promise<void>((done) => {
			hub?.stop();
			unwatch?.();
			mirrors.stop();
			clearInterval(poll);
			clearInterval(beat);
			clearInterval(idle);
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
/** The command that opens a URL: on Windows `cmd` by absolute path, run from System32 (a bare name is looked for in the current folder first). */
export const browserCommand = (url: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): [string, string[], { cwd?: string }] =>
	platform === "darwin" ? ["open", [url], {}] : platform === "win32" ? [system32Path("cmd.exe", env), ["/c", "start", "", url], { cwd: system32(env) }] : ["xdg-open", [url], {}];
export const openBrowser = (url: string) =>
	new Promise<void>((done, fail) => {
		const [cmd, args, options] = browserCommand(url);
		execFileExe(cmd, args, options, (error) => (error ? fail(error) : done()));
	});
