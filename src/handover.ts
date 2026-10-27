import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { connect } from "node:net";
import { join } from "node:path";
import { alive } from "./remote.ts";
import { setTimeout as delay } from "node:timers/promises";
import { startedLater } from "./startof.ts";

// gui.json in the state directory records the GUI the sb server serves (src/server/guihost.ts): its pid and start time, the local and remote port, the token, and the server's
// intercom session. It is the contract straw-boss-desk and the sessions' dialog bridges read (docs/how-it-works.md, `gui.json` is a contract). The server writes it by rename
// when its GUI starts, and a restart or upgrade writes it again with the same port and token, so a page left open reconnects to its successor. Sessions only read it.
/**
 * `pid` and `started` name the sb server, the process that serves the GUI (a pi session before 0.46.0); `owner` is `sb server (pid N)` and `ownerSession` the server's intercom session id: dialog bridges
 * follow it to the server's dialog channel. `herdr` is the socket of the Herdr server the server's net is read from. `stopped` marks a GUI stopped on purpose (`/boss gui stop`) or the whole server stopped on purpose.
 * `trust: 1` says the server reads project trust requests (trust/serve.ts): a pi relays its trust question only to a server that has it. `reload` and `remote` were written by builds up to 0.45.0 and are no longer.
 */
export interface GuiRecord { pid: number; started?: string; port: number; remotePort?: number; token: string; csrf?: string; owner: string; ownerSession?: string; version?: string; herdr?: string; reload?: boolean; stopped?: boolean; remote?: boolean; trust?: 1 }

export const urlOf = (r: GuiRecord) => `http://127.0.0.1:${r.port}/${r.token}/`;

let temps = 0;
/**
 * Writes gui.json by rename: the record goes to a temporary file in the same directory (mode 600) and is renamed into place, so a reader (a session, or the desk shell) never sees half a file.
 * On Windows a rename onto a file that a reader has open can fail for a moment, so it is tried a few times.
 */
export function writeRecordFile(dir: string, record: GuiRecord) {
	// Created new (`wx`) under a name no earlier file has, as record.ts writeJson does (R8-F002): a temporary file that was already there is never written to and renamed into place.
	const file = join(dir, "gui.json"), temp = `${file}.${process.pid}.${temps++}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		writeFileSync(temp, JSON.stringify(record), { mode: 0o600, flag: "wx" });
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


/** Whether anything accepts a connection on the port. Nothing is sent: this is how a wait for a server to let go of its port looks, without giving the token to whoever binds the port next. */
export const listening = (port: number) =>
	new Promise<boolean>((done) => {
		const socket = connect({ host: "127.0.0.1", port, timeout: 1000 });
		socket.once("connect", () => (socket.destroy(), done(true))).once("error", () => done(false)).once("timeout", () => (socket.destroy(), done(false)));
	});

const START_WAIT_MS = 6000;
/** Where a session reads another process's start time and how long it waits: the process's own cache and 6 s unless a test (or a caller) says otherwise. */
export interface StartRead { later?: (pid: number, o: { hold: false }) => Promise<string | undefined>; waitMs?: number }
/** Another process's start time, waited for up to 6 s: a Windows read is 3.5 to 5 s on a cold cache, and a new pi asks its trust question once, at its start. Unknown after the bound stays unknown (nothing is sent). */
export const startBounded = (pid: number, waitMs = START_WAIT_MS, later: NonNullable<StartRead["later"]> = startedLater): Promise<string | undefined> => Promise.race([later(pid, { hold: false }).catch(() => undefined), delay<undefined>(waitMs, undefined, { ref: false })]);

/**
 * Whether the recorded server runs and answers its page, for a session that is not the server (the tower's dashboard, a trust question). The token goes to the port only after the process that
 * recorded it is shown to be alive: its pid runs and its start time is the recorded one. A record without a start time, or one the machine cannot tell yet (the Windows read is not in within 6 s), is not verified,
 * and nothing is sent: another account's process may hold the port a crashed server left (RC2-F001). `read` is where the start time comes from; the callers pass the session's own (`cfg.startRead`), which is the process's cache by default.
 */
export const answersLive = async (r: GuiRecord, { later, waitMs }: StartRead = {}): Promise<boolean> => Boolean(r.started) && alive(r.pid) && (await startBounded(r.pid, waitMs, later)) === r.started && answers(r);
