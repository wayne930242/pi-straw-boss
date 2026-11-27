import type { Locale } from "./locale.ts";
import type { CarFact, CarPhase } from "./train/carfacts.ts";
import { shortCode } from "./train/spec.ts";
import type { Wait } from "./train/waits.ts";

// The words of a car row (docs/specs/2026-11-28-car-rows.md), in sb's language: the "ladder" the boss chose (2026-11-28), `🚂 1127l ▰▰▰▱▱▱▱ merge 12m · waits 1127j`, with what the car waits on after the time. The rows of the
// `straw-boss:car-rows:v1` probe, which pi-todo-ledger draws under the todo that names the car's ticket, and `/boss cars`. Pure.

export const CAR_ROWS_EVENT = "straw-boss:car-rows:v1";
export type Tone = "ok" | "wait" | "warn" | "bad";
/** One row of the probe (the contract the ledger reads): drawn as `${line} ${duration(now - since)}${wait ? " · " + wait : ""}`. */
export interface CarRowV1 { id: string; item?: string; group?: string; tickets: string[]; phase: CarPhase | "sent"; tone: Tone; line: string; wait?: string; since: number }
/** A slip this session sent that no integrator has received yet, as the session remembers it. */
export interface SentSlip { app: string; head: string; tickets: string[]; at: number; reminded?: number }
/** What the rows are placed by: a todo's id, subject, status and uid. */
export interface TodoRef { id: number; subject: string; status: string; uid?: string }

/** How long a slip may go unreceived before its row warns and its coordinator is told (boss 2026-11-28). */
export const UNRECEIVED_MS = 15 * 60_000;

const W = {
	"zh-TW": {
		attempt: (n: number) => `（第 ${n} 次）`, departed: "已出發", stale: "火車停滯", waiting: (app: string) => `🚉 ${app} 等發車`, landed: "已落地", returned: "↩ 退回", dropped: "剔除", sent: "📮 已送出", unreceived: "調度員還沒收",
		load: (max: number, now: number) => `等負載 ≤${max}（現在 ${now}）`, lock: (name: string) => `等鎖 ${name}`, lockHeld: (name: string, holder: string) => `等 ${holder}（鎖 ${name}）`,
		holder: (holder: string) => `等 ${holder}`, holderStale: (wait: string) => `${wait}（它已停滯）`, holderUnread: (wait: string) => `${wait}（它的看板讀不到）`,
		departs: (cars: number, min: number, left: number) => `滿 ${cars} 節或 ${min} 分（${left > 0 ? `還 ${left} 分` : "時間到"}）`,
		other: "其他車廂", trains: "火車", title: "車廂", none: "沒有車廂：這個 session 沒有還在路上、或 30 分鐘內結束的車。",
	},
	en: {
		attempt: (n: number) => ` (try ${n})`, departed: "departed", stale: "train stalled", waiting: (app: string) => `🚉 ${app} waiting to depart`, landed: "landed", returned: "↩ returned", dropped: "dropped", sent: "📮 sent", unreceived: "not received yet",
		load: (max: number, now: number) => `waits load ≤${max} (now ${now})`, lock: (name: string) => `waits lock ${name}`, lockHeld: (name: string, holder: string) => `waits ${holder} (lock ${name})`,
		holder: (holder: string) => `waits ${holder}`, holderStale: (wait: string) => `${wait} (stalled)`, holderUnread: (wait: string) => `${wait} (board unreadable)`,
		departs: (cars: number, min: number, left: number) => `leaves at ${cars} cars or ${min} min (${left > 0 ? `${left} min left` : "time is up"})`,
		other: "Other cars", trains: "Trains", title: "Cars", none: "No cars: this session has no car on its way, nor one that ended in the last 30 minutes.",
	},
};

