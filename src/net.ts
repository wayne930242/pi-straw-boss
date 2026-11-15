import type { Stashed } from "./stash.ts";
import type { LinkSummary } from "./link/holder.ts";
import { homedir } from "node:os";
import { basename, join, sep } from "node:path";
import { commanding, type Mark, markOf, type Row, sessionMark, subagentsOfAll } from "./netdata.ts";
import { cutCards } from "./waitbudget.ts";
import { type HeadChapter, type HeadSeam, type HeadUnit, headUnit, serviceMark } from "./nethead.ts";
import { type HerdrRun, type HerdrWorld, isHead, isSub, type Pane, parentOf, type Session, type Workspace, worldOf } from "./herdr.ts";
import { type Pending, type Relayed, withPending } from "./ask.ts";
import type { Shelf } from "./documents.ts";
import type { Monitor } from "./monitors.ts";
import { canonical } from "./history.ts";
import { type NetEvent, type Tick, trackActivity } from "./activity.ts";
import type { TodoSum } from "./todo.ts";
import { type CoordinatorDuty, type Duty, isCoordinatorDuty } from "./duty.ts";
import { type TrainId, trainFromToken } from "./trainrole.ts";
import type { NetLoad, YardJoin, Yards } from "./train/yardview.ts";
import type { BoardSeam, BoardViewRow } from "./boardview.ts";
import type { TrustAsk } from "./trust/types.ts";

// The whole straw net as one JSON-able snapshot for the browser view: every workspace as a base with its tower, tabs, agents,
// and subagents (linked to their launcher the way the tower dashboard links them), and sub workspaces as outposts.

/** `since`, `ticks`, `todo`, and the net's `events`: what it did lately (activity.ts). */
type Lately = { since?: number; ticks?: Tick[]; todo?: TodoSum };
/** `key` names the unit in routes and the API; `control` says a live pi pane backs it. `outside` units are pi panes the net does not hold (D1). */
/** A message typed while the agent works, waiting in pi's queue: `steer` reaches it at its next turn, `followUp` when the run ends. */
/** `start`: an event of a tower the sb server has not started yet; it waits for the run to start and is queued behind no turn (a pi's own queue says `steer` or `followUp`). */
export interface Queued { text: string; as: "steer" | "followUp" | "start"; /** Why a tower's message waits with no start under way (as `followUp`): the service is off, a start was refused a moment ago, the run slots are full, the tower's pi is not live, or the standing seat is not proven. */ why?: "off" | "refused" | "full" | "offline" | "unproven" }
/** `ended`: a subagent whose run is over (Row.ended); the page clears its finished alert. */
export interface Unit extends Shelf, Lately { queued?: Queued[]; monitors?: Monitor[]; id: string; key: string; control: boolean; name: string; role: "main" | "member" | "train" | "subagent" | "outside"; /** A main's kind, from its pane's `sb_duty` token (docs/specs/2026-11-09-agent-kinds.md §2); a launched subagent's, from the agent role its launch script names (D16). */ duty?: Duty; /** A train's project and code (its pane's `sb_train` token). */ train?: TrainId; mark: Mark; note?: string; subs: Unit[]; pending?: Pending; ended?: boolean }
export interface Tab { id: string; label: string; units: Unit[] }
export interface Outpost extends Lately { id: string; label: string; mark: Mark }
/** A run's proposal the boss has not answered; `cites` is the boss message it comes from. */ export interface MemoryProposal { id: string; op: "add" | "retire"; kind: "standing" | "decision"; text: string; target?: string; cites?: string }
/**
 * A wait for the boss as the page sees it (docs/specs/2026-11-07-wait-cards.md): `card` and `press` as stored, with the raiser's session id replaced by its unit `key` when the net has the unit (buildNet); `cut`: the card went over the snapshot's budget (waitbudget.ts) and is only its `text`,
 * which the page reads whole with the memory route's `read`.
 */
