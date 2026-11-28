import type { AskItem, AskRowV1, AskView } from "../asktypes.ts";
import { HEAD_KEY } from "../headkey.ts";
import type { BossWait, Net, Unit } from "../net.ts";
import { type Asker, type AskRecord, type MirrorEntry, oneLine } from "./askstore.ts";

// What one reading of the net holds for the Ask store (docs/specs/2026-11-28-boss-asks.md): the questions sb can see and does not own, as mirrors (wait cards, the head tower's too, a teammate's wait raised to the boss as a card, units that
// wait on ask_user_question or ask_user), each with the todo it blocks; the sessions on the net (a blocking Ask's asker is gone when its session is not); and, from the store's open Asks, the probe's rows for a session
// and the page's views. Pure: askops.ts reads the net and writes the store.

/** The tools whose open call is a question to the boss that sb can see (rpiv's adapter, owners.ts, or the call in the session file). `call_tower` is not one: its question is an Ask of its own. */
const ASK_TOOLS = new Set(["ask_user_question", "ask_user"]);
interface Place { u: Pick<Unit, "key" | "name" | "role" | "pending" | "since" | "todo" | "ended"> & { subs: Unit[] }; ws: string; wsLabel: string; tab?: string; tabLabel?: string; launcher?: Unit }
function places(net: Pick<Net, "bases">): Place[] {
	const out: Place[] = [];
	const add = (u: Place["u"], at: Omit<Place, "u" | "launcher">, launcher?: Unit) => {
		out.push({ u, ...at, ...(launcher ? { launcher } : {}) });
		for (const s of u.subs) add(s, at, u as Unit);
	};
	for (const b of net.bases) {
		if (b.box) continue; // an operated box's units are the box's: its questions are asked there
		const at = { ws: b.id, wsLabel: b.label };
		if (b.tower) add({ ...b.tower, role: "tower" as never }, at);
		for (const t of b.tabs) for (const u of t.units) add(u, { ...at, tab: t.id, tabLabel: t.label });
		for (const u of b.outside) add(u, at);
	}
	return out;
}
const askerOf = (p: Place, paneOf?: (key: string) => string | undefined): Asker => ((pane) => ({ session: p.u.key, name: p.u.name, role: p.u.role, workspace: p.ws, workspaceLabel: p.wsLabel, ...(p.tab ? { tab: p.tab, tabLabel: p.tabLabel } : {}), ...(pane ? { pane } : {}) }))(paneOf?.(p.u.key));
/** The todo a question of this unit blocks: the call's own item, the launcher's todo bound to the subagent's run, else the unit's todo in progress. */
function itemOf(p: Place, explicit?: number): AskItem | undefined {
	const own = (id: number): AskItem => ((uid) => ({ session: p.u.key, id, ...(uid && { uid }) }))(id === p.u.todo?.doing ? p.u.todo.doingUid : p.u.todo?.runs?.find((r) => r.id === id)?.uid);
	if (explicit) return own(explicit);
	const bound = p.launcher?.todo?.runs?.find((r) => r.run === p.u.key);
	if (bound && p.launcher) return { session: p.launcher.key, id: bound.id, ...(bound.uid && { uid: bound.uid }) };
	return p.u.todo?.doing !== undefined ? own(p.u.todo.doing) : undefined;
}
const subjectOf = (u: Place["u"]) => {
	const p = u.pending!, qs = p.asks ?? (p.ask ? [p.ask] : (p.answer?.questions ?? []).map((q) => ({ question: q.question })));
	return qs.length ? `${oneLine(qs[0]!.question)}${qs.length > 1 ? ` (+${qs.length - 1})` : ""}` : p.tool;
};
const openWait = (w: BossWait) => !w.state && !w.answered && !w.returned;

