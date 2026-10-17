import { execFile } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
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

/** Opens the default browser; rejects when the platform command fails, so the caller can show the URL instead. */
export const openBrowser = (url: string) =>
	new Promise<void>((done, fail) => {
		const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
		execFile(cmd!, args as string[], (error) => (error ? fail(error) : done()));
	});