export interface BossWait { id: string; text: string; at: string; answered?: string; /** A wait the boss declined or the tower resolved, kept until the sweep drops it (24 h): `outcome` is what became of it and `ended` when. It is no longer open: no alert, no count. */ state?: "resolved"; outcome?: string; ended?: string; card?: WaitCardView; press?: WaitPressView; /** Recorded or open while auto mode is on: silent until the boss is back (auto-mode spec §6). */ parked?: true; /** The return panel listed it when auto mode ended: no alert again (auto-mode spec §8). */ listed?: true; cut?: true }
export interface WaitCardView {
	type: "action" | "choice" | "secret"; lang: "zh-TW" | "en"; happened: string; do: string; url?: string; command?: string; after?: string; options?: { label: string; then: string }[]; secret?: { name: string };
	from?: { /** On the server; the net swaps it for `key`. */ id?: string; name: string; role: string; workspace?: string; tab?: string; gone?: true; key?: string };
}
export interface WaitPressView { act: "done" | "choose" | "secret" | "decline" | "restate"; option?: number; reason?: string; at: string; main?: { status: "delivered" | "queued" | "gone" | "failed"; at: string }; secretAsked?: string }
export interface MemorySummary { rev: number; standing: number; decisions: number; waits: number; /** The open waits for the boss, with their text; `answered`: when the boss answered it (their message named it) and the tower has not resolved it yet. */ bossWaits: BossWait[]; /** What runs proposed and the boss has neither confirmed nor rejected. */ proposals: MemoryProposal[]; /** The memory file cannot be read: nothing in it can be changed until it is fixed. */ problem?: string }
/**
 * The sb server's tower service of a workspace (docs/specs/2026-10-26-sb-backend.md, GUI): what the tower unit shows while no pi session is the tower. `queue` and `file` come with the reading and are not part of the
 * snapshot's `service` (the page sees them as the unit's `queued` rows and its comms).
 */
export interface TowerService {
	/** The tower's memory in counts (src/server/towermemory.ts): the standing instructions, decisions, and waits the panel opens. */
	memory?: MemorySummary;
	state: "standing" | "waking" | "running" | "closing" | "held";
	queued: number;
	run?: { id: string; kind: "local" | "ally"; startedAt: string };
	/** The live local run is a boss conversation (the hand copy of runs.ts `ConversationStatus`; times are epoch milliseconds). */
	conversation?: { since: string; resumed: boolean; why?: string; turns: number; idle: boolean; idleAt?: number; idleMs: number; capAt: number; closing?: true };
	/** The live local run is an event run the boss spoke into (runs.ts `ServiceStatus.bossIn`). */
	bossIn?: { id: string; since: string };
	/** The last local runs, oldest first (runs.ts `LocalRunRow`); `key` is the read-only unit that shows an event run's comms, added while its session file is known. */
	localRuns?: { id: string; kind: "conversation" | "event"; resumed?: boolean; why?: string; startedAt: string; endedAt?: string; outcome?: string; note?: string; key?: string }[];
	/** `key`: the read-only unit that shows the run's comms (the net adds it while the run's session file is known; the file itself never reaches the page). */
	allyRuns: { id: string; device: string; label: string; startedAt: string; key?: string }[];
	lastRun?: { endedAt: string; outcome: string }; crashes?: number; // `crashes`: runs that crashed or timed out in the loop window, when any did
	notices: { id: string; level: "info" | "warning" | "error"; kind: string; text: string; at: number; detail?: string }[];
	parked: { id: string; kind: string; from?: string; first: string }[];
}
export type TowerView = TowerService & { queue: Queued[]; file?: string; /** The session files of the live ally runs, by run id. */ allyFiles?: Record<string, string>; /** The session files of the recent event runs, by run id. */ eventFiles?: Record<string, string> };
/**
 * A base that is an unattended box's, shown through an operate session (docs/specs/2026-11-07-link-operate.md §6.4; src/server/operatehost.ts makes it): the controller's own net reading adds it, the box never sends it. `device` and `short` are the
 * box's id and short id and `label` its roster label; `team` names the team (or teams) the sessions came on; `scope` says whether the box's own units are in; `can` lists the page actions the box lets through, so the ⋯ menus hide the rest. `state`:
 * `live`, `unreachable` (no frame for 45 s: greyed, `seen` is the last frame's time in epoch ms) or `ended` (the box refused or closed the session: an otherwise empty base with `why`, a word of a known set).
 */
