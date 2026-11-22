import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, sep } from "node:path";
import { classify, type DeadState, type DeadVerdict } from "./dead.ts";
import { type CoordinatorDuty, isCoordinatorDuty } from "./duty.ts";
import { type HerdrRun, type Pane, panes, type Session } from "./herdr.ts";
import { integratorOf } from "./integrator.ts";
import { artifacts } from "./netdata.ts";
import { readRecords, type RoleRecord } from "./roles.ts";
import { line } from "./safetext.ts";
import { type TrainId, trainFromToken, trainLabel, trainToken } from "./trainrole.ts";

// The tower's revive of a dead main (docs/specs/2026-11-23-tower-revive.md): what is read to find one, what proves it may be revived, and what is kept of each try. The opener (opener.ts `revive`)
// does the opening; the server's sweep (server/deadwatch.ts) and both tower tool surfaces list through `gatherDead`. Nothing here starts a process or writes to Herdr.

/** The pane token that tells the revived pi it was revived (session.ts): the key of its session file, consumed with `sb_open_main`. */
export const REVIVE_TOKEN = "sb_revive";
/** At most this many revives of one session file in 24 h, and none unasked within 10 minutes of the last (the crash-loop guard, §5). */
export const MAX_REVIVES = 2, LOOP_MS = 10 * 60_000, DAY_MS = 24 * 3600_000;
const KEEP_MS = 7 * DAY_MS, HEADER_MAX = 64 * 1024, SCAN_MAX = 32 * 1024 * 1024;
const POLICY = ".pi-herdr-subagent-policy.json";

/** A revive that was refused: nothing was opened, and the reason says why. */
export class ReviveRefused extends Error {}

/** pi's sessions folder, the one a revived session file must be in (server/bossconv.ts `sessionsRoot` reads the same). */
export const sessionsDir = (env: NodeJS.ProcessEnv = process.env) => join(env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "sessions");
export const keyOf = (file: string) => createHash("sha256").update(file).digest("hex").slice(0, 32);
export const reviveDir = (stateDir: string) => join(stateDir, "revive");
export const ledgerPath = (stateDir: string, file: string) => join(reviveDir(stateDir), `${keyOf(file)}.json`);

/** The first line of a session file: pi's header. Undefined when it is no header. */
export function sessionHeader(file: string): { id: string; cwd?: string; parentSession?: string } | undefined {
	try {
		const fd = openSync(file, "r");
		try {
			const buffer = Buffer.alloc(HEADER_MAX), n = readSync(fd, buffer, 0, HEADER_MAX, 0), first = buffer.subarray(0, n).toString("utf8").split("\n")[0]!;
			const h = JSON.parse(first) as { type?: unknown; id?: unknown; cwd?: unknown; parentSession?: unknown };
			return h.type === "session" && typeof h.id === "string" ? { id: h.id, ...(typeof h.cwd === "string" ? { cwd: h.cwd } : {}), ...(typeof h.parentSession === "string" ? { parentSession: h.parentSession } : {}) } : undefined;
		} finally {
			closeSync(fd);
		}
	} catch {
		return undefined;
	}
}
/** The session id pi gives a file in its name (`<timestamp>_<id>.jsonl`). */
export const idOfName = (file: string): string | undefined => /_([0-9a-f][0-9a-f-]{7,63})\.jsonl$/.exec(basename(file))?.[1];

const real = (path: string) => {
	try {
		return realpathSync(path);
	} catch {
		return undefined;
	}
};
export const within = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * Why a role record's session file may not be revived, or undefined when it may (§5): a regular file (no link) under pi's sessions folder, with pi's header whose id is the one in the file's name, no subagent sidecar,
 * and a working folder inside the workspace's checkout. A record is a claim the session's own shell could write, so each of these is read from the file and the folders, never from the record.
 */
export function fileRefusal(file: string, o: { root: string; checkout?: string }): string | undefined {
	let stat;
	try {
		stat = lstatSync(file);
	} catch {
		return "its session file is gone";
	}
	if (!stat.isFile()) return "its session file is no regular file (a link or a folder)";
	const root = real(o.root), path = real(file);
	if (!root || !path || !within(path, root)) return "its session file is outside pi's sessions folder";
	if (existsSync(`${file}${POLICY}`)) return "its session file is a subagent's (it has pi-herdr-agents' policy sidecar): a subagent is resumed by its parent, not revived";
	const header = sessionHeader(file), named = idOfName(file);
	if (!header) return "its session file has no pi session header";
	if (!named || header.id !== named) return `its session file's header id (${header.id.slice(0, 13)}) is not the id in its name: the intercom id would differ (PI_INTERCOM_STABLE_ID or a renamed file), so nothing it held would find it`;
	if (o.checkout && !(header.cwd && real(header.cwd) && within(real(header.cwd)!, real(o.checkout) ?? o.checkout))) return `its working folder (${header.cwd ?? "none"}) is outside the workspace's checkout`;
	if (header.cwd && !real(header.cwd)) return `its working folder ${header.cwd} is gone`;
	return undefined;
}

