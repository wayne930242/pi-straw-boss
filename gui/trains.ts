import type { Net } from "../src/net.ts";
import type { CarFact } from "../src/train/carfacts.ts";
import type { CarState } from "../src/train/cars.ts";
import { shortCode } from "../src/train/spec.ts";
import type { Wait } from "../src/train/waits.ts";
import type { NetLoad, ProjectYard, ReasonKind, YardCar, YardFormingRow, YardStep, YardTrainRow } from "../src/train/yardview.ts";
import { m } from "./sentences.ts";
import { unitsOf } from "./units.ts";

// The page's model of the yards (docs/specs/2026-11-07-train-workers.md §11.2): what the net's `yards` and `load` say, put into the counts, chips, wait words and rows the yard draws (yard.ts), the base header's chip, a train's
// unit card, and Zen's strip. Pure: no DOM, no clock of its own. Every string it gets from a yard is a model's own text; it passes through as text and is never read as markup, a link or a route.

export interface Ctx { now: number; load?: NetLoad }
export interface Counts { trains: number; running: number; waiting: number; mutual: number; stale: number; forming: number; departing: number; refused: number; ended: number; unreadable: number }
export type StepState = "pending" | "running" | "waiting" | "passed" | "failed" | "void";
export type TrainStatus = "running" | "waiting" | "stale" | "ended" | "unreadable";
export interface PillView { id: number; text: string; title: string; state: StepState; round: number; current: boolean }
/** A car's notice line: `detail` is the broker's last answer (text on the card), `title` the reader's own words for a reason the page says in a sentence of its own. */
export interface NoticeView { text: string; detail?: string; title?: string; tone: "told" | "pending" | "escalated" | "unreadable" }
/** `accepted.nods`: the boss's words for each kind (or that none is on file), lines the page shows under the chip. */
export interface CarView { tickets: string; accepted: { text: string; nods: string[] }; conditions: string[]; notice?: NoticeView }
export interface TrainView {
	short: string; app: string; status: TrainStatus; key?: string; route?: { ws: string; key: string }; reason?: string; reasonTitle?: string; round: string; tickets: string[]; pills: PillView[]; wait: string; need: string;
	/** A unit card's note line: the step in progress and what it waits for. */
	note?: string; cars: CarView[]; cut?: string; removed: string[];
	/** Whether sb has told the coordinator of each car the round left out: a round that waits on a notice shows it (TB-F004). */
	removedNotices: NoticeView[];
}
export interface FormingView { short: string; app: string; status: YardFormingRow["status"]; word: string; condition?: string; cars: CarView[] }
export interface ProjectView {
	project: string; title: string; counts: Counts; head: string; load: string; integrator?: { text: string; route?: { ws: string; key: string } }; forming: FormingView[]; trains: TrainView[]; ended: TrainView[];
	/** The counts of the trains that are not live (stalled, forming, departing, refused, unreadable), when there are any: said beside `head`. */
	others: string; problem?: string; problemTitle?: string; empty: boolean;
}
/** Where a unit of the net is: its base and key, for a link to its comms. */
export type Locate = (key: string | undefined) => { ws: string; key: string } | undefined;

const MIN = 60_000;
const short = (code: string) => { try { return shortCode(code); } catch { return code; } };
const list = (items: string[]) => items.join(m.yard_sep_list());
const KIND: Record<YardStep["kind"], () => string> = {
	assemble: m.yard_kind_assemble, review: m.yard_kind_review, "full-check": m.yard_kind_full_check, merge: m.yard_kind_merge, ci: m.yard_kind_ci, deploy: m.yard_kind_deploy,
	"deploy-verify": m.yard_kind_deploy_verify, rollback: m.yard_kind_rollback, land: m.yard_kind_land,
};
const STATE: Record<StepState, () => string> = { pending: m.yard_s_pending, running: m.yard_s_running, waiting: m.yard_s_waiting, passed: m.yard_s_passed, failed: m.yard_s_failed, void: m.yard_s_superseded };
const CAR: Record<CarState, () => string> = { received: m.yard_car_received, returned: m.yard_car_returned, dropped: m.yard_car_dropped, landed: m.yard_car_landed };

