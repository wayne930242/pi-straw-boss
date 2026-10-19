import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { ARROW, headOf, type HerdrRun, type HerdrWorld, isSub, MARK, type Pane, parentOf, type Session, TOWER_LABEL, type Workspace, worldOf } from "./herdr.ts";

// The tower's monitoring screen: a widget above the editor, never focused, redrawn only while something is working.
//
// Data sources, all read-only:
//  - pi-intercom listSessions(): every live session, its status (idle, thinking, tool:<name>), and its Herdr location.
//    presence_update, session_joined, and session_left events on the tower's channel only trigger an early re-read.
//  - `herdr pane list`: per pane the `sb_role` token (main, member), the pi session file, and Herdr's agent_status
//    (blocked means the agent waits on a question); `herdr workspace list`: workspace status, `tower` token, worktree.
//  - pi-herdr-agents subagents: a child's activity file lives at <sessions dir>/artifacts/<parent session id>/
//    subagent-activity/<child id>.json, and its pane's session file is named `<timestamp>_<child id>-<8 hex>-<8 hex>-<4 hex>.jsonl` (pi-herdr-agents makes it so).
//    The parent pane's own session file names the artifacts directory, so children group under the session that launched them.

export type Mark = "working" | "waiting" | "idle" | "done" | "error" | "unknown";
/** One line of the tree. `net` rows are tab (0) > session (1) > subagent (2); `towers` rows are flat. */
/** `ended`: a subagent whose run is over (pi-herdr-agents recorded it done, or its pane is gone or back at a shell); its parent has the result. */
export interface Row { group: "net" | "towers"; depth: number; mark: Mark; text: string; kind?: string; note?: string; workspace?: string; id?: string; file?: string; pane?: string; ended?: boolean }
export interface Snapshot { title: string; mark: Mark; head: boolean; rows: Row[]; gui?: string }
export type Tone = "accent" | "warning" | "muted" | "success" | "dim" | "error" | "border" | "title" | "tower" | "main" | "member";
export type Paint = (tone: Tone, text: string) => string;
/** `world` reads the panes and workspaces; without it they are listed through `run`. */
export interface Sources { run: HerdrRun; world?: HerdrWorld; sessions(): Promise<Session[]>; workspaceId: string; now?: number; gui?(): Promise<string | undefined> }

const KEY = "straw-boss-dashboard";
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
// One glyph and one theme color per state; a working row shows the animated spinner instead of a fixed glyph.
const GLYPH: Record<Exclude<Mark, "working">, string> = { waiting: "?", idle: "○", done: "✓", error: "✗", unknown: "·" };
const TONE: Record<Mark, Tone> = { working: "accent", waiting: "warning", idle: "dim", done: "success", error: "error", unknown: "muted" };
const HERDR_MARK: Record<string, Mark> = { working: "working", blocked: "waiting", idle: "idle", done: "done" };
// A row's role mark goes before its name, the same glyph as Herdr's sidebar shows (src/herdr.ts); a tab or sub workspace has none.
const ROLE: Record<string, [Tone, string]> = { main: ["main", MARK.main], member: ["member", MARK.member], subagent: ["dim", ARROW], tower: ["tower", TOWER_LABEL], "head tower": ["tower", TOWER_LABEL] };
const RECENT_MS = 10 * 60_000;
const MAX_ROWS = 18;
const MAX_WIDTH = 76;
const MAX_CHILDREN = 8;

export const markOf = (status?: string): Mark => HERDR_MARK[status ?? ""] ?? "unknown";
/** A session is waiting when its pane is blocked on a question, else working or idle by its intercom status, else by Herdr's own. */
export function sessionMark(s: Session, pane?: Pane): Mark {
	const busy = s.status ? s.status !== "idle" : undefined;
	return pane?.agent_status === "blocked" ? "waiting" : busy === undefined ? markOf(pane?.agent_status) : busy ? "working" : "idle";
}
const pad = (text: string, width: number) => text + " ".repeat(Math.max(0, width - visibleWidth(text)));

