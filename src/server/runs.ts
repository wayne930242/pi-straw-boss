import { randomBytes } from "node:crypto";
import { type HerdrRun, panes, type Sleep, startPi } from "../herdr.ts";
import { alive as pidAlive } from "../remote.ts";
import { startOf as processStartOf } from "../startof.ts";
import { assertSettingsSafe } from "../trust/settings.ts";
import { waitPastTrust } from "../trust/wait.ts";
import type { TowerView } from "../net.ts";
import type { Log } from "./log.ts";
import type { Slot } from "./record.ts";
import { addNote, clearTimer, listRuns, pruneRuns, readNotes, readTimer, type Outcome, type RunRecord, writeRun, writeTimer } from "./towerrunstore.ts";
import { appendEvent, dropParked, parkEvent, type QueuedEvent, readQueue, removeEvent, type ServiceRecord, unparkEvent, updateEvent } from "./towerstore.ts";
import { RUN_CAP_MINUTES } from "./towerbrief.ts";

// The runs of the tower service (docs/specs/2026-10-26-sb-backend.md, The wake protocol, Crash and timeout, Queueing and concurrency). An event wakes a run: a new pi started in the tower tab's standing pane
// with `--sb-run <run id>`. The run claims itself over the control socket (a run token, kept in memory only), gets the brief, takes its events one at a time when it is idle, and ends with `tower_done`
// and a handoff note. The server watches it: too long, idle without a note, crashed, or gone with a Herdr restart. One local run per workspace; at most `towerRuns.max` runs on the machine.
// This file holds no pi dependency: it runs in the server's bundle.

export interface Timers {
	/** Events are coalesced: a wake waits this long after the first. */
	wake: number;
	/** How long a started pi may take to claim (a trust question the boss answers is not counted). */
	claim: number;
	/** How often the server looks at its live runs. */
	watch: number;
	/** Idle without `tower_done`: a steer after this, the end after `idleEnd` more. */
	idleSteer: number;
	idleEnd: number;
	/** A steer to wrap up, and the end. */
	steerAt: number;
	quitAt: number;
	/** pi has not exited this long after `quit`: Escape and /quit through Herdr, then (after `signal`) SIGTERM. */
	quitGrace: number;
	signal: number;
	/** A run that has not polled for this long is lost: dead, or an orphan that gets quit. Also how long a run of a restarted server has to reconnect. */
	lost: number;
	/** After a refused settings check the next attempt comes no sooner than this. */
	refuse: number;
	/** Three crashed or timed-out runs in this window hold the service. */
	loop: number;
	/** A pi resumed in a pane that held a live run when Herdr went away is quit for this long after the restart. */
	restored: number;
}
export const TIMERS: Timers = { wake: 1000, claim: 60_000, watch: 2000, idleSteer: 60_000, idleEnd: 300_000, steerAt: 18 * 60_000, quitAt: RUN_CAP_MINUTES * 60_000, quitGrace: 10_000, signal: 5000, lost: 30_000, refuse: 60_000, loop: 600_000, restored: 120_000 };
const LOOP_MAX = 3;

export type ServiceState = "standing" | "waking" | "running" | "closing" | "held";
export interface Notice { id: string; level: "info" | "warning" | "error"; kind: "settings" | "loop" | "start" | "late"; text: string; at: number; detail?: string }
/** What the GUI and `status` show of a service's runs. */
export interface ServiceStatus {
	state: ServiceState;
	queued: number;
	run?: { id: string; kind: "local" | "ally"; startedAt: string };
	allyRuns: { device: string; startedAt: string }[];
	lastRun?: { endedAt: string; outcome: Outcome };
	notices: Notice[];
	parked: { id: string; kind: string; from?: string; first: string }[];
}

/** What the hub needs of a tower service (towers.ts implements it). */
export interface ServiceRef {
	workspace: string;
	record(): ServiceRecord;
	/** Whether the identity is registered with pi-intercom: runs reply under it. */
	live(): boolean;
	/** The folder the settings check looks at: the standing pane's, else the workspace's checkout path. */
	cwd(): Promise<string>;
	/** The brief for a run: the server builds it from the net, the opener's ledger, the digest, and the last note. */
	brief(input: { events: QueuedEvent[]; woken: number; run: RunRecord }): Promise<{ text: string; digestKeys: string[] }>;
	/** Drops the digest lines a run's brief showed. */
	clearDigest(keys: string[]): Promise<void>;
}

