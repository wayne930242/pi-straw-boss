import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { type Asked, type Gui, VERSION } from "./gui.ts";
import { alive, runs } from "./remote.ts";
import { startedLater, startOf } from "./startof.ts";

// One server per machine. gui.json in the state directory records the running server (pid, local and remote port, token, owner session), and
// gui.lock makes the check-and-start atomic, so a second /boss gui, from this session or another, opens the running server
// instead of starting one. A dead server's port and token are reused, so a page left open reconnects to its successor. Any session reaches
// the running one: it asks it to stop (requestStop), or takes it over, stopping it and starting its own on the same URL. A session whose
// pi-straw-boss is newer takes it over unasked, so an update reaches every open page once one session has reloaded. When the session that runs it ends without a
// stop, a survivor adopts it (adoptGui): the same port, token, and secret again, so a page left open reconnects by itself. The record tells the two endings apart.
/**
 * `ownerSession` is the owner's intercom session id: bridges follow it to the server's dialog channel. `started` is when the owner's process started, so a pid another
 * process now holds is not taken for the owner; only a build that marks its stops writes it, so a record without it is never adopted (a server such a build stopped looks
 * like one it quit). `herdr` is the socket of the Herdr server the server's net is read from: a session on another Herdr does not adopt it. `reload` marks a server its owner's
 * /reload stopped. `stopped` marks one stopped on purpose (a stop from any session): no session starts it again until someone runs /boss gui. `remote` is only ever written by a
 * build up to 0.32.1 (remote was on at that /reload); paired.json keeps the wish since. `trust: 1` says the server reads project trust requests (trust/serve.ts): a pi relays its trust question only to a server that has it.
 */
export interface GuiRecord { pid: number; started?: string; port: number; remotePort?: number; token: string; csrf?: string; owner: string; ownerSession?: string; version?: string; herdr?: string; reload?: boolean; stopped?: boolean; remote?: boolean; trust?: 1 }
/**
 * `stale`: the running server is older and could not be taken over. `from`: the owner whose end a survivor took the server over from. `moved`: the recorded port was taken, so the URL changed.
 * `stopped`: it was stopped on purpose and `keep.stopped` left it so. `late` (never rejects): this process's start time was not known when the record was written (on Windows it is read in the background), so the record has no `started`
 * yet; it settles to true when the record was written again with it, and to false when the time cannot be read or the record cannot be written, so no survivor adopts that server.
 */
export interface Shared { url: string; owner: string; mine?: Gui; stale?: boolean; from?: string; moved?: boolean; stopped?: boolean; late?: Promise<boolean> }
/** What a start under gui.lock leaves alone: a server stopped on purpose, a server that is down. Only `/boss gui` starts either. */
export interface Keep { stopped?: boolean; down?: boolean }

/** Whether version `a` is newer than `b`; a server that recorded none predates the handover. */
export function newer(a: string, b?: string) {
	const [x, y] = [a, b ?? "0"].map((v) => [...v.split(/[.-]/).slice(0, 3).map(Number), 0, 0].slice(0, 3)) as [number[], number[]];
	const i = x.findIndex((n, j) => n !== y[j]);
	return i >= 0 && x[i]! > y[i]!;
}
export const urlOf = (r: GuiRecord) => `http://127.0.0.1:${r.port}/${r.token}/`;

let temps = 0;
/**
 * Writes gui.json by rename: the record goes to a temporary file in the same directory (mode 600) and is renamed into place, so a reader (a session, or the desk shell) never sees half a file.
 * On Windows a rename onto a file that a reader has open can fail for a moment, so it is tried a few times.
 */
