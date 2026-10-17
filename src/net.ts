import { homedir } from "node:os";
import { basename, join, sep } from "node:path";
import { type Mark, markOf, type Row, sessionMark, subagents } from "./dashboard.ts";
import { headOf, type HerdrRun, isSub, type Pane, panes, parentOf, type Session, workspaces, type Workspace } from "./herdr.ts";
import { canonical } from "./history.ts";

// The whole straw net as one JSON-able snapshot for the browser view: every workspace as a base with its tower, tabs, agents,
// and subagents (linked to their launcher the way the tower dashboard links them), and sub workspaces as outposts.

/** `key` names the unit in routes and the API; `control` says a live pi pane backs it. `outside` units are pi panes the net does not hold (D1). */
export interface Unit { id: string; key: string; control: boolean; name: string; role: "main" | "member" | "subagent" | "outside"; mark: Mark; note?: string; subs: Unit[] }
export interface Tab { id: string; label: string; units: Unit[] }
export interface Outpost { id: string; label: string; mark: Mark }
export interface Base { id: string; label: string; mark: Mark; head: boolean; tower: { name: string; mark: Mark; key: string; control: boolean } | null; tabs: Tab[]; outposts: Outpost[]; outside: Unit[] }
export interface Net { bases: Base[] }
/** What the server may read for a key: the registry entry is the allow list, and paths never come from the browser. */
export interface Ref { key: string; base: string; name: string; role: string; file?: string; pane?: string }
export interface Found extends Ref { live: boolean; successor?: string }
export interface NetInput { sessions: Session[]; panes: Pane[]; workspaces: Workspace[]; children(pane: Pane | undefined): Row[]; sessionDir?: string }

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
	const rowsOf = new Map(joined.map(({ s, pane }) => [s.id, children(pane)]));
	// A sub workspace that already shows as a launched subagent is not an outpost as well.
	const claimed = new Set([...rowsOf.values()].flat().map((r) => r.workspace));
	const held = new Set([...joined.map((j) => j.pane?.pane_id), ...[...rowsOf.values()].flat().map((r) => r.pane)]);
	const keep = (r: Ref) => (refs.set(r.key, r), r.key);
	const bases = all.filter((w) => !isSub(w)).flatMap((w): Base[] => {
		const mine = joined.filter((j) => j.base === w.workspace_id && j.tab);
		const tabs = Object.values(Object.groupBy(mine, (j) => j.tab!.id)).map((group = []): Tab => ({
			id: group[0]!.tab!.id,
			label: group[0]!.tab!.label,
			units: group.toSorted((a, b) => Number(b.role === "main") - Number(a.role === "main")).map(({ s, pane, role }): Unit => {
				const mark = sessionMark(s, pane);
				const subs = (rowsOf.get(s.id) ?? []).map((r): Unit => {
					const key = keep({ key: r.id ?? `${s.id}/${r.text}`, base: w.workspace_id, name: r.text, role: "subagent", file: readable(r.file), pane: r.pane });
					return { id: key, key, control: Boolean(r.pane), name: r.text, role: "subagent", mark: r.mark, note: r.note, subs: [] };
				});
				const key = keep({ key: s.id, base: w.workspace_id, name: s.name ?? s.id, role, file: piFile(pane, s.id), pane: pane?.pane_id });
				return { id: key, key, control: pane?.agent === "pi", name: s.name ?? s.id, role, mark, note: note(mark, s.status), subs };
			}),
		}));
		const outposts = all.filter((x) => isSub(x) && parentOf(all, x) === w && !claimed.has(x.workspace_id)).map((x): Outpost => ({ id: x.workspace_id, label: x.label, mark: markOf(x.agent_status) }));
		const tower = sessions.find((s) => s.id === w.tokens?.tower), towerPane = tower && paneOf(tower);
		const outside = ps.filter((p) => p.workspace_id === w.workspace_id && p.agent === "pi" && p.pane_id !== towerPane?.pane_id && !held.has(p.pane_id)).flatMap((p): Unit[] => {
			const s = sessions.find((x) => x.herdrLocation?.paneId === p.pane_id), file = p.agent_session?.value;
			const key = s?.id ?? (file && basename(file, ".jsonl").split("_").pop());
			if (!key) return [];
			const name = s?.name ?? p.label ?? key.slice(0, 8), mark = s ? sessionMark(s, p) : markOf(p.agent_status);
			keep({ key, base: w.workspace_id, name, role: "outside", file: readable(file, s?.id), pane: p.pane_id });
			return [{ id: key, key, control: true, name, role: "outside", mark, note: note(mark, s?.status), subs: [] }];
		});
		const marks = [...tabs.flatMap((t) => t.units.flatMap((u) => [u.mark, ...u.subs.map((c) => c.mark)])), ...outposts.map((o) => o.mark)];
		// A base shows what needs attention most: a waiting unit, then a working one, else the workspace's own status.
		const mark = (["waiting", "working"] as const).find((m) => marks.includes(m)) ?? markOf(w.agent_status);
		if (!tower && !tabs.length) return [];
		const named = tower && keep({ key: tower.id, base: w.workspace_id, name: tower.name ?? tower.id, role: "tower", file: piFile(towerPane, tower.id), pane: towerPane?.pane_id });
		return [{ id: w.workspace_id, label: w.label, mark, head: w === headOf(all), tower: tower && named ? { name: tower.name ?? tower.id, mark: sessionMark(tower, towerPane), key: named, control: towerPane?.agent === "pi" } : null, tabs, outposts, outside }];
	});
	return { bases };
}

/** One reading of Herdr and intercom as a net. */
export async function collectNet({ run, sessions, now = Date.now(), refs, sessionDir }: { run: HerdrRun; sessions(): Promise<Session[]>; now?: number; refs?: Map<string, Ref>; sessionDir?: string }): Promise<Net> {
	const [live, ps, all] = [await sessions(), await panes(run), await workspaces(run)];
	return buildNet({ sessions: live, panes: ps, workspaces: all, children: (pane) => subagents(pane, ps, now), sessionDir }, refs);
}

/**
 * The net as the server reads it: each read also refreshes the registry. A key that left the net (the pane closed, or moved to
 * another session) stays findable for ten minutes, the window finished subagents already use, with the pane's new session as its successor.
 */
export function netSource(env: { run: HerdrRun; sessions(): Promise<Session[]>; sessionDir?: string }) {
	let refs = new Map<string, Ref>();
	const gone = new Map<string, { ref: Ref; at: number }>();
	return {
		async read(): Promise<Net> {
			const next = new Map<string, Ref>(), at = Date.now();
			const net = await collectNet({ ...env, refs: next });
			for (const [key, ref] of refs) if (!next.has(key)) gone.set(key, { ref, at });
			for (const [key, old] of gone) if (next.has(key) || at - old.at > RECENT_MS) gone.delete(key);
			refs = next;
			return net;
		},
		lookup(key: string): Found | undefined {
			const live = refs.get(key), old = gone.get(key)?.ref;
			if (live) return { ...live, live: true };
			return old && { ...old, live: false, successor: old.pane ? [...refs.values()].find((r) => r.pane === old.pane)?.key : undefined };
		},
		workspace: (id: string): Ref[] => [...refs.values()].filter((r) => r.base === id),
	};
}