/** What a session file says of itself: its last name (pi's `session_info`) and what Straw Boss wrote in it (the kind, the opener, a train). Read up to 32 MB. */
export function sessionNotes(file: string): { name?: string; duty?: CoordinatorDuty; openedBy?: string; train?: TrainId } {
	let text: string;
	try {
		const size = statSync(file).size, fd = openSync(file, "r");
		try {
			const from = Math.max(0, size - SCAN_MAX), buffer = Buffer.alloc(size - from), n = readSync(fd, buffer, 0, buffer.length, from);
			text = buffer.subarray(0, n).toString("utf8");
		} finally {
			closeSync(fd);
		}
	} catch {
		return {};
	}
	let name: string | undefined, duty: CoordinatorDuty | undefined, openedBy: string | undefined, train: TrainId | undefined;
	for (const row of text.split("\n")) {
		if (!row.includes('"session_info"') && !row.includes('"straw-boss"')) continue;
		try {
			const e = JSON.parse(row) as { type?: string; name?: unknown; customType?: string; data?: Record<string, unknown> };
			if (e.type === "session_info") name = typeof e.name === "string" && e.name.trim() ? e.name.trim() : undefined;
			else if (e.type === "custom" && e.customType === "straw-boss" && e.data) {
				if ("duty" in e.data) duty = isCoordinatorDuty(e.data.duty) ? e.data.duty : duty;
				if ("openedBy" in e.data) openedBy = typeof e.data.openedBy === "string" ? e.data.openedBy : undefined;
				if (e.data.train && typeof e.data.train === "object") train = trainFromToken(trainToken(e.data.train as TrainId)) ?? train;
			}
		} catch { /* a cut line says nothing */ }
	}
	return { ...(name ? { name } : {}), ...(duty ? { duty } : {}), ...(openedBy ? { openedBy } : {}), ...(train ? { train } : {}) };
}

/** One death: the session file as it was when it was found dead. A file that moved since is another life of the session. */
export const deathKey = (file: string): string | undefined => {
	try {
		const st = statSync(file);
		return createHash("sha256").update(`${file}\n${st.size}\n${Math.trunc(st.mtimeMs)}`).digest("hex").slice(0, 16);
	} catch {
		return undefined;
	}
};

// --- the ledger ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface Attempt { at: number; key: string; by: string; outcome: "revived" | "failed" | "refused"; asked?: boolean; reason?: string; error?: string; tab?: string; pane?: string }
/** A message a tower could not deliver to the session while it was dead, kept for its revive handoff. */
export interface Missed { at: number; from: string; text: string }
export interface Ledger { v: 1; file: string; session: string; detections: { key: string; at: number }[]; attempts: Attempt[]; missed: Missed[] }

export function readLedger(stateDir: string, file: string, session = idOfName(file) ?? ""): Ledger {
	try {
		const l = JSON.parse(readFileSync(ledgerPath(stateDir, file), "utf8")) as Partial<Ledger>;
		if (l.v === 1 && l.file === file) return { v: 1, file, session: typeof l.session === "string" ? l.session : session, detections: Array.isArray(l.detections) ? l.detections : [], attempts: Array.isArray(l.attempts) ? l.attempts : [], missed: Array.isArray(l.missed) ? l.missed : [] };
	} catch { /* none yet, or one that cannot be read: a new one */ }
	return { v: 1, file, session, detections: [], attempts: [], missed: [] };
}
/** Changes a ledger and writes it whole, dropping what is older than a week. */
export function updateLedger(stateDir: string, file: string, now: number, change: (l: Ledger) => void): Ledger {
	const l = readLedger(stateDir, file);
	change(l);
	l.detections = l.detections.filter((d) => now - d.at < KEEP_MS).slice(-32);
	l.attempts = l.attempts.filter((a) => now - a.at < KEEP_MS).slice(-32);
	l.missed = l.missed.filter((m) => now - m.at < DAY_MS).slice(-16);
	mkdirSync(reviveDir(stateDir), { recursive: true, mode: 0o700 });
	const path = ledgerPath(stateDir, file), temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, JSON.stringify(l), { mode: 0o600 });
	renameSync(temp, path);
	return l;
}
/** The revives of the last 24 h that opened a session. */
export const revivedIn = (l: Ledger, now: number) => l.attempts.filter((a) => a.outcome === "revived" && now - a.at < DAY_MS);
/** A message to `session` that could not be delivered while it was dead: kept for its revive handoff, at most 16, each cut to 2,000 characters. */
export function noteMissed(stateDir: string, file: string, now: number, from: string, text: string): void {
	updateLedger(stateDir, file, now, (l) => void l.missed.push({ at: now, from: from.slice(0, 80), text: text.slice(0, 2000) }));
}

