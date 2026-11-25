import type { Slot } from "./record.ts";
import type { By } from "../autostate.ts";
import type { Decided, Note, Period } from "./automode.ts";
import { type WatchReport, watchLines } from "./autowatch.ts";
import { cut, type Entry, hhmm, iso, MEM, readMemory, updateMemory } from "./towermemory.ts";

// What auto mode adds for the towers (docs/specs/2026-11-09-auto-mode.md, §6 and §8): the line of a brief, the waits parked, the message to the raiser of a parked card, the check of a `basis`, and the return list the end of auto
// mode builds from one period. When the period ends, every parked card goes back to whoever raised it, to ask the boss again directly, and is closed (docs/specs/2026-11-21-auto-return.md, AR-D3, AR-D4). Pure functions over the
// memory files and the period; the server wires them in towers.ts and automode.ts.

/** The one line every tower and head brief gains while auto mode is on, written by code (§6). */
export const briefLine = (since: string | undefined): string =>
	`Auto mode: on since ${since ? hhmm(since) : "?"} (the boss is away). A wait for the boss you record is parked and raises no alert. Answer a blocked call yourself only from your memory's standing instructions and decisions or a boss event you took; a sender's quote alone is not enough: record the wait and tell the sender with tower_reply to go on without it.`;
/** What the raiser of a parked card is told, once, under the `wait_parked` header (not `wait_card`, which means the boss's answer). */
export const parkedText = (id: string): string => `Wait ${id} is parked: the boss is away (auto mode). Do not wait on it; when they are back it comes back to you as a wait_returned message, and you ask them again yourself then.`;

/** A tower's workspace as the memory files know it (the head's is its own workspace, bound to its folder). */
export interface Target { workspace: string; label: string; /** The head tower's own memory (its wait ids are counted apart from the towers'). */ head?: true }
/**
 * Where a parked card went when auto mode ended (AR-D3, AR-D4): `raiser`, a message to the session that raised it; `tower`, an event of the tower that holds it (its own card, or the head's own); `gone`, nobody could take it (the raiser
 * left, the message did not go through, the tower is not served), so it is closed with nothing left for the boss.
 */
export type Returned = "raiser" | "tower" | "gone";
export interface ParkedRow { workspace: string; /** Set for the head's rows: a wait id alone does not tell the head's W1 from a tower's. */ head?: true; tower: string; id: string; text: string; type: string; from?: string; at: string; /** Absent in a list written before AR-D3. */ returned?: Returned }

const waitsForBoss = (e: Entry) => e.kind === "wait" && e.for === "boss" && (e.state === "open" || e.state === "answered");

/** Parks every open boss wait that is not parked yet (auto mode just turned on); returns the ones newly parked, with the raiser that must be told once (`parkedTold` is set in the same write, so a restart never tells twice). */
export function parkOpen(slot: Slot, now: number, targets: Target[]): { target: Target; entry: Entry }[] {
	const out: { target: Target; entry: Entry }[] = [];
	for (const target of targets) {
		const probe = readMemory(slot, target.workspace, now);
		if (probe.problem || !probe.memory.entries.some((e) => waitsForBoss(e) && !e.parked)) continue;
		const { value } = updateMemory(slot, target.workspace, now, (m) => m.entries.filter((e) => waitsForBoss(e) && !e.parked).map((e) => (Object.assign(e, { parked: true, ...(e.card?.from && !e.card.from.gone ? { parkedTold: true } : {}) }), { ...e })));
		out.push(...value.map((entry) => ({ target, entry })));
	}
	return out;
}
/** The parked waits that are still open, for the return list. */
export function parkedRows(slot: Slot, now: number, targets: Target[]): ParkedRow[] {
	return targets.flatMap((t) => {
		const { memory, problem } = readMemory(slot, t.workspace, now);
		return problem ? [] : memory.entries.filter((e) => waitsForBoss(e) && e.parked).map((e) => rowOf(t, e));
	});
}
const rowOf = (t: Target, e: Entry, returned?: Returned): ParkedRow => ({ workspace: t.workspace, ...(t.head ? { head: true as const } : {}), tower: t.label, id: e.id, text: e.text.slice(0, 160), type: e.card?.type ?? "legacy", ...(e.card?.from ? { from: e.card.from.name } : {}), at: e.at, ...(returned ? { returned } : {}) });

// --- the end of the period: the parked cards go back (AR-D3, AR-D4) -------------------------------------------------------------------------------------------------------

