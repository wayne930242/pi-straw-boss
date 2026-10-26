import { appendFileSync, chmodSync, closeSync, existsSync, fstatSync, openSync, readSync, renameSync, rmSync, statSync } from "node:fs";

// The server's log: `server.log`, mode 600, one line per event. It holds events and their facts (a pid, a version, a reason, an outcome), never message text,
// a brief, a token, a secret, a CSRF value, or file contents, as the relay's logs hold no bodies. It is rotated at 5 MB and keeps `server.log.1` to `server.log.3`.

export const LOG_MAX = 5 * 1024 * 1024;
export const LOG_KEEP = 3;
export type Fact = string | number | boolean | undefined;

export interface Log {
	/** One line: the event name and its facts. */
	line(event: string, facts?: Record<string, Fact>): void;
	/** Values that must never reach the log (the connection secret, the GUI token): any text equal to one is replaced. */
	hide(...secrets: (string | undefined)[]): void;
}

const oneLine = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim();
const quote = (value: string) => (/^[\w@%+=:,./~-]+$/.test(value) ? value : JSON.stringify(value));

export function createLog(file: string, { now = Date.now, max = LOG_MAX, keep = LOG_KEEP }: { now?: () => number; max?: number; keep?: number } = {}): Log {
	const secrets = new Set<string>();
	let opened = false;
	const scrub = (text: string) => [...secrets].reduce((out, secret) => out.split(secret).join("[hidden]"), text);
	const rotate = () => {
		const size = statSync(file, { throwIfNoEntry: false })?.size ?? 0;
		if (size < max) return;
		rmSync(`${file}.${keep}`, { force: true });
		for (let n = keep - 1; n >= 1; n--) if (existsSync(`${file}.${n}`)) renameSync(`${file}.${n}`, `${file}.${n + 1}`);
		renameSync(file, `${file}.1`);
	};
	return {
		hide: (...more) => more.forEach((secret) => secret && secrets.add(secret)),
		line(event, facts = {}) {
			const fields = Object.entries(facts).flatMap(([key, value]) => (value === undefined ? [] : [`${key}=${quote(oneLine(String(value)))}`]));
			const text = scrub(`${new Date(now()).toISOString()} ${event}${fields.length ? ` ${fields.join(" ")}` : ""}`);
			try {
				rotate();
				appendFileSync(file, `${text}\n`, { mode: 0o600 });
				if (!opened) {
					opened = true;
					chmodSync(file, 0o600);
				}
			} catch {
				// A log that cannot be written must not stop the server; stderr is the detached server's nowhere, so the line is lost.
			}
		},
	};
}

/** The last `lines` lines of the log, reaching into `server.log.1` and on when the current file is short. Reads only what it needs, so a 5 MB log costs little. */
export function tailLog(file: string, lines = 200, keep = LOG_KEEP): string[] {
	const out: string[] = [];
	for (let n = 0; n <= keep && out.length < lines; n++) {
		const text = readTail(n === 0 ? file : `${file}.${n}`, lines - out.length);
		out.unshift(...text);
	}
	return out.slice(-lines);
}
function readTail(file: string, lines: number): string[] {
	let fd: number;
	try {
		fd = openSync(file, "r");
	} catch {
		return [];
	}
	try {
		const size = fstatSync(fd).size, chunk = 64 * 1024;
		let end = size, text = "";
		while (end > 0 && text.split("\n").length <= lines + 1) {
			const start = Math.max(0, end - chunk), buffer = Buffer.alloc(end - start);
			readSync(fd, buffer, 0, buffer.length, start);
			text = buffer.toString("utf8") + text;
			end = start;
		}
		const all = text.split("\n");
		if (all.at(-1) === "") all.pop();
		return (end > 0 ? all.slice(1) : all).slice(-lines);
	} finally {
		closeSync(fd);
	}
}
/** The size of the log file now, for a follower that watches it grow. */
export const logSize = (file: string) => statSync(file, { throwIfNoEntry: false })?.size ?? 0;
/** What was appended to the log since `from`; a file that is smaller than `from` was rotated, and is read from its start. */
export function readFrom(file: string, from: number): { text: string; size: number } {
	const size = logSize(file), start = size < from ? 0 : from;
	if (size === start) return { text: "", size };
	const fd = openSync(file, "r");
	try {
		const buffer = Buffer.alloc(size - start);
		readSync(fd, buffer, 0, buffer.length, start);
		return { text: buffer.toString("utf8"), size };
	} finally {
		closeSync(fd);
	}
}