export interface RemoteBox {
	device: string; short: string; label: string; team: string; scope: "team" | "box"; can: string[]; state: "live" | "unreachable" | "ended"; why?: string; seen?: number;
	/** A base two sessions of the box show (one per team) whose sessions differ: the units whose own session's state, scope or reach differs from the base's, by unit key (a unit's actions go to the session that shows it). */
	units?: Record<string, { state: "live" | "unreachable"; scope: "team" | "box"; can: string[] }>;
}
export interface Base { id: string; label: string; mark: Mark; /** Only on a base of an unattended box (RemoteBox). */ box?: RemoteBox; tower: ({ name: string; mark: Mark; key: string; control: boolean; service?: TowerService; pending?: Pending; queued?: Queued[]; monitors?: Monitor[]; subs: Unit[] } & Shelf & Lately) | null; tabs: Tab[]; outposts: Outpost[]; outside: Unit[] }
/**
 * `stashed`: the bases put away with /boss stash, waiting to be popped (stash.ts). `trust`: the folders whose agents wait for a trust decision (trust/serve.ts). `link`: Straw Link's teammates' bases, the notices it raises, and the confirms waiting for the boss; absent
 * when Straw Link is not set up or says nothing. `yards`: the trains of this computer, per project, from the trainboard files (docs/specs/2026-11-07-train-workers.md §11.1, server/trainyard.ts); `load`: the 1-minute load average and the core count
 * for the header chip, given only with `yards`, and not on Windows. Both are absent with the merge train off and stay on this computer: the board message, a remote turn and the operate slice never carry them.
 * `board`: the work board of THIS computer as the boss's own page shows it (boardview.ts, docs/specs/2026-11-09-board-view.md); allies' boards are not in it, and like `yards` it never reaches the link, a remote turn, or the operate slice.
 */
/** Auto mode as the boss own page shows it (docs/specs/2026-11-09-auto-mode.md, section 7): present only while it is on or the head request waits for the boss confirm (`pending`: the id the confirm names, what the boss said, when it lapses). Like `board` it never reaches the link, a remote turn, or the operate slice. */
export interface AutoSnap { on: boolean; since?: string; pending?: { id: string; said: string; expires: number } }
export interface Net { bases: Base[]; /** The head tower (nethead.ts); present when the server runs the tower service. */ head?: HeadUnit; stashed?: Stashed[]; trust?: TrustAsk[]; events?: NetEvent[]; link?: LinkSummary; yards?: Yards; load?: NetLoad; board?: BoardViewRow[]; auto?: AutoSnap; /** This server can switch auto mode (the primary slot's, attended): the page shows the chip only then. */ autoable?: true }
/** What the server may read for a key: the registry entry is the allow list, and paths never come from the browser. */
export interface Ref { key: string; base: string; name: string; role: string; file?: string; pane?: string; /** The head tower's chapters, oldest first (the last is `file`): the history chains through them (watch.ts). */ chapters?: HeadChapter[] }
export interface Found extends Ref { live: boolean; successor?: string }
export interface NetInput { /** The tower service of a workspace, when the sb server runs towers there. */ services?(workspace: string): TowerView | undefined; /** The head tower: its key, asks, and chapters. */ head?: HeadSeam; sessions: Session[]; panes: Pane[]; workspaces: Workspace[]; children(pane: Pane | undefined): Row[]; sessionDir?: string }

