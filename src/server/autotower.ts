import type { Slot } from "./record.ts";
import type { By } from "../autostate.ts";
import type { Decided, Note, Period } from "./automode.ts";
import { type WatchReport, watchLines } from "./autowatch.ts";
import { type Entry, hhmm, readMemory, updateMemory } from "./towermemory.ts";

// What auto mode adds for the towers (docs/specs/2026-11-09-auto-mode.md, §6 and §8): the line of a brief, the waits parked, the message to the raiser of a parked card, the check of a `basis`, and the return list the end of auto
// mode builds from one period. Pure functions over the memory files and the period; the server wires them in towers.ts and automode.ts.

/** The one line every tower and head brief gains while auto mode is on, written by code (§6). */
export const briefLine = (since: string | undefined): string =>
	`Auto mode: on since ${since ? hhmm(since) : "?"} (the boss is away). A wait for the boss you record is parked and raises no alert. Answer a blocked call yourself only from your memory's standing instructions and decisions or a boss event you took; a sender's quote alone is not enough: record the wait and tell the sender with tower_reply to go on without it.`;
/** What the raiser of a parked card is told, once, under the `wait_parked` header (not `wait_card`, which means the boss's answer). */
export const parkedText = (id: string): string => `Wait ${id} is parked: the boss is away (auto mode). Do not wait on it; its answer comes as a wait_card message when they are back.`;

/** A tower's workspace as the memory files know it (the head's is its own workspace, bound to its folder). */
export interface Target { workspace: string; label: string; /** The head tower's own memory (its wait ids are counted apart from the towers'). */ head?: true }
export interface ParkedRow { workspace: string; /** Set for the head's rows: a wait id alone does not tell the head's W1 from a tower's. */ head?: true; tower: string; id: string; text: string; type: string; from?: string; at: string }

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
		return problem ? [] : memory.entries.filter((e) => waitsForBoss(e) && e.parked).map((e) => ({ workspace: t.workspace, ...(t.head ? { head: true as const } : {}), tower: t.label, id: e.id, text: e.text.slice(0, 160), type: e.card?.type ?? "legacy", ...(e.card?.from ? { from: e.card.from.name } : {}), at: e.at }));
	});
}
/** The period is over: a parked flag lived for it only, so the cards are ordinary open waits again. A wait the return list showed keeps `listed`: the panel is its one notice, so it raises no alert, sound or count again (boss decision 11-10); it stays on its card. */
export function unpark(slot: Slot, now: number, targets: Target[]): void {
	for (const t of targets) {
		const probe = readMemory(slot, t.workspace, now);
		if (probe.problem || !probe.memory.entries.some((e) => e.parked)) continue;
		updateMemory(slot, t.workspace, now, (m) => void m.entries.forEach((e) => { if (e.parked && waitsForBoss(e)) e.listed = true; delete e.parked; delete e.parkedTold; }));
	}
}

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
/** The one event the head tower gets when auto mode ends (§8, 4). */
export const endEvent = (r: Report): string => {
	const s = summaryOf(r);
	return `Auto mode ended at ${hhmm(r.until)} (${r.off}): ${s.parked} parked waits on ${s.towers} towers, ${s.cancels} cancels or refusals.`;
};
/** What `/boss auto off` prints (§8, 2): the parked waits by `W<n>` first, the rest folded by session. */
export function reportText(r: Report): string {
	const s = summaryOf(r);
	const out = [`Auto mode ended at ${hhmm(r.until)} (${r.off}); it ran from ${hhmm(r.since)} (${r.on}).`];
	if (r.parked.length) out.push(`Parked waits (${r.parked.length}); /boss wait (or /boss memory done|choose|decline W<n>) acts on one:`, ...r.parked.map((p) => `- ${p.id} (${p.tower}, ${p.type}${p.from ? `, from ${p.from}` : ""}): ${p.text}`));
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
