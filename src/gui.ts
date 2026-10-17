import { execFile } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, request, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Net } from "./net.ts";

// The browser view's server: serves the built page and one live stream of the net, read-only, on 127.0.0.1 only.
// Every URL starts with a random token (/<token>/index.html, /<token>/events) and a request without it, or with another Host
// header, is refused, so other local pages cannot read the net. The stream sends the full snapshot on connect and on every
// change, plus a `ping` event every 15 s so a client can tell a silent drop from a quiet net. It polls only while someone listens.

export const BUNDLE = fileURLToPath(new URL("../dist/gui", import.meta.url));
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json" };
const HEADERS = {
	"cache-control": "no-store",
	"referrer-policy": "no-referrer",
	"x-content-type-options": "nosniff",
	"content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
};

export interface Gui { url: string; port: number; token: string; stop(): Promise<void> }
export interface GuiOptions { read(): Promise<Net>; dir?: string; port?: number; token?: string; pollMs?: number; pingMs?: number }

/** Starts the server. A preferred `port` (and `token`) is reused when free, so a restarted server keeps the URL an open page already has. */
export async function startGui({ read, dir = BUNDLE, port = 0, token = randomBytes(16).toString("hex"), pollMs = 2000, pingMs = 15_000 }: GuiOptions): Promise<Gui> {
	try {
		if (!statSync(join(dir, "index.html")).isFile()) throw new Error();
	} catch {
		throw new Error(`The GUI bundle is missing (${dir}); build it with npm run gui:build`);
	}
	const clients = new Set<ServerResponse>();
	let last: string | undefined, problem: string | undefined, busy = false;
	let poll: ReturnType<typeof setInterval> | undefined, beat: ReturnType<typeof setInterval> | undefined;
	const push = (data: string, event?: string) => clients.forEach((c) => c.write(`${event ? `event: ${event}\n` : ""}data: ${data}\n\n`));
	const tick = async () => {
		if (busy) return;
		busy = true;
		try {
			const json = JSON.stringify(await read());
			if (json !== last || problem) push((last = json));
			problem = undefined;
		} catch (error) {
			// The stream stays up and says why the net is unreadable, once per distinct reason.
			const message = (error as Error).message;
			if (message !== problem) push(JSON.stringify(message), "problem");
			problem = message;
		}
		busy = false;
	};
	const listen = (at: number) => new Promise<void>((done, fail) => {
		server.once("error", fail);
		server.listen(at, "127.0.0.1", () => (server.off("error", fail), done()));
	});
	const allowed = (req: IncomingMessage, given: string | undefined) => {
		const [a, b] = [Buffer.from(given ?? ""), Buffer.from(token)];
		return req.method === "GET" && req.headers.host === `127.0.0.1:${(server.address() as AddressInfo).port}` && a.length === b.length && timingSafeEqual(a, b);
	};
	const events = (req: IncomingMessage, res: ServerResponse) => {
		res.writeHead(200, { ...HEADERS, "content-type": "text/event-stream", connection: "keep-alive" });
		clients.add(res);
		if (last) res.write(`data: ${last}\n\n`);
		if (clients.size === 1) {
			poll = setInterval(() => void tick(), pollMs).unref();
			beat = setInterval(() => push("", "ping"), pingMs).unref();
			void tick();
		}
		req.on("close", () => {
			clients.delete(res);
			if (!clients.size) (clearInterval(poll), clearInterval(beat));
		});
	};
	const server = createServer((req, res) => {
		const pathname = new URL(req.url ?? "/", "http://local").pathname;
		const [, given, ...path] = pathname.split("/");
		const fail = (code: number) => res.writeHead(code, { ...HEADERS, "content-type": "text/plain" }).end(code === 403 ? "forbidden" : "not found");
		if (!allowed(req, given)) return void fail(403);
		// The page loads its assets and the stream relative to its own URL, so that URL must end with a slash.
		if (path.length === 0) return void res.writeHead(308, { ...HEADERS, location: `${pathname}/` }).end();
		if (path.join("/") === "events") return events(req, res);
		let file: string;
		try {
			file = resolve(dir, decodeURIComponent(path.join("/")) || "index.html");
			if (!file.startsWith(resolve(dir) + sep) || !statSync(file).isFile()) throw new Error();
		} catch {
			return void fail(404);
		}
		res.writeHead(200, { ...HEADERS, "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
		createReadStream(file).pipe(res);
	});
	try {
		await listen(port);
	} catch (error) {
		if (!port || (error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
		await listen(0);
	}
	const bound = (server.address() as AddressInfo).port;
	return {
		url: `http://127.0.0.1:${bound}/${token}/`, port: bound, token,
		stop: () => new Promise<void>((done) => {
			clearInterval(poll);
			clearInterval(beat);
			clients.forEach((c) => c.end());
			server.close(() => done());
			server.closeAllConnections();
		}),
	};
}

// One server per machine. gui.json in the state directory records the running server (pid, port, token, owner session), and
// gui.lock makes the check-and-start atomic, so a second /boss gui, from this session or another, opens the running server
// instead of starting one. A dead server's port and token are reused, so a page left open reconnects to its successor.
export interface GuiRecord { pid: number; port: number; token: string; owner: string }
export interface Shared { url: string; owner: string; mine?: Gui }
const urlOf = (r: GuiRecord) => `http://127.0.0.1:${r.port}/${r.token}/`;

export function readRecord(dir: string): GuiRecord | undefined {
	try {
		return JSON.parse(readFileSync(join(dir, "gui.json"), "utf8")) as GuiRecord;
	} catch {
		return undefined;
	}
}

/** Whether a recorded server answers its own page. */
export const answers = (r: GuiRecord) =>
	new Promise<boolean>((done) => {
		const req = request({ host: "127.0.0.1", port: r.port, path: `/${r.token}/`, headers: { host: `127.0.0.1:${r.port}` }, timeout: 1000 }, (res) => {
			res.resume();
			done(res.statusCode === 200);
		});
		req.on("error", () => done(false)).on("timeout", () => (req.destroy(), done(false)));
		req.end();
	});

export async function sharedGui(dir: string, owner: string, start: (prefer: { port?: number; token?: string }) => Promise<Gui>, sleep: (ms: number) => Promise<void>): Promise<Shared> {
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
		if (record && (await answers(record))) return { url: urlOf(record), owner: record.owner };
		const gui = await start(record ? { port: record.port, token: record.token } : {});
		writeFileSync(join(dir, "gui.json"), JSON.stringify({ pid: process.pid, port: gui.port, token: gui.token, owner }), { mode: 0o600 });
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
