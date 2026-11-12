import { mkdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { baseName, descendants, type Proc } from "../procs/table.ts";
import { writeJson } from "./record.ts";

// The stall watch of the sb server: a pi session that froze is told to its workspace's tower, once per incident. On 2026-11-12 a main's pi pegged its main thread for 40 hours, took no keys, and fell out
// of pi-intercom's list, and nobody noticed until a tower rescued it by hand. Once a minute the watch reads, from the process table the owner registry's tick already holds (procs.ts), three signals of each
// pi session that pi-intercom lists in a Herdr pane:
//   cpu      its process averaged `cpuPercent` of a core or more over `cpuMinutes` samples in a row, none of them calm (under half of `cpuPercent`), while its session file was not written. The share is
//            averaged because a pegged pi on a loaded machine dips under the threshold for a minute now and then; a calm sample or a write starts the count again, since a thread that spins has no calm
//            minute and a session that still writes its file is working, not frozen. Healthy mains with a long history were measured at 73% and 83% of a core over a minute while they wrote their files, so
//            the write, not the threshold, is what tells work from a freeze;
//   missing  its process is alive and pi-intercom has not listed it for `missingMinutes` samples in a row (the broker drops a client whose event loop stopped heartbeating); the sessions known are kept in
//            `<slot dir>/procs/stallwatch.json`, so one that never came back after a server restart is told too;
//   silent   its pane says working, its session file was not written for `silentMinutes` samples in a row, and no tool call is open in it: it waits on a model that does not answer (a long tool call, a
//            subagent, or a build is an open call and is never a stall).
// Streaks count samples, not the wall clock: a sample that comes more than three minutes after the last (the computer slept, the server was stopped) starts every streak again.
// Not told (SW-F005): a session that froze more than ten minutes before the watch first saw its pane, with a calm process. `missing` counts only for a session known to have registered, and what says so of
// a process is its place in pi-intercom's list or its pane's `sb_role` token, which the session itself renews and which lapses ten minutes after it stops (herdr.ts). Nothing else on this machine says it of the
// process: a session file's entries are carried along by a resume or a fork, and the owner registry holds workers only. So it holds for the first sample of a server whose `stallwatch.json` has no row for the
// pi (the release that brings the watch, a watch turned on, a lost file); afterwards `known` is on file.
// The watch only tells: it sends no signal and no key to any process. What the tower does with it is the runbook in the message (`stallText`).

export const STALL_FILE = "stallwatch.json";
export const SAMPLE_MS = 60_000, PAUSE_MS = 180_000, CLEAR_SAMPLES = 3, REMIND_MAX_MS = 8 * 3600_000;
/** A tick that comes a little early still samples: the tick's own timer is 10 or 30 s. */
const SLACK_MS = 5000;
/** The most panes one sample asks Herdr about (`pane process-info` starts the CLI, which costs seconds on a loaded machine): after a server start the panes are taken in over a few samples. */
export const ADMIT_MAX = 8;
/** A pane whose pi was not found is asked again after 2, 4, 8, 16, then every 32 samples, and is in the log once, at its third ask in a row that found none. */
const RETRY_MAX = 32, UNRESOLVED_LOG = 3;

export interface StallConfig { enabled: boolean; cpuPercent: number; cpuMinutes: number; silentMinutes: number; missingMinutes: number; remindMinutes: number }
export const STALL_DEFAULTS: StallConfig = { enabled: true, cpuPercent: 75, cpuMinutes: 5, silentMinutes: 30, missingMinutes: 3, remindMinutes: 60 };

/** `stallWatch` from `<state dir>/config.json`: a key that is missing or no number of its kind keeps its default, and a file that is missing or cannot be parsed means the defaults. `0` minutes turns that signal (or the reminders) off. */
export function readStallWatch(stateDir: string): StallConfig {
	let section: unknown;
	try {
		section = (JSON.parse(readFileSync(join(stateDir, "config.json"), "utf8")) as { stallWatch?: unknown }).stallWatch;
	} catch { /* none, or not JSON (the tower service tells the boss of a config that cannot be read): the defaults */ }
	const found = (typeof section === "object" && section !== null ? section : {}) as Record<string, unknown>;
	const minutes = (key: "cpuMinutes" | "silentMinutes" | "missingMinutes" | "remindMinutes") => (Number.isInteger(found[key]) && (found[key] as number) >= 0 && (found[key] as number) <= 10_080 ? (found[key] as number) : STALL_DEFAULTS[key]);
	const percent = typeof found.cpuPercent === "number" && found.cpuPercent >= 10 && found.cpuPercent <= 100 ? found.cpuPercent : STALL_DEFAULTS.cpuPercent;
	return { enabled: found.enabled !== false, cpuPercent: percent, cpuMinutes: minutes("cpuMinutes"), silentMinutes: minutes("silentMinutes"), missingMinutes: minutes("missingMinutes"), remindMinutes: minutes("remindMinutes") };
}

export type Signal = "cpu" | "missing" | "silent";
/** A session as pi-intercom lists it. Its pid is the session's own word: it counts only for a process Herdr lists in the pane (`piOf`), and for a watched pi only when the session is in that pi's pane. `pane` is where the broker places it now; none when it could not (not hosted, or Herdr did not answer the broker), and the pid then counts alone. */
export interface SessionFact { id: string; name?: string; pid: number; pane?: string; workspace?: string }
export interface PaneFact { pane: string; /** The terminal in the pane: Herdr reuses a pane id, and another terminal under it is another pane. */ terminal?: string; workspace?: string; /** Herdr says a pi runs in it. */ pi: boolean; working: boolean; /** The session file Herdr names for the pane's pi. */ file?: string; /** The pane's `sb_role` token. */ role?: string }
/** What Herdr lists in a pane: its shell and its foreground. */
export interface PaneProcs { shell?: number; foreground: { pid: number; name?: string; argv0?: string }[] }
/** What a tower is told. `flag`: a new incident; `change`: a further signal fired in it; `remind`: it still stands after the backoff; `clear`: its signals are gone while the process lives. */
export interface Flag {
	kind: "flag" | "change" | "remind" | "clear";
	pid: number; started: string; session: string; name?: string; pane: string; workspace?: string; role?: string;
	signals: Signal[];
	/** The cpu time the process has used so far, in minutes, and its share of a core over the last sample, in percent. */
	cpuMinutes: number; cpuNow?: number;
	/** How many times this incident was told before. */
	told: number;
	text: string;
}
export interface StallDeps {
	/** The folder of the slot; the watch keeps its file in `procs/` below it, beside the owner registry's. */
	dir: string;
	now(): number;
	log(event: string, facts: Record<string, number | string | boolean>): void;
	config(): StallConfig;
	/** The sessions pi-intercom lists now; rejects when the list is not known (the server is not connected), which counts for nothing. */
	sessions(): Promise<SessionFact[]>;
	/** The panes Herdr lists now; rejects when they are not known. */
	panes(): Promise<PaneFact[]>;
	/** What Herdr lists in a pane; undefined or a rejection when it is not known. Asked when a pane's pi is first watched, not at each sample. */
	paneProcs(pane: string): Promise<PaneProcs | undefined>;
	/** When a file was last written, in ms; undefined when it cannot be read. */
	mtime(file: string): number | undefined;
	/** How many tool calls the session file's newest assistant message leaves open; undefined when that cannot be told. */
	openCalls(file: string): Promise<number | undefined>;
	/** Tells the tower that serves the flag's workspace. False when nobody could be told: the watch tries again at the next sample. */
	tell(flag: Flag): Promise<boolean>;
	/** Pids that are never a pi session: this server (its tower identities are in pi-intercom's list under its pid). */
	self?: number[];
}
export interface StallRow { pid: number; session: string; pane: string; /** The workspace of its pane, when Herdr named one. */ workspace?: string; signals: Signal[]; told: number }
export interface StallWatch {
	/** One look at the table of a tick; it does nothing until a minute has passed since the last sample, or while a sample runs. Never rejects. */
	sample(table: readonly Proc[]): Promise<void>;
	/** The open incidents. */
	list(): StallRow[];
}

const phrase = (value: unknown, max: number) => (typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");
const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "csh", "tcsh"]);
const nameOf = (p: { name?: string; argv0?: string }) => baseName(p.argv0 ?? p.name ?? "").replace(/^-/, "");