const joinedRole = (token?: string): "main" | "member" | "train" | undefined => (token === "main" || token === "member" || token === "train" ? token : undefined);
const RECENT_MS = 10 * 60_000;

/**
 * The pure half: sessions, panes, and workspaces in, the net out. Sessions that did not join (no main or member token) are left out,
 * and so are workspaces with no part in the net (no live tower, nobody joined): a base is a workspace the net reaches. Every unit
 * that has a key is also written to `refs`, the server's allow list, with a file only from pi's `sessionDir`. A base's `outside` lists its other pi panes (D1), except one that is closing on purpose (`sb_closing`, closing.ts: its session has left intercom, its pi is shutting down).
 */
/** A raiser as the page gets it: the unit key when the net has the session, not its id. */
const raiserView = ({ id, ...rest }: NonNullable<WaitCardView["from"]>, keys: Map<string, string>): NonNullable<WaitCardView["from"]> => ({ ...rest, ...(id && keys.get(id) ? { key: keys.get(id)! } : {}) });
export function buildNet({ sessions, panes: ps, workspaces: all, children, services, head, sessionDir = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "sessions") }: NetInput, refs = new Map<string, Ref>()): Net {
	// Readable: a .jsonl really under pi's sessions directory (symlinks resolved), named for its intercom session (during /new the pane names the
	// next file first). The registry keeps the resolved path, so the reader and the input check compare like with like.
	const root = canonical(sessionDir), readable = (file?: string, id?: string, real = file?.endsWith(".jsonl") ? canonical(file) : undefined) => (real && real.startsWith(root + sep) && (!id || basename(real).endsWith(`_${id}.jsonl`)) ? real : undefined);
	const piFile = (pane: Pane | undefined, id: string) => readable(pane?.agent === "pi" ? pane.agent_session?.value : undefined, id);
	const paneOf = (s: Session) => ps.find((p) => p.pane_id === s.herdrLocation?.paneId);
	const note = (mark: Mark, status?: string) => ({ working: status, waiting: "waiting on a question" })[mark as "working"];
	const joined = sessions.flatMap((s) => {
		const pane = paneOf(s), role = joinedRole(pane?.tokens?.sb_role);
		return role ? [{ s, pane, role, base: s.herdrLocation?.workspace?.id, tab: s.herdrLocation?.tab }] : [];
	});
	const towerOf = (w: Workspace) => sessions.find((s) => s.id === w.tokens?.tower);
	// A tower launches subagents too: they hang under it, as a member's hang under the member.
	const towers = all.filter((w) => !isSub(w) && !isHead(w)).flatMap((w) => ((t) => (t ? [t] : []))(towerOf(w)));
	const rowsOf = new Map([...joined, ...towers.map((s) => ({ s, pane: paneOf(s) }))].map(({ s, pane }) => [s.id, children(pane)]));
	// A sub workspace that already shows as a launched subagent is not an outpost as well.
	const claimed = new Set([...rowsOf.values()].flat().map((r) => r.workspace));
	const held = new Set([...joined.map((j) => j.pane?.pane_id), ...[...rowsOf.values()].flat().map((r) => r.pane)]);
	const keep = (r: Ref) => (refs.set(r.key, r), r.key);
	const subsOf = (launcher: string, base: string) => (rowsOf.get(launcher) ?? []).map((r): Unit => {
		const key = keep({ key: r.id ?? `${launcher}/${r.text}`, base, name: r.text, role: "subagent", file: readable(r.file), pane: r.pane });
		return { id: key, key, control: Boolean(r.pane), name: r.text, role: "subagent", ...(r.duty ? { duty: r.duty } : {}), mark: r.mark, note: r.note, subs: [], ...(r.ended && { ended: true }) };
	});
	const towerKeys = new Map<string, string>();
	const bases = all.filter((w) => !isSub(w) && !isHead(w)).flatMap((w): Base[] => {
		const mine = joined.filter((j) => j.base === w.workspace_id && j.tab);
		const tabs = Object.values(Object.groupBy(mine, (j) => j.tab!.id)).map((group = []): Tab => ({
			id: group[0]!.tab!.id,
			label: group[0]!.tab!.label,
			units: group.toSorted((a, b) => Number(b.role === "main") - Number(a.role === "main")).map(({ s, pane, role }): Unit => {
				const subs = subsOf(s.id, w.workspace_id), mark = commanding(sessionMark(s, pane), subs.map((c) => c.mark));
				const key = keep({ key: s.id, base: w.workspace_id, name: s.name ?? s.id, role, file: piFile(pane, s.id), pane: pane?.pane_id }), train = role === "train" ? trainFromToken(pane?.tokens?.sb_train) : undefined, duty = role === "main" && isCoordinatorDuty(pane?.tokens?.sb_duty) ? pane!.tokens!.sb_duty as CoordinatorDuty : undefined;
				return { id: key, key, control: pane?.agent === "pi", name: s.name ?? s.id, role, ...(train ? { train } : {}), ...(duty ? { duty } : {}), mark, note: note(mark, s.status), subs };
			}),
		}));
		const outposts = all.filter((x) => isSub(x) && parentOf(all, x) === w && !claimed.has(x.workspace_id)).map((x): Outpost => ({ id: x.workspace_id, label: x.label, mark: markOf(x.agent_status) }));
		const tower = towerOf(w), towerPane = tower && paneOf(tower), towerSubs = tower ? subsOf(tower.id, w.workspace_id) : [];
		const outside = ps.filter((p) => p.workspace_id === w.workspace_id && p.agent === "pi" && p.pane_id !== towerPane?.pane_id && !held.has(p.pane_id) && !p.tokens?.sb_closing).flatMap((p): Unit[] => {
			const s = sessions.find((x) => x.herdrLocation?.paneId === p.pane_id), file = p.agent_session?.value;
			const key = s?.id ?? (file && basename(file, ".jsonl").split("_").pop());
			if (!key) return [];
			const name = s?.name ?? p.label ?? key.slice(0, 8), mark = s ? sessionMark(s, p) : markOf(p.agent_status);
			keep({ key, base: w.workspace_id, name, role: "outside", file: readable(file, s?.id), pane: p.pane_id });
			return [{ id: key, key, control: true, name, role: "outside", mark, note: note(mark, s?.status), subs: [] }];
		});
		const marks = [...towerSubs.map((c) => c.mark), ...tabs.flatMap((t) => t.units.flatMap((u) => [u.mark, ...u.subs.map((c) => c.mark)])), ...outposts.map((o) => o.mark)]; // a commanding unit has a working or waiting subagent here, which the base shows already
		// A base shows what needs attention most: a waiting unit, then a working one, else the workspace's own status.
		const mark = (["waiting", "working"] as const).find((m) => marks.includes(m)) ?? markOf(w.agent_status);
		if (!tower && !tabs.length) return [];
		// A tower the sb server runs: its comms are the live run's session file, else the last run's (read only); the composer wakes it (a boss event), so it is always a control; a live run that is
		// not waiting on a question shows as working, and the queued events show as the unit's queued rows.
		const view = tower ? services?.(w.workspace_id) : undefined, { queue, file: runFile, allyFiles, eventFiles, ...service } = view ?? ({} as Partial<TowerView>);
		const named = tower && keep({ key: tower.id, base: w.workspace_id, name: tower.name ?? tower.id, role: "tower", file: view ? readable(runFile) : piFile(towerPane, tower.id), pane: towerPane?.pane_id });
		if (tower && named) towerKeys.set(tower.id, named);
		// An ally run of the service whose session file is known is a unit of its own with no pane (a teammate's message drives it, so nothing is typed into it): the chip on the tower opens its comms read-only.
		const allyRuns = (service.allyRuns ?? []).map((a) => { const file = readable(allyFiles?.[a.id]); return file ? { ...a, key: keep({ key: `ally-${a.id}`, base: w.workspace_id, name: a.label, role: "ally", file }) } : a; });
		// An event run whose session file is known is a read-only unit as well (its handoff note stays on the chip): the tower's own comms are the boss conversation, which an event run does not interrupt.
		const localRuns = (service.localRuns ?? []).map((r) => { const file = r.kind === "event" ? readable(eventFiles?.[r.id]) : undefined; return file ? { ...r, key: keep({ key: `run-${r.id}`, base: w.workspace_id, name: `${r.id.slice(0, 8)}`, role: "run", file }) } : r; });
		const towerMark = tower ? commanding(sessionMark(tower, towerPane), towerSubs.map((c) => c.mark)) : "unknown";
		return [{ id: w.workspace_id, label: w.label, mark, tower: tower && named ? { name: tower.name ?? tower.id, mark: serviceMark(view ? (service as TowerService) : undefined, towerMark), key: named, control: view ? true : towerPane?.agent === "pi", ...(view ? { service: { ...service, allyRuns, ...(localRuns.length ? { localRuns } : {}) } as TowerService, ...(queue?.length ? { queued: queue } : {}) } : {}), subs: towerSubs } : null, tabs, outposts, outside }];
	});
	const headed = head ? headUnit({ all, sessions, ps, services, seam: head, readable: (file) => readable(file), keep }) : undefined;
	// The cards of the wait for the boss: the raiser's unit key (never its session id) and the budget across every tower, the head's included.
	const keys = new Map<string, string>(towerKeys);
	for (const b of bases) for (const u of [...b.tabs.flatMap((t) => t.units), ...b.outside]) keys.set(u.id, u.key);
	const holders = [...bases.flatMap((b) => (b.tower?.service?.memory ? [b.tower.service] : [])), ...(headed?.head.service?.memory ? [headed.head.service] : [])];
	const keyed = holders.map((h) => ({ ...h.memory!, bossWaits: h.memory!.bossWaits.map((w): BossWait => (w.card?.from ? { ...w, card: { ...w.card, from: raiserView(w.card.from, keys) } } : w)) }));
	cutCards(keyed).forEach((memory, i) => void (holders[i]!.memory = memory));
	return { bases, ...(headed ?? {}) };
}