/** The pure half: a snapshot in, a framed tree out. One shared spinner frame animates every working row. */
export function render({ title, mark, head, rows, gui }: Snapshot, frame: number, width: number, paint: Paint): string[] {
	const total = Math.min(width, MAX_WIDTH), inner = Math.max(8, total - 4);
	const glyph = (m: Mark) => paint(TONE[m], m === "working" ? SPINNER[frame % SPINNER.length]! : GLYPH[m as Exclude<Mark, "working">]);
	const shown = rows.slice(0, MAX_ROWS);
	// A row is the last child when the next row at its depth or above is shallower (or there is none).
	const last = (i: number) => i < 0 || shown.slice(i + 1).find((r) => r.group === shown[i]!.group && r.depth <= shown[i]!.depth)?.depth !== shown[i]!.depth;
	const ancestor = (i: number, depth: number) => shown.findLastIndex((r, k) => k < i && r.group === shown[i]!.group && r.depth === depth);
	const prefix = (i: number) => (shown[i]!.group === "net" ? Array.from({ length: shown[i]!.depth }, (_, d) => (last(ancestor(i, d)) ? "   " : "│  ")).join("") + (last(i) ? "└─ " : "├─ ") : "");
	const role = (kind?: string) => (kind && ROLE[kind] ? `${paint(...ROLE[kind]!)} ` : "");
	const cells = shown.map((r, i) => paint("border", prefix(i)) + (r.mark === "unknown" && !r.kind ? "" : `${glyph(r.mark)} `) + role(r.kind) + r.text);
	const [w1, w2] = [Math.max(...cells.map(visibleWidth), 0), Math.max(...shown.map((r) => r.kind?.length ?? 0))];
	const line = (i: number) => `${pad(cells[i]!, w1)}  ${paint("muted", (shown[i]!.kind ?? "").padEnd(w2))}  ${paint("dim", shown[i]!.note ?? "")}`.trimEnd();
	const section = (group: Row["group"], name: string, empty?: string) => {
		const at = shown.flatMap((r, i) => (r.group === group ? [i] : []));
		return at.length || empty ? [paint("muted", name), ...(at.length ? at.map(line) : [paint("dim", `  ${empty}`)])] : [];
	};
	// What this pane is, and where the browser view lives, come before the tree.
	const intro = [paint("dim", "Control tower: main agents talk here (call_tower)."), gui ? `${paint("muted", "GUI")}  ${paint("accent", gui)}` : paint("dim", "GUI not running; /boss gui opens it"), ""];
	const body = [...intro, ...section("net", "this net", "nothing has joined yet"), ...section("towers", "other towers"), ...(rows.length > MAX_ROWS ? [paint("muted", `… ${rows.length - MAX_ROWS} more`)] : [])];
	const [name, tag] = [` ${glyph(mark)} ${role("tower")}${paint("title", title)} `, head ? ` ${paint("accent", "head tower")} ` : ""];
	const dashes = "─".repeat(Math.max(1, total - 4 - visibleWidth(name) - visibleWidth(tag)));
	const frameLine = (text: string) => paint("border", "│ ") + pad(truncateToWidth(text, inner), inner) + paint("border", " │");
	return [paint("border", "╭─") + name + paint("border", dashes) + tag + paint("border", "─╮"), ...body.map(frameLine), paint("border", `╰${"─".repeat(total - 2)}╯`)].map((l) => truncateToWidth(l, width));
}

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
			return { group: "net" as const, depth: 2, mark, text: name, kind: "subagent", workspace: pane?.workspace_id, id, file, pane: pane?.agent === "pi" ? pane.pane_id : undefined, ...(ended && { ended }), note: { working: doing, waiting: "waiting on a question", done: "finished" }[mark as "working"] };
		})
		.sort((a, b) => Number(a.mark === "done") - Number(b.mark === "done") || a.text.localeCompare(b.text))
		.slice(0, limit);
}

/**
 * One reading of the world as rows: this tower's own net in detail (each tab's joined sessions with their subagents, then its
 * sub workspaces), and one summary line for every other tower. Other workspaces' sessions, and sessions that did not join, are not listed.
 */
export async function collect({ run, world = worldOf(run), sessions, workspaceId, now = Date.now(), gui }: Sources): Promise<Snapshot> {
	const [live, { panes: ps, workspaces: all }] = await Promise.all([sessions(), world()]);
	const head = headOf(all);
	const mine = all.find((w) => w.workspace_id === workspaceId);
	const sessionRow = (s: Session, role: string): Row => {
		const mark = sessionMark(s, ps.find((p) => p.pane_id === s.herdrLocation?.paneId));
		return { group: "net", depth: 1, mark, text: s.name ?? s.id, kind: role, note: { working: s.status, waiting: "waiting on a question" }[mark as "working"] };
	};
	const joined = live.filter((s) => s.herdrLocation?.workspace?.id === workspaceId).flatMap((s) => {
		const pane = ps.find((p) => p.pane_id === s.herdrLocation?.paneId);
		const role = pane?.tokens?.sb_role;
		return role === "main" || role === "member" ? [{ s, pane, role, tab: s.herdrLocation!.tab! }] : [];
	});
	const rows: Row[] = [];
	for (const group of Object.values(Object.groupBy(joined, (j) => j.tab.id))) {
		rows.push({ group: "net", depth: 0, mark: "unknown", text: `tab ${group![0]!.tab.label}` });
		for (const { s, pane, role } of group!.sort((a, b) => Number(b.role === "main") - Number(a.role === "main"))) rows.push(sessionRow(s, role), ...subagents(pane, ps, now));
	}
	// Sub workspaces are linked worktrees: they hang under this tower like subagents, and their sessions never join. One that
	// already shows as a launched subagent (pi-herdr-agents runs worktree children there) is not listed a second time.
	const claimed = new Set(rows.map((r) => r.workspace));
	for (const sub of all.filter((x) => isSub(x) && mine && parentOf(all, x) === mine && !claimed.has(x.workspace_id))) rows.push({ group: "net", depth: 0, mark: markOf(sub.agent_status), text: sub.label, kind: "sub workspace" });
	for (const w of all.filter((x) => x !== mine && !isSub(x) && live.some((s) => s.id === x.tokens?.tower))) rows.push({ group: "towers", depth: 0, mark: markOf(w.agent_status), text: w.label, kind: w === head ? "head tower" : "tower" });
	// The title shows what needs attention most: a waiting row, then a working one, else the workspace's own status.
	const attention = (["waiting", "working"] as const).find((m) => rows.some((r) => r.mark === m));
	return { title: mine?.label ?? workspaceId, mark: attention ?? markOf(mine?.agent_status), head: Boolean(mine) && mine === head, rows, gui: await gui?.().catch(() => undefined) };
}