export function asksOfNet(net: Pick<Net, "bases" | "head">, { now, paneOf }: { now: number; paneOf?: (key: string) => string | undefined }): { entries: MirrorEntry[]; live: Set<string>; place(session: string): Partial<Asker> | undefined } {
	const all = places(net), entries: MirrorEntry[] = [], byKey = new Map(all.map((p) => [p.u.key, p]));
	/** One tower's open waits for the boss: the asker is the card's raiser, a teammate's device, else the tower (`self`). */
	const waits = (ws: string, list: BossWait[] | undefined, self: Asker | undefined) => {
		for (const w of (list ?? []).filter(openWait)) {
			const from = w.card?.from, raiser = from?.key ? byKey.get(from.key) : undefined, device = from?.role === "device";
			const asker: Asker | undefined = device ? { session: `device:${from!.id ?? from!.name}`, name: from!.name, device: from!.name } : raiser ? askerOf(raiser, paneOf) : self;
			if (!asker) continue;
			const since = Date.parse(w.at);
			entries.push({ mirror: `wait:${ws}:${w.id}`, kind: device ? "link" : "wait", asker, subject: oneLine(w.card?.do ?? w.text.split("\n")[0] ?? "") || w.id, since: Number.isFinite(since) ? since : now, ...(raiser && !device ? ((item) => (item ? { item } : {}))(itemOf(raiser)) : {}) });
		}
	};
	for (const b of net.bases) {
		if (b.box) continue;
		const tower = all.find((p) => p.u.key === b.tower?.key && !p.launcher);
		waits(b.id, b.tower?.service?.memory?.bossWaits, tower && askerOf(tower, paneOf));
	}
	// The head tower's own waits (asks-r2-F005): its card is the head's (`wait:@head:<W>`), opened on the head page.
	if (net.head) waits(HEAD_KEY, net.head.service?.memory?.bossWaits, { session: net.head.key, name: net.head.name, role: "tower", workspace: HEAD_KEY, workspaceLabel: net.head.name });
	for (const p of all) {
		const pending = p.u.pending;
		if (!pending || !ASK_TOOLS.has(pending.tool) || p.u.ended) continue;
		const item = itemOf(p, pending.item);
		entries.push({ mirror: `dialog:${p.u.key}:${pending.callId}`, kind: "dialog", asker: askerOf(p, paneOf), subject: subjectOf(p.u), since: p.u.since ?? now, ...(item ? { item } : {}) });
	}
	return { entries, live: new Set([...all.filter((p) => !p.u.ended).map((p) => p.u.key), ...(net.head ? [net.head.key] : [])]), place: (session) => ((p) => p && (({ session: _s, ...rest }) => rest)(askerOf(p, paneOf)))(byKey.get(session)) };
}

const whereOf = (a: Asker) => a.device ?? [a.workspaceLabel, a.tabLabel].filter(Boolean).join(" › ");
/** The units a session answers for: itself and its subagents, at any depth. */
function ownKeys(net: Pick<Net, "bases">, session: string): Set<string> {
	const own = new Set([session]);
	for (const p of places(net)) if (p.launcher && own.has(p.launcher.key)) own.add(p.u.key);
	return own;
}
/** `straw-boss:ask-rows:v1` for a session: every open Ask, the oldest first. */
export function rowsFor(open: AskRecord[], net: Pick<Net, "bases"> | undefined, session: string): AskRowV1[] {
	const own = net ? ownKeys(net, session) : new Set([session]);
	return open.map((r) => ({ id: `Q${r.n}`, subject: r.subject, asker: r.asker.name, where: whereOf(r.asker), kind: r.kind, since: r.since, mine: own.has(r.asker.session), ...(r.item ? { item: r.item } : {}) }));
}
/** The page's `asks`: each open Ask with the unit whose plate counts it, its workspace, and the card a wait is. */
export function viewsOf(open: AskRecord[], net: Pick<Net, "bases" | "head">): AskView[] {
	const keys = new Set([...places(net).map((p) => p.u.key), ...(net.head ? [net.head.key] : [])]);
	return open.map((r): AskView => {
		const [, ws, wait] = r.mirror?.startsWith("wait:") ? r.mirror.split(":") : [], tower = ws === HEAD_KEY ? net.head?.key : ws ? net.bases.find((b) => b.id === ws)?.tower?.key : undefined;
		const unit = keys.has(r.asker.session) ? r.asker.session : tower;
		return { id: r.id, n: r.n, kind: r.kind, subject: r.subject, asker: r.asker.name, where: whereOf(r.asker), since: r.since, ...((ws ?? r.asker.workspace) ? { ws: ws ?? r.asker.workspace } : {}), ...(unit ? { unit } : {}), ...(wait ? { wait } : {}), ...(r.asker.pane ? { pane: true as const } : {}), ...(r.item ? { item: r.item } : {}) };
	});
}
/** Writes each unit's count of open Asks (`Unit.asks`, the plate's pill) into the reading the page gets; a tower's too. */
export function countOn(net: Pick<Net, "bases">, views: AskView[]): void {
	const n = new Map<string, number>();
	for (const v of views) if (v.unit) n.set(v.unit, (n.get(v.unit) ?? 0) + 1);
	const put = (u: { key: string; subs: Unit[]; asks?: number }) => { if (n.has(u.key)) u.asks = n.get(u.key); u.subs.forEach(put); };
	for (const b of net.bases) {
		if (b.box) continue;
		if (b.tower) put(b.tower);
		for (const t of b.tabs) t.units.forEach(put);
		b.outside.forEach(put);
	}
}