/** One reading of Herdr and intercom as a net. */
export async function collectNet({ run, world = worldOf(run), sessions, now = Date.now(), refs, sessionDir, trust, services, head }: { services?(workspace: string): TowerView | undefined; head?: HeadSeam; run: HerdrRun; world?: HerdrWorld; sessions(): Promise<Session[]>; now?: number; refs?: Map<string, Ref>; sessionDir?: string; trust?: { asks(panes: Pane[], workspaces: Workspace[]): TrustAsk[] } }): Promise<Net> {
	const [live, { panes: ps, workspaces: all }] = await Promise.all([sessions(), world()]);
	const net = buildNet({ sessions: live, panes: ps, workspaces: all, children: subagentsOfAll(ps, now), sessionDir, ...(services ? { services } : {}), ...(head ? { head } : {}) }, refs), asks = trust?.asks(ps, all) ?? [];
	return asks.length ? { ...net, trust: asks } : net;
}

/**
 * The net as the server reads it: each read also refreshes the registry. A key that left the net (the pane closed, or moved to
 * another session) stays findable for ten minutes, the window finished subagents already use, with the pane's new session as its successor.
 */
/** The trains the page draws: the units of the net that are trains (by their panes' tokens) and the keys of the mains, which is all the reader needs of the net to name the unit that runs a train or wrote a yard. */
export function joinOf(net: Net): YardJoin {
	const units = net.bases.flatMap((b) => b.tabs.flatMap((t) => t.units));
	return { trains: units.flatMap((u) => (u.role === "train" && u.train ? [{ key: u.key, project: u.train.project, code: u.train.code }] : [])), mains: new Set(units.filter((u) => u.role === "main").map((u) => u.key)), integrators: new Set(units.filter((u) => u.role === "main" && (u.duty === "integrator" || u.duty === undefined)).map((u) => u.key)) };
}

