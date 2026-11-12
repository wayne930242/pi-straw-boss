import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { secretShaped } from "./waitcard.ts";
import { type WatchReport, type WatchState, watchOf } from "./autowatch.ts";
import { type BoxAsk, buildReport, endEvent, type ParkedRow, type Report, reportText } from "./autotower.ts";
import { REPORT_FILE, AUTO_FILE, type AutoState, type By, isOwn, matchBoss, OWN_FILE, type Own, type Pending, readAuto, readOwn, seal } from "../autostate.ts";

// The server's auto mode (docs/specs/2026-11-09-auto-mode.md, §1 and §2). The server alone writes `auto.json` (what every session reads) and `auto-own.json` (what it wrote last, a pending `on`, and the words it has used), the
// own record first. A write that is not its own is put back as a new rev. Turning it on is never one step outside the GUI's two taps: every `on` request stages a pending record that the boss confirms (D9).

/** How long a staged `on` waits for the boss's confirm (D9). */
export const PENDING_MS = 10 * 60_000;
const USED_MAX = 500;
export const STALE = "This request expired or was replaced: ask again";
export const NOT_THE_BOSS = "Auto mode changes only on the boss's own words in this turn (for example 我要睡了 or 我起床了), or /boss auto in pi, or the GUI switch.";

export interface AutoDeps {
	/** The state root: `auto.json` and `auto-own.json` live here, so every Herdr slot's sessions read the same file. */
	dir: string;
	now(): number;
	log(event: string, facts: Record<string, string | number | boolean | undefined>): void;
	/** A pending id; a test fixes it. */
	id?(): string;
	/** One event to the head tower (a staged request that expired; the end of auto mode). */
	tellHead?(text: string): void;
	/** The parked boss waits now open across the towers and the head (towers.ts), for the return list; and the end of the period, which makes them ordinary again. */
	parked?(): ParkedRow[];
	unpark?(): void;
	/** The asks of the boxes this computer controls that were left waiting (D6). */
	boxes?(): BoxAsk[];
	/** The watch's section of the return list (autowatch.ts `watchSection`), from the period that ends. */
	watch?(period: Period, until: string): WatchReport | undefined;
}
/** What the boss's own words in a head turn came from: the event that started it (never a press), or the typed line the head pane's extension reported. */
export interface Words { event?: { id: string; text: string; press?: true }; typed?: { text: string; run: string; seq: number } }
export type Outcome = { ok: true; [key: string]: unknown } | { ok: false; error: string };
export interface Change { from: AutoState; to: AutoState }
export interface View { on: boolean; since?: string; rev: number; hash: string; by: By; pending?: { id: string; said: string; from: By; at: number; expires: number }; foreign: number }

/** A requester as flat facts for the log. */
const whoFacts = (by: By) => ({ via: by.via, name: by.name, session: by.requester?.session, pane: by.requester?.pane, pid: by.requester?.pid });
/** One thing auto mode did to a session, for the return list: a refusal, a cancel, a dialog answered as Escape, a trust question, or a wait the backstop could not end. Never the content of an answer. */
export const NOTE_KINDS = ["refused", "cancelled", "escaped", "trust", "still-waiting", "re-asked", "backstop"] as const;
export interface Note { session: string; tool: string; kind: (typeof NOTE_KINDS)[number]; gist: string; at: string }
/** What one period of auto mode collected, from the switch on to the switch off (§8). */
export interface Period { since: string; notes: Note[]; foreign: { at: string; why: string }[]; decided: Decided[]; /** The head tower's watch (autowatch.ts): its count and last wake, so a restart goes on from them. */ watch?: WatchState }
/** A `tower_reply` or `tower_send` a run made to a session whose `blocked` call it took, while auto mode was on (§6; AM2-F004). */
export interface Decided { at: string; run: string; to: string; gist: string; basis: string }
export const PERIOD_FILE = "auto-period.json", NOTES_MAX = 500;
const phrase = (v: string, max: number) => v.replace(/\s+/g, " ").trim().slice(0, max);
/** A gist of the return list: at most 120 characters, and `(withheld)` when it looks like a secret (§5). */
const gistOf = (v: unknown) => { const g = phrase(String(v ?? ""), 120); return g && secretShaped(g) ? "(withheld)" : g; };