/** The lock that keeps a pi tower and the server's tower from reviving one file at once: created with `wx`, and taken over only when it is older than 5 minutes (a revive waits 60 s at most for its pi). */
export function takeLock(stateDir: string, file: string, now: number): () => void {
	mkdirSync(reviveDir(stateDir), { recursive: true, mode: 0o700 });
	const path = `${ledgerPath(stateDir, file)}.lock`;
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			writeFileSync(path, String(process.pid), { flag: "wx", mode: 0o600 });
			return () => rmSync(path, { force: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			let age = 0;
			try { age = now - statSync(path).mtimeMs; } catch { continue; }
			if (age < 5 * 60_000) break;
			rmSync(path, { force: true });
		}
	}
	throw new ReviveRefused("another tower is reviving this session right now");
}

// --- the dead mains of a workspace ---------------------------------------------------------------------------------------------------------------------------------------------------------

/** What the runs a dead main launched have left (inherit.ts classifies them in the revived main): counted from the files alone. */
export interface OrphanCount { finished: number; pings: number; open: number; worktree: number; persistent: number }
export function countOrphans(file: string): OrphanCount {
	const count: OrphanCount = { finished: 0, pings: 0, open: 0, worktree: 0, persistent: 0 }, base = artifacts(file);
	let ids: string[] = [];
	try {
		ids = readdirSync(join(base, "subagent-activity")).filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5));
	} catch {
		return count;
	}
	let scripts: string[] = [];
	try { scripts = readdirSync(join(base, "subagent-scripts")); } catch { /* none */ }
	for (const id of ids) {
		const script = scripts.find((n) => n.endsWith(`-${id}.sh`) && !n.includes("-resume-"));
		let text = "";
		try { text = script ? readFileSync(join(base, "subagent-scripts", script), "utf8") : ""; } catch { /* unreadable */ }
		const session = /^# Session: (.+)$/m.exec(text)?.[1]?.trim();
		if (/\bPI_SUBAGENT_PERSISTENT=1\b/.test(text)) count.persistent++;
		else if (existsSync(join(base, "worktree-runs", `${id}.json`))) count.worktree++;
		else if (session && existsSync(`${session}.exit`)) {
			try { (JSON.parse(readFileSync(`${session}.exit`, "utf8")) as { type?: string }).type === "ping" ? count.pings++ : count.finished++; } catch { count.finished++; }
		} else count.open++;
	}
	return count;
}
const countText = (c: OrphanCount) => {
	const parts = [c.finished && `${c.finished} finished`, c.pings && `${c.pings} asking for help`, c.open && `${c.open} open (running, idle, or cut)`, c.worktree && `${c.worktree} worktree`, c.persistent && `${c.persistent} persistent`].filter(Boolean);
	return parts.length ? parts.join(", ") : "none";
};