/** What the raiser of a parked card is told when auto mode ends, under the `wait_returned` header: the boss is back, so it asks them again itself; sb closed the card, and no `wait_card` answer comes. */
export function returnedText(id: string, what: string, at: string, role: string | undefined): string {
	const again = role === "tower" ? "record it again with tower_memory as a wait for the boss, or ask as you asked before" : "ask them again now with call_tower why: blocked and boss";
	return `Wait ${id} (${what}) comes back to you: auto mode ended at ${hhmm(at)} and the boss is back. sb closed the card instead of keeping it for them, so no wait_card answer will come for it. If you still need it, ${again}.`;
}
/** The event of a tower (the head included) whose own parked card comes back: it records the wait again if it still needs the boss. */
export const ownReturnedText = (id: string, what: string, at: string): string =>
	`Your wait ${id} (${what}) was parked while the boss was away. Auto mode ended at ${hhmm(at)} and the boss is back; sb closed the card instead of keeping it for them. If it still needs the boss, record it again with tower_memory (add kind wait): it reaches them now as a new card.`;
/** The outcome a returned card keeps for its 24 h (`MEM.outcome`, 120 characters, cut by the caller). */
export const returnedOutcome = (to: Returned, name: string | undefined, why?: string): string =>
	to === "raiser" ? `returned to ${name ?? "the raiser"} to ask the boss again (auto mode ended)` : to === "tower" ? "returned to the tower to ask again (auto mode ended)" : `closed: ${name ?? "the raiser"} ${why ?? "was gone"} when auto mode ended`;

/** One parked card that goes back, as `returnParked` decided its way. */
export interface Back { target: Target; entry: Entry; to: Returned }
/** A parked card that still waits for the boss: open, never pressed. One the boss answered while away (a press, or a reply in its box) is the tower's to resolve: it only loses the flag. */
const goesBack = (e: Entry) => Boolean(e.parked) && e.kind === "wait" && e.for === "boss" && e.state === "open" && !e.press;
/**
 * The period is over: every parked card that still waits (`goesBack`) is resolved at once, so nobody presses it for the boss any more, with the outcome of where it goes: `route` names the way (it queues the tower's event itself,
 * synchronously, and says `gone` when it could not). The flag on any other entry is dropped; an answered boss wait keeps `listed`, as before, so it raises no alert again. The messages to raisers are the caller's, after this
 * write; one that fails is `closeGone`.
 */
export function returnParked(slot: Slot, now: number, targets: Target[], route: (target: Target, entry: Entry) => Returned): Back[] {
	const out: Back[] = [];
	for (const target of targets) {
		const probe = readMemory(slot, target.workspace, now);
		if (probe.problem || !probe.memory.entries.some((e) => e.parked)) continue;
		const ways = new Map(probe.memory.entries.filter(goesBack).map((e) => [e.id, route(target, e)] as const));
		const { value } = updateMemory(slot, target.workspace, now, (m) => m.entries.flatMap((e) => {
			const to = goesBack(e) ? ways.get(e.id) : undefined;
			if (!to && e.parked && waitsForBoss(e)) e.listed = true;
			delete e.parked;
			delete e.parkedTold;
			if (!to) return [];
			Object.assign(e, { state: "resolved", ended: iso(now), outcome: cut(returnedOutcome(to, e.card?.from?.name, e.card?.from?.gone ? "had left" : undefined), MEM.outcome), returned: to });
			delete e.shown;
			return [{ target, entry: { ...e }, to }];
		}));
		out.push(...value);
	}
	return out;
}
/** A raiser that could not be told (`why`: gone, or not reached): its returned card is closed as such (AR-D4). */
export function closeGone(slot: Slot, now: number, workspace: string, id: string, why: string): void {
	updateMemory(slot, workspace, now, (m) => {
		const e = m.entries.find((x) => x.id === id && x.returned === "raiser");
		if (e) Object.assign(e, { returned: "gone", outcome: cut(returnedOutcome("gone", e.card?.from?.name, why), MEM.outcome) });
	});
}
/** The rows of the return list for the cards that went back. */
export const backRows = (back: Back[]): ParkedRow[] => back.map((b) => rowOf(b.target, b.entry, b.to));

/** `basis` of a reply that decides a blocked call (§6): a standing instruction or decision of the memory, or a boss event of the run that is no press. Anything else is `none`. */
export function basisOf(basis: unknown, memory: { entries: Entry[] }, events: { id: string; press?: true }[]): string {
	if (typeof basis !== "string") return "none";
	const id = basis.trim();
	if (/^[SD]\d+$/.test(id)) return memory.entries.some((e) => e.id === id && (e.kind === "standing" || e.kind === "decision")) ? id : "none";
	return events.some((e) => e.id === id && !e.press) ? id : "none";
}

// --- the return list -----------------------------------------------------------------------------------------------------------------------------------------------