/** A step's state for its colour: a step in progress that waits for anything is waiting; a completed one is coloured by its outcome. */
export const stepState = (s: YardStep): StepState => (s.status === "pending" ? "pending" : s.status === "in_progress" ? (s.waits.length ? "waiting" : "running") : s.outcome === "failed" ? "failed" : s.outcome === "void" ? "void" : "passed");
const stateWord = (s: YardStep) => (stepState(s) === "void" && s.why === "skipped" ? m.yard_s_skipped() : STATE[stepState(s)]());

/** A name that a line may not break inside: a word joiner after each hyphen (a phone's narrow note breaks after a hyphen otherwise). */
const glue = (name: string) => name.replace(/-/g, "-\u2060");
/** A wait in words (§7.3). A holder is named by its short code; a holder that is stalled or whose board cannot be read says so. */
export function waitWords(w: Wait): string {
	if ("load" in w) return m.yard_wait_load({ max: w.load.max, now: w.load.now });
	if ("lock" in w) return w.lock.holder ? m.yard_wait_lock_held({ name: w.lock.name, holder: short(w.lock.holder.train) }) : m.yard_wait_lock({ name: w.lock.name });
	const [base, why] = "lane" in w ? [m.yard_wait_lane({ holder: short(w.lane.holder), app: glue(w.lane.app) }), w.lane.why] : [m.yard_wait_target({ holder: short(w.target.holder), target: glue(w.target.target) }), w.target.why];
	return why === "stale" ? m.yard_wait_stale({ wait: base }) : why === "unreadable" ? m.yard_wait_unreadable({ wait: base }) : base;
}

/** The CPU a step needs: its load limit (a per-core factor is made a number with the cores, when known) and the cores it expects to use. Empty without either. */
export function needWords(load: YardStep["load"], cores?: number): string {
	if (!load) return "";
	const num = (n: number) => Math.round(n * 10) / 10;
	const parts = [
		load.max !== undefined ? m.yard_need_limit({ max: num(load.max) }) : load.perCore !== undefined ? (cores ? m.yard_need_limit({ max: num(load.perCore * cores) }) : m.yard_need_percore({ perCore: num(load.perCore) })) : "",
		load.weight !== undefined ? m.yard_need_weight({ weight: num(load.weight) }) : "",
	].filter(Boolean);
	return parts.join(m.yard_sep_comma());
}

/** 「第 2 次組裝：移除 T-12（unit 紅）」: the round, and the cars it left out with why when the board says. */
export function roundWords(row: Pick<YardTrainRow, "round" | "removed">): string {
	const round = row.round ?? 1;
	return row.removed?.length ? m.yard_round_removed({ round, cars: list(row.removed.map((r) => m.yard_removed_one({ ticket: r.ticket, why: r.why }))) }) : m.yard_round({ round });
}

const WHY: Record<ReasonKind, () => string> = {
	toobig: m.yard_why_toobig, budget: m.yard_why_budget, notfile: m.yard_why_notfile, notjson: m.yard_why_notjson, io: m.yard_why_io, misplaced: m.yard_why_misplaced, shape: m.yard_why_shape, failed: m.yard_why_failed,
};
/** A reason the server gave: a kind the page knows is a sentence of its own in the page's language and the reader's English is its tooltip; text with no known kind shows as text only. */
const reasonOf = (reason: string, kind: string | undefined): { said: string; title?: string } => (kind !== undefined && Object.hasOwn(WHY, kind) ? { said: WHY[kind as ReasonKind](), title: reason } : { said: reason });

const kindName = (kind: string) => (kind.toLowerCase() === "uat" ? "UAT" : kind);
/** A car's acceptance as a chip: the kinds in its text, and under it the boss's words for each kind (or that none is on file) as lines of the page: a tap or a key reaches them, a tooltip is for the pointer only. */
export function acceptedChip(car: Pick<YardCar, "accepted" | "unverified">): { text: string; nods: string[] } {
	if (car.unverified) return { text: m.yard_accepted_unknown(), nods: [] };
	if (!car.accepted.length) return { text: m.yard_accepted_none(), nods: [] };
	const kinds = car.accepted.map((a) => ({ kind: kindName(a.kind), nod: a.nod }));
	return { text: m.yard_accepted({ kinds: list(kinds.map((k) => k.kind)) }), nods: kinds.map((k) => (k.nod ? m.yard_nod({ kind: k.kind, nod: k.nod }) : m.yard_nod_none({ kind: k.kind }))) };
}