export function writeRecordFile(dir: string, record: GuiRecord) {
	const file = join(dir, "gui.json"), temp = `${file}.${process.pid}.${temps++}.tmp`;
	try {
		writeFileSync(temp, JSON.stringify(record), { mode: 0o600 });
		for (let tries = 0; ; tries++) {
			try {
				return renameSync(temp, file);
			} catch (error) {
				if (tries >= 20 || !["EPERM", "EBUSY", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
			}
		}
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}

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
	if (record?.pid === pid) writeRecordFile(dir, { ...record, reload: true });
}

/**
 * Marks the record of the server `seen` names as stopped on purpose, so no survivor starts it again. A record of another server is left alone, and that includes a successor
 * on the same port and token (a restart reuses both): the process and its start time must match too.
 */
export function markStopped(dir: string, seen: Pick<GuiRecord, "pid" | "started" | "port" | "token">) {
	const record = readRecord(dir);
	if (record?.pid === seen.pid && record.started === seen.started && record.port === seen.port && record.token === seen.token) writeRecordFile(dir, { ...record, stopped: true });
}

/** Whether a survivor may take over `record`'s server: its writer marks stops (`started`), and it serves the survivor's own Herdr. */
export const adoptable = (record: GuiRecord, { herdr }: { herdr: string }) => Boolean(record.started) && record.herdr === herdr;
/** Whether the server is a newer build's than the survivor: an older survivor takes it only when no newer one has, and downgrades it until the next newer session takes it back. */
export const downgrades = (record: GuiRecord, version: string) => Boolean(record.version && newer(record.version, version));

/**
 * A look at whether the process that recorded a server is gone for good, for a survivor to decide on: its pid is dead, or now belongs to another process (one that
 * started at another time, or after an old record was written). A process confirmed as the recorder is afterwards looked at by signal alone, not by `ps`.
 */
export function ownerGone(start: (pid: number) => string | undefined = startOf): (record: GuiRecord, wrote: number) => boolean {
	let confirmed: string | undefined;
	return (record, wrote) => {
		const key = `${record.pid}/${record.started ?? wrote}`;
		if (confirmed === key) return !alive(record.pid);
		if (!alive(record.pid)) return true;
		const now = start(record.pid);
		if (!runs(record, wrote, () => now)) return true;
		if (now) confirmed = key; // a start time that is not in yet (Windows) confirms nothing: the next look asks again
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

const STALE_MS = 10_000;
const ageOf = (file: string) => Date.now() - (statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
/**
 * Removes a gui.lock a session that died left (older than 10 s), once. Of several sessions that find it stale only the one that makes `gui.lock.stale` looks again and removes it, so none
 * removes the fresh lock another has just taken. False when another session is at it (or left its mark: a guard older than 10 s was left by a session that died inside this), for the caller to wait and try again.
 */
export function clearStale(lock: string) {
	const guard = `${lock}.stale`;
	try {
		mkdirSync(guard);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		if (ageOf(guard) > STALE_MS) rmSync(guard, { recursive: true, force: true });
		return false;
	}
	try {
		if (ageOf(lock) > STALE_MS) rmSync(lock, { force: true });
		return true;
	} finally {
		rmSync(guard, { recursive: true, force: true });
	}
}
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
			if (ageOf(lock) > STALE_MS && clearStale(lock)) continue; // a dead session's lock is gone: take it
			if (!patient) return false;
			if (tries >= 50) throw new Error("Another session is starting the straw net GUI; try again");
			await sleep(200);
		}
	}
}
const unlockGui = (dir: string) => rmSync(join(dir, "gui.lock"), { force: true });
/**
 * Records the server this process started. Without this process's start time yet (Windows reads it in the background), the record is written without `started` and again with it when it arrives, unless
 * another server has been recorded since; `late` tells the caller how that ended.
 */
export const writeRecord = (dir: string, gui: Gui, [owner, ownerSession]: [string, string], version: string, herdr: string, own = { at: startOf, later: startedLater }) => {
	const started = own.at(process.pid), record: GuiRecord = { pid: process.pid, started, port: gui.port, remotePort: gui.remotePort, token: gui.token, csrf: gui.csrf, owner, ownerSession, version, herdr, trust: 1 };
	writeRecordFile(dir, record);
	if (started) return {};
	return {
		late: own.later(process.pid).then((known) => {
			if (!known) return false;
			const now = readRecord(dir);
			if (now?.pid === record.pid && now.port === record.port && now.token === record.token && !now.started) writeRecordFile(dir, { ...now, started: known });
			return true;
		}).catch(() => false), // the record could not be written again (EPERM, a full disk): told as "not written", never as a rejection
	};
};
type Start = (prefer: { port?: number; remotePort?: number; token?: string; csrf?: string }) => Promise<Gui>;

/**
 * A stop typed in a session that does not run the server, under gui.lock: a survivor that is starting it finishes first, so the stop reads and marks the record that start wrote and
 * is not overwritten by it, and a server it started is asked to stop as it answers. `down`: nothing answered, and the record is marked so none is started later.
 */
export async function stopRecorded(dir: string, by: string, sleep: (ms: number) => Promise<void>): Promise<{ state: "down" | "stopped" | "refused"; record?: GuiRecord }> {
	await lockGui(dir, sleep, true);
	try {
		const record = readRecord(dir);
		if (!record || !(await answers(record))) {
			if (record && !record.stopped) markStopped(dir, record); // a server that is down may be about to be taken over: a stop is a stop all the same
			return { state: "down", record };
		}
		const stopped = await requestStop(record, { by, take: false }, sleep);
		if (stopped) markStopped(dir, record); // its owner marks it too, unless it is a build from before this record knew
		return { state: stopped ? "stopped" : "refused", record };
	} finally {
		unlockGui(dir);
	}
}

/**
 * `take` takes the running server over whatever its version; a newer `version` takes it over anyway. `herdr` is the socket the server's net is read from. `keep`: a server stopped on purpose, or one
 * that is down, is left as it is (read under the lock, so a stop typed meanwhile counts): the restore after a /reload keeps a stop, the takeover by a newer version also keeps a down server, and
 * `/boss stash` and `/boss close all` keep a stop.
 */
export async function sharedGui(dir: string, who: [string, string], start: Start, sleep: (ms: number) => Promise<void>, { version = VERSION, take = false, herdr = "", keep = {} as Keep } = {}): Promise<Shared> {
	await lockGui(dir, sleep, true);
	try {
		const record = readRecord(dir);
		if (record?.stopped && keep.stopped) return { url: urlOf(record), owner: record.owner, stopped: true };
		const theirs = record && (await answers(record)) && { url: urlOf(record), owner: record.owner };
		if (record && !theirs && keep.down) return { url: urlOf(record), owner: record.owner };
		if (theirs && !(take || newer(version, record.version))) return theirs;
		if (theirs && !(await requestStop(record, { by: who[0], take: true }, sleep))) return { ...theirs, stale: true };
		const gui = await start(record ? { port: record.port, remotePort: record.remotePort, token: record.token, csrf: record.csrf } : {});
		return { url: gui.url, owner: who[0], mine: gui, ...writeRecord(dir, gui, who, version, herdr) };
	} finally {
		unlockGui(dir);
	}
}

/**
 * A survivor's takeover of a server whose session ended: starts it again on the recorded port, token, and secret. It starts nothing when the server answers, when a deliberate stop
 * ended it, when `adoptable` says no (an old build's record, another Herdr), or when the session that ran it still lives (its /reload, /new, or /resume brings it back
 * in that process). Undefined then, and when another session holds gui.lock: that one is starting it, or is about to look. The lock is the arbiter, so of several survivors looking at
 * once exactly one starts it. `moved` is set when the recorded port was taken and the server got another.
 */
export async function adoptGui(dir: string, who: [string, string], start: Start, sleep: (ms: number) => Promise<void>, gone: (record: GuiRecord, wrote: number) => boolean, { version = VERSION, herdr = "" } = {}): Promise<Shared | undefined> {
	if (!(await lockGui(dir, sleep, false))) return undefined;
	try {
		const record = readRecord(dir), wrote = statSync(join(dir, "gui.json"), { throwIfNoEntry: false })?.mtimeMs ?? 0;
		if (!record || record.stopped || !adoptable(record, { herdr }) || !gone(record, wrote) || (await answers(record))) return undefined;
		const gui = await start({ port: record.port, remotePort: record.remotePort, token: record.token, csrf: record.csrf });
		return { url: gui.url, owner: who[0], mine: gui, from: record.owner, ...writeRecord(dir, gui, who, version, herdr), ...(gui.url === urlOf(record) ? {} : { moved: true }) };
	} finally {
		unlockGui(dir);
	}
}
