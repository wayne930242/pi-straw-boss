import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Kit } from "./state.ts";

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

const KEEP_MS = 90 * 24 * 3600_000;
export interface RoleRecord { role: "tower" | "main"; pane: string; tab: string; workspace: string; terminal?: string; file?: string; openedBy?: string; at: number }
/** Where a session runs now: the pane, tab, and workspace of the record must all be these. */
export interface Here { paneId?: string; tabId?: string; workspaceId?: string; terminalId?: string }

const keyOf = (file: string) => createHash("sha256").update(file).digest("hex").slice(0, 32);

/** The role records of the sessions on this machine, in `roles/` of the state directory. */
export function createRoles({ cfg, s, guiDir, tell }: Kit) {
	const dir = join(guiDir, "roles");
	const path = (file: string) => join(dir, `${keyOf(file)}.json`);
	const load = (record: string, quiet = false): RoleRecord | undefined => {
		let raw: string;
		try {
			raw = readFileSync(record, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			if (!quiet) tell(`Straw Boss: could not read this session's role record: ${(error as Error).message}`, "warning");
			return undefined;
		}
		try {
			const r = JSON.parse(raw) as Partial<RoleRecord>;
			return (r.role === "tower" || r.role === "main") && typeof r.pane === "string" && typeof r.tab === "string" && typeof r.workspace === "string" && (r.terminal === undefined || typeof r.terminal === "string") && (r.file === undefined || typeof r.file === "string") && (r.openedBy === undefined || typeof r.openedBy === "string") ? (r as RoleRecord) : undefined;
		} catch {
			return undefined; // a record that cannot be read proves nothing
		}
	};
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
		 */
		held(here: Here): RoleRecord["role"] | undefined {
			const record = within(here);
			if (record?.role === "tower") return "tower";
			if (!record || !record.terminal || !here.terminalId || record.terminal === here.terminalId) return undefined;
			return mainOf(record.tab, record.workspace)?.at === record.at ? "main" : undefined;
		},
		/** Whether the record is a main's from this very terminal: a pi started in the shell that outlived the session, which no restore brought. */
		sameShell(here: Here): boolean {
			const record = within(here);
			return record?.role === "main" && record.terminal !== undefined && record.terminal === here.terminalId;
		},
		/**
		 * The marker (`sb_opened_by`) a main a tower opened had before a Herdr restore, for a main taking its role back (`held` said main); none without `here`. A restore is a
		 * plain startup, which keeps neither the pane's tokens nor the claim of the one-time token, and the tower is a new session. What closes the main is the tower token
		 * of its workspace at the time of the ask (closemain.ts), so the record only has to bring the marker back: it is read where the main ran (same pane, tab, and
		 * workspace), and a main the boss opened has none.
		 */
		openerOf(here?: Here): string | undefined {
			const record = here && within(here);
			return record && record.role === "main" ? record.openedBy : undefined;
		},
		/** The main record of a tab, whichever session left it: the main a Herdr restore may be bringing back there. */
		mainOf,
		remember(role: RoleRecord["role"]) {
			const openedBy = role === "main" ? s.openedBy ?? s.restoredOpener : undefined;
			if (s.file) {
				try {
					mkdirSync(dir, { recursive: true, mode: 0o700 });
					const file = path(s.file), temp = `${file}.${process.pid}.tmp`, at = cfg.now();
					writeFileSync(temp, JSON.stringify({ role, pane: s.at.paneId, tab: s.at.tabId, workspace: s.at.workspaceId, ...(s.at.terminalId ? { terminal: s.at.terminalId } : {}), file: s.file, ...(openedBy ? { openedBy } : {}), at } satisfies RoleRecord), { mode: 0o600 });
					renameSync(temp, file);
				} catch (error) {
					return void tell(`Straw Boss: could not record this session's role, so a Herdr restore will not bring it back: ${(error as Error).message}`, "warning");
				}
			}
			// What follows tidies other files, and one that vanished meanwhile (another session tidying too) is no failure. It runs also for a session with no file of
			// its own (a sidecar's main): the demoted main's record must not outlive the tab's new main.
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
	};
}
export type Roles = ReturnType<typeof createRoles>;
