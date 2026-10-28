import { lstatSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Slot } from "./record.ts";
import { ensureDir, towerDir, writeDurable } from "./towerstore.ts";

// The boss conversation's pointer (docs/specs/2026-10-26-sb-backend.md, The boss conversation): `tower/<workspace>/boss-session.json` names the pi session file the boss's last conversation with the tower used, so the next one
// resumes it (`--session <file>`) instead of starting from nothing. Only a conversation run moves it, and only by its own `run-file` report; an event run never does. A file is resumed only when every check below holds, and
// the run still treats nothing in it as the boss's but the events the server marks (a resumed session carries agent traffic).

/** A boss session over this size, or whose last boss turn is older than `BOSS_FILE_DAYS`, is not resumed: a new one starts. */
export const BOSS_FILE_MAX = 4 * 1024 * 1024;
export const BOSS_FILE_DAYS = 7;
export interface BossPointer {
	file: string;
	/** The conversation run that last reported this file. */
	run: string;
	/** When the session began (a resumed one keeps it). */
	startedAt: string;
	/** The boss's last turn in it. */
	lastAt: string;
	/** The boss turns the session has had: events the boss wrote that a run took, and the boss typing in the run's pi (counted at most every 15 s). */
	turns: number;
	/** The boss typed `/new` (or the GUI's New): the next conversation starts a fresh session. */
	fresh?: true;
}

const pointerFile = (slot: Slot, workspace: string) => join(towerDir(slot, workspace), "boss-session.json");
export function readPointer(slot: Slot, workspace: string): BossPointer | undefined {
	try {
		const p = JSON.parse(readFileSync(pointerFile(slot, workspace), "utf8")) as Partial<BossPointer>;
		return typeof p.file === "string" && typeof p.run === "string" && typeof p.startedAt === "string" && typeof p.lastAt === "string" && Number.isFinite(Date.parse(p.lastAt)) && Number.isInteger(p.turns) && p.turns! >= 0
			? { file: p.file, run: p.run, startedAt: p.startedAt, lastAt: p.lastAt, turns: p.turns!, ...(p.fresh === true ? { fresh: true as const } : {}) }
			: undefined;
	} catch {
		return undefined;
	}
}
export function writePointer(slot: Slot, workspace: string, pointer: BossPointer): void {
	ensureDir(towerDir(slot, workspace));
	writeDurable(pointerFile(slot, workspace), pointer);
}
export const clearPointer = (slot: Slot, workspace: string) => rmSync(pointerFile(slot, workspace), { force: true });

/** Where pi keeps its session files: the agent folder's `sessions`. */
export const sessionsRoot = (env: NodeJS.ProcessEnv = process.env) => join(env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "sessions");
const real = (path: string) => {
	try {
		return realpathSync(path);
	} catch {
		return undefined;
	}
};
/** The file's real path when it is a `.jsonl` under the sessions folder, else undefined. */
export function underRoot(file: string, root: string): string | undefined {
	if (!file.endsWith(".jsonl")) return undefined;
	const base = real(root), path = real(file);
	return base && path && path.startsWith(base + sep) ? path : undefined;
}

/** Whether any component of `file` below `root` is a symlink (each is lstat'ed; a missing one is not a link). */
function linkIn(file: string, root: string): boolean {
	const abs = resolve(file);
	// The pointer holds a real path, so the root is also tried by its real path: a link inside the root's own path must not hide the check.
	const bases = [resolve(root), real(root)].filter((b): b is string => b !== undefined);
	for (const base of bases) {
		const rel = relative(base, abs);
		if (rel.startsWith("..") || isAbsolute(rel)) continue;
		let at = base;
		for (const part of rel.split(sep)) {
			at = join(at, part);
			try {
				if (lstatSync(at).isSymbolicLink()) return true;
			} catch {
				return false;
			}
		}
		return false;
	}
	return false; // outside both spellings of the root: not a link, and underRoot refuses it
}

export type Resume = { ok: true; file: string } | { ok: false; why: string };
export interface ResumeEnv {
	now: number;
	root: string;
	/** The session files the live panes report (Herdr's `agent_session`): a session another pi has open is not resumed. */
	live: string[];
	/** The owner a session file must have (POSIX); unset on Windows. A link anywhere below the root is refused on both. */
	uid?: number;
}
/** Whether the pointer's session may be resumed, and the reason when it may not (shown in the brief's first line and the GUI's divider). */
export function resumable(pointer: BossPointer | undefined, e: ResumeEnv): Resume {
	if (!pointer) return { ok: false, why: "no earlier boss session" };
	if (pointer.fresh) return { ok: false, why: "the boss asked for a new one (/new)" };
	if (e.now - Date.parse(pointer.lastAt) > BOSS_FILE_DAYS * 86_400_000) return { ok: false, why: `the last boss turn was over ${BOSS_FILE_DAYS} days ago` };
	if (linkIn(pointer.file, e.root)) return { ok: false, why: "the last session file is, or sits behind, a link" };
	const path = underRoot(pointer.file, e.root);
	if (!path) return { ok: false, why: "the last session file is gone, or not under pi's sessions folder" };
	let stat;
	try {
		stat = lstatSync(path);
	} catch {
		return { ok: false, why: "the last session file is gone" };
	}
	if (!stat.isFile()) return { ok: false, why: "the last session file is not a regular file" };
	if (e.uid !== undefined && stat.uid !== e.uid) return { ok: false, why: "the last session file is not the boss's" };
	if (stat.size > BOSS_FILE_MAX) return { ok: false, why: `the last session grew past ${BOSS_FILE_MAX / 1024 / 1024} MB` };
	if (e.live.some((f) => (real(f) ?? f) === path)) return { ok: false, why: "the last session is open in another pane" };
	return { ok: true, file: path };
}

/** What a conversation run records of how it began: the brief's first line, the GUI's divider, and the status say it from here. */
export interface ConversationInfo {
	resumed: boolean;
	/** When the session being resumed began, and (for a resumed or a replaced session alike) when the boss last spoke with the tower. */
	from?: string;
	after?: string;
	/** The boss turns the session had when this run began (0 for a new one). */
	turns: number;
	/** A new session: why. */
	why?: string;
}
