import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { type Asked, type Gui, VERSION } from "./gui.ts";

// One server per machine. gui.json in the state directory records the running server (pid, local and remote port, token, owner session), and
// gui.lock makes the check-and-start atomic, so a second /boss gui, from this session or another, opens the running server
// instead of starting one. A dead server's port and token are reused, so a page left open reconnects to its successor. Any session reaches
// the running one: it asks it to stop (requestStop), or takes it over, stopping it and starting its own on the same URL. A session whose
// pi-straw-boss is newer takes it over unasked, so an update reaches every open page once one session has reloaded.
/** `ownerSession` is the owner's intercom session id: bridges follow it to the server's dialog channel. `reload` marks a server its owner's /reload stopped. `remote` is only ever written by a build up to 0.32.1 (remote was on at that /reload); paired.json keeps the wish since. */
export interface GuiRecord { pid: number; port: number; remotePort?: number; token: string; csrf?: string; owner: string; ownerSession?: string; version?: string; reload?: boolean; remote?: boolean }
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

/**
 * Marks the record of the server this process runs, so the extension that loads after its /reload starts it again on the same URL.
 * Matched by pid, not by session id: pi-intercom, loaded first, has already cleared PI_INTERCOM_SESSION_ID when this runs at shutdown.
 */
export function markReload(dir: string, pid = process.pid) {
	const record = readRecord(dir);
	if (record?.pid === pid) writeFileSync(join(dir, "gui.json"), JSON.stringify({ ...record, reload: true }), { mode: 0o600 });
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

/** One POST to a recorded server's API from this machine, as its own page sends it: the status and the JSON body (status 0 when it did not answer). */
export function postServer(r: GuiRecord, path: string, json: Record<string, unknown>, timeoutMs: number) {
	const body = JSON.stringify(json), origin = `http://127.0.0.1:${r.port}`;
	return new Promise<{ status: number; body: Record<string, unknown> }>((done) => {
		const headers = { host: `127.0.0.1:${r.port}`, origin, "content-type": "application/json", "x-sb-csrf": r.csrf ?? "", "content-length": Buffer.byteLength(body) };
		const req = request({ host: "127.0.0.1", port: r.port, path: `/${r.token}/api/${path}`, method: "POST", headers, agent: false, timeout: timeoutMs }, (res) => {
			let text = "";
			res.setEncoding("utf8").on("data", (c: string) => (text += c)).on("end", () => {
				let parsed: Record<string, unknown> = {};
				try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { /* a body that is not JSON says nothing more than its status */ }
				done({ status: res.statusCode ?? 0, body: parsed });
			});
		});
		req.on("error", () => done({ status: 0, body: {} })).on("timeout", () => (req.destroy(), done({ status: 0, body: {} })));
		req.end(body);
	});
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
export async function sharedGui(dir: string, [owner, ownerSession]: [string, string], start: (prefer: { port?: number; remotePort?: number; token?: string; csrf?: string }) => Promise<Gui>, sleep: (ms: number) => Promise<void>, { version = VERSION, take = false } = {}): Promise<Shared> {
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
		const gui = await start(record ? { port: record.port, remotePort: record.remotePort, token: record.token, csrf: record.csrf } : {});
		writeFileSync(join(dir, "gui.json"), JSON.stringify({ pid: process.pid, port: gui.port, remotePort: gui.remotePort, token: gui.token, csrf: gui.csrf, owner, ownerSession, version }), { mode: 0o600 });
		return { url: gui.url, owner, mine: gui };
	} finally {
		rmSync(lock, { force: true });
	}
}