export interface Dashboard { poke(): void; stop(): void }
/** `watch` subscribes to what changes the screen and calls `refresh` for each; it returns the unsubscribe. */
export interface Timing { frameMs?: number; pollMs?: number; minGapMs?: number; debounceMs?: number; watch?(refresh: () => void): () => void }

/** The dashboard re-reads when Herdr reports a change; this poll only catches what no event told (a missed one, a subagent's activity file). */
export const SAFETY_MS = 30_000;
const DEBOUNCE_MS = 500;

/**
 * Shows the dashboard in a tower's TUI. The spinner timer (8 fps) runs only while a row is working. Data is re-read when `watch` reports
 * a change (collected for `debounceMs`, so a burst is one read), when poke() says intercom changed (at once), and every `pollMs` as a safety net;
 * two reads are never closer than `minGapMs`, and a request that comes inside the gap or while a read runs is read when it ends, not dropped.
 * stop() clears the timers and the subscription and removes the widget, and pi disposing the widget does the same.
 */
export function startDashboard({ ui, collect: read, watch, frameMs = 125, pollMs = SAFETY_MS, minGapMs = 500, debounceMs = DEBOUNCE_MS }: { ui: ExtensionContext["ui"]; collect(): Promise<Snapshot> } & Timing): Dashboard {
	let live: Dashboard | undefined;
	ui.setWidget(KEY, (tui, theme) => {
		let snap: Snapshot = { title: "", mark: "unknown", head: false, rows: [] }, frame = 0, busy = false, again = false, stopped = false, last = 0, due = Infinity;
		let spinner: ReturnType<typeof setInterval> | undefined, wake: ReturnType<typeof setTimeout> | undefined;
		// One pending read at a time, at the earliest time anyone asked for (and not inside the gap after the last read).
		const schedule = (delay: number) => {
			const at = Math.max(Date.now() + delay, last + minGapMs);
			if (stopped || at >= due) return;
			clearTimeout(wake);
			due = at;
			// A read that ran meanwhile moved `last`, so the gap is checked again when the timer fires.
			wake = setTimeout(() => ((due = Infinity), Date.now() < last + minGapMs ? schedule(0) : void refresh()), Math.max(0, at - Date.now())).unref();
		};
		const refresh = async () => {
			if (stopped) return;
			if (busy) return void (again = true);
			busy = true;
			try {
				snap = await read();
			} catch (error) {
				snap = { ...snap, mark: "error", rows: [{ group: "net", depth: 0, mark: "error", text: `dashboard unavailable: ${(error as Error).message}` }] };
			}
			busy = false;
			last = Date.now();
			if (stopped) return;
			const working = snap.mark === "working" || snap.rows.some((r) => r.mark === "working");
			if (working && !spinner) spinner = setInterval(() => (frame++, tui.requestRender()), frameMs).unref();
			if (!working && spinner) spinner = void clearInterval(spinner);
			tui.requestRender();
			if (again) (again = false, schedule(0));
		};
		const poll = setInterval(() => schedule(0), pollMs).unref();
		const unwatch = watch?.(() => schedule(debounceMs));
		const stop = () => {
			if (stopped) return;
			stopped = true;
			clearInterval(poll);
			clearTimeout(wake);
			clearInterval(spinner);
			spinner = undefined;
			unwatch?.();
		};
		live = { poke: () => schedule(0), stop };
		void refresh();
		// Every color is a theme role. The title and the role marks are bold: the tower in warning, a main agent in accent, a member in success.
		const strong: Partial<Record<Tone, "accent" | "warning" | "success">> = { title: "accent", tower: "warning", main: "accent", member: "success" };
		const paint: Paint = (tone, text) => (strong[tone] ? theme.bold(theme.fg(strong[tone], text)) : theme.fg(tone as Exclude<Tone, "title" | "tower" | "main" | "member">, text));
		return { render: (width) => render(snap, frame, width, paint), invalidate() {}, dispose: stop };
	});
	return { poke: () => live?.poke(), stop: () => (ui.setWidget(KEY, undefined), live?.stop(), (live = undefined), undefined) };
}
