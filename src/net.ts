import type { Stashed } from "./stash.ts";
import { homedir } from "node:os";
import { basename, join, sep } from "node:path";
import { commanding, type Mark, markOf, type Row, sessionMark, subagents } from "./dashboard.ts";
import { headOf, type HerdrRun, type HerdrWorld, isSub, type Pane, parentOf, type Session, type Workspace, worldOf } from "./herdr.ts";
import { type Pending, type Relayed, withPending } from "./ask.ts";
import type { Shelf } from "./documents.ts";
import type { Monitor } from "./monitors.ts";
import { canonical } from "./history.ts";
import { type NetEvent, type Tick, trackActivity } from "./activity.ts";
import type { TodoSum } from "./todo.ts";
import type { TrustAsk } from "./trust/types.ts";

// The whole straw net as one JSON-able snapshot for the browser view: every workspace as a base with its tower, tabs, agents,
// and subagents (linked to their launcher the way the tower dashboard links them), and sub workspaces as outposts.

/** `since`, `ticks`, `todo`, and the net's `events`: what it did lately (activity.ts). */
type Lately = { since?: number; ticks?: Tick[]; todo?: TodoSum };
/** `key` names the unit in routes and the API; `control` says a live pi pane backs it. `outside` units are pi panes the net does not hold (D1). */
/** A message typed while the agent works, waiting in pi's queue: `steer` reaches it at its next turn, `followUp` when the run ends. */
export interface Queued { text: string; as: "steer" | "followUp" }
/** `ended`: a subagent whose run is over (Row.ended); the page clears its finished alert. */
export interface Unit extends Shelf, Lately { queued?: Queued[]; monitors?: Monitor[]; id: string; key: string; control: boolean; agent?: "claude" | "codex"; name: string; role: "main" | "member" | "subagent" | "outside"; mark: Mark; note?: string; subs: Unit[]; pending?: Pending; ended?: boolean }
export interface Tab { id: string; label: string; units: Unit[] }
export interface Outpost extends Lately { id: string; label: string; mark: Mark }
export interface Base { id: string; label: string; mark: Mark; head: boolean; tower: ({ name: string; mark: Mark; key: string; control: boolean; pending?: Pending; queued?: Queued[]; monitors?: Monitor[]; subs: Unit[] } & Shelf & Lately) | null; tabs: Tab[]; outposts: Outpost[]; outside: Unit[] }
/** `stashed`: the bases put away with /boss stash, waiting to be popped (stash.ts). `trust`: the folders whose agents wait for a trust decision (trust/serve.ts). */
export interface Net { bases: Base[]; stashed?: Stashed[]; trust?: TrustAsk[]; events?: NetEvent[] }
/** What the server may read for a key: the registry entry is the allow list, and paths never come from the browser. */
export interface Ref { key: string; base: string; name: string; role: string; file?: string; pane?: string }
export interface Found extends Ref { live: boolean; successor?: string }
export interface NetInput { sessions: Session[]; panes: Pane[]; workspaces: Workspace[]; children(pane: Pane | undefined): Row[]; sessionDir?: string }

const agentOf = (pane?: Pane) => (pane?.agent === "claude" || pane?.agent === "codex" ? pane.agent : undefined); // a net sidecar (src/agent) joined it: the page names the agent, and nothing can be typed into it
const joinedRole = (token?: string): "main" | "member" | undefined => (token === "main" || token === "member" ? token : undefined);
const RECENT_MS = 10 * 60_000;

/**
 * The pure half: sessions, panes, and workspaces in, the net out. Sessions that did not join (no main or member token) are left out,
 * and so are workspaces with no part in the net (no live tower, nobody joined): a base is a workspace the net reaches. Every unit
 * that has a key is also written to `refs`, the server's allow list, with a file only from pi's `sessionDir`. A base's `outside` lists its other pi panes (D1).
 */
