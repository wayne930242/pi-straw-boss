import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { type Duty, dutyOfAgent } from "./duty.ts";
import type { Pane, Session } from "./herdr.ts";

// The tower dashboard's data, without its screen: the marks, the rows, and the subagents a session launched. It imports no pi-tui,
// typebox, or pi-coding-agent (tests/pure-imports.test.ts walks the graph), so the server can load it where pi is not on disk.
// Data sources, all read-only:
//  - pi-herdr-agents subagents: a child's activity file lives at <sessions dir>/artifacts/<parent session id>/
//    subagent-activity/<child id>.json, and its pane's session file is named `<timestamp>_<child id>-<8 hex>-<8 hex>-<4 hex>.jsonl` (pi-herdr-agents makes it so).
//    The parent pane's own session file names the artifacts directory, so children group under the session that launched them.

/** `commanding`: itself idle while a subagent of it works or waits, or a monitor of it runs (see `commanding`). */
export type Mark = "working" | "waiting" | "idle" | "done" | "error" | "unknown" | "commanding";
/** One line of the tree. `net` rows are tab (0) > session (1) > subagent (2); `towers` rows are flat. */
/** `ended`: a subagent whose run is over (pi-herdr-agents recorded it done, or its pane is gone or back at a shell); its parent has the result. */
export interface Row { group: "net" | "towers"; depth: number; mark: Mark; text: string; kind?: string; note?: string; workspace?: string; id?: string; file?: string; pane?: string; ended?: boolean; finished?: boolean; /** A subagent's kind (D16): the agent role its launch script names, or a main's `sb_duty` (dashboard.ts). */ duty?: Duty }

const HERDR_MARK: Record<string, Mark> = { working: "working", blocked: "waiting", idle: "idle", done: "done" };
const RECENT_MS = 10 * 60_000;
const MAX_CHILDREN = 8;

export const markOf = (status?: string): Mark => HERDR_MARK[status ?? ""] ?? "unknown";
/** A session is waiting when its pane is blocked on a question, else working or idle by its intercom status, else by Herdr's own. */
export function sessionMark(s: Session, pane?: Pane): Mark {
	const busy = s.status ? s.status !== "idle" : undefined;
	return pane?.agent_status === "blocked" ? "waiting" : busy === undefined ? markOf(pane?.agent_status) : busy ? "working" : "idle";
}
/**
 * A session that is idle itself but commands work shows as commanding, not idle: a subagent of it is working, waiting, or commanding, or one of its
 * monitors runs (`monitoring`). Its own state wins: working and waiting stay as they are, and a finished subagent counts for nothing.
 */
export const commanding = (mark: Mark, subs: Mark[], monitoring = false): Mark => (mark === "idle" && (monitoring || subs.some((m) => m === "working" || m === "waiting" || m === "commanding")) ? "commanding" : mark);

/** Whether a session file is the child `id`'s: pi-herdr-agents names it `<timestamp>_<id>-<hex>-<hex>-<hex>.jsonl`, so `kid` does not match `kid-2`'s or `kidney`'s. */
export const ownFile = (file: string | undefined, id: string) => new RegExp(`_${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(-[0-9a-f]{1,8}-[0-9a-f]{1,8}-[0-9a-f]{1,4})?\\.jsonl$`).test(file ?? "");

/** The artifacts directory pi-herdr-agents keeps for the session file `file`: its launch records and the activity of the children it launched. */
export const artifacts = (file: string) => join(dirname(file), "artifacts", basename(file, ".jsonl").split("_").pop()!);

export function readJson(path: string): Record<string, unknown> {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return {};
	}
}

// What a tick re-reads for every child is cached: the pane that runs each child (indexed once per pane list), the names in the two
// directories pi-herdr-agents keeps per session (until the directory changes), and a launch script's session file (until the script does).
const RACY_MS = 2000;
const childPanes = new WeakMap<Pane[], { size: number; index: Map<string, Pane> }>();
const listings = new Map<string, { mtime: bigint; readAt: number; names: string[] }>();
/**
 * A parent's launch scripts, kept per scripts folder so one parent with many launches cannot evict another's (review R0790-F001): the scripts read, and the
 * resumes by the child id they carry, both kept while the folder lists the same names. Only a resume's script is read to find a child; a first launch is found by its name.
 */