const clock = (iso: string) => {
	const at = Date.parse(iso);
	return Number.isFinite(at) ? new Date(at).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) : iso;
};
/** A car's departure conditions, one line per clause of its slip's `departs` (alone, with, after, by); the default `next` says nothing, a clause it does not know shows as written. */
export function conditionLines(car: Pick<YardCar, "tickets" | "departs">): string[] {
	const ticket = list(car.tickets);
	return car.departs.split(",").map((c) => c.trim()).filter(Boolean).flatMap((clause): string[] => {
		const [, word = "", rest = ""] = /^(\w+)\s*(.*)$/.exec(clause) ?? [];
		const w = word.toLowerCase();
		if (w === "next" && !rest) return [];
		if (w === "alone" && !rest) return [m.yard_car_alone({ ticket })];
		if (w === "with" && rest) return [m.yard_car_with({ ticket, other: rest })];
		if (w === "after" && rest) return [m.yard_car_after({ ticket, time: clock(rest) })];
		if (w === "by" && rest) return [m.yard_car_by({ ticket, time: clock(rest) })];
		return [clause];
	});
}

/** When a forming train leaves: 「滿 4 節或 60 分（還 23 分）」. None without its departure line. */
export function formingWords(row: Pick<YardFormingRow, "departs">, now: number): string | undefined {
	const d = row.departs;
	if (!d) return undefined;
	const since = Date.parse(d.oldest), left = Math.ceil(d.maxWaitMin - (Number.isFinite(since) ? now - since : 0) / MIN);
	return left > 0 ? m.yard_depart_full({ maxCars: d.maxCars, maxWaitMin: d.maxWaitMin, left }) : m.yard_depart_due({ maxCars: d.maxCars, maxWaitMin: d.maxWaitMin });
}

/** Whether sb has told a car's coordinator of its newest state: told, still telling (with the try), reported up, or a record that cannot be read. None where no notice is on file. */
export function noticeLine(car: Pick<YardCar, "tickets" | "notice">): NoticeView | undefined {
	const n = car.notice, ticket = list(car.tickets);
	if (!n) return undefined;
	if (n.status === "unreadable") {
		const why = reasonOf(n.reason, n.kind);
		return { text: m.yard_notice_unreadable({ ticket, reason: why.said }), tone: "unreadable", ...(why.title ? { title: why.title } : {}) };
	}
	const state = CAR[n.state](), from = (text: string) => (n.journal ? m.yard_notice_from_file({ text }) : text);
	if (n.status === "delivered") return { text: from(m.yard_notice_delivered({ ticket, state })), tone: "told" };
	if (n.status === "escalated") return { text: from(m.yard_notice_escalated({ ticket })), tone: "escalated" };
	return { text: from(n.attempts > 0 ? m.yard_notice_pending({ ticket, state, attempts: n.attempts }) : m.yard_notice_pending_first({ ticket, state })), tone: "pending", ...(n.last ? { detail: m.yard_notice_last({ answer: n.last }) } : {}) };
}

/** A car as a line; its departure conditions only for a car still waiting to leave (`leaving`): once the train runs they are moot, and a line that says a car waits for another reads as if it still did. */
const carView = (car: YardCar, leaving: boolean): CarView => {
	const notice = noticeLine(car);
	return { tickets: list(car.tickets), accepted: acceptedChip(car), conditions: leaving ? conditionLines(car) : [], ...(notice ? { notice } : {}) };
};

const pillText = (s: YardStep) => (!s.name || s.name === s.kind || s.name === KIND[s.kind]() ? KIND[s.kind]() : m.yard_step_named({ kind: KIND[s.kind](), name: s.name }));
const going = (row: Pick<YardTrainRow, "steps">) => row.steps.filter((s) => s.status === "in_progress").sort((a, b) => a.id - b.id);

