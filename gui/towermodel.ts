import type { MemorySummary, TowerService } from "../src/net.ts";
import type { Mark } from "../src/netdata.ts";
import { m } from "./paraglide/messages.js";
import type { Answer } from "./post.ts";

// What the page says about the sb server's tower service (src/server/runs.ts `ServiceStatus`, carried on the tower unit as `service`), as plain functions of the reading: the state's word, the last run,
// the queue, the notices in the page's language, the turns of a run that the server wrote, and the buttons that answer. No DOM here, so tests drive it.

type Opts = { locale?: "en" | "zh-TW" };
/** The mark's own word (render.ts `LABEL`). */
export type Word = (mk: Mark) => string;

/** The ally runs of a service as one phrase: the device of the one, else how many. */
export const allyWord = (service: TowerService, o?: Opts) => (service.allyRuns.length === 1 ? m.tower_state_ally({ device: service.allyRuns[0]!.label }, o) : service.allyRuns.length > 1 ? m.ally_runs({ count: service.allyRuns.length }, o) : m.role_ally({}, o));

/**
 * The one word for the tower's state, on the map, in the dossier and in the comms. A tower the server runs says what the service is doing; one that stands by with nobody working says so instead
 * of "idle". Without a service (a resident tower) it is the mark's word.
 */
export function towerWord(service: TowerService | undefined, mk: Mark, word: Word, o?: Opts): string {
	if (!service) return word(mk);
	switch (service.state) {
		case "held": return m.tower_state_held({}, o);
		case "waking": return m.tower_state_waking({}, o);
		case "closing": return m.tower_state_closing({}, o);
		case "running": return service.run?.kind === "ally" ? allyWord(service, o) : word(mk);
		case "standing": return mk !== "idle" ? word(mk) : service.allyRuns.length ? allyWord(service, o) : m.mark_standing({}, o); // an ally run is working: not "standing by"
	}
}

const LAST: Record<string, (o?: Opts) => string> = { crashed: (o) => m.tower_last_crashed({}, o), timeout: (o) => m.tower_last_timeout({}, o), quit: (o) => m.tower_last_quit({}, o) };
/** How the last run ended when it did not end well or was quit, with the runs that failed lately; nothing while a run is under way (it is the news) or when the last one finished. */
export function lastLine(service: TowerService | undefined, o?: Opts): string | undefined {
	if (!service || service.run) return undefined;
	const how = Object.hasOwn(LAST, service.lastRun?.outcome ?? "") ? LAST[service.lastRun!.outcome]!(o) : undefined;
	return how && [how, service.crashes ? m.tower_failures({ count: service.crashes }, o) : ""].filter(Boolean).join(" · ");
}
/** The state's word and the last run, as one line. */
export const statusLine = (service: TowerService | undefined, mk: Mark, word: Word, o?: Opts) => [towerWord(service, mk, word, o), lastLine(service, o)].filter(Boolean).join(" · ");
/** The count of messages the service holds for the next run. */
export const queueChip = (service: TowerService | undefined, o?: Opts): string | undefined => (service?.queued ? m.tower_queued({ count: service.queued }, o) : undefined);

export type Act = "retry" | "deliver" | "drop" | "answer";
export interface Row { id: string; level: "info" | "warning" | "error"; text: string; event?: string; actions: Act[] }
const START = "A run could not start: ", LATE = "An event was parked after two runs crashed with it: ";
/** A notice the server wrote (English, src/server/runs.ts) in the page's language; one it does not know stays as written. The reasons inside (a path, a Herdr error) are the server's own text. */
function noticeText(n: TowerService["notices"][number], o?: Opts): string {
	if ((n.kind === "settings" || n.kind === "start") && n.text.startsWith(START)) return m.tower_notice_start({ reason: n.text.slice(START.length) }, o);
	if (n.kind === "loop") return m.tower_notice_loop({}, o);
	if (n.kind === "late" && n.text.startsWith(LATE)) return m.tower_notice_late({ what: n.text.slice(LATE.length) }, o);
	return n.text;
}
/** The service's notices (a refused settings check, a crash loop) and its parked events, each with its buttons. A notice about a parked event is its parked row's, so it is not drawn twice. */
export function noticeRows(service: TowerService | undefined, o?: Opts): Row[] {
	return [
		...(service?.notices ?? []).filter((n) => !n.id.startsWith("parked-")).map((n): Row => ({ id: n.id, level: n.level, text: noticeText(n, o), actions: n.kind === "loop" ? ["retry"] : [] })),
		...(service?.memory?.bossWaits ?? []).map((w): Row => ({ id: `wait-${w.id}`, level: "warning", text: m.tower_waits_for_you({ text: w.text }, o), actions: ["answer"] })),
		...(service?.parked ?? []).map((p): Row => ({ id: `parked-${p.id}`, level: "warning", text: p.from ? m.tower_parked({ kind: p.kind, from: p.from, first: p.first }, o) : m.tower_parked_anon({ kind: p.kind, first: p.first }, o), event: p.id, actions: ["deliver", "drop"] })),
	];
}

