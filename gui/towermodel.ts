import type { MemoryProposal, MemorySummary, TowerService } from "../src/net.ts";
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

type Conversation = NonNullable<TowerService["conversation"]>;
const clock = (v: number | string) => new Date(v).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
const minutes = (c: Conversation) => Math.max(1, Math.round(c.idleMs / 60_000));
/** A boss conversation in one phrase for the map, the header and the dossier: that it is the boss's, whether it waits for them, and when their silence ends it. An idle one is not "working". */
export const conversationWord = (c: Conversation, o?: Opts) => (c.closing ? m.conv_state_closing({}, o) : (c.idle ? m.conv_state_waiting : m.conv_state_working)({ minutes: minutes(c) }, o));
/** What the comms' conversation box says of a live conversation, line by line: how it began, what it does now and when it ends, and the hard cap. `why` is the server's own English reason, kept for a tooltip. */
export function conversationFacts(c: Conversation, o?: Opts): { began: string; why?: string; now: string; cap: string } {
	return {
		began: c.resumed ? m.conv_resumed({ turns: c.turns }, o) : c.why ? m.conv_new_why({ why: c.why }, o) : m.conv_new({}, o),
		...(c.why ? { why: c.why } : {}),
		now: c.closing ? m.conv_closing({}, o) : c.idle && c.idleAt ? m.conv_idle_deadline({ time: clock(c.idleAt) }, o) : m.conv_working({ minutes: minutes(c) }, o),
		cap: m.conv_cap({ time: clock(c.capAt) }, o),
	};
}
/** The divider that opens a conversation's run in the log, and how it ended (a time and its note) when it has. */
export function conversationDivider(r: NonNullable<TowerService["localRuns"]>[number], o?: Opts): { title: string; ended?: string } {
	return { title: (r.resumed ? m.conv_divider_resumed : m.conv_divider_new)({ time: clock(r.startedAt) }, o), ...(r.endedAt ? { ended: [m.conv_ended({ time: clock(r.endedAt) }, o), r.note].filter(Boolean).join(" · ") } : {}) };
}
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
		case "running": return service.run?.kind === "ally" ? allyWord(service, o) : service.conversation && mk !== "waiting" ? conversationWord(service.conversation, o) : word(mk); // a question it waits on is the news
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

export type Act = "retry" | "deliver" | "drop" | "answer" | "confirm" | "reject";
/** `proposal`: a memory proposal's id and `rev` the snapshot carried, which its Confirm and Reject buttons name to the memory route. */
export interface Row { id: string; level: "info" | "warning" | "error"; text: string; event?: string; proposal?: string; rev?: number; actions: Act[] }
const START = "A run could not start: ", UNCHECKED = "The tower could not check the standing pane for a program of yours, so it types nothing there; press Retry when it is free", NOTHING_TYPED = "The tower types nothing in the standing pane: ", LATE = "An event was parked after two runs crashed with it: ";
/** A notice the server wrote (English, src/server/runs.ts) in the page's language; one it does not know stays as written. The reasons inside (a path, a Herdr error) are the server's own text. */
function noticeText(n: TowerService["notices"][number], o?: Opts): string {
	if ((n.kind === "settings" || n.kind === "start") && n.text.startsWith(START)) return m.tower_notice_start({ reason: n.text.slice(START.length) }, o);
	if (n.kind === "start" && n.text === UNCHECKED) return m.tower_notice_unchecked({}, o);
	if (n.kind === "start" && n.text.startsWith(NOTHING_TYPED)) return m.tower_notice_nothing_typed({ reason: n.text.slice(NOTHING_TYPED.length) }, o);
	if (n.kind === "loop") return m.tower_notice_loop({}, o);
	if (n.kind === "late" && n.text.startsWith(LATE)) return m.tower_notice_late({ what: n.text.slice(LATE.length) }, o);
	return n.text;
}
/** The service's notices (a refused settings check, a crash loop) and its parked events, each with its buttons. A notice about a parked event is its parked row's, so it is not drawn twice. */
export function noticeRows(service: TowerService | undefined, o?: Opts): Row[] {
	return [
		...(service?.notices ?? []).filter((n) => !n.id.startsWith("parked-")).map((n): Row => ({ id: n.id, level: n.level, text: noticeText(n, o), actions: n.kind === "loop" || (n.kind === "start" && n.id === "start") ? ["retry"] : [] })),
		...(service?.memory?.bossWaits ?? []).map((w): Row => ({ id: `wait-${w.id}`, level: "warning", text: m.tower_waits_for_you({ text: w.text }, o), actions: ["answer"] })),
		...(service?.memory?.proposals ?? []).map((p): Row => ({ id: `proposal-${p.id}`, level: "warning", text: proposalText(p, o), proposal: p.id, rev: service!.memory!.rev, actions: ["confirm", "reject"] })),
		...(service?.memory?.problem ? [{ id: "memory-unreadable", level: "warning" as const, text: service.memory.problem, actions: [] }] : []),
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

// --- the tower's memory panel (src/server/towermemory.ts): the boss's standing instructions and decisions as the boss wrote or confirmed them, and the waits ------------------------------------------------------------

/** An entry as the memory route answers it (`view` in towermemory.ts). */
export interface MemoryEntry { id: string; kind: "standing" | "decision" | "wait"; text: string; by: "boss" | "run"; via: "gui" | "proposal" | "run"; at: string; for?: "boss" | "agent"; on?: string; state?: "open" | "answered" | "resolved" | "expired"; due?: string; answered?: string; outcome?: string; ended?: string }
export interface MemoryView { rev: number; entries: MemoryEntry[]; proposals: (MemoryProposal & { at: string })[] }
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
/** What a run proposes, in the page's language. */
export const proposalText = (p: Pick<MemoryProposal, "op" | "kind" | "text" | "target">, o?: Opts): string => (p.op === "retire" ? m.memory_proposal_retire({ id: p.target ?? "", text: p.text }, o) : (p.kind === "standing" ? m.memory_proposal_add_standing : m.memory_proposal_add_decision)({ text: p.text }, o));
/** The summary line of the closed panel. */
export const memoryChip = (s: MemorySummary, o?: Opts) => (s.proposals.length ? m.memory_counts_pending({ standing: s.standing, decisions: s.decisions, waits: s.waits, proposals: s.proposals.length }, o) : m.memory_counts({ standing: s.standing, decisions: s.decisions, waits: s.waits }, o));
/** Where an entry came from, and for a wait its state: an entry is the boss's words or a proposal the boss confirmed, a wait is the tower's own note. */
export function memoryMeta(e: MemoryEntry, o?: Opts): string {
	const from = e.kind === "wait" ? m.memory_by_run_note({}, o) : e.via === "proposal" ? m.memory_by_proposal({}, o) : m.memory_by_boss({}, o);
	const who = e.kind !== "wait" ? undefined : e.for === "boss" ? m.memory_wait_boss({}, o) : m.memory_wait_agent({ who: e.on ?? "" }, o);
	const state = e.state === "answered" ? m.memory_wait_answered({ who: e.on ?? "" }, o) : e.state === "resolved" ? m.memory_wait_resolved({ outcome: e.outcome ?? "" }, o) : e.state === "expired" ? m.memory_wait_expired({}, o) : undefined;
	return [from, who, state].filter(Boolean).join(" · ");
}
/** What the memory route refused, in the page's language by the reasons it is known to give; the server's own words otherwise. */
export function memoryWhy(r: Pick<Answer, "status" | "body">, o?: Opts): string {
	return r.body.error === "rev" ? m.memory_rev({}, o) : String(r.body.reason ?? r.body.error ?? r.status);
}