/** One train as a row: its short code, round, steps as pills, the wait of its steps in progress, the load it needs, and its cars. A board that cannot be read shows its reason and nothing else of the train. */
export function trainView(row: YardTrainRow, ctx: Ctx, locate: Locate = () => undefined): TrainView {
	const base = { short: short(row.code), app: row.app ?? "", ...(row.key ? { key: row.key } : {}) };
	const route = locate(row.key);
	if (row.state === "unreadable") {
		const why = reasonOf(row.reason ?? "", row.reasonKind);
		return { ...base, status: "unreadable", ...(route ? { route } : {}), reason: m.yard_state_unreadable({ reason: why.said }), ...(why.title ? { reasonTitle: why.title } : {}), round: "", tickets: [], pills: [], wait: "", need: "", cars: [], removed: [], removedNotices: [] };
	}
	const active = going(row), waits = [...new Set(active.flatMap((s) => s.waits.map(waitWords)))], first = active[0];
	const needy = active.find((s) => s.load && s.waits.length) ?? active.find((s) => s.load);
	const status: TrainStatus = row.state === "stale" ? "stale" : row.state === "ended" ? "ended" : waits.length ? "waiting" : "running";
	const wait = list(waits);
	const note = row.state === "live" && first ? (wait ? m.yard_note({ step: pillText(first), wait }) : m.yard_note_running({ step: pillText(first) })) : undefined;
	return {
		...base, status, ...(route ? { route } : {}), round: roundWords(row), tickets: [...new Set(row.cars.flatMap((c) => c.tickets))], wait, need: needWords(needy?.load, ctx.load?.cores), ...(note ? { note } : {}),
		pills: row.steps.map((s): PillView => ({ id: s.id, text: pillText(s), title: m.yard_step_label({ kind: KIND[s.kind](), state: stateWord(s) }), state: stepState(s), round: s.round, current: s === first })),
		cars: row.cars.map((c) => carView(c, false)), removed: (row.removed ?? []).map((r) => m.yard_removed_one({ ticket: r.ticket, why: r.why })), removedNotices: (row.removed ?? []).flatMap((r) => noticeLine({ tickets: [r.ticket], ...(r.notice ? { notice: r.notice } : {}) }) ?? []),
		...(row.stepsCut ? { cut: m.yard_steps_cut({ count: row.stepsCut }) } : {}),
	};
}

export function countsOf(p: ProjectYard): Counts {
	const live = p.trains.filter((t) => t.state === "live"), waiting = live.filter((t) => going(t).some((s) => s.waits.length)).length, rows = new Set(p.trains.map((t) => t.code));
	return {
		trains: live.length, running: live.length - waiting, waiting, mutual: p.waiting.filter((code) => rows.has(code)).length, stale: p.trains.filter((t) => t.state === "stale").length,
		forming: p.forming.filter((f) => f.status === "forming").length, departing: p.forming.filter((f) => f.status === "departing").length, refused: p.forming.filter((f) => f.status === "refused").length, ended: p.trains.filter((t) => t.state === "ended").length, unreadable: p.trains.filter((t) => t.state === "unreadable").length,
	};
}
/** 「3 列火車：1 運行、2 等待（互相等待 1）」. */
export const headWords = (c: Counts) => (c.mutual ? m.yard_counts_mutual({ trains: c.trains, running: c.running, waiting: c.waiting, mutual: c.mutual }) : m.yard_counts({ trains: c.trains, running: c.running, waiting: c.waiting }));
/** 「停滯 1 · 編組中 1 · 出發中 1 · 被拒絕 1 · 讀不到 1」: the trains that are not live, so a red card never sits under a header that says zero (§26: the stalled are counted apart). Empty when there are none; the ended have their fold. */
export const othersWords = (c: Counts) => [
	c.stale && m.yard_stale_count({ count: c.stale }), c.forming && m.yard_count_forming({ count: c.forming }), c.departing && m.yard_count_departing({ count: c.departing }), c.refused && m.yard_count_refused({ count: c.refused }), c.unreadable && m.yard_count_unreadable({ count: c.unreadable }),
].filter(Boolean).join(m.yard_sep_dot());
/** The chip on a base's header: the live trains and those that wait; failing those, the stalled, the forming (a departing train is one still on its way out), or just the yard. */
export const chipWords = (c: Counts) => (c.trains ? (c.waiting ? m.yard_chip_waiting({ count: c.trains, waiting: c.waiting }) : m.yard_chip({ count: c.trains })) : c.stale ? m.yard_chip_stale({ count: c.stale }) : c.forming + c.departing ? m.yard_chip_forming({ count: c.forming + c.departing }) : m.yard_open());
export const loadWords = (load: NetLoad | undefined) => (load ? m.yard_load({ now: load.now, cores: load.cores }) : m.yard_load_none());
/** Adds counts: a base's chip over all its projects. */
export const sumCounts = (all: Counts[]): Counts => all.reduce((t, c) => Object.fromEntries(Object.keys(t).map((k) => [k, t[k as keyof Counts] + c[k as keyof Counts]])) as unknown as Counts, { trains: 0, running: 0, waiting: 0, mutual: 0, stale: 0, forming: 0, departing: 0, refused: 0, ended: 0, unreadable: 0 });