export interface DeadRow {
	session: string;
	file: string;
	record: RoleRecord & { file: string };
	verdict: DeadVerdict;
	name?: string;
	kind?: CoordinatorDuty;
	/** The record's opener as the main's caps and close read it (`sb_opened_by`): a sender's session id, `link:<device>`, an integrator's mark, or none (the boss opened it). */
	openedBy?: string;
	train?: TrainId;
	/** Its board line, when its board entry is still there. */
	board?: string;
	/** How long ago its session file last moved. */
	ageMs?: number;
	key?: string;
	orphans?: OrphanCount;
}
export interface GatherDeps {
	stateDir: string;
	run: HerdrRun;
	now: number;
	sessions(): Promise<Session[]>;
	/** pi's sessions folder (server/bossconv.ts `sessionsRoot`). */
	root: string;
	/** Only the records of this workspace; and its checkout, inside which a revived session's folder must be. */
	workspace?: string;
	checkout?: string;
	recovering?: boolean;
	/** The looks that found each file dead before (server/deadwatch.ts): absent for an explicit call. */
	seen?(file: string): { first: number; looks: number } | undefined;
	/** Read the name and kind of every row's session file (a call that names one by name), not only of the rows that are not live (the sweep). */
	allNotes?: boolean;
	/** The panes and sessions read once by the caller, when it has them. */
	panes?: Pane[];
	sessionList?: Session[];
}
/** The mains and trains with a role record (of one workspace), classified (dead.ts). Towers are left out: one comes back by itself. */
export async function gatherDead(d: GatherDeps): Promise<DeadRow[]> {
	const records = readRecords(d.stateDir).filter((r) => r.record.role !== "tower" && (!d.workspace || r.record.workspace === d.workspace));
	if (!records.length) return [];
	const [ps, sessions] = await Promise.all([d.panes ?? panes(d.run), d.sessionList ?? d.sessions()]);
	return records.map(({ record }): DeadRow => {
		const file = record.file, session = idOfName(file) ?? sessionHeader(file)?.id ?? keyOf(file);
		let mtimeMs: number | undefined;
		try { mtimeMs = statSync(file).mtimeMs; } catch { /* gone */ }
		const invalid = mtimeMs === undefined ? undefined : fileRefusal(file, { root: d.root, ...(d.checkout ? { checkout: d.checkout } : {}) });
		const held = ps.some((p) => p.agent_session?.value === file), listed = sessions.some((s) => s.id === session);
		const seen = d.seen?.(file);
		const verdict = classify({ now: d.now, record, ...(invalid ? { invalid } : {}), ...(mtimeMs !== undefined ? { mtimeMs } : {}), held, listed, recovering: Boolean(d.recovering), ...(seen ? { seen } : {}) });
		const notes = d.allNotes || verdict.state === "dead" || verdict.state === "quit" || verdict.state === "restoring" ? sessionNotes(file) : {};
		let board: string | undefined;
		try { board = (JSON.parse(readFileSync(join(d.stateDir, "board", `${session}.json`), "utf8")) as { now?: unknown }).now as string | undefined; } catch { /* none */ }
		const kind = notes.duty ?? record.duty, train = record.role === "train" ? record.train : undefined;
		return {
			session, file, record, verdict, ...(notes.name ? { name: notes.name } : {}), ...(kind ? { kind } : {}), ...(record.openedBy ? { openedBy: record.openedBy } : {}), ...(train ? { train } : {}),
			...(typeof board === "string" ? { board: line(board).slice(0, 120) } : {}), ...(mtimeMs !== undefined ? { ageMs: d.now - mtimeMs } : {}),
			...(verdict.state === "dead" || verdict.state === "quit" ? { key: deathKey(file), orphans: countOrphans(file) } : {}),
		};
	});
}

/** A session named by its id, a prefix of 8 or more characters, or its name. Several that match are an error that names them. */
export function pick(rows: DeadRow[], query: string): DeadRow {
	const q = query.trim();
	const found = rows.filter((r) => r.session === q || (q.length >= 8 && r.session.startsWith(q)) || r.name === q);
	if (found.length === 1) return found[0]!;
	if (found.length > 1) throw new ReviveRefused(`${found.length} sessions match ${JSON.stringify(q.slice(0, 40))} (${found.map((r) => `${r.name ?? "unnamed"} ${r.session.slice(0, 8)}`).join(", ")}): name one by its id`);
	throw new ReviveRefused(`No main or train of this workspace with a role record matches ${JSON.stringify(q.slice(0, 40))}. A member has no role record and holds nothing a tower restores: resume it with pi --session. A main closed on purpose (/boss close, boss_close_main) has none either.`);
}

/** What a run sees of one row: the facts, no text a peer chose. */
export function rowLine(r: DeadRow, now: number): string {
	const what = r.record.role === "train" && r.train ? trainLabel(r.train.code) : `main ${r.name ? JSON.stringify(line(r.name).slice(0, 40)) : "(unnamed)"}`;
	const age = r.ageMs === undefined ? "" : `, its file last moved ${ago(r.ageMs)} ago`;
	return `${what} (session ${r.session.slice(0, 8)}, kind ${r.kind ?? "none"}, tab ${r.record.tab}${r.openedBy ? `, opened by ${line(r.openedBy).slice(0, 60)}` : ", opened by the boss"}): ${r.verdict.state}: ${r.verdict.reason}${age}${r.board ? `; board: ${r.board}` : ""}${r.orphans ? `; subagents: ${countText(r.orphans)}` : ""}${now ? "" : ""}`;
}
export const ago = (ms: number) => {
	const m = Math.max(0, Math.round(ms / 60_000));
	return m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
};

