import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { type Asked, type Gui, VERSION } from "./gui.ts";
import { alive, runs, startOf } from "./remote.ts";

// One server per machine. gui.json in the state directory records the running server (pid, local and remote port, token, owner session), and
// gui.lock makes the check-and-start atomic, so a second /boss gui, from this session or another, opens the running server
// instead of starting one. A dead server's port and token are reused, so a page left open reconnects to its successor. Any session reaches
// the running one: it asks it to stop (requestStop), or takes it over, stopping it and starting its own on the same URL. A session whose
// pi-straw-boss is newer takes it over unasked, so an update reaches every open page once one session has reloaded. When the session that runs it ends without a
// stop, a survivor adopts it (adoptGui): the same port, token, and secret again, so a page left open reconnects by itself. The record tells the two endings apart.
/**
 * `ownerSession` is the owner's intercom session id: bridges follow it to the server's dialog channel. `started` is when the owner's process started, so a pid another
 * process now holds is not taken for the owner. `reload` marks a server its owner's /reload stopped. `stopped` marks one stopped on purpose (a stop from any session): no
 * session starts it again until someone runs /boss gui. `remote` is only ever written by a build up to 0.32.1 (remote was on at that /reload); paired.json keeps the wish since.
 */
export interface GuiRecord { pid: number; started?: string; port: number; remotePort?: number; token: string; csrf?: string; owner: string; ownerSession?: string; version?: string; reload?: boolean; stopped?: boolean; remote?: boolean }
/** `stale`: the running server is older and could not be taken over. `from`: the owner whose end a survivor took the server over from. */
export interface Shared { url: string; owner: string; mine?: Gui; stale?: boolean; from?: string }

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

/** Marks the record of the server on `port` with `token` as stopped on purpose, so no survivor starts it again; another server's record is left alone. */
export function markStopped(dir: string, { port, token }: { port: number; token: string }) {
	const record = readRecord(dir);
	if (record?.port === port && record.token === token) writeFileSync(join(dir, "gui.json"), JSON.stringify({ ...record, stopped: true }), { mode: 0o600 });
}

/**
 * A look at whether the process that recorded a server is gone for good, for a survivor to decide on: its pid is dead, or now belongs to another process (one that
 * started at another time, or after an old record was written). A process confirmed as the recorder is afterwards looked at by signal alone, not by `ps`.
 */
export function ownerGone(start: (pid: number) => string | undefined = startOf): (record: GuiRecord, wrote: number) => boolean {
	let confirmed: string | undefined;
	return (record, wrote) => {
		const key = `${record.pid}/${record.started ?? wrote}`;
		if (confirmed === key) return !alive(record.pid);
		if (!runs(record, wrote, start)) return true;
		confirmed = key;
		return false;
	};
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

/** Takes gui.lock, which makes the check-and-start of a server atomic. Patient: waits for another session's start (a lock older than 10 s was left by a session that died); otherwise false at once when it is held. */
async function lockGui(dir: string, sleep: (ms: number) => Promise<void>, patient: boolean) {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const lock = join(dir, "gui.lock");
	for (let tries = 0; ; tries++) {
		try {
			writeFileSync(lock, String(process.pid), { flag: "wx" });
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const age = Date.now() - (statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
			if (age > 10_000) rmSync(lock, { force: true });
			else if (!patient) return false;
			else if (tries >= 50) throw new Error("Another session is starting the straw net GUI; try again");
			else await sleep(200);
		}
	}
}
const unlockGui = (dir: string) => rmSync(join(dir, "gui.lock"), { force: true });
/** Records the server this process started. */
const writeRecord = (dir: string, gui: Gui, [owner, ownerSession]: [string, string], version: string) =>
	writeFileSync(join(dir, "gui.json"), JSON.stringify({ pid: process.pid, started: startOf(process.pid), port: gui.port, remotePort: gui.remotePort, token: gui.token, csrf: gui.csrf, owner, ownerSession, version }), { mode: 0o600 });
type Start = (prefer: { port?: number; remotePort?: number; token?: string; csrf?: string }) => Promise<Gui>;

/** `take` takes the running server over whatever its version; a newer `version` takes it over anyway. */
export async function sharedGui(dir: string, who: [string, string], start: Start, sleep: (ms: number) => Promise<void>, { version = VERSION, take = false } = {}): Promise<Shared> {
	await lockGui(dir, sleep, true);
	try {
		const record = readRecord(dir);
		const theirs = record && (await answers(record)) && { url: urlOf(record), owner: record.owner };
		if (theirs && !(take || newer(version, record.version))) return theirs;
		if (theirs && !(await requestStop(record, { by: who[0], take: true }, sleep))) return { ...theirs, stale: true };
		const gui = await start(record ? { port: record.port, remotePort: record.remotePort, token: record.token, csrf: record.csrf } : {});
		writeRecord(dir, gui, who, version);
		return { url: gui.url, owner: who[0], mine: gui };
	} finally {
		unlockGui(dir);
	}
}

/**
 * A survivor's takeover of a server whose session ended: starts it again on the recorded port, token, and secret. It starts nothing when the server answers, when a deliberate stop
 * ended it, or when the session that ran it still lives (its /reload, /new, or /resume brings it back in that process). Undefined then, and when another session holds gui.lock:
 * that one is starting it, or is about to look. The lock is the arbiter, so of several survivors looking at once exactly one starts it.
 */
export async function adoptGui(dir: string, who: [string, string], start: Start, sleep: (ms: number) => Promise<void>, gone: (record: GuiRecord, wrote: number) => boolean, { version = VERSION } = {}): Promise<Shared | undefined> {
	if (!(await lockGui(dir, sleep, false))) return undefined;
	try {
		const record = readRecord(dir), wrote = statSync(join(dir, "gui.json"), { throwIfNoEntry: false })?.mtimeMs ?? 0;
		if (!record || record.stopped || !gone(record, wrote) || (await answers(record))) return undefined;
		const gui = await start({ port: record.port, remotePort: record.remotePort, token: record.token, csrf: record.csrf });
		writeRecord(dir, gui, who, version);
		return { url: gui.url, owner: who[0], mine: gui, from: record.owner };
	} finally {
		unlockGui(dir);
	}
}