const formingView = (f: YardFormingRow, ctx: Ctx): FormingView => {
	const condition = formingWords(f, ctx.now);
	return { short: short(f.code), app: f.app, status: f.status, word: f.status === "forming" ? m.yard_forming() : f.status === "departing" ? m.yard_departing() : m.yard_refused(), ...(condition ? { condition } : {}), cars: f.cars.map((c) => carView(c, true)) };
};

/** A project's yard: the header, the forming trains, a row per train that lives or stalled, and the ended ones apart (newest first). */
export function projectView(p: ProjectYard, ctx: Ctx, locate: Locate): ProjectView {
	const counts = countsOf(p), rows = p.trains.map((t) => trainView(t, ctx, locate)), ended = rows.filter((r) => r.status === "ended").reverse();
	const route = locate(p.integrator?.key);
	const integrator = p.integrator ? (p.integrator.live && p.integrator.key ? { text: m.yard_integrator_live({ kind: m.kind_integrator() }), ...(route ? { route } : {}) } : { text: p.integrator.switched ? m.yard_integrator_switched({ kind: m.kind_integrator() }) : m.yard_integrator_gone({ kind: m.kind_integrator() }) }) : undefined;
	const problem = p.problem ? reasonOf(p.problem, p.problemKind) : undefined;
	return {
		project: p.project, title: m.yard_title({ project: p.project }), counts, head: headWords(counts), others: othersWords(counts), load: loadWords(ctx.load), ...(integrator ? { integrator } : {}), forming: p.forming.map((f) => formingView(f, ctx)),
		trains: rows.filter((r) => r.status !== "ended"), ended, ...(problem ? { problem: m.yard_problem({ problem: problem.said }), ...(problem.title ? { problemTitle: problem.title } : {}) } : {}), empty: !p.forming.length && !p.trains.length && !p.problem,
	};
}

export interface YardMap {
	/** Each project hangs on the base that holds its integrator, else one of its trains. */
	byBase: Map<string, string[]>;
	/** The projects no unit of the net places: the HUD's chip keeps them reachable. */
	loose: string[];
	/** The unit keys of integrators (mains that wrote a yard) to their project: their card opens the yard. */
	integrators: Map<string, string>;
}
export function yardMap(net: Pick<Net, "bases" | "yards">): YardMap {
	const out: YardMap = { byBase: new Map(), loose: [], integrators: new Map() };
	if (!net.yards) return out;
	const at = new Map<string, string>();
	for (const r of unitsOf(net as Net)) at.set(r.unit.key, r.base.id);
	for (const p of net.yards.projects) {
		const key = p.integrator?.key, own = key && at.has(key) ? key : undefined;
		if (own) out.integrators.set(own, p.project);
		const base = (own ? at.get(own) : undefined) ?? p.trains.map((t) => (t.key ? at.get(t.key) : undefined)).find(Boolean);
		if (base) out.byBase.set(base, [...(out.byBase.get(base) ?? []), p.project]);
		else out.loose.push(p.project);
	}
	return out;
}

/** The note line of each train's unit card, by unit key: the step in progress and what it waits for. */
export function trainNotes(net: Pick<Net, "yards" | "load">, ctx: Ctx): Map<string, string> {
	const out = new Map<string, string>();
	for (const p of net.yards?.projects ?? []) for (const t of p.trains) {
		const view = t.key ? trainView(t, ctx) : undefined;
		if (t.key && view?.note) out.set(t.key, view.note);
	}
	return out;
}

