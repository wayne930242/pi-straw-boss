import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { ARROW, headOf, type HerdrRun, type HerdrWorld, isSub, MARK, parentOf, type Session, TOWER_LABEL, worldOf } from "./herdr.ts";
import { commanding, type Mark, markOf, type Row, sessionMark, subagents } from "./netdata.ts";

// The tower's monitoring screen: a widget above the editor, never focused, animated only while something is working and the tower's tab is on screen.
//
// Data sources, all read-only:
//  - pi-intercom listSessions(): every live session, its status (idle, thinking, tool:<name>), and its Herdr location.
//    presence_update, session_joined, and session_left events on the tower's channel only trigger an early re-read.
//  - `herdr pane list`: per pane the `sb_role` token (main, member), the pi session file, and Herdr's agent_status
//    (blocked means the agent waits on a question); `herdr workspace list`: workspace status, `tower` token, worktree.
//  - pi-herdr-agents subagents: a child's activity file lives at <sessions dir>/artifacts/<parent session id>/
//    subagent-activity/<child id>.json, and its pane's session file is named `<timestamp>_<child id>-<8 hex>-<8 hex>-<4 hex>.jsonl` (pi-herdr-agents makes it so).
//    The parent pane's own session file names the artifacts directory, so children group under the session that launched them.

export interface Snapshot { title: string; mark: Mark; head: boolean; rows: Row[]; gui?: string; checking?: boolean; pending?: Promise<string | undefined>; visible?: boolean } // visible: the tower's tab is the active tab of the focused workspace (unknown without a tabId)
export type Tone = "accent" | "warning" | "muted" | "success" | "dim" | "error" | "border" | "title" | "tower" | "main" | "member";
export type Paint = (tone: Tone, text: string) => string;
/** `world` reads the panes and workspaces; without it they are listed through `run`. */
export interface Sources { run: HerdrRun; world?: HerdrWorld; sessions(): Promise<Session[]>; workspaceId: string; tabId?: string; now?: number; gui?(): Promise<string | undefined> }

const KEY = "straw-boss-dashboard";
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
// One glyph and one theme color per state; a working row shows the animated spinner instead of a fixed glyph.
const GLYPH: Record<Exclude<Mark, "working">, string> = { waiting: "?", idle: "○", done: "✓", error: "✗", unknown: "·", commanding: "◈" };
const TONE: Record<Mark, Tone> = { working: "accent", waiting: "warning", idle: "dim", done: "success", error: "error", unknown: "muted", commanding: "title" };
// A row's role mark goes before its name, the same glyph as Herdr's sidebar shows (src/herdr.ts); a tab or sub workspace has none.
const ROLE: Record<string, [Tone, string]> = { main: ["main", MARK.main], member: ["member", MARK.member], subagent: ["dim", ARROW], tower: ["tower", TOWER_LABEL], "head tower": ["tower", TOWER_LABEL] };
const MAX_ROWS = 18;
const MAX_WIDTH = 76;

const pad = (text: string, width: number) => text + " ".repeat(Math.max(0, width - visibleWidth(text)));

/** The pure half: a snapshot in, a framed tree out. One shared spinner frame animates every working row. */
export function render({ title, mark, head, rows, gui, checking }: Snapshot, frame: number, width: number, paint: Paint): string[] {
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
	const intro = [paint("dim", "Control tower: main agents talk here (call_tower)."), gui ? `${paint("muted", "GUI")}  ${paint("accent", gui)}` : paint("dim", checking ? "GUI checking…" : "GUI not running; /boss gui opens it"), ""];
	const body = [...intro, ...section("net", "this net", "nothing has joined yet"), ...section("towers", "other towers"), ...(rows.length > MAX_ROWS ? [paint("muted", `… ${rows.length - MAX_ROWS} more`)] : [])];
	const [name, tag] = [` ${glyph(mark)} ${role("tower")}${paint("title", title)} `, head ? ` ${paint("accent", "head tower")} ` : ""];
	const dashes = "─".repeat(Math.max(1, total - 4 - visibleWidth(name) - visibleWidth(tag)));
	const frameLine = (text: string) => paint("border", "│ ") + pad(truncateToWidth(text, inner), inner) + paint("border", " │");
	return [paint("border", "╭─") + name + paint("border", dashes) + tag + paint("border", "─╮"), ...body.map(frameLine), paint("border", `╰${"─".repeat(total - 2)}╯`)].map((l) => truncateToWidth(l, width));
}

/**
 * One reading of the world as rows: this tower's own net in detail (each tab's joined sessions with their subagents, then its
 * sub workspaces), and one summary line for every other tower. Other workspaces' sessions, and sessions that did not join, are not listed.
 */
