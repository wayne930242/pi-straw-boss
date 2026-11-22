import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type CoordinatorDuty, isCoordinatorDuty } from "./duty.ts";
import { TOWER_LABEL } from "./herdr.ts";
import type { Kit } from "./state.ts";
import { TRAIN, type TrainId, trainFromToken, trainLabel, trainToken } from "./trainrole.ts";

// What a Herdr restore cannot keep. After `herdr server stop` and a new server, Herdr resumes each pi pane into its session file, but a role lives in
// things the restore drops: STRAW_BOSS_ROLE in the pane's environment, the pane and workspace tokens, and, for a session without a conversation yet, the
// session entry pi never wrote. Each tower and main therefore records its role in the state directory, keyed by its session file (the one thing a resumed
// pane keeps, even when pi had not written it), together with the pane and tab it held. A resumed session takes the role back only in that same pane and
// tab; anywhere else, or with no record, it stays a member.
// A record is dropped when the session is closed on purpose (Closing). A /quit, a guard demotion, and a Herdr stop all look alike from inside the process, and
// a stop demotes the mains just before it ends them, so none of those drops it: a record outlives a demotion, which is why a restored main never opens its tower
// (the tower comes back with its own record, and a base without one clears its mains, guard.ts).
// Two checks keep a record from outliving its meaning. A tab has one main record: the session that becomes its main drops the others for the tab (a demoted
// main, whose record would race the new one at a restore). And a main takes the role back only in a pane whose terminal is not the one it recorded: Herdr starts
// a new terminal for a pane it restores, while a `/resume` in the same shell after a /quit finds the old one, and that is no restore. (A tower needs no such
// check: it closes its pane when it quits, and its record is dropped then.)
// A record is a claim, never a proof: the session's own shell can write this folder (and its session file), so a record that says `tower` or `train` gives the
// role back only in the tab Herdr labels as that role's (the tower glyph, a train's `train <MMDDx>`), which a restore keeps and no file holds. The caller reads the
// label from Herdr (`Here.tabLabel`). A main has no such tab (its label is its own free name), so its record stands on the checks above
// (docs/specs/2026-11-07-train-workers.md §29).

const KEEP_MS = 90 * 24 * 3600_000;
/**
 * How a session with a record ended without a close on purpose (docs/specs/2026-11-23-tower-revive.md §2): `quit` is a /quit, Ctrl-D, or another session of the same pi (/new, /resume, /fork), `signal` a SIGHUP or SIGTERM
 * pi turned into a quit. A crash, a kill -9, and a pane or tab Herdr closed leave no mark: pi never runs its shutdown then (§1, P0). The mark says nothing to `held`: a Herdr restore brings the session back whatever it says, and the next record a start writes has none.
 */
export interface Ended { at: number; reason: "quit" | "new" | "resume" | "fork" | "signal" }
export interface RoleRecord { role: "tower" | "main" | "train"; pane: string; tab: string; workspace: string; terminal?: string; file?: string; openedBy?: string; /** A train's project and code (docs/specs/2026-11-07-train-workers.md §3.3). */ train?: TrainId; /** A main's kind, for a restore before its first message, when pi has written no entry yet (docs/specs/2026-11-09-agent-kinds.md §6). */ duty?: CoordinatorDuty; at: number; ended?: Ended; /** A main that opened its successor with boss_handover, once that successor took the handoff (RVR-F004): never raised as dead or revived, however it ends. */ handedOver?: HandedOver }
/** The successor a main handed its work to: when, and its session id. */
export interface HandedOver { at: number; to: string }
/** Where a session runs now: the pane, tab, and workspace of the record must all be these. `tabLabel` is the label Herdr lists for the tab now, the proof of a tower's or a train's tab; left out, neither role is given back. */
export interface Here { paneId?: string; tabId?: string; workspaceId?: string; terminalId?: string; tabLabel?: string }