interface Active {
	rec: RunRecord;
	svc: Svc;
	token?: string;
	/** Commands for the run, handed out at its next poll. */
	commands: ({ type: "steer"; text: string } | { type: "quit" })[];
	lastPoll: number;
	idleSince?: number;
	started: number;
	closing?: number;
	steeredLong?: boolean;
	steeredIdle?: boolean;
	/** The outcome the run gets when it is gone, if it is not `done`/`crashed` by its own course. */
	pending?: Outcome;
	terminating?: number;
	escalated?: number;
	signalled?: boolean;
	digestKeys: string[];
	/** Events handed to the run and not yet confirmed `taken`. */
	offered: Map<string, QueuedEvent>;
	/** A run found on disk after a server restart that has not reconnected yet. */
	recovering?: number;
	ended?: boolean;
}
interface Svc {
	ref: ServiceRef;
	state: ServiceState;
	run?: Active;
	wake?: ReturnType<typeof setTimeout>;
	timer?: ReturnType<typeof setTimeout>;
	crashes: number[];
	notices: Notice[];
	lastRun?: { endedAt: string; outcome: Outcome };
	refusedAt?: number;
	/** Events a pending slot wait is for. */
	waiting?: boolean;
}

export interface RunsOptions {
	slot: Slot;
	run: HerdrRun;
	sleep: Sleep;
	now: () => number;
	log: Log;
	enabled(): boolean;
	max(): number;
	/** `<state dir>/trust`, where a pi that waits on a trust question leaves its request. */
	trustDir?: string;
	model(): string | undefined;
	timers?: Partial<Timers>;
	// Seams for tests: starting pi, the settings check, process liveness, the start time of a process, signals, and run ids.
	startPi?: typeof startPi;
	settings?: (dirs: string[]) => Promise<void>;
	alive?: (pid: number) => boolean;
	startOf?: (pid: number) => string | undefined;
	kill?: (pid: number, signal: NodeJS.Signals) => void;
	newId?: () => string;
	/** Events are appended with this, so a test can watch the store. */
	append?: typeof appendEvent;
}