/** What a tower is told of a revive that opened a session (both tool surfaces say the same). */
export const revivedText = (d: { tab: string; main: string; name?: string; kind?: string; train?: TrainId; closedOld?: string }) =>
	`Revived ${d.train ? trainLabel(d.train.code) : `main ${d.name ?? d.main.slice(0, 8)}`} (session ${d.main}) in tab ${d.tab} as the same session, kind ${d.train ? "train" : d.kind ?? "none"}, and handed it what it held.${d.closedOld ? ` Its old tab ${d.closedOld} held only its dead pane at a shell and was closed.` : ""} It picks up its subagents itself.`;

/** The `main_died` notice a confirmed death puts on the tower's queue (§3): code-written facts only. */
export const diedText = (r: DeadRow, now: number) =>
	`main_died: ${rowLine(r, now)}. Decide whether to revive it: boss_revive_main {action: "revive", session: "${r.session}", reason}. It comes back as the same session in a new tab, with its role, kind, name, board, todos, and waits; ${r.orphans && (r.orphans.finished || r.orphans.pings || r.orphans.open) ? "it picks up its subagents itself. " : ""}Leave it when the boss closed it on purpose or its work is done, and say why in your handoff note.`;

/** States a run may revive. A `quit` one only when a request names it (the tool's description says so). */
export const REVIVABLE: readonly DeadState[] = ["dead", "quit"];

/** The refusals that come from the record and its opener alone (§4, the identity table). `integrationOff` and the live panes say the rest. */
export function roleRefusal(r: DeadRow, o: { integrationOff: boolean; live: Pane[]; sessions: Session[] }): string | undefined {
	if (r.openedBy?.startsWith("link:")) return `it was opened for a teammate's device (${line(r.openedBy).slice(0, 40)}): its route has lapsed and the device's trust may have changed, so it is not revived; the device asks again`;
	const integ = integratorOf(r.openedBy) ?? (r.kind === "integrator" ? (/^integ (.+)$/.exec(r.name ?? "")?.[1] ?? "") : undefined);
	if (integ !== undefined) {
		if (o.integrationOff) return "it is an integrator, and integration is off on this computer";
		const twin = o.live.find((p) => p.tokens?.sb_role === "main" && p.tokens.sb_duty === "integrator" && (integratorOf(p.tokens.sb_opened_by) === integ || o.sessions.find((s) => s.herdrLocation?.paneId === p.pane_id)?.name === `integ ${integ}`));
		if (integ && twin) return `project ${integ} has a live integrator (pane ${twin.pane_id}); a project has one`;
	}
	return undefined;
}

/** The revived pi's first message (§4, step 6): facts only, written by the code. */
export function reviveHandoff(i: { row: DeadRow; tower: { id: string; name: string }; tab: string; workspace: string; reason: string; waits: string[]; missed: Missed[]; now: number }): string {
	const r = i.row, ended = r.record.ended;
	const how = ended ? `${ended.reason === "signal" ? "on a signal" : `by ${ended.reason}`} at ${new Date(ended.at).toISOString()}` : `with no shutdown (a crash, a kill, or its pane closed) about ${r.ageMs === undefined ? "a while" : ago(r.ageMs)} ago`;
	const lines = [
		`Straw Boss: this session ended ${how} without a close. Tower ${i.tower.name} (session ${i.tower.id}) revived it in tab ${i.tab} of workspace ${i.workspace}; its reason: ${line(i.reason).slice(0, 300)}.`,
		`You are the same session with the same id: your ${r.record.role === "train" ? "train role" : "role (main)"}, kind (${r.kind ?? "none"}), name, todos, board row, and the waits you held are as they were. What lived in your process did not come back: your monitors, loops, and watches, and the watchers of your subagents.`,
		"Do this now, in order:",
		"1. Read your todo list and board_read; set your board line again.",
		"2. Recreate the monitors, loops, and watches your work needs.",
		`3. ${r.openedBy && !r.openedBy.startsWith("integ:") ? `Tell ${line(r.openedBy).slice(0, 60)} (the session that asked for your work) that you are back.` : "Tell whoever waits on you that you are back."}`,
		"4. Your subagents: Straw Boss checks the runs you launched and sends you one message about them; act on it.",
	];
	if (i.waits.length) lines.push("Waits you hold:", ...i.waits.map((w) => `- ${w}`));
	if (i.missed.length) lines.push("Messages that could not reach you while you were down (each as it was sent):", ...i.missed.map((m) => `- from ${line(m.from).slice(0, 60)} at ${new Date(m.at).toISOString()}: ${line(m.text)}`));
	return lines.join("\n");
}