const keyOf = (file: string) => createHash("sha256").update(file).digest("hex").slice(0, 32);
const ENDED = new Set<Ended["reason"]>(["quit", "new", "resume", "fork", "signal"]);
/** The folder of the role records in a state folder, and the record of one session file there. */
export const rolesDir = (stateDir: string) => join(stateDir, "roles");
export const recordPath = (stateDir: string, file: string) => join(rolesDir(stateDir), `${keyOf(file)}.json`);
/** One record as written, or undefined when it is missing or proves nothing (a role it may not name, a field of the wrong type). `problem` hears why a file that is there could not be read. */
export function loadRecord(record: string, problem?: (why: string) => void): RoleRecord | undefined {
	let raw: string;
	try {
		raw = readFileSync(record, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") problem?.((error as Error).message);
		return undefined;
	}
	try {
		const r = JSON.parse(raw) as Partial<RoleRecord>;
		if (r.duty !== undefined && !isCoordinatorDuty(r.duty)) delete r.duty; // a kind that is none says nothing; the role still stands
		if (r.ended !== undefined && !(typeof r.ended === "object" && r.ended !== null && typeof r.ended.at === "number" && ENDED.has(r.ended.reason))) delete r.ended; // a mark that cannot be read says the session did not end cleanly
		if (r.handedOver !== undefined && !(typeof r.handedOver === "object" && r.handedOver !== null && typeof r.handedOver.at === "number" && typeof r.handedOver.to === "string")) delete r.handedOver;
		if (r.role === TRAIN && !(r.train && trainFromToken(trainToken(r.train as TrainId)))) return undefined; // a train record names its project and code, or proves nothing
		return (r.role === "tower" || r.role === "main" || r.role === TRAIN) && typeof r.pane === "string" && typeof r.tab === "string" && typeof r.workspace === "string" && (r.terminal === undefined || typeof r.terminal === "string") && (r.file === undefined || typeof r.file === "string") && (r.openedBy === undefined || typeof r.openedBy === "string") ? (r as RoleRecord) : undefined;
	} catch {
		return undefined; // a record that cannot be read proves nothing
	}
}
/** Writes `patch` into a session's own record in place, nothing else changed; nothing when it has none. */
function patchRecord(stateDir: string, file: string, patch: Partial<RoleRecord>): void {
	const path = recordPath(stateDir, file), record = loadRecord(path);
	if (!record) return;
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, JSON.stringify({ ...record, ...patch } satisfies RoleRecord), { mode: 0o600 });
	renameSync(temp, path);
}
/** RVR-F004: the main of `file` handed its work over (tools.ts `boss_handover`); the records it writes later keep the mark from its session's `successor` entry. */
export const markHandedOver = (stateDir: string, file: string, h: HandedOver): void => patchRecord(stateDir, file, { handedOver: h });
/** Every record of the state folder that names its session file, with the path it was read from. */
export function readRecords(stateDir: string): { path: string; record: RoleRecord & { file: string } }[] {
	let names: string[] = [];
	try {
		names = readdirSync(rolesDir(stateDir)).filter((name) => /^[0-9a-f]{32}\.json$/.test(name));
	} catch { /* no records */ }
	return names.flatMap((name) => {
		const path = join(rolesDir(stateDir), name), record = loadRecord(path);
		// The file a record names has to be the one its name is the key of: a record copied under another key claims a session it was not written for.
		return record?.file && path === recordPath(stateDir, record.file) ? [{ path, record: record as RoleRecord & { file: string } }] : [];
	});
}