const short = (code: string | undefined) => { if (!code) return undefined; try { return shortCode(code); } catch { return code; } };
/** As the worker rows say it: `42s`, `12m`, `1h05m`. */
export function duration(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h${String(Math.floor(s / 60) % 60).padStart(2, "0")}m`;
}

export function waitWords(w: Wait, lang: Locale): string {
	const t = W[lang];
	if ("load" in w) return t.load(w.load.max, w.load.now);
	if ("lock" in w) return w.lock.holder ? t.lockHeld(w.lock.name, short(w.lock.holder.train)!) : t.lock(w.lock.name);
	// A lane or a target: the train that holds it, by its short code (`waits 1127j`); which lane or target is the yard's to say.
	const [base, why] = "lane" in w ? [t.holder(short(w.lane.holder)!), w.lane.why] : [t.holder(short(w.target.holder)!), w.target.why];
	return why === "stale" ? t.holderStale(base) : why === "unreadable" ? t.holderUnread(base) : base;
}

/** The ladder of a stage: the stages done full, the rest empty; nothing off the ladder. */
const ladder = (stage: NonNullable<CarFact["stage"]>) => (stage.at && stage.of ? `${"▰".repeat(stage.between ? stage.at : stage.at - 1)}${"▱".repeat(stage.of - (stage.between ? stage.at : stage.at - 1))} ` : "");
/** Where the train is, without the 🚂 and the code: `▰▰▰▱▱▱▱ merge（第 2 次）`. The stage is the train's own English id in every language (boss 2026-11-28): only the words around it follow sb's language. */
function stageWords(f: Pick<CarFact, "stage">, lang: Locale): string {
	const t = W[lang], s = f.stage;
	if (!s) return t.departed;
	return `${ladder(s)}${s.kind}${s.attempt > 1 ? t.attempt(s.attempt) : ""}${s.between ? " ✓" : ""}`;
}

/** One car's line, what it waits on, and its tone. */
export function factLine(f: CarFact, lang: Locale, now: number): { line: string; wait?: string; tone: Tone } {
	const t = W[lang], code = short(f.train), at = code ? ` ${code}` : "";
	const out = (line: string, tone: Tone, wait?: string) => ({ line, ...(wait ? { wait } : {}), tone });
	switch (f.phase) {
		case "riding": {
			const waits = (f.waits ?? []).slice(0, 2).map((w) => waitWords(w, lang)).join(" · ");
			return out(`🚂${at} ${stageWords(f, lang)}`, f.stale ? "warn" : waits ? "wait" : "ok", f.stale ? t.stale : waits || undefined);
		}
		case "waiting": {
			const d = f.departs, left = d ? Math.ceil((Date.parse(d.oldest) + d.maxWaitMin * 60_000 - now) / 60_000) : 0;
			return out(t.waiting(f.app), "wait", d ? t.departs(d.maxCars, d.maxWaitMin, left) : undefined);
		}
		case "landed": return out(`✅${at} ${t.landed}${f.version ? ` ${f.version}` : ""}`, "ok");
		case "returned": return out(t.returned, "bad", f.reason);
		case "dropped": return out(`✖${at} ${t.dropped}`, "bad", f.reason);
	}
}

/** The open todo a car goes under: the open todos whose subject names one of its tickets as a word; the first in progress, else the first by id. */
export function itemOf(tickets: readonly string[], todos: readonly TodoRef[], me: string): string | undefined {
	const named = todos.filter((t) => (t.status === "pending" || t.status === "in_progress") && tickets.some((k) => new RegExp(`(?<![A-Za-z0-9])${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`, "i").test(t.subject))).sort((a, b) => a.id - b.id);
	const hit = named.find((t) => t.status === "in_progress") ?? named[0];
	return hit && (hit.uid ?? `${me.slice(0, 8)}#${hit.id}`);
}

const TONE_RANK: Record<Tone, number> = { bad: 3, warn: 2, wait: 1, ok: 0 };
/**
 * The rows of a session: its cars (`facts` whose coordinator it is) under the todo that names them or in Other cars, the slips it sent that no fact holds yet, and, for the integrator, one row per train it received cars for.
 */
export function carRows(input: { facts: readonly CarFact[]; sent: readonly SentSlip[]; todos: readonly TodoRef[]; me: string; lang: Locale; now: number }): CarRowV1[] {
	const { lang, now, me, todos } = input, t = W[lang], rows: CarRowV1[] = [];
	const place = (tickets: string[], wait: string | undefined): Pick<CarRowV1, "item" | "group" | "wait"> => {
		const item = itemOf(tickets, todos, me);
		if (item) return { item, ...(wait ? { wait } : {}) };
		return { group: t.other, wait: [wait, tickets.join(", ")].filter(Boolean).join(" · ") };
	};
	const heads = new Set(input.facts.map((f) => `${f.app}\n${f.head}`));
	for (const s of input.sent) {
		if (heads.has(`${s.app}\n${s.head}`)) continue;
		rows.push({ id: `sent:${s.app}-${s.head.slice(0, 12)}`, tickets: [...s.tickets], phase: "sent", tone: now - s.at >= UNRECEIVED_MS ? "warn" : "wait", line: t.sent, since: s.at, ...place(s.tickets, t.unreceived) });
	}
	for (const f of input.facts) {
		if (f.coordinator !== me) continue;
		const { line, wait, tone } = factLine(f, lang, now);
		rows.push({ id: f.id, tickets: [...f.tickets], phase: f.phase, tone, line, since: f.since, ...place(f.tickets, wait) });
	}
	const trains = new Map<string, CarFact[]>();
	for (const f of input.facts) if (f.integrator === me && f.coordinator !== me && f.train) trains.set(`${f.project}/${f.train}`, [...(trains.get(`${f.project}/${f.train}`) ?? []), f]);
	for (const [key, cars] of trains) {
		// The train's row follows its car that is still on the way, else the car that landed, else the last to end.
		const lead = cars.find((c) => c.phase === "riding" || c.phase === "waiting") ?? cars.find((c) => c.phase === "landed") ?? cars.at(-1)!;
		const { line, wait, tone } = factLine(lead, lang, now), tickets = cars.flatMap((c) => c.tickets);
		const named = lead.phase === "waiting" ? line.replace(/^🚉 /, `🚉 ${short(lead.train)} `) : line.replace(/^(🚂|✅|✖) (\S+)/, `$1 $2 ${lead.app}`);
		const worst = cars.reduce<Tone>((top, c) => (TONE_RANK[factLine(c, lang, now).tone] > TONE_RANK[top] ? factLine(c, lang, now).tone : top), tone);
		rows.push({ id: `train:${key}`, group: t.trains, tickets, phase: lead.phase, tone: worst, line: named, since: lead.since, wait: [wait, tickets.join(", ")].filter(Boolean).join(" · ") });
	}
	return rows;
}

/** `/boss cars`: the rows with their times, under their todos (`#id subject`), then Other cars and Trains. */
export function carsText(rows: readonly CarRowV1[], todos: readonly TodoRef[], me: string, lang: Locale, now: number): string {
	const t = W[lang];
	if (!rows.length) return t.none;
	const draw = (r: CarRowV1) => `  ${r.line} ${duration(now - r.since)}${r.wait ? ` · ${r.wait}` : ""}`;
	const lines = [t.title];
	for (const todo of todos) {
		const key = todo.uid ?? `${me.slice(0, 8)}#${todo.id}`, mine = rows.filter((r) => r.item === key || (todo.uid && r.item === `${me.slice(0, 8)}#${todo.id}`));
		if (mine.length) lines.push(`#${todo.id} ${todo.subject}`, ...mine.map(draw));
	}
	for (const group of [t.other, t.trains]) {
		const mine = rows.filter((r) => r.group === group);
		if (mine.length) lines.push(group, ...mine.map(draw));
	}
	return lines.join("\n");
}