/** The unit keys of the live trains whose steps in progress wait for something (a load, a lock, a lane, a target): their cards say waiting, not the idle of the pane they sit in. */
export function trainWaits(net: Pick<Net, "yards">): Set<string> {
	const out = new Set<string>();
	for (const p of net.yards?.projects ?? []) for (const t of p.trains) if (t.key && t.state === "live" && going(t).some((s) => s.waits.length)) out.add(t.key);
	return out;
}

/** Zen's strip: the live trains and how many of them wait, nothing more (D9). */
export function zenTrains(net: Partial<Pick<Net, "yards">> | undefined): { count: number; waiting: number } {
	const all = (net?.yards?.projects ?? []).map(countsOf);
	return { count: all.reduce((n, c) => n + c.trains, 0), waiting: all.reduce((n, c) => n + c.waiting, 0) };
}

/** A car on its coordinator's unit card (docs/specs/2026-11-28-car-rows.md): its tickets, the ladder or the phase (the stage is the train's English id, boss 2026-11-28), the time in it, what it waits on, and where its train is in the yard. */
export interface CarCardView { id: string; tickets: string; tone: "ok" | "wait" | "warn" | "bad"; mark: string; line: string; time: string; wait?: string; project: string; short?: string }
const span = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h${String(Math.floor(s / 60) % 60).padStart(2, "0")}m`; };
const cardWait = (w: Wait) => ("load" in w ? m.car_load({ max: w.load.max, now: w.load.now }) : "lock" in w ? (w.lock.holder ? m.car_waits({ holder: short(w.lock.holder.train) }) : m.car_lock({ name: w.lock.name })) : m.car_waits({ holder: short("lane" in w ? w.lane.holder : w.target.holder) }));
export function carCard(f: CarFact, now: number): CarCardView {
	const code = f.train ? short(f.train) : undefined, base = { id: f.id, tickets: list(f.tickets), project: f.project, time: span(now - f.since), ...(code ? { short: code } : {}) };
	const st = f.stage, cells = st?.at && st.of ? ((done) => `${"▰".repeat(done)}${"▱".repeat(st.of! - done)} `)(st.between ? st.at : st.at - 1) : "";
	switch (f.phase) {
		case "riding": {
			const wait = f.stale ? m.car_stale() : list([...new Set((f.waits ?? []).map(cardWait))]);
			return { ...base, mark: "🚂", tone: f.stale ? "warn" : wait ? "wait" : "ok", line: `${code ?? ""} ${st ? `${cells}${st.kind}${st.attempt > 1 ? m.car_try({ n: st.attempt }) : ""}${st.between ? " ✓" : ""}` : m.car_departed()}`.trim(), ...(wait ? { wait } : {}) };
		}
		case "waiting": { const condition = f.departs ? formingWords({ departs: f.departs }, now) : undefined; return { ...base, mark: "🚉", tone: "wait", line: m.car_waiting({ app: f.app }), ...(condition ? { wait: condition } : {}) }; }
		case "landed": return { ...base, mark: "✅", tone: "ok", line: `${code ?? ""} ${f.version ? m.car_landed({ version: f.version }) : m.car_landed_bare()}`.trim() };
		case "returned": return { ...base, mark: "↩", tone: "bad", line: m.car_returned(), ...(f.reason ? { wait: f.reason } : {}) };
		case "dropped": return { ...base, mark: "✖", tone: "bad", line: `${code ?? ""} ${m.car_dropped()}`.trim(), ...(f.reason ? { wait: f.reason } : {}) };
	}
}
/** The cars of each main's card, by unit key: the cars it coordinates, from every project's facts. */
export function carCards(net: Pick<Net, "yards">, now: number): Map<string, CarCardView[]> {
	const out = new Map<string, CarCardView[]>();
	for (const p of net.yards?.projects ?? []) for (const f of p.cars ?? []) out.set(f.coordinator, [...(out.get(f.coordinator) ?? []), carCard(f, now)]);
	return out;
}