export function buildNet({ sessions, panes: ps, workspaces: all, children, sessionDir = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "sessions") }: NetInput, refs = new Map<string, Ref>()): Net {
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
	const towers = all.filter((w) => !isSub(w)).flatMap((w) => ((t) => (t ? [t] : []))(towerOf(w)));
	const rowsOf = new Map([...joined, ...towers.map((s) => ({ s, pane: paneOf(s) }))].map(({ s, pane }) => [s.id, children(pane)]));
	// A sub workspace that already shows as a launched subagent is not an outpost as well.
	const claimed = new Set([...rowsOf.values()].flat().map((r) => r.workspace));
	const held = new Set([...joined.map((j) => j.pane?.pane_id), ...[...rowsOf.values()].flat().map((r) => r.pane)]);
	const keep = (r: Ref) => (refs.set(r.key, r), r.key);
	const subsOf = (launcher: string, base: string) => (rowsOf.get(launcher) ?? []).map((r): Unit => {
		const key = keep({ key: r.id ?? `${launcher}/${r.text}`, base, name: r.text, role: "subagent", file: readable(r.file), pane: r.pane });
		return { id: key, key, control: Boolean(r.pane), name: r.text, role: "subagent", mark: r.mark, note: r.note, subs: [], ...(r.ended && { ended: true }) };
	});
	const bases = all.filter((w) => !isSub(w)).flatMap((w): Base[] => {
		const mine = joined.filter((j) => j.base === w.workspace_id && j.tab);
		const tabs = Object.values(Object.groupBy(mine, (j) => j.tab!.id)).map((group = []): Tab => ({
			id: group[0]!.tab!.id,
			label: group[0]!.tab!.label,
			units: group.toSorted((a, b) => Number(b.role === "main") - Number(a.role === "main")).map(({ s, pane, role }): Unit => {
				const subs = subsOf(s.id, w.workspace_id), mark = commanding(sessionMark(s, pane), subs.map((c) => c.mark));
				const key = keep({ key: s.id, base: w.workspace_id, name: s.name ?? s.id, role, file: piFile(pane, s.id), pane: pane?.pane_id });
				return { id: key, key, control: pane?.agent === "pi", ...(agentOf(pane) && { agent: agentOf(pane) }), name: s.name ?? s.id, role, mark, note: note(mark, s.status), subs };
			}),
		}));
		const outposts = all.filter((x) => isSub(x) && parentOf(all, x) === w && !claimed.has(x.workspace_id)).map((x): Outpost => ({ id: x.workspace_id, label: x.label, mark: markOf(x.agent_status) }));
		const tower = towerOf(w), towerPane = tower && paneOf(tower), towerSubs = tower ? subsOf(tower.id, w.workspace_id) : [];
		const outside = ps.filter((p) => p.workspace_id === w.workspace_id && p.agent === "pi" && p.pane_id !== towerPane?.pane_id && !held.has(p.pane_id)).flatMap((p): Unit[] => {
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
		const named = tower && keep({ key: tower.id, base: w.workspace_id, name: tower.name ?? tower.id, role: "tower", file: piFile(towerPane, tower.id), pane: towerPane?.pane_id });
		return [{ id: w.workspace_id, label: w.label, mark, head: w === headOf(all), tower: tower && named ? { name: tower.name ?? tower.id, mark: commanding(sessionMark(tower, towerPane), towerSubs.map((c) => c.mark)), key: named, control: towerPane?.agent === "pi", subs: towerSubs } : null, tabs, outposts, outside }];
	});
	return { bases };
}

/** One reading of Herdr and intercom as a net. */
export async function collectNet({ run, world = worldOf(run), sessions, now = Date.now(), refs, sessionDir, trust }: { run: HerdrRun; world?: HerdrWorld; sessions(): Promise<Session[]>; now?: number; refs?: Map<string, Ref>; sessionDir?: string; trust?: { asks(panes: Pane[], workspaces: Workspace[]): TrustAsk[] } }): Promise<Net> {
	const [live, { panes: ps, workspaces: all }] = await Promise.all([sessions(), world()]);
	const net = buildNet({ sessions: live, panes: ps, workspaces: all, children: (pane) => subagents(pane, ps, now), sessionDir }, refs), asks = trust?.asks(ps, all) ?? [];
	return asks.length ? { ...net, trust: asks } : net;
}

/**
 * The net as the server reads it: each read also refreshes the registry. A key that left the net (the pane closed, or moved to
 * another session) stays findable for ten minutes, the window finished subagents already use, with the pane's new session as its successor.
 */
export function netSource(env: { run: HerdrRun; world?: HerdrWorld; sessions(): Promise<Session[]>; sessionDir?: string; hub?: { relayed(sessions: Session[], refs: Map<string, Ref>): Relayed }; stashed?(): Stashed[]; trust?: { asks(panes: Pane[], workspaces: Workspace[]): TrustAsk[] } }) {
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
			return stashed.length ? { ...seen, stashed } : seen;
		},
		lookup(key: string): Found | undefined {
			const live = refs.get(key), old = gone.get(key)?.ref;
			if (live) return { ...live, live: true };
			return old && { ...old, live: false, successor: old.pane ? [...refs.values()].find((r) => r.pane === old.pane)?.key : undefined };
		},
		workspace: (id: string): Ref[] => [...refs.values()].filter((r) => r.base === id),
		/** Hides a finished subagent from every page until it leaves the net; false for anything else. */
		dismiss: (key: string) => ended.has(key) && Boolean(dismissed.add(key)),
		/** Hides every finished subagent now on the net at once; how many were newly hidden. */
		dismissAll: () => [...ended].filter((key) => !dismissed.has(key) && dismissed.add(key)).length,
	};
}