/** The role records of the sessions on this machine, in `roles/` of the state directory. */
export function createRoles({ cfg, s, guiDir, tell }: Kit) {
	const dir = rolesDir(guiDir);
	const path = (file: string) => recordPath(guiDir, file);
	const load = (record: string, quiet = false): RoleRecord | undefined => loadRecord(record, quiet ? undefined : (why) => tell(`Straw Boss: could not read this session's role record: ${why}`, "warning"));
	const within = (here: Here): RoleRecord | undefined => {
		const record = s.file ? load(path(s.file)) : undefined;
		return record && here.paneId === record.pane && here.tabId === record.tab && here.workspaceId === record.workspace ? record : undefined;
	};
	/** The newest main record of a tab. A tab has one, but a demoted main's record from before the one-record rule may be left beside it. */
	const mainOf = (tab: string, workspace: string): RoleRecord | undefined => {
		let names: string[] = [];
		try {
			names = readdirSync(dir).filter((name) => name.endsWith(".json"));
		} catch { /* no records */ }
		const mains = names.flatMap((name) => load(join(dir, name), true) ?? []).filter((r) => r.role === "main" && r.tab === tab && r.workspace === workspace);
		return mains.sort((a, b) => b.at - a.at)[0];
	};
	const forget = () => {
		if (s.file) rmSync(path(s.file), { force: true });
	};
	return {
		/**
		 * The role this session recorded for the pane, tab, and workspace it is in now; undefined when it recorded none there, or when `here` lacks one of the
		 * three. A main also needs proof of a restart (a terminal other than the one it recorded) and the newest main record of its tab: a tab has one main.
		 * A tower and a train need the tab Herdr labels as theirs (`here.tabLabel`): the record alone gives neither role.
		 */
		held(here: Here): RoleRecord["role"] | undefined {
			const record = within(here);
			if (record?.role === "tower") return here.tabLabel === TOWER_LABEL ? "tower" : undefined;
			if (!record || !record.terminal || !here.terminalId || record.terminal === here.terminalId) return undefined;
			// A train takes its role back on the same proof as a main (a new terminal for the same pane, tab, and workspace), in the tab that carries its code; a tab has no "newest train" to check, since no one else is crowned beside it.
			if (record.role === TRAIN) return record.train && here.tabLabel === trainLabel(record.train.code) ? TRAIN : undefined;
			return mainOf(record.tab, record.workspace)?.at === record.at ? "main" : undefined;
		},
		/** The role the record names for the pane, tab, and workspace the session is in, proven or not: what tells the start to ask Herdr for the tab's label, and what a refusal names. */
		claimed(here: Here): RoleRecord["role"] | undefined {
			return within(here)?.role;
		},
		/** Whether the record is a main's from this very terminal: a pi started in the shell that outlived the session, which no restore brought. */
		sameShell(here: Here): boolean {
			const record = within(here);
			return (record?.role === "main" || record?.role === TRAIN) && record.terminal !== undefined && record.terminal === here.terminalId;
		},
		/**
		 * The marker (`sb_opened_by`) a main a tower opened had before a Herdr restore, for a main taking its role back (`held` said main); none without `here`. A restore is a
		 * plain startup, which keeps neither the pane's tokens nor the claim of the one-time token, and the tower is a new session. What closes the main is the tower token
		 * of its workspace at the time of the ask (closemain.ts), so the record only has to bring the marker back: it is read where the main ran (same pane, tab, and
		 * workspace), and a main the boss opened has none.
		 */
		openerOf(here?: Here): string | undefined {
			const record = here && within(here);
			return record && (record.role === "main" || record.role === TRAIN) ? record.openedBy : undefined;
		},
		/** The kind a main recorded for the pane, tab, and workspace it is in now: read when `held` says main (session.ts). */
		dutyOf(here: Here): CoordinatorDuty | undefined {
			const record = within(here);
			return record?.role === "main" ? record.duty : undefined;
		},
		/** The project and code a train recorded for the pane, tab, and workspace it is in now. */
		trainOf(here: Here): TrainId | undefined {
			const record = within(here);
			return record?.role === TRAIN ? record.train : undefined;
		},
		/** The main record of a tab, whichever session left it: the main a Herdr restore may be bringing back there. */
		mainOf,
		remember(role: RoleRecord["role"]) {
			const openedBy = role === "main" || role === TRAIN ? s.openedBy ?? s.restoredOpener : undefined;
			if (s.file) {
				try {
					mkdirSync(dir, { recursive: true, mode: 0o700 });
					const file = path(s.file), temp = `${file}.${process.pid}.tmp`, at = cfg.now();
					writeFileSync(temp, JSON.stringify({ role, pane: s.at.paneId, tab: s.at.tabId, workspace: s.at.workspaceId, ...(s.at.terminalId ? { terminal: s.at.terminalId } : {}), file: s.file, ...(openedBy ? { openedBy } : {}), ...(role === TRAIN && s.train ? { train: s.train } : {}), ...(role === "main" && isCoordinatorDuty(s.duty) ? { duty: s.duty } : {}), ...(role === "main" && s.saved.successor?.main ? { handedOver: { at: s.saved.successor.at, to: s.saved.successor.main } } : {}), at } satisfies RoleRecord), { mode: 0o600 });
					renameSync(temp, file);
				} catch (error) {
					return void tell(`Straw Boss: could not record this session's role, so a Herdr restore will not bring it back: ${(error as Error).message}`, "warning");
				}
			}
			// What follows tidies other files, and one that vanished meanwhile (another session tidying too) is no failure. It runs also for a session with no file of
			// its own (a main that has none): the demoted main's record must not outlive the tab's new main.
			let names: string[] = [];
			try {
				names = readdirSync(dir).filter((name) => name.endsWith(".json") && (!s.file || join(dir, name) !== path(s.file)));
			} catch { /* nothing to tidy */ }
			for (const name of names) {
				try {
					const other = join(dir, name), record = load(other, true);
					// A tab has one main: the others' records, a demoted main's among them, would race this one at a restore.
					const rival = role === "main" && record?.role === "main" && record.tab === s.at.tabId && record.workspace === s.at.workspaceId;
					if (rival || cfg.now() - statSync(other).mtimeMs > KEEP_MS) rmSync(other, { force: true });
				} catch { /* gone already, or unreadable: left for the next write */ }
			}
		},
		forget,
		/**
		 * The session ended without a close on purpose (session.ts, `session_shutdown`): its record, if it has one, keeps how (`Ended`). A tower's revive reads it (dead.ts): a quit is no death. Written in place, nothing else changed,
		 * so a Herdr restore that follows still finds the record as `held` reads it.
		 */
		markEnded(reason: Ended["reason"]) {
			if (!s.file) return;
			try {
				patchRecord(guiDir, s.file, { ended: { at: cfg.now(), reason } });
			} catch { /* a mark that is not written leaves the session looking dead: the tower run that hears of it decides */ }
		},
	};
}
export type Roles = ReturnType<typeof createRoles>;
