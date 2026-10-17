import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { headOf, type HerdrRun, isSub, type Pane, panes, parentOf, type Session, workspaces, type Workspace } from "./herdr.ts";

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
export interface Row { group: "net" | "towers"; depth: number; mark: Mark; text: string; kind?: string; note?: string; workspace?: string; id?: string; file?: string; pane?: string }
export interface Snapshot { title: string; mark: Mark; head: boolean; rows: Row[] }
export type Tone = "accent" | "warning" | "muted" | "success" | "dim" | "error" | "border" | "title";
export type Paint = (tone: Tone, text: string) => string;
export interface Sources { run: HerdrRun; sessions(): Promise<Session[]>; workspaceId: string; now?: number }

const KEY = "straw-boss-dashboard";
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
// One glyph and one theme color per state; a working row shows the animated spinner instead of a fixed glyph.
const GLYPH: Record<Exclude<Mark, "working">, string> = { waiting: "?", idle: "○", done: "✓", error: "✗", unknown: "·" };
const TONE: Record<Mark, Tone> = { working: "accent", waiting: "warning", idle: "dim", done: "success", error: "error", unknown: "muted" };
const HERDR_MARK: Record<string, Mark> = { working: "working", blocked: "waiting", idle: "idle", done: "done" };
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
export function render({ title, mark, head, rows }: Snapshot, frame: number, width: number, paint: Paint): string[] {
	const total = Math.min(width, MAX_WIDTH), inner = Math.max(8, total - 4);
	const glyph = (m: Mark) => paint(TONE[m], m === "working" ? SPINNER[frame % SPINNER.length]! : GLYPH[m as Exclude<Mark, "working">]);
	const shown = rows.slice(0, MAX_ROWS);
	// A row is the last child when the next row at its depth or above is shallower (or there is none).
	const last = (i: number) => i < 0 || shown.slice(i + 1).find((r) => r.group === shown[i]!.group && r.depth <= shown[i]!.depth)?.depth !== shown[i]!.depth;
	const ancestor = (i: number, depth: number) => shown.findLastIndex((r, k) => k < i && r.group === shown[i]!.group && r.depth === depth);
	const prefix = (i: number) => (shown[i]!.group === "net" ? Array.from({ length: shown[i]!.depth }, (_, d) => (last(ancestor(i, d)) ? "   " : "│  ")).join("") + (last(i) ? "└─ " : "├─ ") : "");
	const cells = shown.map((r, i) => paint("border", prefix(i)) + (r.mark === "unknown" && !r.kind ? "" : `${glyph(r.mark)} `) + r.text);
	const [w1, w2] = [Math.max(...cells.map(visibleWidth), 0), Math.max(...shown.map((r) => r.kind?.length ?? 0))];
	const line = (i: number) => `${pad(cells[i]!, w1)}  ${paint("muted", (shown[i]!.kind ?? "").padEnd(w2))}  ${paint("dim", shown[i]!.note ?? "")}`.trimEnd();
	const section = (group: Row["group"], name: string, empty?: string) => {
		const at = shown.flatMap((r, i) => (r.group === group ? [i] : []));
		return at.length || empty ? [paint("muted", name), ...(at.length ? at.map(line) : [paint("dim", `  ${empty}`)])] : [];
	};
	const body = [...section("net", "this net", "nothing has joined yet"), ...section("towers", "other towers"), ...(rows.length > MAX_ROWS ? [paint("muted", `… ${rows.length - MAX_ROWS} more`)] : [])];
	const [name, tag] = [` ${glyph(mark)} ${paint("title", `tower · ${title}`)} `, head ? ` ${paint("accent", "head tower")} ` : ""];
	const dashes = "─".repeat(Math.max(1, total - 4 - visibleWidth(name) - visibleWidth(tag)));
	const frameLine = (text: string) => paint("border", "│ ") + pad(truncateToWidth(text, inner), inner) + paint("border", " │");
	return [paint("border", "╭─") + name + paint("border", dashes) + tag + paint("border", "─╮"), ...body.map(frameLine), paint("border", `╰${"─".repeat(total - 2)}╯`)].map((l) => truncateToWidth(l, width));
}

/** Whether a session file is the child `id`'s: pi-herdr-agents names it `<timestamp>_<id>-<hex>-<hex>-<hex>.jsonl`, so `kid` does not match `kid-2`'s or `kidney`'s. */
const ownFile = (file: string | undefined, id: string) => new RegExp(`_${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(-[0-9a-f]{1,8}-[0-9a-f]{1,8}-[0-9a-f]{1,4})?\\.jsonl$`).test(file ?? "");