const phrase = (value: unknown, max: number) => (typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");
const iso = (ms: number) => new Date(ms).toISOString();
const PRIORITY: Record<string, number> = { boss: 0, notice: 1, timer: 1, intercom: 1 };

export type ClaimRequest = Record<string, unknown>
export type ClaimReply = { ok: true; wait: true } | { ok: false; error: string } | { ok: true; token: string; kind: "local" | "ally"; level?: string; run: string; workspace: string; identity: string; label: string; brief: string; hand?: true };

export function createRuns(o: RunsOptions) {
	const t: Timers = { ...TIMERS, ...o.timers };
	const { slot, log, now } = o;
	const alive = o.alive ?? pidAlive, startOf = o.startOf ?? processStartOf, kill = o.kill ?? ((pid, signal) => void process.kill(pid, signal));
	const start = o.startPi ?? startPi, settings = o.settings ?? ((dirs: string[]) => assertSettingsSafe(dirs)), append = o.append ?? appendEvent;
	const newId = o.newId ?? (() => randomBytes(8).toString("hex"));
	const services = new Map<string, Svc>(), byToken = new Map<string, Active>(), byRun = new Map<string, Active>(), blocked = new Set<Svc>();
	let slots = 0, pendingTakeovers = 0, watcher: ReturnType<typeof setInterval> | undefined, stopped = false;
	/** Panes that held a live run when Herdr went away, with when a resumed pi there stops being the old run. */
	const restored = new Map<string, number>();
	const error = (code: string, text: string) => log.line("error", { code, text: phrase(text, 300) });

	// --- events -----------------------------------------------------------------------------------------------------------------------------------------------------

	/** Events waiting for a run: not taken, not offered, a timer only when due; the boss first, then in the order the server received them. */
	const waitingOf = (svc: Svc, offered: ReadonlySet<string> = new Set()): QueuedEvent[] =>
		readQueue(slot, svc.ref.workspace).filter((e) => !e.taken && !offered.has(e.id)).sort((a, b) => (PRIORITY[a.kind] ?? 1) - (PRIORITY[b.kind] ?? 1) || a.seq - b.seq);
	const noticeOf = (svc: Svc, n: Omit<Notice, "at">) => {
		svc.notices = [...svc.notices.filter((x) => x.id !== n.id), { ...n, at: now() }].slice(-10);
	};

	// --- wake -------------------------------------------------------------------------------------------------------------------------------------------------------

	const poke = (svc: Svc) => {
		if (stopped || svc.run || svc.wake || svc.state === "held" || !o.enabled()) return;
		if (svc.refusedAt !== undefined && now() - svc.refusedAt < t.refuse) return;
		if (!waitingOf(svc).length) return;
		svc.wake = setTimeout(() => ((svc.wake = undefined), void begin(svc).catch((cause: Error) => (error("run-begin", cause.message), (svc.state = "standing")))), t.wake);
		svc.wake.unref();
	};
	const release = () => {
		for (const svc of [...blocked]) (blocked.delete(svc), poke(svc));
	};
	const begin = async (svc: Svc) => {
		if (stopped || svc.run || svc.state !== "standing" || !o.enabled() || !waitingOf(svc).length) return;
		if (!svc.ref.live()) return; // the identity registers first: runs reply under it. The service pokes again when it is live.
		if (slots >= o.max()) return void blocked.add(svc);
		slots++;
		svc.state = "waking";
		const id = newId(), woken = now();
		const rec: RunRecord = { id, workspace: svc.ref.workspace, kind: "local", pane: svc.ref.record().pane, agent: agentName(slot, svc.ref.workspace, id), startedAt: iso(woken), events: [] };
		const active: Active = { rec, svc, commands: [], lastPoll: woken, started: woken, digestKeys: [], offered: new Map() };
		try {
			await settings([await svc.ref.cwd()]);
		} catch (cause) {
			slots--;
			svc.state = "standing";
			svc.refusedAt = now();
			noticeOf(svc, { id: "settings", level: "error", kind: "settings", text: `A run could not start: ${(cause as Error).message}` });
			log.line("run-refused", { workspace: svc.ref.workspace, why: "settings" });
			return;
		}
		svc.refusedAt = undefined;
		svc.notices = svc.notices.filter((n) => n.id !== "settings");
		svc.run = active;
		byRun.set(id, active);
		writeRun(slot, rec);
		log.line("run-start", { workspace: svc.ref.workspace, run: id, kind: "local" });
		ensureWatcher();
		try {
			await start(o.run, o.sleep, rec.agent, rec.pane, ["--name", `tower run · ${svc.ref.record().label} · ${id.slice(0, 8)}`, "--sb-run", id, ...(o.model() ? ["--model", o.model()!] : [])]);
			const found = await procOf(rec.pane, id);
			if (!found) throw new Error("pi's process was not found in the pane");
			rec.pid = found;
			rec.started = startOf(found);
			writeRun(slot, rec);
			const claimed = await waitPastTrust(o.sleep, () => active.token || active.ended, t.claim, 200, o.trustDir ? { dir: o.trustDir, pane: rec.pane } : undefined);
			if (!claimed) throw new Error(`pi did not claim the run within ${t.claim / 1000} s`);
		} catch (cause) {
			if (active.ended) return;
			error("run-start", `${rec.id}: ${(cause as Error).message}`);
			noticeOf(svc, { id: `start-${rec.id}`, level: "warning", kind: "start", text: `A run could not start: ${(cause as Error).message}` });
			terminate(active, "crashed");
			await finish(active, "crashed", (cause as Error).message);
		}
	};
	/** A Herdr agent name is lowercase, up to 32 characters, and unique per run. */
	const agentName = (s: Slot, workspace: string, id: string) => `tower-${s.primary ? "" : `${s.slot8}-`}${workspace.toLowerCase().replace(/[^a-z0-9_-]/g, "")}-${id.slice(0, 8)}`.slice(0, 32).replace(/[-_]+$/, "");
	/** pi's PID in the pane: the process whose command line holds the run id, else the one named pi. */
	const procOf = async (pane: string, runId?: string): Promise<number | undefined> => {
		try {
			const info = JSON.parse(await o.run(["pane", "process-info", "--pane", pane])).result?.process_info?.foreground_processes as { pid?: number; argv0?: string; name?: string; cmdline?: string }[] | undefined;
			const pick = (info ?? []).find((p) => runId && p.cmdline?.includes(runId)) ?? (info ?? []).find((p) => p.argv0 === "pi") ?? (info ?? []).filter((p) => p.name === "node")[0];
			return typeof pick?.pid === "number" ? pick.pid : undefined;
		} catch {
			return undefined;
		}
	};

	// --- the end of a run ---------------------------------------------------------------------------------------------------------------------------------------------

	/** Asks a run to leave (a command at its next poll), and falls back to Herdr's keys and then a signal if pi has not exited. */
	function terminate(a: Active, outcome?: Outcome) {
		if (a.ended) return;
		if (outcome && !a.pending) a.pending = outcome;
		a.terminating ??= now();
		if (!a.commands.some((c) => c.type === "quit")) a.commands.push({ type: "quit" });
	}
	const escalate = async (a: Active) => {
		const pane = a.rec.pane;
		if (a.escalated === undefined) {
			a.escalated = now();
			log.line("run-quit-keys", { run: a.rec.id });
			// pi has not exited: Escape and /quit through Herdr.
			for (const args of [["pane", "send-keys", pane, "esc"], ["pane", "send-text", pane, "/quit"], ["pane", "send-keys", pane, "enter"]]) await o.run(args).catch(() => {});
			return;
		}
		if (!a.signalled && now() - a.escalated >= t.signal) {
			a.signalled = true;
			// The PID is read from Herdr now, never taken from a record alone.
			const pid = await procOf(pane, a.rec.id);
			if (pid !== undefined) {
				log.line("run-sigterm", { run: a.rec.id, pid });
				try { kill(pid, "SIGTERM"); } catch { /* gone */ }
			}
		}
	};
	const gone = (a: Active) => {
		if (a.rec.pid !== undefined) return !alive(a.rec.pid) || (a.rec.started !== undefined && startOf(a.rec.pid) !== undefined && startOf(a.rec.pid) !== a.rec.started);
		return false;
	};

	/** Ends a run in the records: its events, its note, the crash rules, and the service goes back to standing (the next wake comes 1 s later). */
	async function finish(a: Active, outcome: Outcome, detail?: string) {
		if (a.ended) return;
		a.ended = true;
		const svc = a.svc, ws = svc.ref.workspace;
		a.rec.outcome = outcome;
		a.rec.endedAt = iso(now());
		if (detail) a.rec.detail = phrase(detail, 200);
		try { writeRun(slot, a.rec); pruneRuns(slot, ws); } catch (cause) { error("run-record", (cause as Error).message); }
		if (a.token) byToken.delete(a.token);
		byRun.delete(a.rec.id);
		slots = Math.max(0, slots - 1);
		if (svc.run === a) svc.run = undefined;
		const taken = readQueue(slot, ws).filter((e) => e.taken?.run === a.rec.id);
		const failed = outcome === "crashed" || outcome === "timeout";
		for (const e of taken) {
			try {
				if (!failed && outcome !== "herdr-restart") removeEvent(slot, ws, e);
				else if (outcome === "herdr-restart") updateEvent(slot, ws, { ...withoutTaken(e), flag: "crash" });
				else if ((e.crashes ?? 0) + 1 >= 2) (parkEvent(slot, ws, { ...withoutTaken(e), crashes: (e.crashes ?? 0) + 1, flag: "crash" }), noticeOf(svc, { id: `parked-${e.id}`, level: "warning", kind: "late", text: `An event was parked after two runs crashed with it: ${e.kind} ${e.from?.name ?? e.from?.id ?? ""}`.trim() }));
				else updateEvent(slot, ws, { ...withoutTaken(e), crashes: (e.crashes ?? 0) + 1, flag: "crash" });
			} catch (cause) { error("run-events", (cause as Error).message); }
		}
		if (failed) {
			try { addNote(slot, ws, { kind: a.rec.kind, ...(a.rec.device ? { device: a.rec.device } : {}), run: a.rec.id, at: iso(now()), note: `(${outcome === "timeout" ? "timed out" : "crashed"}: ${detail ?? outcome})` }); } catch (cause) { error("run-note", (cause as Error).message); }
		}
		svc.lastRun = { endedAt: a.rec.endedAt, outcome };
		svc.state = svc.state === "held" ? "held" : "standing";
		log.line("run-end", { workspace: ws, run: a.rec.id, outcome, ...(detail ? { detail: phrase(detail, 120) } : {}) });
		if (failed) {
			const cutoff = now() - t.loop;
			svc.crashes = [...svc.crashes.filter((x) => x > cutoff), now()];
			if (svc.crashes.length >= LOOP_MAX) {
				svc.state = "held";
				const tail = await o.run(["pane", "read", a.rec.pane, "--lines", "20"]).then((x) => x.trim().split("\n").slice(-20).join("\n"), () => "");
				noticeOf(svc, { id: "loop", level: "error", kind: "loop", text: `${LOOP_MAX} runs crashed or timed out in ${Math.round(t.loop / 60_000)} minutes, so the tower stops waking. The queue is kept; Retry, or a message from the boss, wakes it again.`, ...(tail ? { detail: tail } : {}) });
				log.line("run-loop", { workspace: ws });
			}
		}
		release();
		poke(svc);
	}
	const withoutTaken = (e: QueuedEvent): QueuedEvent => {
		const { taken: _taken, ...rest } = e;
		return rest;
	};

	// --- watching ---------------------------------------------------------------------------------------------------------------------------------------------------

	const ensureWatcher = () => {
		if (watcher || stopped) return;
		watcher = setInterval(() => void tick().catch((cause: Error) => error("run-watch", cause.message)), t.watch);
		watcher.unref();
	};
	let ticking = false;
	const tick = async () => {
		if (ticking) return;
		ticking = true;
		try {
			for (const a of [...byRun.values()]) {
				if (a.ended) continue;
				const age = now() - a.started;
				const exited = gone(a) || (a.rec.pid === undefined && a.token !== undefined && (await panes(o.run, a.rec.workspace).catch(() => undefined))?.every((p) => p.pane_id !== a.rec.pane) === true);
				if (exited) {
					const outcome = a.pending ?? (a.closing !== undefined ? "done" : "crashed");
					await finish(a, outcome, outcome === "crashed" ? "pi exited without tower_done" : undefined);
					continue;
				}
				if (a.recovering !== undefined) {
					if (now() - a.recovering > t.lost) (terminate(a, "crashed"), void escalate(a));
					continue;
				}
				if (a.terminating !== undefined) {
					if (now() - a.terminating >= t.quitGrace) await escalate(a);
					continue;
				}
				if (a.closing !== undefined) {
					if (now() - a.closing >= t.quitGrace) await escalate(a);
					continue;
				}
				if (!a.token) continue;
				if (now() - a.lastPoll > t.lost) {
					log.line("run-lost", { run: a.rec.id });
					terminate(a, "crashed");
					continue;
				}
				if (age >= t.quitAt) {
					a.pending = "timeout";
					terminate(a, "timeout");
				} else if (age >= t.steerAt && !a.steeredLong) {
					a.steeredLong = true;
					a.commands.push({ type: "steer", text: `You have run for ${Math.round(age / 60_000)} minutes and the cap is ${RUN_CAP_MINUTES}. Wrap up now and call tower_done with your handoff note.` });
				}
				if (a.idleSince !== undefined) {
					const idle = now() - a.idleSince;
					if (idle >= t.idleSteer + t.idleEnd) {
						try { addNote(slot, a.rec.workspace, { kind: a.rec.kind, ...(a.rec.device ? { device: a.rec.device } : {}), run: a.rec.id, at: iso(now()), note: "(ended without a note)" }); } catch (cause) { error("run-note", (cause as Error).message); }
						terminate(a, "quit");
					} else if (idle >= t.idleSteer && !a.steeredIdle) {
						a.steeredIdle = true;
						a.commands.push({ type: "steer", text: "You are idle with nothing pending. Call tower_done with your handoff note." });
					}
				}
			}
			if (!byRun.size) (clearInterval(watcher), (watcher = undefined));
		} finally {
			ticking = false;
		}
	};

	// --- claims -----------------------------------------------------------------------------------------------------------------------------------------------------

	const refuse = (error: string): ClaimReply => ({ ok: false, error });
	/** Issues the run's token and its brief. */
	const issue = async (a: Active, hand?: true): Promise<ClaimReply> => {
		const svc = a.svc, events = waitingOf(svc);
		const built = await svc.ref.brief({ events, woken: a.started, run: a.rec });
		a.digestKeys = built.digestKeys;
		a.token = randomBytes(24).toString("hex");
		a.lastPoll = now();
		a.recovering = undefined;
		a.rec.claimed = true;
		writeRun(slot, a.rec);
		byToken.set(a.token, a);
		svc.state = "running";
		log.line("run-claim", { workspace: a.rec.workspace, run: a.rec.id, ...(hand ? { hand: true } : {}) });
		const r = svc.ref.record();
		return { ok: true, token: a.token, kind: a.rec.kind, ...(a.rec.level ? { level: a.rec.level } : {}), run: a.rec.id, workspace: a.rec.workspace, identity: r.id, label: r.label, brief: built.text, ...(hand ? { hand } : {}) };
	};
	const heldReply = (): ClaimReply => ({ ok: true, wait: true });

	/** `--sb-run`: the pi the server started claims its run. */
	async function claim(req: ClaimRequest): Promise<ClaimReply> {
		const runId = phrase(req.runId, 64), pane = phrase(req.pane, 64), pid = req.pid, started = typeof req.started === "string" ? req.started : undefined;
		if (!runId || !pane || typeof pid !== "number" || !Number.isInteger(pid)) return refuse("a claim needs the run id, the pane, and the PID");
		// Until every Herdr takeover the server has seen is processed, a claim is held: a pi that Herdr's integration resumed meets a run that is already ended.
		if (pendingTakeovers > 0) return heldReply();
		const a = byRun.get(runId);
		if (!a || a.ended) return refuse("this run is not one the server has live (it ended, or it never started)");
		if (a.rec.pid === undefined) return a.rec.claimed ? refuse("this run cannot be matched") : heldReply();
		if (a.rec.pane !== pane || a.rec.pid !== pid || (a.rec.started !== undefined && started !== undefined && started !== a.rec.started)) return refuse("the pane, PID, or start time are not the ones the server recorded for this run");
		if (a.token) return refuse("this run was claimed already");
		return issue(a);
	}
	/** A pi without the flag in a pane the server lists as a standing pane (or an ally pane): quit, or take the pane as a run of the boss's own. */
	async function paneRole(req: Record<string, unknown>): Promise<{ ok: true; role: "none" | "quit" | "wait" | "hand"; reason?: string; claim?: ClaimReply }> {
		const pane = phrase(req.pane, 64), pid = req.pid;
		const svc = [...services.values()].find((s) => s.ref.record().pane === pane);
		if (!svc || typeof pid !== "number") return { ok: true, role: "none" };
		if (pendingTakeovers > 0) return { ok: true, role: "wait" };
		if ((restored.get(pane) ?? 0) > now()) return { ok: true, role: "quit", reason: "Herdr restored this pane after a restart and resumed the old run's pi; the server starts its runs itself" };
		if (svc.run && !svc.run.ended) return { ok: true, role: "quit", reason: "a run of the tower service holds this pane" };
		// The boss started pi by hand in the standing pane: a local run with the brief and no events.
		slots++;
		const woken = now(), id = newId();
		const rec: RunRecord = { id, workspace: svc.ref.workspace, kind: "local", pane, agent: "hand", pid, ...(typeof req.started === "string" ? { started: req.started } : {}), startedAt: iso(woken), events: [], hand: true };
		const a: Active = { rec, svc, commands: [], lastPoll: woken, started: woken, digestKeys: [], offered: new Map() };
		svc.run = a;
		byRun.set(id, a);
		writeRun(slot, rec);
		ensureWatcher();
		return { ok: true, role: "hand", claim: await issue(a, true) };
	}

	// --- the run's requests -------------------------------------------------------------------------------------------------------------------------------------------

	const of = (token: unknown): Active | undefined => (typeof token === "string" ? byToken.get(token) : undefined);
	const unknown = { ok: false as const, error: "unknown_token" };
	/** The run's poll: its heartbeat, and at idle the next event; or a command (steer, quit). */
	function poll(req: Record<string, unknown>) {
		const a = of(req.token);
		if (!a || a.ended) return unknown;
		a.lastPoll = now();
		const command = a.commands.shift();
		if (command) return { ok: true as const, command };
		if (a.terminating !== undefined || a.closing !== undefined) return { ok: true as const };
		if (req.idle !== true) return (a.idleSince = undefined, { ok: true as const });
		// An event offered and not yet taken is offered again (the run did not confirm it); then the next one waiting.
		const again = [...a.offered.values()][0], next = again ?? waitingOf(a.svc, new Set(a.offered.keys()))[0];
		if (!next) return (a.idleSince ??= now(), { ok: true as const });
		a.idleSince = undefined;
		a.steeredIdle = false;
		a.offered.set(next.id, next);
		return { ok: true as const, event: { id: next.id, kind: next.kind, text: next.text, from: next.from, at: next.at, ...(next.flag ? { flag: next.flag } : {}) } };
	}
	/** The run says an event is in its session. */
	function taken(req: Record<string, unknown>) {
		const a = of(req.token);
		if (!a || a.ended) return unknown;
		const event = typeof req.id === "string" ? a.offered.get(req.id) : undefined;
		if (!event) return { ok: false as const, error: "that event was not offered to this run" };
		updateEvent(slot, a.rec.workspace, { ...event, taken: { run: a.rec.id, at: iso(now()) } });
		a.offered.delete(event.id);
		a.rec.events.push(event.id);
		writeRun(slot, a.rec);
		return { ok: true as const };
	}
	/** `tower_done`: refused while events are outstanding; otherwise the note is kept, the digest lines it showed are cleared, and the run is told to leave. */
	async function done(req: Record<string, unknown>) {
		const a = of(req.token);
		if (!a || a.ended) return unknown;
		if (a.closing !== undefined) return { ok: true as const };
		const note = typeof req.note === "string" ? req.note.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/g, "").split("\n").map((l) => l.trim()).filter(Boolean).join("\n") : "";
		if (!note || note.length > 1200) return { ok: false as const, error: "the handoff note is 1 to 1,200 characters, one item per line" };
		if (req.wakeAfter !== undefined && a.rec.kind !== "local") return { ok: false as const, error: "an ally run schedules no wake" };
		const wake = req.wakeAfter;
		if (wake !== undefined && (typeof wake !== "number" || !Number.isInteger(wake) || wake < 5 || wake > 240)) return { ok: false as const, error: "wakeAfter is 5 to 240 minutes" };
		const outstanding = a.offered.size + waitingOf(a.svc, new Set(a.offered.keys())).length;
		if (outstanding) return { ok: false as const, error: `${outstanding} event${outstanding > 1 ? "s" : ""} still for you: they come to you at your next idle moment; handle them, then call tower_done again` };
		addNote(slot, a.rec.workspace, { kind: a.rec.kind, ...(a.rec.device ? { device: a.rec.device } : {}), run: a.rec.id, at: iso(now()), note });
		if (a.rec.kind === "local") await a.svc.ref.clearDigest(a.digestKeys).catch(() => {});
		if (wake !== undefined) schedule(a.svc, now() + wake * 60_000, iso(now()));
		a.closing = now();
		a.svc.state = "closing";
		a.commands.length = 0;
		return { ok: true as const };
	}
	/** `/new`, `/resume`, or `/fork` in a run end its claim: the next event wakes a fresh run. */
	async function releaseRun(req: Record<string, unknown>) {
		const a = of(req.token);
		if (!a || a.ended) return unknown;
		a.pending = "quit";
		await finish(a, "quit", phrase(req.reason, 60) || "the session was replaced");
		return { ok: true as const };
	}

	// --- timers (`wakeAfter`) -----------------------------------------------------------------------------------------------------------------------------------------

	/** One pending timer per workspace: a later one replaces it. */
	function schedule(svc: Svc, at: number, asked: string) {
		clearTimeout(svc.timer);
		writeTimer(slot, svc.ref.workspace, { at, asked });
		svc.timer = setTimeout(() => fire(svc), Math.max(0, at - now()));
		svc.timer.unref();
	}
	const fire = (svc: Svc) => {
		svc.timer = undefined;
		clearTimer(slot, svc.ref.workspace);
		try {
			append(slot, svc.ref.record(), { kind: "timer", text: "The follow-up you asked for with wakeAfter is due.", at: iso(now()) });
		} catch (cause) { return error("timer", (cause as Error).message); }
		poke(svc);
	};

	// --- services ---------------------------------------------------------------------------------------------------------------------------------------------------

	/** A service with a tower of its own: reads what the last server left (live runs to take back, events a dead run held, the pending timer). */
	function attach(ref: ServiceRef): Svc {
		const prior = services.get(ref.workspace);
		if (prior) return (prior.ref = ref, prior);
		const svc: Svc = { ref, state: "standing", crashes: [], notices: [] };
		services.set(ref.workspace, svc);
		const ws = ref.workspace, live = new Set<string>();
		for (const rec of listRuns(slot, ws).filter((r) => !r.outcome)) {
			// A run of a server that went away: it has `lost` to reconnect with its run id; until then it is the service's run.
			const a: Active = { rec, svc, commands: [], lastPoll: now(), started: Date.parse(rec.startedAt) || now(), digestKeys: [], offered: new Map(), recovering: now() };
			svc.run = svc.run ?? a;
			svc.state = "running";
			byRun.set(rec.id, a);
			slots++;
			live.add(rec.id);
		}
		if (live.size) ensureWatcher();
		// Events a dead run held (the server was down when it ended): handled as a crash.
		for (const e of readQueue(slot, ws)) if (e.taken && !live.has(e.taken.run)) {
			try { updateEvent(slot, ws, { ...withoutTaken(e), crashes: (e.crashes ?? 0) + 1, flag: "crash" }); } catch (cause) { error("run-events", (cause as Error).message); }
		}
		const timer = readTimer(slot, ws);
		if (timer) schedule(svc, timer.at, timer.asked);
		poke(svc);
		return svc;
	}
	/** The service is gone (the boss closed the tower, its tab is gone, the flag went off): its runs end. */
	async function detach(workspace: string, why = "the tower service ended") {
		const svc = services.get(workspace);
		if (!svc) return;
		services.delete(workspace);
		clearTimeout(svc.wake);
		clearTimeout(svc.timer);
		blocked.delete(svc);
		const a = svc.run;
		if (a && !a.ended) {
			terminate(a, "quit");
			await finish(a, "quit", why);
		}
	}
	const find = (workspace: string) => services.get(workspace);

	const api = {
		attach, detach, poke: (workspace: string) => { const s = services.get(workspace); if (s) poke(s); },
		claim, paneRole, poll, taken, done, release: releaseRun,
		/** The run behind a token, or undefined. */
		runOf: (token: unknown): { id: string; workspace: string; kind: "local" | "ally"; level?: string; device?: string; pane: string } | undefined => {
			const a = of(token);
			return a && !a.ended ? { id: a.rec.id, workspace: a.rec.workspace, kind: a.rec.kind, ...(a.rec.level ? { level: a.rec.level } : {}), ...(a.rec.device ? { device: a.rec.device } : {}), pane: a.rec.pane } : undefined;
		},
		/** A new Herdr server took over: the takeover is counted until `settled` (claims are held meanwhile), and every live run ends with outcome `herdr-restart`. */
		takeoverBegin() {
			pendingTakeovers++;
			for (const a of [...byRun.values()]) restored.set(a.rec.pane, now() + t.restored);
		},
		async takeoverEnd() {
			const runs = [...byRun.values()];
			for (const a of runs) await finish(a, "herdr-restart");
			pendingTakeovers = Math.max(0, pendingTakeovers - 1);
		},
		/** The boss writes to the tower (the GUI's composer, `/boss tower <prompt>`): an event ahead of the rest; a held service wakes again. */
		boss(workspace: string, text: string, from = "the boss"): QueuedEvent {
			const svc = services.get(workspace);
			if (!svc) throw new Error(`The sb server stands in for no tower of workspace ${workspace}`);
			const written = append(slot, svc.ref.record(), { kind: "boss", from: { id: "boss", name: from }, text, at: iso(now()) });
			if (svc.state === "held") (svc.state = svc.run ? "running" : "standing", (svc.crashes = []), (svc.notices = svc.notices.filter((n) => n.id !== "loop")));
			poke(svc);
			return written;
		},
		/** A late outcome of something a run sent after the run ended: a notice event for the next run. */
		notice(workspace: string, text: string, key: string) {
			const svc = services.get(workspace);
			if (!svc) return;
			if (waitingOf(svc).some((e) => e.kind === "notice" && e.messageId === key)) return;
			append(slot, svc.ref.record(), { kind: "notice", text, at: iso(now()), messageId: key });
			poke(svc);
		},
		/** Retry on the crash-loop notice. */
		retry(workspace: string) {
			const svc = services.get(workspace);
			if (!svc) throw new Error(`The sb server stands in for no tower of workspace ${workspace}`);
			svc.crashes = [];
			svc.notices = svc.notices.filter((n) => n.id !== "loop");
			if (svc.state === "held") svc.state = "standing";
			poke(svc);
		},
		deliverAgain(workspace: string, id: string) {
			const svc = services.get(workspace), e = readQueue(slot, workspace, true).find((x) => x.id === id);
			if (!svc || !e) throw new Error("No such parked event");
			unparkEvent(slot, workspace, e);
			svc.notices = svc.notices.filter((n) => n.id !== `parked-${id}`);
			poke(svc);
		},
		dropParked(workspace: string, id: string) {
			const svc = services.get(workspace), e = readQueue(slot, workspace, true).find((x) => x.id === id);
			if (!svc || !e) throw new Error("No such parked event");
			dropParked(slot, workspace, e);
			svc.notices = svc.notices.filter((n) => n.id !== `parked-${id}`);
		},
		status(workspace: string): ServiceStatus | undefined {
			const svc = find(workspace);
			if (!svc) return undefined;
			const run = svc.run;
			return {
				state: svc.state,
				queued: waitingOf(svc, new Set(run?.offered.keys() ?? [])).length,
				...(run ? { run: { id: run.rec.id, kind: run.rec.kind, startedAt: run.rec.startedAt } } : {}),
				allyRuns: [],
				...(svc.lastRun ? { lastRun: svc.lastRun } : {}),
				notices: svc.notices,
				parked: readQueue(slot, workspace, true).map((e) => ({ id: e.id, kind: e.kind, ...(e.from?.name ?? e.from?.id ? { from: e.from?.name ?? e.from?.id } : {}), first: phrase(e.text.split("\n").find((l) => l.trim()) ?? "", 120) })),
			};
		},
		/** The waiting events of a workspace for the GUI's queue rows. */
		queue: (workspace: string) => { const s = find(workspace); return s ? waitingOf(s, new Set(s.run?.offered.keys() ?? [])) : []; },
		/** The session file of the live run, else of the last local run (the comms of the tower unit). */
		file: (workspace: string): string | undefined => {
			const svc = find(workspace);
			return svc?.run?.rec.file ?? listRuns(slot, workspace).filter((r) => r.kind === "local" && r.file).at(-1)?.file;
		},
		/** The pi session file the run's pane reports, kept in the record. */
		setFile(token: unknown, file: unknown) {
			const a = of(token);
			if (!a || typeof file !== "string" || file.length > 4096) return;
			a.rec.file = file;
			writeRun(slot, a.rec);
		},
		/**
		 * A run token for a run the server did not start through pi: B6 issues an ally run's token this way once it has started its pane, and the tests use it to hold an ally token to its kind. It has no pane
		 * or PID, so the watcher leaves it alone (`release` ends it).
		 */
		mint(workspace: string, who: { kind: "local" | "ally"; device?: string; level?: string }): string {
			const svc = services.get(workspace);
			if (!svc) throw new Error(`The sb server stands in for no tower of workspace ${workspace}`);
			const rec: RunRecord = { id: newId(), workspace, kind: who.kind, ...(who.device ? { device: who.device } : {}), ...(who.level ? { level: who.level } : {}), pane: svc.ref.record().pane, agent: "minted", startedAt: iso(now()), events: [] };
			const a: Active = { rec, svc, commands: [], lastPoll: now(), started: now(), digestKeys: [], offered: new Map(), token: randomBytes(24).toString("hex") };
			byToken.set(a.token!, a);
			return a.token!;
		},
		async stop() {
			stopped = true;
			clearInterval(watcher);
			watcher = undefined;
			for (const svc of services.values()) (clearTimeout(svc.wake), clearTimeout(svc.timer));
		},
		/** The notes of a service, for the brief. */
		notes: (workspace: string) => readNotes(slot, workspace),
		running: () => slots,
		tick,
		/** What the GUI shows of a tower the server runs: the service's state, its waiting events as queued rows (kind, sender, first line), and the session file of its comms. */
		view(workspace: string): TowerView | undefined {
			const status = api.status(workspace);
			if (!status) return undefined;
			const rows = api.queue(workspace).map((e) => ({ text: phrase(`${e.kind}${e.from?.name ?? e.from?.id ? ` · ${e.from?.name ?? e.from?.id}` : ""}: ${e.text.split("\n").find((l) => l.trim()) ?? ""}`, 240), as: "followUp" as const }));
			const file = api.file(workspace);
			return { ...status, queue: rows, ...(file ? { file } : {}) };
		},
	};
	return api;
}
export type Runs = ReturnType<typeof createRuns>;