interface Scripts { names: string[]; reads: Map<string, Launch & { mtimeMs: number }>; resumes?: Map<string, { script: string; launch: Launch }> }
const folders = new Map<string, Scripts>();
/** How many launch scripts were read from disk: the cost tests/kinds-net.test.ts bounds for a parent with many old launches. */
export const scriptReads = { count: 0 };
/** What a launch script says: the child's id, its session file, the agent role of a first launch (a resume names none), and whether it is a persistent specialist. */
interface Launch { id?: string; session?: string; persistent: boolean; agent?: string }
const SUFFIX = /^(.*)-[0-9a-f]{1,8}-[0-9a-f]{1,8}-[0-9a-f]{1,4}$/;

/** The child ids a pane's session file can belong to: `ownFile` read from the file's side, so one pass over the panes replaces a match per child and pane. */
function childIds(file: string | undefined): string[] {
	if (!file?.endsWith(".jsonl")) return [];
	const name = file.slice(Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\")) + 1, -".jsonl".length), ids: string[] = [];
	for (let at = name.indexOf("_"); at >= 0; at = name.indexOf("_", at + 1)) {
		const tail = name.slice(at + 1), stripped = SUFFIX.exec(tail)?.[1];
		ids.push(tail, ...(stripped === undefined ? [] : [stripped]));
	}
	return ids;
}

/** The first pane in list order that runs each child. The index belongs to the list it was built from, which is a reading of Herdr and not changed after (one that grew or shrank is indexed again). */
function paneOfChild(all: Pane[], id: string): Pane | undefined {
	let cached = childPanes.get(all);
	if (cached?.size !== all.length) {
		const index = new Map<string, Pane>();
		for (const pane of all) for (const child of childIds(pane.agent_session?.value)) if (!index.has(child)) index.set(child, pane);
		childPanes.set(all, (cached = { size: all.length, index }));
	}
	return cached.index.get(id);
}

/** The file names in `dir`, read again only once the directory has changed (a directory changed in the last two seconds is always read, as its timestamp may not tell two changes apart). */
function listed(dir: string): string[] {
	try {
		const stat = statSync(dir, { bigint: true }), cached = listings.get(dir);
		// A listing read within RACY_MS of the directory's timestamp may have missed a change in the same tick (git's racy-index rule).
		if (cached?.mtime === stat.mtimeNs && cached.readAt - Number(stat.mtimeNs / 1_000_000n) > RACY_MS) return cached.names;
		const readAt = Date.now(), names = readdirSync(dir);
		if (listings.size > 200) listings.clear();
		listings.set(dir, { mtime: stat.mtimeNs, readAt, names });
		return names;
	} catch {
		listings.delete(dir);
		return []; // the directory is not there: nothing was ever launched from this session
	}
}

/** The scripts kept for `dir` while it lists `names`; a folder that lists other names starts afresh. */
function scriptsOf(dir: string, names: string[]): Scripts {
	const kept = folders.get(dir);
	if (kept && kept.names.length === names.length && kept.names.every((n, i) => n === names[i])) return kept;
	if (folders.size > 200) folders.clear();
	const fresh: Scripts = { names, reads: new Map() };
	folders.set(dir, fresh);
	return fresh;
}

/** The child id, session file, and agent role a launch script names (`PI_SUBAGENT_ID`, `PI_SUBAGENT_SESSION`, `PI_SUBAGENT_AGENT`), and whether it launched a persistent specialist, read again only when the script changed. */
function scriptRead(folder: Scripts, path: string): Launch | undefined {
	try {
		const { mtimeMs } = statSync(path), cached = folder.reads.get(path);
		if (cached?.mtimeMs === mtimeMs) return cached;
		scriptReads.count++;
		const text = readFileSync(path, "utf8"), read = { mtimeMs, id: text.match(/\bPI_SUBAGENT_ID='([^']+)'/)?.[1], session: text.match(/PI_SUBAGENT_SESSION='([^']+)'/)?.[1], persistent: /\bPI_SUBAGENT_PERSISTENT=1\b/.test(text), agent: text.match(/\bPI_SUBAGENT_AGENT='([^']+)'/)?.[1] };
		folder.reads.set(path, read);
		return read;
	} catch {
		return undefined; // the launch script is only a fallback source for the name and the session file
	}
}

/** Every launch script of a parent's artifacts folder `dir`, as watch-report's checks read them (src/server/watchreport.ts): the script's name and the child id, session file, and agent role it carries. */
export const launchScripts = (dir: string, scriptDir = join(dir, "subagent-scripts"), names = listed(scriptDir).filter((f) => f.endsWith(".sh")), folder = scriptsOf(scriptDir, names)) => names.flatMap((script) => ((l) => (l ? [{ script, id: l.id, session: l.session, agent: l.agent }] : []))(scriptRead(folder, join(scriptDir, script))));

// A child records its role in its session file at its first turn (childkind.ts): `straw-boss { agent }`, the first such entry wins. AK4 found it within the first 30 KB of every child session sampled, so
// only the first 64 KB are read. A role, once found, is kept by path; a file read without one is read again only once it has grown, and never once 64 KB of it held none.
const ROLE_BYTES = 64 * 1024;
const roles = new Map<string, string>(), roleless = new Map<string, number>();

/** The agent role a child's session file records: its first `straw-boss { agent }` entry in the first 64 KB, or undefined (none yet, a handoff, a bare spawn). */
export function agentOfSession(file: string | undefined): string | undefined {
	if (!file) return undefined;
	const known = roles.get(file);
	if (known !== undefined) return known;
	let fd: number | undefined;
	try {
		const { size } = statSync(file), missed = roleless.get(file);
		if (missed !== undefined && (missed >= ROLE_BYTES || missed === size)) return undefined;
		fd = openSync(file, "r");
		const buffer = Buffer.alloc(Math.min(size, ROLE_BYTES)), read = readSync(fd, buffer, 0, buffer.length, 0);
		const lines = buffer.subarray(0, read).toString("utf8").split("\n");
		lines.pop(); // the last piece is a line cut off by the read, or the empty tail after the last newline
		for (const line of lines) {
			if (!line.includes('"straw-boss"') || !line.includes('"agent"')) continue;
			try {
				const e = JSON.parse(line) as { type?: unknown; customType?: unknown; data?: { agent?: unknown } };
				if (e.type !== "custom" || e.customType !== "straw-boss" || typeof e.data?.agent !== "string") continue;
				if (roles.size > 2000) roles.clear();
				roles.set(file, e.data.agent);
				return e.data.agent;
			} catch { /* a line pi is still writing, or not JSON: the next one is read */ }
		}
		if (roleless.size > 2000) roleless.clear();
		roleless.set(file, read >= ROLE_BYTES ? ROLE_BYTES : size);
	} catch { /* no session file yet: pi writes it with the first message */ } finally {
		if (fd !== undefined) closeSync(fd);
	}
	return undefined;
}

/** The pane whose pi runs the session file `file`: how a resumed child, whose new id its session file's name does not carry, is found. */
const paneOfSession = (all: Pane[], file: string | undefined) => (file ? all.find((p) => p.agent === "pi" && p.agent_session?.value === file) : undefined);

/** The subagents a pi session launched: live ones, plus those that finished in the last 10 minutes. The dashboard shows the first `limit`. */
export function subagents(parent: Pane | undefined, all: Pane[], now: number, limit = MAX_CHILDREN): Row[] {
	const file = parent?.agent_session?.value;
	if (!file) return [];
	const dir = artifacts(file), scriptDir = join(dir, "subagent-scripts"), launched = listed(scriptDir).filter((f) => f.endsWith(".sh"));
	const folder = scriptsOf(scriptDir, launched), read = (f: string) => scriptRead(folder, join(scriptDir, f));
	// A first launch's script is named `<name>-<id>.sh`; a resume's is `<name>-resume-<ts>.sh` and names a new id inside only (pi-herdr-agents launch-resume.ts), so it is found by what it carries.
	// Only the resumes are read for that, once while the folder lists the same names.
	const resumeOf = (id: string) => {
		if (!folder.resumes) {
			const index = new Map<string, { script: string; launch: Launch }>();
			let whole = true;
			for (const f of launched) if (/-resume-[^-]*\.sh$/.test(f)) { const launch = read(f); if (launch?.id) index.has(launch.id) || index.set(launch.id, { script: f, launch }); else whole = false; }
			// A script that names no id yet is still being written (R0790-D001): the index is not kept, so the next read looks again.
			if (whole) folder.resumes = index;
			else return index.get(id);
		}
		return folder.resumes.get(id);
	};
	const launchOf = (id: string) => {
		const own = launched.find((f) => f.endsWith(`-${id}.sh`));
		if (own) return { script: own, name: own.slice(0, -`-${id}.sh`.length), launch: read(own) };
		const resume = resumeOf(id);
		return resume && { script: resume.script, name: resume.script.replace(/-resume-[^-]*\.sh$/, ""), launch: resume.launch };
	};
	// Before the child's first turn its session file holds no role yet: the first launch's script stands in, found by the id the session file's name carries (`ownFile`).
	const firstLaunchAgent = (session: string | undefined) => {
		for (const id of childIds(session)) {
			const own = launched.find((f) => f.endsWith(`-${id}.sh`)), launch = own === undefined ? undefined : read(own);
			if (launch && launch.session === session && launch.agent) return launch.agent;
		}
		return undefined;
	};
	// A child is kept when a pane runs it or it was active in the last 10 minutes; its launch script is read only then, so a parent's old launches cost a stat each.
	const rows = listed(join(dir, "subagent-activity"))
		.flatMap((name) => {
			const id = name.replace(/\.json$/, ""), path = join(dir, "subagent-activity", name);
			try {
				const at = statSync(path).mtimeMs, pane = paneOfChild(all, id) ?? paneOfSession(all, resumeOf(id)?.launch.session);
				return pane || now - at < RECENT_MS ? [{ id, path, at, pane, found: launchOf(id) }] : [];
			} catch {
				return []; // the activity file went away since the directory was listed
			}
		})
		.map(({ id, path, at, found, pane }) => {
			const activity = readJson(path), launch = found?.launch;
			// A child whose pane is gone, or back at a shell prompt, has finished.
			const live: Mark = pane?.agent === "pi" ? markOf(pane.agent_status) : "done";
			const recordedDone = activity.phase === "done" && !(launch?.persistent && (live === "working" || live === "commanding")); // a persistent specialist stays available after done and its recorder stops writing: its phase stays done while a later subagent_send task runs
			const mark: Mark = recordedDone && (live === "working" || live === "commanding") ? "done" : live; // a pi pane still working after the child recorded done is winding down: the map, the drawer's tag and the badge follow `ended`
			// Only a pi pane's session file is the child's transcript; a reused pane running another agent is not read.
			const file = (pane?.agent === "pi" ? pane.agent_session?.value : undefined) ?? launch?.session;
			const name = pane?.label || (found?.name ?? id.slice(0, 8));
			const doing = activity.toolActive ? String(activity.toolName) : String(activity.phase ?? "");
			const ended = pane?.agent !== "pi" || recordedDone, duty = dutyOfAgent(agentOfSession(file) ?? launch?.agent ?? firstLaunchAgent(file));
			return { at, resumed: found?.script.includes("-resume-") ?? false, row: { group: "net" as const, depth: 2, mark, text: name, kind: "subagent", ...(duty ? { duty } : {}), workspace: pane?.workspace_id, id, file, pane: pane?.agent === "pi" ? pane.pane_id : undefined, ...(ended && { ended }), ...(recordedDone && { finished: true }), note: { working: doing, waiting: "waiting on a question", done: "finished" }[mark as "working"] } };
		});
	// A session file resumed under a new id has two launches here; the newest activity is the child as it runs now, and on a tie the resume (review R0790-F002).
	const newest = new Map<string, (typeof rows)[number]>();
	for (const r of rows) {
		const held = r.row.file === undefined ? undefined : newest.get(r.row.file);
		if (r.row.file !== undefined && (!held || r.at > held.at || (r.at === held.at && r.resumed && !held.resumed))) newest.set(r.row.file, r);
	}
	return rows
		.filter((r) => r.row.file === undefined || newest.get(r.row.file) === r)
		.map(({ row }) => row)
		.sort((a, b) => Number(a.mark === "done") - Number(b.mark === "done") || a.text.localeCompare(b.text))
		.slice(0, limit);
}