function readJson(path: string): Record<string, unknown> {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return {};
	}
}

/** The subagents a pi session launched: live ones, plus those that finished in the last 10 minutes. */
export function subagents(parent: Pane | undefined, all: Pane[], now: number): Row[] {
	const file = parent?.agent_session?.value;
	if (!file) return [];
	const dir = join(dirname(file), "artifacts", basename(file, ".jsonl").split("_").pop()!);
	let files: string[] = [];
	try {
		files = readdirSync(join(dir, "subagent-activity"));
	} catch {} // no subagents were ever launched from this session
	return files
		.map((name) => {
			const id = name.replace(/\.json$/, "");
			const path = join(dir, "subagent-activity", name);
			return { id, path, pane: all.find((p) => ownFile(p.agent_session?.value, id)), age: now - statSync(path).mtimeMs };
		})
		.filter((c) => c.pane || c.age < RECENT_MS)
		.map(({ id, path, pane }) => {
			const activity = readJson(path);
			// A child whose pane is gone, or back at a shell prompt, has finished.
			const mark: Mark = pane?.agent === "pi" ? markOf(pane.agent_status) : "done";
			// Only a pi pane's session file is the child's transcript; a reused pane running another agent is not read.
			let script: string | undefined, file = pane?.agent === "pi" ? pane.agent_session?.value : undefined;
			try {
				script = readdirSync(join(dir, "subagent-scripts")).find((f) => f.endsWith(`-${id}.sh`));
				file ??= readFileSync(join(dir, "subagent-scripts", script!), "utf8").match(/PI_SUBAGENT_SESSION='([^']+)'/)?.[1];
			} catch {} // the launch script is only a fallback source for the name and the session file
			const name = pane?.label ?? script?.slice(0, -`-${id}.sh`.length) ?? id.slice(0, 8);
			const doing = activity.toolActive ? String(activity.toolName) : String(activity.phase ?? "");
			return { group: "net" as const, depth: 2, mark, text: name, kind: "subagent", workspace: pane?.workspace_id, id, file, pane: pane?.agent === "pi" ? pane.pane_id : undefined, note: { working: doing, waiting: "waiting on a question", done: "finished" }[mark as "working"] };
		})
		.sort((a, b) => Number(a.mark === "done") - Number(b.mark === "done") || a.text.localeCompare(b.text))
		.slice(0, MAX_CHILDREN);
}

/**
 * One reading of the world as rows: this tower's own net in detail (each tab's joined sessions with their subagents, then its
 * sub workspaces), and one summary line for every other tower. Other workspaces' sessions, and sessions that did not join, are not listed.
 */
export async function collect({ run, sessions, workspaceId, now = Date.now() }: Sources): Promise<Snapshot> {
	const [live, ps, all] = [await sessions(), await panes(run), await workspaces(run)];
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
	return { title: mine?.label ?? workspaceId, mark: attention ?? markOf(mine?.agent_status), head: Boolean(mine) && mine === head, rows };
}

export interface Dashboard { poke(): void; stop(): void }
export interface Timing { frameMs?: number; pollMs?: number; minGapMs?: number }

/**
 * Shows the dashboard in a tower's TUI. The spinner timer (8 fps) runs only while a row is working; the data poll (3 s)
 * runs while the widget exists. stop() clears both timers and the widget, and pi disposing the widget does the same.
 */
export function startDashboard({ ui, collect: read, frameMs = 125, pollMs = 3000, minGapMs = 500 }: { ui: ExtensionContext["ui"]; collect(): Promise<Snapshot> } & Timing): Dashboard {
	let live: Dashboard | undefined;
	ui.setWidget(KEY, (tui, theme) => {
		let snap: Snapshot = { title: "", mark: "unknown", head: false, rows: [] }, frame = 0, busy = false, stopped = false, last = 0;
		let spinner: ReturnType<typeof setInterval> | undefined;
		const refresh = async () => {
			if (busy || stopped) return;
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
		};
		const poll = setInterval(() => void refresh(), pollMs).unref();
		const stop = () => {
			stopped = true;
			clearInterval(poll);
			clearInterval(spinner);
			spinner = undefined;
		};
		live = { poke: () => void (Date.now() - last >= minGapMs && refresh()), stop };
		void refresh();
		const paint: Paint = (tone, text) => (tone === "title" ? theme.bold(theme.fg("accent", text)) : theme.fg(tone, text));
		return { render: (width) => render(snap, frame, width, paint), invalidate() {}, dispose: stop };
	});
	return { poke: () => live?.poke(), stop: () => (ui.setWidget(KEY, undefined), live?.stop(), (live = undefined), undefined) };
}
