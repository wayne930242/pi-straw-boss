import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Pane, Session } from "./herdr.ts";

// The tower dashboard's data, without its screen: the marks, the rows, and the subagents a session launched. It imports no pi-tui,
// typebox, or pi-coding-agent (tests/imports.test.ts walks the graph), so the server can load it where pi is not on disk.
// Data sources, all read-only:
//  - pi-herdr-agents subagents: a child's activity file lives at <sessions dir>/artifacts/<parent session id>/
//    subagent-activity/<child id>.json, and its pane's session file is named `<timestamp>_<child id>-<8 hex>-<8 hex>-<4 hex>.jsonl` (pi-herdr-agents makes it so).
//    The parent pane's own session file names the artifacts directory, so children group under the session that launched them.

/** `commanding`: itself idle while a subagent of it works or waits, or a monitor of it runs (see `commanding`). */
export type Mark = "working" | "waiting" | "idle" | "done" | "error" | "unknown" | "commanding";
/** One line of the tree. `net` rows are tab (0) > session (1) > subagent (2); `towers` rows are flat. */
/** `ended`: a subagent whose run is over (pi-herdr-agents recorded it done, or its pane is gone or back at a shell); its parent has the result. */
export interface Row { group: "net" | "towers"; depth: number; mark: Mark; text: string; kind?: string; note?: string; workspace?: string; id?: string; file?: string; pane?: string; ended?: boolean; finished?: boolean }

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
const scripts = new Map<string, { mtimeMs: number; session?: string }>();
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

/** The session file a launch script names, read again only when the script changed. */
function scriptSession(path: string): string | undefined {
	try {
		const { mtimeMs } = statSync(path), cached = scripts.get(path);
		if (cached?.mtimeMs === mtimeMs) return cached.session;
		const session = readFileSync(path, "utf8").match(/PI_SUBAGENT_SESSION='([^']+)'/)?.[1];
		if (scripts.size > 500) scripts.clear();
		scripts.set(path, { mtimeMs, session });
		return session;
	} catch {
		return undefined; // the launch script is only a fallback source for the name and the session file
	}
}

/** The subagents a pi session launched: live ones, plus those that finished in the last 10 minutes. The dashboard shows the first `limit`. */
export function subagents(parent: Pane | undefined, all: Pane[], now: number, limit = MAX_CHILDREN): Row[] {
	const file = parent?.agent_session?.value;
	if (!file) return [];
	const dir = artifacts(file), launched = listed(join(dir, "subagent-scripts"));
	return listed(join(dir, "subagent-activity"))
		.flatMap((name) => {
			const id = name.replace(/\.json$/, ""), path = join(dir, "subagent-activity", name);
			try {
				const child = { id, path, pane: paneOfChild(all, id), age: now - statSync(path).mtimeMs };
				return child.pane || child.age < RECENT_MS ? [child] : [];
			} catch {
				return []; // the activity file went away since the directory was listed
			}
		})
		.map(({ id, path, pane }) => {
			const activity = readJson(path);
			// A child whose pane is gone, or back at a shell prompt, has finished.
			const mark: Mark = pane?.agent === "pi" ? markOf(pane.agent_status) : "done";
			// Only a pi pane's session file is the child's transcript; a reused pane running another agent is not read.
			const script = launched.find((f) => f.endsWith(`-${id}.sh`));
			const file = (pane?.agent === "pi" ? pane.agent_session?.value : undefined) ?? (script && scriptSession(join(dir, "subagent-scripts", script)));
			const name = pane?.label || (script?.slice(0, -`-${id}.sh`.length) ?? id.slice(0, 8));
			const doing = activity.toolActive ? String(activity.toolName) : String(activity.phase ?? "");
			const ended = pane?.agent !== "pi" || activity.phase === "done";
			return { group: "net" as const, depth: 2, mark, text: name, kind: "subagent", workspace: pane?.workspace_id, id, file, pane: pane?.agent === "pi" ? pane.pane_id : undefined, ...(ended && { ended }), ...(activity.phase === "done" && { finished: true }), note: { working: doing, waiting: "waiting on a question", done: "finished" }[mark as "working"] };
		})
		.sort((a, b) => Number(a.mark === "done") - Number(b.mark === "done") || a.text.localeCompare(b.text))
		.slice(0, limit);
}