export function netSource(env: { auto?: () => AutoSnap | undefined; autoable?: () => boolean; board?: BoardSeam; trainyard?: { yards(join: YardJoin): Yards | undefined; load(): NetLoad | undefined }; services?(workspace: string): TowerView | undefined; head?: HeadSeam; run: HerdrRun; world?: HerdrWorld; sessions(): Promise<Session[]>; sessionDir?: string; hub?: { relayed(sessions: Session[], refs: Map<string, Ref>): Relayed }; stashed?(): Stashed[]; trust?: { asks(panes: Pane[], workspaces: Workspace[]): TrustAsk[] } }) {
	let refs = new Map<string, Ref>(), live: Session[] = [];
	const gone = new Map<string, { ref: Ref; at: number }>(), sessions = async () => (live = await env.sessions()), dismissed = new Set<string>(), ended = new Set<string>();
	const lately = trackActivity();
	const drop = (u: { subs: Unit[] }) => (u.subs.forEach((c) => c.ended && ended.add(c.key)), (u.subs = u.subs.filter((c) => !(c.ended && dismissed.has(c.key))))); // finished subagents the page dismissed
	return {
		async read(): Promise<Net> {
			const next = new Map<string, Ref>(), at = Date.now(), net = await collectNet({ ...env, sessions, refs: next });
			await withPending(net, (key) => next.get(key)?.file, env.hub?.relayed(live, next)); // what waiting units wait on, and the dialogs bridges relay; a subagent watching a monitor is not finished, so this comes before the finished are counted
			ended.clear();
			net.bases.forEach((b) => [...(b.tower ? [b.tower] : []), ...b.tabs.flatMap((t) => t.units), ...b.outside].forEach(drop));
			for (const key of dismissed) if (!next.has(key)) dismissed.delete(key); // gone from the net: nothing left to hide
			for (const [key, ref] of refs) if (!next.has(key)) gone.set(key, { ref, at });
			for (const [key, old] of gone) if (next.has(key) || at - old.at > RECENT_MS) gone.delete(key);
			refs = next;
			const stashed = env.stashed?.() ?? [], seen = lately(net); // after the dialogs and the finished: the marks the page shows
			const stashing = stashed.length ? { ...seen, stashed } : seen, board = env.board?.rows(stashing, live.map((x) => x.id)), boarded = board ? { ...stashing, board } : stashing, snap = env.auto?.(), able = env.autoable?.() ? { ...boarded, autoable: true as const } : boarded, shown: Net = snap && (snap.on || snap.pending) ? { ...able, auto: snap } : able, yards = env.trainyard?.yards(joinOf(shown));
			if (!yards) return shown;
			const load = env.trainyard!.load();
			return { ...shown, yards, ...(load ? { load } : {}) };
		},
		lookup(key: string): Found | undefined {
			const live = refs.get(key), old = gone.get(key)?.ref;
			if (live) return { ...live, live: true };
			return old && { ...old, live: false, successor: old.pane ? [...refs.values()].find((r) => r.pane === old.pane)?.key : undefined };
		},
		workspace: (id: string): Ref[] => [...refs.values()].filter((r) => r.base === id),
		refs: (): Ref[] => [...refs.values()], // every unit of the last reading: the operate scope reads the owner of each (operatescope.ts)
		/** Hides a finished subagent from every page until it leaves the net; false for anything else. */
		dismiss: (key: string) => ended.has(key) && Boolean(dismissed.add(key)),
		/** Hides every finished subagent now on the net at once; how many were newly hidden. */
		dismissAll: () => [...ended].filter((key) => !dismissed.has(key) && dismissed.add(key)).length,
	};
}