/** What the tower service refused to a button, in the page's language, by the reasons it is known to give; undefined for any other (the server's own words stay). */
export function actionWhy(r: Pick<Answer, "status" | "body">, o?: Opts): string | undefined {
	if (r.status < 400) return undefined;
	if (r.body.reason === "No such parked event") return m.tower_err_no_event({}, o);
	if (r.body.reason?.startsWith("The sb server stands in for no tower")) return m.tower_err_no_tower({}, o);
}

/**
 * A button that asks the server: it is off and says "Working…" until the answer, then comes back (a row that stays can be pressed again once `holdMs` has passed), and a refusal or a lost request is
 * said through `note` where the user can see it, not in a tooltip.
 */
export async function guarded(button: { disabled: boolean; textContent: string | null }, note: (text?: string) => void, run: () => Promise<Pick<Answer, "ok" | "status" | "body">>, holdMs = 1200): Promise<void> {
	const label = button.textContent;
	(button.disabled = true), (button.textContent = m.tower_working()), note(undefined);
	try {
		const r = await run();
		if (!r.ok) note(m.tower_action_failed({ reason: actionWhy(r) ?? r.body.reason ?? r.body.error ?? String(r.status) }));
		else if (holdMs) await new Promise((done) => setTimeout(done, holdMs));
	} catch {
		note(m.tower_action_failed({ reason: m.unreachable() }));
	} finally {
		(button.disabled = false), (button.textContent = label);
	}
}

// --- the tower's memory panel (src/server/towermemory.ts): the boss's standing instructions and decisions, verbatim, and the waits ------------------------------------------------------------

/** An entry as the memory route answers it (`view` in towermemory.ts). */
export interface MemoryEntry { id: string; kind: "standing" | "decision" | "wait"; text: string; by: "boss" | "run"; via: "gui" | "prompt" | "run"; at: string; for?: "boss" | "agent"; on?: string; state?: "open" | "answered" | "resolved" | "expired"; due?: string; answered?: string; outcome?: string; ended?: string }
export interface MemoryView { rev: number; entries: MemoryEntry[]; notices: { id: string; text: string; at: string }[] }
/** The caps the server holds to (towermemory.ts MEM), shown beside the inputs. */
export const MEMORY_CAP = { standing: 12, decision: 24 } as const;
/** The memory in its three lists: standing in the order kept, decisions newest first, waits with the live ones before the ended. */
export function memoryGroups(entries: MemoryEntry[]) {
	const ended = (e: MemoryEntry) => e.state === "resolved" || e.state === "expired";
	return {
		standing: entries.filter((e) => e.kind === "standing"),
		decisions: entries.filter((e) => e.kind === "decision").reverse(),
		waits: entries.filter((e) => e.kind === "wait").sort((a, b) => Number(ended(a)) - Number(ended(b))),
	};
}
/** The summary line of the closed panel. */
export const memoryChip = (s: MemorySummary, o?: Opts) => m.memory_counts({ standing: s.standing, decisions: s.decisions, waits: s.waits }, o);
/** Where an entry came from, and for a wait its state: a run's entry is a quote of the boss's words, a wait is the tower's own note. */
export function memoryMeta(e: MemoryEntry, o?: Opts): string {
	const from = e.kind === "wait" ? m.memory_by_run_note({}, o) : e.by === "run" ? m.memory_by_run({}, o) : m.memory_by_boss({}, o);
	const who = e.kind !== "wait" ? undefined : e.for === "boss" ? m.memory_wait_boss({}, o) : m.memory_wait_agent({ who: e.on ?? "" }, o);
	const state = e.state === "answered" ? m.memory_wait_answered({ who: e.on ?? "" }, o) : e.state === "resolved" ? m.memory_wait_resolved({ outcome: e.outcome ?? "" }, o) : e.state === "expired" ? m.memory_wait_expired({}, o) : undefined;
	return [from, who, state].filter(Boolean).join(" · ");
}
/** What the memory route refused, in the page's language by the reasons it is known to give; the server's own words otherwise. */
export function memoryWhy(r: Pick<Answer, "status" | "body">, o?: Opts): string {
	return r.body.error === "rev" ? m.memory_rev({}, o) : String(r.body.reason ?? r.body.error ?? r.status);
}
