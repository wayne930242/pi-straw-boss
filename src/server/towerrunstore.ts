import { appendFileSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Slot } from "./record.ts";
import { ensureDir, safe, towerDir, writeDurable, writeDurableText } from "./towerstore.ts";

// What a tower service keeps about its runs (docs/specs/2026-10-26-sb-backend.md, State): `runs/<run id>.json` (the last 50), `notes.jsonl` (handoff notes: the last 10 of each kind), and `timer.json`
// (the one pending `wakeAfter`). Each file is written by rename, flushed, mode 600, in the service's 700 folder.

export const KEEP_RUNS = 50;
export const KEEP_NOTES = 10;
export type Outcome = "done" | "timeout" | "crashed" | "quit" | "herdr-restart";
/** One run: a pi session the service started (or the boss started by hand in the standing pane). */
export interface RunRecord {
	id: string;
	workspace: string;
	kind: "local" | "ally";
	/** An ally run: the device, its label, the team, and the level it was claimed at (B6). */
	device?: string;
	deviceLabel?: string;
	deviceShort?: string;
	team?: string;
	teamName?: string;
	level?: string;
	pane: string;
	/** The Herdr agent name the run was started under; unique per run (the broker treats a name and cwd as one mailbox identity). */
	agent: string;
	/** pi's PID and its start time, read from Herdr's process list right after the start: a claim must match them. */
	pid?: number;
	started?: string;
	/** The processes between Herdr's listed one and pi's own, when pi was started through a wrapper (`cmd.exe /c pi.cmd`): the listed one first. A kill takes pi's own and then the listed one. */
	via?: number[];
	/** The pi session file, once the pane reports it. */
	file?: string;
	startedAt: string;
	endedAt?: string;
	outcome?: Outcome;
	/** The ids of the events the run took. */
	events: string[];
	/** An ally run: the ids of the inbox messages it was given at its start (at most 5); a message that comes later waits for the next run. */
	admitted?: string[];
	/** Claimed once: a second claim for the same run is refused (a server restart's reconnect is the one exception). */
	claimed?: true;
	/** The boss started pi in the standing pane by hand. */
	hand?: true;
	/** A short word on why it ended (the quit failed, the pane vanished). */
	detail?: string;
}
export interface NoteRow { kind: "local" | "ally"; device?: string; run: string; at: string; note: string }

const runsDir = (slot: Slot, workspace: string) => join(towerDir(slot, workspace), "runs");
const readJson = <T>(file: string): T | undefined => {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as T;
	} catch {
		return undefined;
	}
};

export function writeRun(slot: Slot, run: RunRecord): void {
	ensureDir(towerDir(slot, run.workspace));
	ensureDir(runsDir(slot, run.workspace));
	writeDurable(join(runsDir(slot, run.workspace), `${safe(run.id)}.json`), run);
}
export const readRun = (slot: Slot, workspace: string, id: string) => readJson<RunRecord>(join(runsDir(slot, workspace), `${safe(id)}.json`));
/** Every run record of a workspace, oldest first (by start). */
export function listRuns(slot: Slot, workspace: string): RunRecord[] {
	let names: string[] = [];
	try {
		names = readdirSync(runsDir(slot, workspace)).filter((n) => n.endsWith(".json"));
	} catch { return []; }
	return names.flatMap((n) => {
		const run = readJson<RunRecord>(join(runsDir(slot, workspace), n));
		return run && typeof run.id === "string" && typeof run.startedAt === "string" ? [run] : [];
	}).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}
/** Keeps the last KEEP_RUNS records; a run that has not ended is never removed. */
export function pruneRuns(slot: Slot, workspace: string): void {
	const all = listRuns(slot, workspace);
	for (const run of all.slice(0, Math.max(0, all.length - KEEP_RUNS))) if (run.outcome) rmSync(join(runsDir(slot, workspace), `${safe(run.id)}.json`), { force: true });
}

const notesFile = (slot: Slot, workspace: string) => join(towerDir(slot, workspace), "notes.jsonl");
export function readNotes(slot: Slot, workspace: string): NoteRow[] {
	try {
		return readFileSync(notesFile(slot, workspace), "utf8").split("\n").flatMap((line) => {
			try {
				const row = JSON.parse(line) as NoteRow;
				return typeof row?.note === "string" && (row.kind === "local" || row.kind === "ally") ? [row] : [];
			} catch { return []; }
		});
	} catch { return []; }
}
/** Adds a handoff note and keeps the last KEEP_NOTES of its kind (an ally's notes per device); local and ally notes never cross. */
export function addNote(slot: Slot, workspace: string, row: NoteRow): void {
	ensureDir(towerDir(slot, workspace));
	const same = (r: NoteRow) => r.kind === row.kind && r.device === row.device;
	const all = [...readNotes(slot, workspace), row], mine = all.filter(same);
	if (mine.length <= KEEP_NOTES) return void appendFileSync(notesFile(slot, workspace), `${JSON.stringify(row)}\n`, { mode: 0o600 });
	const drop = new Set(mine.slice(0, mine.length - KEEP_NOTES));
	writeDurableText(notesFile(slot, workspace), all.filter((r) => !drop.has(r)).map((r) => JSON.stringify(r)).join("\n") + "\n");
}
/** The last note of a kind (for an ally, of a device). */
export const lastNote = (slot: Slot, workspace: string, kind: "local" | "ally", device?: string) => readNotes(slot, workspace).filter((r) => r.kind === kind && r.device === device).at(-1);

const timerFile = (slot: Slot, workspace: string) => join(towerDir(slot, workspace), "timer.json");
/** The pending `wakeAfter`: one per workspace; a later one replaces it. */
export const readTimer = (slot: Slot, workspace: string) => readJson<{ at: number; asked: string }>(timerFile(slot, workspace));
export function writeTimer(slot: Slot, workspace: string, value: { at: number; asked: string }): void {
	ensureDir(towerDir(slot, workspace));
	writeDurable(timerFile(slot, workspace), value);
}
export const clearTimer = (slot: Slot, workspace: string) => rmSync(timerFile(slot, workspace), { force: true });

// Replies a run is waiting for: a send with `reply` expected whose answer has not come. The brief lists them as open obligations; a message from the one it was asked of clears it. 24 h, at most 20.
export interface Expect { to: string; name: string; at: number; first: string }
const expectsFile = (slot: Slot, workspace: string) => join(towerDir(slot, workspace), "expects.json");
export const EXPECT_KEEP_MS = 24 * 3600_000;
export function readExpects(slot: Slot, workspace: string, now: number): Expect[] {
	const found = readJson<{ entries?: Expect[] }>(expectsFile(slot, workspace));
	return (Array.isArray(found?.entries) ? found.entries : []).filter((e) => typeof e?.to === "string" && typeof e.at === "number" && now - e.at <= EXPECT_KEEP_MS);
}
export function addExpect(slot: Slot, workspace: string, row: Expect, now: number): void {
	ensureDir(towerDir(slot, workspace));
	writeDurable(expectsFile(slot, workspace), { entries: [...readExpects(slot, workspace, now).filter((e) => e.to !== row.to), row].slice(-20) });
}
export function clearExpect(slot: Slot, workspace: string, from: string, now: number): void {
	const was = readExpects(slot, workspace, now);
	if (was.some((e) => e.to === from)) writeDurable(expectsFile(slot, workspace), { entries: was.filter((e) => e.to !== from) });
}