/**
 * The pid of a pane's pi. A pid a listed session gives for the pane is taken when Herdr lists it in the pane's foreground or the table has it below the pane's shell; else the foreground process that is pi by its
 * program (`argv0` on macOS, `name` on Linux), else the one process named node. Two candidates and no listed pid: nothing is guessed. The pane's shell and any shell are never a pi.
 */
export function piOf(info: PaneProcs, table: readonly Proc[], listed: readonly number[]): number | undefined {
	const front = info.foreground.filter((p) => p.pid !== info.shell && !SHELLS.has(nameOf(p)));
	const below = info.shell === undefined ? new Set<number>() : new Set(descendants(table, [info.shell]).map((p) => p.pid));
	const said = listed.find((pid) => pid !== info.shell && (front.some((p) => p.pid === pid) || below.has(pid)));
	if (said !== undefined) return said;
	const one = (list: typeof front) => (list.length === 1 ? list[0]!.pid : undefined);
	return one(front.filter((p) => p.argv0 === "pi")) ?? one(front.filter((p) => p.name === "pi")) ?? one(front.filter((p) => p.name === "node"));
}

const minutes = (n: number) => `${n} minute${n === 1 ? "" : "s"}`;
/** What each signal saw, in the words of the message. */
const SEEN: Record<Signal, (cfg: StallConfig) => string> = {
	cpu: (cfg) => `its process averaged at or above ${cfg.cpuPercent}% of a core over ${minutes(cfg.cpuMinutes)} while its session file was not written`,
	missing: (cfg) => `its process is alive and pi-intercom has not listed it for ${minutes(cfg.missingMinutes)} (a pi whose event loop stopped falls out of the list)`,
	silent: (cfg) => `its pane says working, its session file was not written for ${minutes(cfg.silentMinutes)}, and no tool call is open`,
};
/** The message a tower gets: what was seen, and the runbook. A session's name and id are its own words, so they are cleaned, cut, and quoted; the rest is the server's. */
export function stallText(f: Omit<Flag, "text">, cfg: StallConfig): string {
	// Every word here that a session wrote (its name and id, its pane's role token) is cleaned, cut, and kept from closing a quote or a code span or opening a header line.
	const word = (value: unknown, max: number) => phrase(value, max).replace(/["`\[\]]/g, "'");
	const name = word(f.name, 60), pane = word(f.pane, 40), started = word(f.started, 40);
	// The id is quoted like the name and keeps an id's characters only: with no space in it, it cannot read as a sentence of the server's beside the runbook (SW-F006).
	const id = String(f.session ?? "").replace(/[^A-Za-z0-9._:-]+/g, "").slice(0, 80) || "unknown";
	const who = `session "${id}"${name ? ` ("${name}")` : ""}${f.role ? `, role ${word(f.role, 20)}` : ""}, pid ${f.pid} (started ${started} UTC)${f.workspace ? `, workspace ${word(f.workspace, 40)}` : ""}`;
	const cpu = `${f.cpuMinutes} min of cpu so far${f.cpuNow === undefined ? "" : `, ${f.cpuNow}% of a core over the last sample`}`;
	const seen = f.signals.map((sig) => SEEN[sig](cfg)).join("; and ");
	if (f.kind === "clear") return `Stall watch: the pi in pane ${pane} recovered. ${who}; ${cpu}. What was seen no longer holds (${seen}). Do not stop it. Drop what you recorded or asked for it.`;
	const head = f.kind === "change" ? "Stall watch, one more signal" : f.kind === "remind" ? `Stall watch, reminder (told ${f.told} time${f.told === 1 ? "" : "s"} before)` : "Stall watch";
	return [
		`${head}: the pi in pane ${pane} looks frozen. ${who}; ${cpu}.`,
		`Seen: ${seen}.`,
		"The sb server sent no signal and no key to it, and never does. The steps need a shell, and a tower run has none: hand them, with this message, to a main of the workspace that is not this session (open one when there is none), or to the boss.",
		`1. Read the pane twice, a few seconds apart: \`herdr pane read ${pane} --lines 40\`. A screen that moves is a session at work: leave it and stop here.`,
		`2. A screen that stands still: \`herdr pane send-keys ${pane} esc\`, then read it again. If it answers, have it write a handoff note and quit.`,
		`3. If it takes no key: only when it left a handoff file, or the boss approves (record a wait for the boss, and wait), check that pid ${f.pid} is still that process (\`TZ=UTC LC_ALL=C ps -o lstart= -p ${f.pid}\` prints ${started}), stop it with \`kill ${f.pid}\`, and start a fresh session in its folder with the handoff.`,
		`This incident is told once. A further signal or a recovery is told${cfg.remindMinutes ? `, and a reminder comes after ${minutes(cfg.remindMinutes)} and then at twice the wait each time` : ""}.`,
	].join("\n");
}

interface Incident { signals: Signal[]; since: number; told: number; reminds: number; toldAt?: number; /** Samples in a row without a symptom of its signals. */ quiet: number; due?: Flag["kind"]; /** `stall-untold` is in the log. */ untold?: true }
interface Watched {
	pid: number; started: string; pane: string; terminal?: string; workspace?: string; role?: string; file?: string;
	/** The id and name pi-intercom listed it under; `known` once it was listed, or its pane carries a role and a session file (it registered at some time). */
	session?: string; name?: string; known: boolean;
	/** The last sample's readings; none right after a start or a pause. */
	cpu?: number; mtime?: number; pct?: number;
	/** The shares of a core at the last samples in a row that were not calm and had no write, `cpuMinutes` of them at most. */
	heat: number[];
	silent: number; missing: number;
	/** The open calls of the file as it was at `at` (its mtime). */
	open?: { at: number | undefined; calls: number | undefined };
	incident?: Incident;
}
const keyOf = (p: { pid: number; started: string }) => `${p.pid}\n${p.started}`;
const paneKey = (p: { pane: string; terminal?: string }) => `${p.pane}\n${p.terminal ?? ""}`;
const text = (v: unknown, max: number) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined);

export function createStallWatch(d: StallDeps): StallWatch {
	const folder = join(d.dir, "procs"), file = join(folder, STALL_FILE), self = d.self ?? [process.pid];
	const watched = new Map<string, Watched>();
	/** The panes whose pi was not found, by pane and terminal: how many asks in a row found none, and the sample that asks again. */
	const unresolved = new Map<string, { tries: number; again: number }>();
	let lastAt: number | undefined, on = false, busy = false, saved = "", loaded = false, samples = 0, askedLast: string | undefined;

	const kept = () => JSON.stringify({ v: 1, watched: [...watched.values()].map(({ pid, started, pane, terminal, workspace, role, file: f, session, name, known, incident }) => ({ pid, started, pane, terminal, workspace, role, file: f, session, name, known, incident })) });
	// A write that fails is one log line: the watch goes on in memory, and a restart then tells an open incident once more.
	const save = () => {
		const next = kept();
		if (next === saved) return;
		try {
			mkdirSync(folder, { recursive: true, mode: 0o700 });
			writeJson(file, JSON.parse(next));
			saved = next;
		} catch (error) {
			d.log("stall-error", { text: `${STALL_FILE} was not written (${(error as NodeJS.ErrnoException).code ?? (error as Error).name})` });
		}
	};
	/** The sessions the last server knew, with their open incidents: the counts start from nothing, so the first samples after a restart are its grace. */
	const load = () => {
		loaded = true;
		try {
			const parsed = JSON.parse(readFileSync(file, "utf8")) as { watched?: unknown };
			for (const r of Array.isArray(parsed.watched) ? parsed.watched : []) {
				const o = r as Partial<Watched>, i = o?.incident as Partial<Incident> | undefined;
				if (!Number.isSafeInteger(o?.pid) || typeof o.started !== "string" || typeof o.pane !== "string") continue;
				const signals = Array.isArray(i?.signals) ? i.signals.filter((x): x is Signal => x === "cpu" || x === "missing" || x === "silent") : [];
				const incident: Incident | undefined = i && signals.length && Number.isSafeInteger(i.told) ? { signals, since: Number(i.since) || d.now(), told: i.told!, reminds: Number.isSafeInteger(i.reminds) ? i.reminds! : 0, ...(typeof i.toldAt === "number" ? { toldAt: i.toldAt } : {}), quiet: 0, ...(i.due === "flag" || i.due === "change" || i.due === "clear" ? { due: i.due } : {}) } : undefined;
				watched.set(keyOf(o as Watched), { pid: o.pid!, started: o.started, pane: o.pane, terminal: text(o.terminal, 200), workspace: text(o.workspace, 200), role: text(o.role, 40), file: text(o.file, 4096), session: text(o.session, 200), name: text(o.name, 200), known: o.known === true, heat: [], silent: 0, missing: 0, ...(incident ? { incident } : {}) });
			}
		} catch { /* none yet, or not readable: the watch starts empty */ }
		saved = kept();
	};
	const flagOf = (w: Watched, kind: Flag["kind"], proc: Proc, cfg: StallConfig): Flag => {
		const bare: Omit<Flag, "text"> = {
			kind, pid: w.pid, started: w.started, session: w.session ?? (w.file ? basename(w.file).replace(/\.jsonl$/, "") : "(unknown)"), ...(w.name ? { name: w.name } : {}), pane: w.pane, ...(w.workspace ? { workspace: w.workspace } : {}), ...(w.role ? { role: w.role } : {}),
			signals: [...w.incident!.signals], cpuMinutes: Math.round(proc.cpu / 60), ...(w.pct !== undefined ? { cpuNow: Math.round(w.pct) } : {}), told: w.incident!.told,
		};
		return { ...bare, text: stallText(bare, cfg) };
	};
	/** The open calls of a session file, read again only when the file was written since. */
	const openOf = async (w: Watched): Promise<number | undefined> => {
		if (!w.file) return undefined;
		if (!w.open || w.open.at !== w.mtime || w.open.calls === undefined) w.open = { at: w.mtime, calls: await d.openCalls(w.file).catch(() => undefined) };
		return w.open.calls;
	};

	async function take(table: readonly Proc[], cfg: StallConfig, now: number, gap: number | undefined): Promise<void> {
		// A first sample, and one that comes late (the computer slept, the server was stopped), only takes the readings: every count starts again.
		const paused = gap === undefined || gap > PAUSE_MS;
		const [sessions, panes] = await Promise.all([d.sessions().catch(() => undefined), d.panes().catch(() => undefined)]);
		const live = new Map(table.filter((p) => !p.zombie).map((p) => [keyOf(p), p]));
		// A pi that ended, or whose pane closed (its id gone, or reused for another terminal), is no longer watched: its incident goes without a word (whoever stopped it knows).
		const still = (w: Watched) => !panes || panes.some((p) => p.pane === w.pane && (p.terminal === undefined || w.terminal === undefined || p.terminal === w.terminal));
		for (const [key, w] of watched) {
			if (live.has(key) && still(w)) continue;
			if (w.incident) d.log("stall-ended", { pid: w.pid, pane: w.pane, signals: w.incident.signals.join("+"), told: w.incident.told });
			watched.delete(key);
		}
		for (const pane of panes ?? []) {
			const now1 = [...watched.values()].find((w) => w.pane === pane.pane);
			if (!now1) continue;
			[now1.workspace, now1.role] = [pane.workspace ?? now1.workspace, pane.role ?? now1.role];
			if (pane.file && pane.file !== now1.file) [now1.file, now1.mtime, now1.open] = [pane.file, undefined, undefined]; // /new or /resume in the same pi: another file, read from nothing
		}
		// The pi of each pane where Herdr says one runs is watched from now on. The panes are asked in Herdr's order, in turn from behind the one asked last, and a pane whose pi was not found waits longer
		// before each further ask: panes that give nothing neither keep the others from their turn nor start Herdr's CLI every minute (SW-F003).
		samples++;
		const all = panes ?? [], from = all.findIndex((p) => p.pane === askedLast) + 1;
		const open = [...all.slice(from), ...all.slice(0, from)].filter((p) => p.pi && ![...watched.values()].some((w) => w.pane === p.pane));
		for (const key of unresolved.keys()) if (panes && !open.some((p) => paneKey(p) === key)) unresolved.delete(key);
		for (const pane of open.filter((p) => (unresolved.get(paneKey(p))?.again ?? 0) <= samples).slice(0, ADMIT_MAX)) {
			askedLast = pane.pane;
			const info = await d.paneProcs(pane.pane).catch(() => undefined);
			const pid = info && piOf(info, table, (sessions ?? []).filter((s) => s.pane === pane.pane).map((s) => s.pid));
			const proc = pid === undefined || self.includes(pid) ? undefined : table.find((p) => p.pid === pid && !p.zombie);
			if (!proc || watched.has(keyOf(proc))) {
				const tries = (unresolved.get(paneKey(pane))?.tries ?? 0) + 1;
				unresolved.set(paneKey(pane), { tries, again: samples + Math.min(2 ** tries, RETRY_MAX) });
				if (tries === UNRESOLVED_LOG) d.log("stall-unresolved", { pane: pane.pane, tries });
				continue;
			}
			unresolved.delete(paneKey(pane));
			watched.set(keyOf(proc), { pid: proc.pid, started: proc.started, pane: pane.pane, ...(pane.terminal ? { terminal: pane.terminal } : {}), ...(pane.workspace ? { workspace: pane.workspace } : {}), ...(pane.role ? { role: pane.role } : {}), ...(pane.file ? { file: pane.file } : {}), known: false, heat: [], silent: 0, missing: 0 });
		}
		for (const w of watched.values()) {
			const proc = live.get(keyOf(w))!, pane = panes?.find((p) => p.pane === w.pane);
			// A session counts for this pi by the pid it reports only when it is in this pi's pane, or the broker could not place it (SW-F004).
			const listed = sessions?.find((s) => s.pid === w.pid && (s.pane === undefined || s.pane === w.pane));
			if (listed) [w.session, w.name, w.known, w.missing] = [listed.id, listed.name, true, 0];
			// A pane that carries a role and a session file registered at some time, though this server never saw it listed: it froze before the watch first saw it, and less than ten minutes before, while its role token still stood (the header's limit).
			if (pane?.role && pane.file) w.known = true;
			const mtime = w.file ? d.mtime(w.file) : undefined, written = w.file !== undefined && mtime !== w.mtime;
			if (paused) [w.heat, w.silent, w.missing, w.pct] = [[], 0, 0, undefined];
			else {
				w.pct = w.cpu === undefined ? undefined : ((proc.cpu - w.cpu) / (gap / 1000)) * 100;
				// One sample under the threshold does not start the count again (a pegged pi dips on a loaded machine); a calm one, under half of it, does, and so does a write (SW-F002).
				w.heat = !cfg.cpuMinutes || w.pct === undefined || w.pct < cfg.cpuPercent / 2 || written ? [] : [...w.heat, w.pct].slice(-cfg.cpuMinutes);
				// Without Herdr's word on the pane the count stands as it is.
				if (pane || panes) w.silent = pane?.working && w.file !== undefined && !written ? w.silent + 1 : 0;
				if (sessions && !listed && w.known) w.missing++;
			}
			[w.cpu, w.mtime] = [proc.cpu, mtime];
			/** The samples in a row that were not calm average the threshold or more: the cpu signal once there are `cpuMinutes` of them, and its symptom from the first. */
			const pegged = w.heat.length > 0 && w.heat.reduce((sum, pct) => sum + pct, 0) / w.heat.length >= cfg.cpuPercent;
			const firing: Signal[] = [];
			if (pegged && w.heat.length >= cfg.cpuMinutes) firing.push("cpu");
			if (cfg.missingMinutes && w.missing >= cfg.missingMinutes) firing.push("missing");
			if (cfg.silentMinutes && w.silent >= cfg.silentMinutes && (await openOf(w)) === 0) firing.push("silent");
			let inc = w.incident;
			if (!inc) {
				if (!firing.length) continue;
				inc = w.incident = { signals: firing, since: now, told: 0, reminds: 0, quiet: 0, due: "flag" };
			} else {
				const more = firing.filter((sig) => !inc!.signals.includes(sig));
				if (more.length) (inc.signals.push(...more), inc.due = inc.due === "flag" ? "flag" : "change");
				// The incident ends when none of its signals showed a symptom for three samples in a row; a symptom in between starts that count again, so a pi that is pegged on and off stays one incident.
				// A silent incident's symptom is the signal's own: a pane that works with a call open (the session answered and runs a build or a subagent) is at work, not silent (SW-F001).
				const symptom = (inc.signals.includes("cpu") && pegged) || (inc.signals.includes("missing") && w.missing > 0) || (inc.signals.includes("silent") && w.silent > 0 && (await openOf(w)) === 0);
				if (!paused) inc.quiet = symptom ? 0 : inc.quiet + 1;
				if (inc.quiet >= CLEAR_SAMPLES) {
					if (!inc.told) { delete w.incident; continue; } // nobody heard of it
					inc.due = "clear";
				} else if (inc.due === "clear") inc.due = undefined;
				const wait = Math.min(cfg.remindMinutes * 60_000 * 2 ** inc.reminds, REMIND_MAX_MS);
				// A reminder says "looks frozen", so it waits while the symptoms are gone: they come back, or the incident clears.
				if (!inc.due && !inc.quiet && cfg.remindMinutes && inc.toldAt !== undefined && now - inc.toldAt >= wait) inc.due = "remind";
			}
			if (!inc.due) continue;
			const flag = flagOf(w, inc.due, proc, cfg);
			if (await d.tell(flag).catch(() => false)) {
				d.log("stall-told", { kind: flag.kind, pid: w.pid, pane: w.pane, session: flag.session, signals: flag.signals.join("+"), cpuMinutes: flag.cpuMinutes, told: inc.told });
				if (flag.kind === "clear") delete w.incident;
				else [inc.told, inc.reminds, inc.toldAt, inc.due, inc.untold] = [inc.told + 1, inc.reminds + (flag.kind === "remind" ? 1 : 0), now, undefined, undefined];
			} else if (!inc.untold) (inc.untold = true, d.log("stall-untold", { kind: flag.kind, pid: w.pid, pane: w.pane, session: flag.session, signals: flag.signals.join("+") }));
		}
	}

	return {
		async sample(table) {
			if (busy) return;
			busy = true;
			try {
				const now = d.now();
				if (lastAt !== undefined && now - lastAt < SAMPLE_MS - SLACK_MS) return;
				// The settings are read at each sample. A watch that is off takes no reading, so the first sample after it is turned on starts every count.
				const cfg = d.config(), gap = lastAt === undefined || !on ? undefined : now - lastAt;
				[lastAt, on] = [now, cfg.enabled];
				if (!cfg.enabled) return;
				if (!loaded) load();
				await take(table, cfg, now, gap);
				save();
			} catch (error) {
				d.log("stall-error", { text: String((error as Error)?.message ?? error).slice(0, 200) });
			} finally {
				busy = false;
			}
		},
		list: () => [...watched.values()].flatMap((w) => (w.incident ? [{ pid: w.pid, session: w.session ?? "(unknown)", pane: w.pane, ...(w.workspace ? { workspace: w.workspace } : {}), signals: [...w.incident.signals], told: w.incident.told }] : [])),
	};
}