export interface Line { session: string; tool: string; kind: Note["kind"]; count: number; first: string; gist: string }
/** An ask a controlled box forwarded and auto mode left waiting (D6). */
export interface BoxAsk { box: string; gist: string }
export interface Report {
	v: 1;
	since: string;
	until: string;
	on: string;
	off: string;
	parked: ParkedRow[];
	lines: Line[];
	decided: Decided[];
	stillWaiting: Line[];
	boxes: BoxAsk[];
	foreign: { at: string; why: string }[];
	/** What the head tower's watch saw and did (autowatch.ts); absent when it never came due, and in a list written before it existed. */
	watch?: WatchReport;
}
const who = (by: By) => `${by.via}: ${by.name}`;
const group = (notes: Note[]): Line[] => {
	const lines = new Map<string, Line>();
	for (const n of notes) {
		const key = `${n.session}\u0000${n.tool}\u0000${n.kind}`, had = lines.get(key);
		if (had) had.count++;
		else lines.set(key, { session: n.session, tool: n.tool, kind: n.kind, count: 1, first: n.at, gist: n.gist });
	}
	return [...lines.values()];
};
export function buildReport(p: Period, on: By, off: By, until: string, parked: ParkedRow[], boxes: BoxAsk[] = [], watch?: WatchReport): Report {
	return {
		v: 1, since: p.since, until, on: who(on), off: who(off), parked, lines: group(p.notes.filter((n) => n.kind !== "still-waiting")), decided: p.decided,
		stillWaiting: group(p.notes.filter((n) => n.kind === "still-waiting")), boxes, foreign: p.foreign, ...(watch ? { watch } : {}),
	};
}
/** What a person did not choose: the cancels and refusals of the period (the count of the head's event). */
const cancelled = (r: Report) => r.lines.filter((l) => l.kind !== "re-asked").reduce((n, l) => n + l.count, 0);
export const summaryOf = (r: Report) => ({ parked: r.parked.length, towers: new Set(r.parked.map((p) => p.workspace)).size, cancels: cancelled(r), decided: r.decided.length, stillWaiting: r.stillWaiting.length, boxes: r.boxes.length, foreign: r.foreign.length });
/** The one event the head tower gets when auto mode ends (§8, 4): the parked waits went back to their raisers (AR-D3), so there is nothing of them for the head to present. */
export const endEvent = (r: Report): string => {
	const s = summaryOf(r);
	return `Auto mode ended at ${hhmm(r.until)} (${r.off}): ${s.parked} parked waits on ${s.towers} towers went back to whoever raised them, to ask the boss again; ${s.cancels} cancels or refusals.`;
};
/** Where a returned row went, as the printed list says it. */
const wentTo = (p: ParkedRow) => (p.returned === "tower" ? "back to the tower" : p.returned === "gone" ? `closed: ${p.from ?? "the raiser"} is gone` : `back to ${p.from ?? "the raiser"}`);
/** What `/boss auto off` prints (§8, 2): the parked waits by `W<n>` first, with where each went (AR-D3), the rest folded by session. */
export function reportText(r: Report): string {
	const s = summaryOf(r);
	const out = [`Auto mode ended at ${hhmm(r.until)} (${r.off}); it ran from ${hhmm(r.since)} (${r.on}).`];
	// AR-D3: the parked cards are not answered here; each went back to whoever raised it, who asks the boss again directly.
	if (r.parked.length) out.push(`Parked waits (${r.parked.length}) went back to whoever raised them, to ask you again directly; sb closed the cards:`, ...r.parked.map((p) => `- ${p.id} (${p.tower}, ${p.type}${p.from ? `, from ${p.from}` : ""}): ${p.text} → ${wentTo(p)}`));
	else out.push("No wait was parked.");
	const bySession = Object.groupBy(r.lines, (l) => l.session || "(unknown)");
	if (r.lines.length) out.push(`Cancelled or refused (${s.cancels}):`, ...Object.entries(bySession).map(([session, lines]) => `- ${session}: ${lines!.map((l) => `${l.tool} ${l.kind}${l.count > 1 ? ` ×${l.count}` : ""}${l.gist ? ` "${l.gist}"` : ""} (from ${hhmm(l.first)})`).join("; ")}`));
	if (r.decided.length) out.push(`A tower answered a blocked call itself (${r.decided.length}):`, ...r.decided.map((d) => `- ${hhmm(d.at)} to ${d.to}, basis ${d.basis}: ${d.gist}`));
	if (r.stillWaiting.length) out.push(`Still waiting (no cancel: answer or close them):`, ...r.stillWaiting.map((l) => `- ${l.session}: ${l.tool}${l.gist ? ` "${l.gist}"` : ""}`));
	if (r.boxes.length) out.push("Asks of the boxes you control, left waiting:", ...r.boxes.map((b) => `- ${b.box}: ${b.gist}`));
	else out.push("Asks of the boxes you control: not collected in this version; look at the page's waiting dialogs.");
	if (r.foreign.length) out.push(`${r.foreign.length} foreign or unreadable write${r.foreign.length > 1 ? "s" : ""} to the state file were put back.`);
	if (r.watch) out.push(...watchLines(r.watch));
	return out.join("\n");
}