export async function collect({ run, world = worldOf(run), sessions, workspaceId, tabId, now = Date.now(), gui }: Sources): Promise<Snapshot> {
	// The GUI line is read alongside the rest and handed on as `pending`: on Windows its start time can take seconds, and the rows must not wait for it.
	const pending = gui?.().catch(() => undefined);
	const [live, { panes: ps, workspaces: all }] = await Promise.all([sessions(), world()]);
	const head = headOf(all);
	const mine = all.find((w) => w.workspace_id === workspaceId);
	const sessionRow = (s: Session, role: string, kids: Row[]): Row => {
		const mark = commanding(sessionMark(s, ps.find((p) => p.pane_id === s.herdrLocation?.paneId)), kids.map((k) => k.mark));
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
		for (const { s, pane, role } of group!.sort((a, b) => Number(b.role === "main") - Number(a.role === "main"))) {
			const kids = subagents(pane, ps, now);
			rows.push(sessionRow(s, role, kids), ...kids);
		}
	}
	// Sub workspaces are linked worktrees: they hang under this tower like subagents, and their sessions never join. One that
	// already shows as a launched subagent (pi-herdr-agents runs worktree children there) is not listed a second time.
	const claimed = new Set(rows.map((r) => r.workspace));
	for (const sub of all.filter((x) => isSub(x) && mine && parentOf(all, x) === mine && !claimed.has(x.workspace_id))) rows.push({ group: "net", depth: 0, mark: markOf(sub.agent_status), text: sub.label, kind: "sub workspace" });
	for (const w of all.filter((x) => x !== mine && !isSub(x) && live.some((s) => s.id === x.tokens?.tower))) rows.push({ group: "towers", depth: 0, mark: markOf(w.agent_status), text: w.label, kind: w === head ? "head tower" : "tower" });
	// The title shows what needs attention most: a waiting row, then a working one, else the workspace's own status.
	const attention = (["waiting", "working"] as const).find((m) => rows.some((r) => r.mark === m || (m === "working" && r.mark === "commanding"))); // commanding is active, like working
	return { title: mine?.label ?? workspaceId, mark: attention ?? markOf(mine?.agent_status), head: Boolean(mine) && mine === head, rows, pending, visible: tabId === undefined ? undefined : Boolean(mine?.focused) && mine?.active_tab_id === tabId };
}

export interface Dashboard { poke(): void; stop(): void }
/** `watch` subscribes to what changes the screen and calls `refresh` for each; it returns the unsubscribe. */
export interface Timing { frameMs?: number; pollMs?: number; minGapMs?: number; debounceMs?: number; watch?(refresh: () => void): () => void }

/** The dashboard re-reads when Herdr reports a change; this poll only catches what no event told (a missed one, a subagent's activity file). */
export const SAFETY_MS = 30_000;
const DEBOUNCE_MS = 500;

/**
 * Shows the dashboard in a tower's TUI. The spinner timer (1 fps; each tick redraws the whole TUI) runs only while a row is working and the tower is not `visible: false`. Data is re-read when `watch` reports
 * a change (collected for `debounceMs`, so a burst is one read), when poke() says intercom changed (at once), and every `pollMs` as a safety net;
 * two reads are never closer than `minGapMs`, and a request that comes inside the gap or while a read runs is read when it ends, not dropped.
 * stop() clears the timers and the subscription and removes the widget, and pi disposing the widget does the same.
 */
export function startDashboard({ ui, collect: read, watch, frameMs = 1000, pollMs = SAFETY_MS, minGapMs = 500, debounceMs = DEBOUNCE_MS }: { ui: ExtensionContext["ui"]; collect(): Promise<Snapshot> } & Timing): Dashboard {
	let live: Dashboard | undefined;
	ui.setWidget(KEY, (tui, theme) => {
		let snap: Snapshot = { title: "", mark: "unknown", head: false, rows: [] }, known: { url?: string } | undefined, frame = 0, busy = false, again = false, stopped = false, last = 0, due = Infinity, seq = 0, got = 0;
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
				const p = snap.pending;
				if (p) { // the rows are drawn now with the last known GUI line; the title follows when the read settles
					snap = { ...snap, gui: known?.url, checking: !known };
					const mine = ++seq;
					void p.then((url) => {
						// An answer older than the one shown is dropped; a newer one is shown even when a later read is still pending, so reads slower than the refreshes cannot keep a dead URL up.
						if (stopped || mine < got) return;
						[got, known] = [mine, { url }];
						snap = { ...snap, gui: url, checking: false, pending: snap.pending === p ? undefined : snap.pending };
						tui.requestRender();
					});
				}
			} catch (error) {
				snap = { ...snap, mark: "error", rows: [{ group: "net", depth: 0, mark: "error", text: `dashboard unavailable: ${(error as Error).message}` }] };
			}
			busy = false;
			last = Date.now();
			if (stopped) return;
			const working = snap.visible !== false && (snap.mark === "working" || snap.rows.some((r) => r.mark === "working"));
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