/** The return list of the last period (`auto-report.json`), when it parses. */
export function readReportFile(dir: string): Report | undefined {
	try {
		const j = JSON.parse(readFileSync(join(dir, REPORT_FILE), "utf8")) as Partial<Report>;
		return j.v === 1 && typeof j.since === "string" && Array.isArray(j.parked) && Array.isArray(j.lines) ? (j as Report) : undefined;
	} catch {
		return undefined;
	}
}

export function createAutoMode(d: AutoDeps) {
	const iso = () => new Date(d.now()).toISOString();
	const boot: By = { via: "pi", name: "server" };
	let own: Own = { v: 1, rev: 0, hash: "", state: seal({ v: 1, rev: 0, on: false, by: boot }), used: { events: [], typed: [] } };
	own.hash = own.state.hash;
	let foreign = 0, period: Period | undefined, last: Report | undefined;
	const listeners = new Set<(change: Change) => void>();

	const readPeriod = (): Period | undefined => {
		try {
			const j = JSON.parse(readFileSync(join(d.dir, PERIOD_FILE), "utf8")) as Partial<Period>;
			return typeof j.since === "string" && Array.isArray(j.notes) ? { since: j.since, notes: j.notes.slice(-NOTES_MAX), foreign: Array.isArray(j.foreign) ? j.foreign : [], decided: Array.isArray(j.decided) ? j.decided : [], ...((w) => (w ? { watch: w } : {}))(watchOf(j.watch)) } : undefined;
		} catch {
			return undefined;
		}
	};
	const readReport = (): Report | undefined => readReportFile(d.dir);
	const savePeriod = () => { if (period) write(PERIOD_FILE, period); };
	const write = (name: string, value: unknown) => {
		const file = join(d.dir, name), tmp = `${file}.${process.pid}.tmp`;
		mkdirSync(d.dir, { recursive: true });
		writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
		renameSync(tmp, file);
	};
	/** The own record first, then the state by rename (AM2-F008). */
	const commit = (next: Own, publish: boolean) => {
		own = next;
		write(OWN_FILE, own);
		if (publish) write(AUTO_FILE, own.state);
	};
	const state = () => own.state;
	/** A new state: the next rev, the own record written, then the file. */
	const move = (s: Omit<AutoState, "hash" | "rev" | "v">, extra: Partial<Own> = {}, floor = 0): Change => {
		const from = own.state, to = seal({ v: 1, rev: Math.max(own.rev, from.rev, floor) + 1, ...s });
		commit({ ...own, rev: to.rev, hash: to.hash, state: to, prev: { rev: from.rev, hash: from.hash }, ...extra }, true);
		return { from, to };
	};
	const tell = (change: Change) => listeners.forEach((l) => { try { l(change); } catch (error) { d.log("auto-listener", { text: (error as Error).message }); } });

	/** A write that is not the server's own: put back as a new rev, logged without its content, and counted for the return list. */
	const putBack = (why: string, floor = 0) => {
		foreign++;
		d.log("auto-foreign", { why });
		if (period) (period.foreign.push({ at: iso(), why }), savePeriod());
		const change = move({ on: own.state.on, ...(own.state.since ? { since: own.state.since } : {}), by: own.state.by }, {}, floor);
		tell(change);
	};

	/** Reads both files at the start: the own record settles which writes are the server's. */
	function start() {
		const record = readOwn(d.dir);
		if (record) own = record;
		// A lost or broken own record with a readable `auto.json`: the file is the last good state, adopted as the server's own (AMC-F004). Putting back the default would turn auto mode off and tell every session the boss is back.
		const seen = record ? undefined : readAuto(d.dir);
		const adopted = seen?.kind === "ok" ? seen.state : undefined;
		if (adopted) {
			own = { v: 1, rev: adopted.rev, hash: adopted.hash, state: adopted, used: { events: [], typed: [] } };
			commit(own, false);
			foreign++;
			d.log("auto-foreign", { why: "own-missing" });
		}
		period = own.state.on ? readPeriod() : undefined;
		if (adopted && period) (period.foreign.push({ at: iso(), why: "own-missing" }), savePeriod());
		last = readReport();
		reconcile();
	}
	function reconcile() {
		const seen = readAuto(d.dir);
		if (seen.kind === "missing") {
			// No file is off. An own record that says on and a missing file is a removed file.
			if (own.state.on) return putBack("missing");
			return;
		}
		if (seen.kind === "unreadable") return putBack("unreadable");
		if (!isOwn(seen.state, own)) return putBack("foreign", seen.state.rev);
		// The file is the write before the own record: a crash between the two writes; the own record is finished.
		if (seen.state.rev !== own.rev || seen.state.hash !== own.hash) commit(own, true);
	}
	/** The 2 s poll: a foreign write is put back, and a staged `on` that was not confirmed in time is dropped and told to the head. */
	function tick() {
		reconcile();
		if (own.pending && d.now() >= own.pending.expires) {
			const gone = own.pending;
			commit({ ...own, pending: undefined }, false);
			d.log("auto-pending-expired", { id: gone.id });
			d.tellHead?.("Auto mode was not started: the boss did not confirm within 10 minutes");
		}
	}

	const view = (): View => ({
		on: own.state.on, ...(own.state.since ? { since: own.state.since } : {}), rev: own.rev, hash: own.hash, by: own.state.by,
		...(own.pending && d.now() < own.pending.expires ? { pending: { ...own.pending } } : {}), foreign,
	});

	function stage(said: string, from: By): Outcome {
		if (own.state.on) return { ok: false, error: "Auto mode is on already." };
		const at = d.now(), pending: Pending = { id: d.id?.() ?? randomBytes(6).toString("hex"), said: phrase(said, 200), from: { ...from, name: phrase(from.name, 80) }, at, expires: at + PENDING_MS };
		commit({ ...own, pending }, false);
		d.log("auto-staged", { id: pending.id, ...whoFacts(from) });
		return { ok: true, pending: { id: pending.id, said: pending.said, expires: pending.expires } };
	}
	function switchOn(by: By): Outcome {
		if (own.state.on) return { ok: true, changed: false };
		const change = move({ on: true, since: iso(), by }, { pending: undefined });
		period = { since: change.to.since!, notes: [], foreign: [], decided: [] };
		savePeriod();
		d.log("auto-on", whoFacts(by));
		tell(change);
		return { ok: true, changed: true };
	}
	function switchOff(by: By): Outcome {
		if (!own.state.on) {
			if (own.pending) commit({ ...own, pending: undefined }, false);
			return { ok: true, changed: false };
		}
		const change = move({ on: false, by }, { pending: undefined });
		d.log("auto-off", whoFacts(by));
		// The return list of the period just ended (§8): written before anyone is told, so every door reads the same one.
		let text: string | undefined;
		try {
			const p = period ?? { since: change.from.since ?? iso(), notes: [], foreign: [], decided: [] };
			const until = iso();
			// The watch's section is the watch's alone: one that cannot be built costs that section, never the list or the unpark.
			let watch: WatchReport | undefined;
			try { watch = d.watch?.(p, until); } catch (error) { d.log("auto-watch-report", { text: (error as Error).message }); }
			last = buildReport(p, change.from.by, by, until, d.parked?.() ?? [], d.boxes?.() ?? [], watch);
			write(REPORT_FILE, last);
			text = reportText(last);
			d.unpark?.();
			d.tellHead?.(endEvent(last));
		} catch (error) {
			d.log("auto-report", { text: (error as Error).message });
		}
		tell(change);
		return { ok: true, changed: true, ...(text ? { report: text } : {}) };
	}
	/** The confirm of a staged `on`. A stale, replaced, or cleared id is refused. */
	function confirm(id: unknown, by: By): Outcome {
		const p = own.pending;
		if (!p || typeof id !== "string" || p.id !== id || d.now() >= p.expires) return { ok: false, error: STALE };
		return switchOn({ via: by.via, name: phrase(`${by.name} (asked by ${p.from.via})`, 80), said: p.said, ...(by.requester ? { requester: by.requester } : {}) });
	}
	/** The head's `boss_auto` (AM-F001): it acts on the boss's own words in the turn the run's extension reports, never a press, read here against the fixed lists; each event or typed line works once (AM2-F007). */
	function bossAuto(on: boolean, words: Words, requester: By["requester"]): Outcome {
		const source = words.event && !words.event.press ? { key: `event:${words.event.id}`, text: words.event.text, set: "events" as const } : words.typed ? { key: `typed:${words.typed.run}:${words.typed.seq}`, text: words.typed.text, set: "typed" as const } : undefined;
		if (!source) return { ok: false, error: NOT_THE_BOSS };
		if (own.used[source.set].includes(source.key)) return { ok: false, error: `${NOT_THE_BOSS} (these words were used already)` };
		const said = matchBoss(source.text, on ? "on" : "off");
		if (said === undefined) return { ok: false, error: NOT_THE_BOSS };
		const used = { ...own.used, [source.set]: [...own.used[source.set], source.key].slice(-USED_MAX) };
		commit({ ...own, used }, false);
		const by: By = { via: "head", name: "head tower", said, ...(requester ? { requester } : {}) };
		if (!on) {
			const off = switchOff(by);
			return off.ok ? { ...off, said } : off;
		}
		if (own.state.on) return { ok: true, changed: false, said };
		const staged = stage(said, by);
		return staged.ok ? { ...staged, said, typed: Boolean(words.typed) } : staged;
	}
	/** Whether a session's reading is the server's own write; with it the session acts once per rev (§1). */
	const check = (rev: unknown, hash: unknown) => rev === own.rev && hash === own.hash;
	/** A session's note of what auto mode did to it (`auto-note`): kept only while on, cut to the fields the list shows, at most 500 a period. */
	function note(raw: Record<string, unknown>): Outcome {
		if (!own.state.on || !period) return { ok: false, error: "auto mode is off" };
		const kind = NOTE_KINDS.find((k) => k === raw.kind);
		if (!kind) return { ok: false, error: "unknown kind" };
		period.notes.push({ session: phrase(String(raw.session ?? ""), 80), tool: phrase(String(raw.tool ?? ""), 60), kind, gist: gistOf(raw.gist), at: typeof raw.at === "string" && Date.parse(raw.at) <= d.now() ? raw.at : iso() });
		if (period.notes.length > NOTES_MAX) period.notes.splice(0, period.notes.length - NOTES_MAX);
		savePeriod();
		return { ok: true };
	}
	/** A reply of a run that decided a blocked call itself (§6). */
	function decided(entry: Omit<Decided, "at">): void {
		if (!own.state.on || !period) return;
		period.decided.push({ at: iso(), ...entry, gist: gistOf(entry.gist) });
		if (period.decided.length > NOTES_MAX) period.decided.splice(0, period.decided.length - NOTES_MAX);
		savePeriod();
	}
	/** The watch's state of the period that runs; it is written with the period, and dropped when auto mode is off or the period's file is lost. */
	const setWatch = (state: WatchState): void => { if (own.state.on && period) (period.watch = state, savePeriod()); };
	return { watch: () => (own.state.on ? period?.watch : undefined), setWatch, note, decided, report: () => last, period: () => period, start, tick, view, state, stage, confirm, switchOn, switchOff, bossAuto, check, onSwitch: (l: (change: Change) => void) => (listeners.add(l), () => void listeners.delete(l)), foreignCount: () => foreign };
}
export type AutoMode = ReturnType<typeof createAutoMode>;
