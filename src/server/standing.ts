import { type HerdrApi, type HerdrRun, type HerdrWorld, isStandin, type Pane, releaseStandin, reportStandin, type Sleep } from "../herdr.ts";
import { alive as pidAlive } from "../remote.ts";
import type { Log } from "./log.ts";
import type { ServiceStatus } from "./runs.ts";

// The standing pane between runs (docs/how-it-works.md, The standing pane; docs/specs/2026-10-26-sb-backend.md, The tower service). A tower's standing pane is no bare shell: the server types the tower prompt's
// command into it (`cli.mjs prompt`, src/towerprompt/), and while that process polls, it reports a stand-in agent `tower` on the pane, so the tower keeps its row in Herdr's Agents list (and in the
// net view) between runs. Herdr clears a reported agent about a second after the pane's foreground is back at its idle shell prompt, whatever the label (docs of Herdr, "Release on exit", and checked on
// 0.9.5), so the label is kept by the prompt being there, and the server has the prompt come back whenever the pane is free: after a run, a Herdr restart, a crashed prompt. It never types into a pane
// that runs something, that has an agent, or that the boss took with Ctrl+D (parked until a run takes the pane or Herdr restarts), and it releases the stand-in and has the prompt leave before a run starts pi there (Herdr starts an agent only in an
// available shell).

export interface StandingTimers {
	/** How often the server looks at every standing pane. */
	intervalMs: number;
	/** How long after its last poll the prompt still counts as there. */
	presentMs: number;
	/** How long after the command was typed nothing is typed again; each typing with no poll after it doubles the wait, up to `launchMaxMs`. */
	launchMs: number;
	launchMaxMs: number;
	/** How long a run's start waits for the prompt to leave, and then again after Ctrl+C. */
	leaveMs: number;
	/** How long a reported stand-in stands before it is reported again (Herdr keeps it without a refresh; the report also repairs a label Herdr lost). */
	refreshMs: number;
	/** How long a resident tower's hand-over is waited on for its pi to leave the pane, and how long the pane it freed is believed to be a bare shell after that (Windows lists the shell alone whatever runs under it). */
	handMs: number;
}
export const STANDING: StandingTimers = { intervalMs: 3000, presentMs: 6000, launchMs: 15_000, launchMaxMs: 10 * 60_000, leaveMs: 3000, refreshMs: 4 * 60_000, handMs: 60_000 };
/** Failed typings of the command (Herdr refused `pane run`) in a row, retried one `launchMs` apart, before the server says so (once) and waits for the pane's next fresh start. */
const TYPE_TRIES = 3;
/** Reports of the stand-in that Herdr did not keep, in a row, before the server says so (once) and stops asking for this prompt. */
const MISSES = 3;
/** Typings of the command with no poll after any of them, in a row, before the server says so (once); it goes on at the capped pace. */
const NO_START = 3;
/** A run whose wake is due within this long is about to take the standing pane: the prompt is not typed into it (it starts slower than the run waits, a cold PowerShell and node: 29 s on the VM). */
const RUN_SOON_MS = 5000;
const SHELLS = new Set(["zsh", "bash", "fish", "sh", "dash", "ksh", "tcsh", "csh", "nu", "login", "pwsh", "powershell", "cmd"]);

/** What the standing logic needs of one tower service (towers.ts builds it). */
export interface StandingTarget {
	workspace: string;
	label(): string;
	/** The standing pane now (the record's, which a Herdr restart may change). */
	pane(): string;
	/** Whether the identity is registered: nothing is typed or reported before. */
	live(): boolean;
	status(): ServiceStatus | undefined;
	/** Whether a run starts in the pane within `ms`: a prompt typed now would only have to start, poll, and leave before the run's pi can. */
	runWithin?(ms: number): boolean;
	/** The service is held because the pane runs a program of the boss's (runs.ts), and the call that starts it again. */
	paneBusy?(): boolean;
	/** The PIDs of the boss's programs that held the pane when the start failed (Windows proves the pane free by these being gone). */
	busyPids?(): number[];
	paneFree?(): void;
}
export interface StandingOptions {
	run: HerdrRun;
	api: HerdrApi;
	world: HerdrWorld;
	sleep: Sleep;
	now: () => number;
	log: Log;
	/** The line typed into the pane's shell to start the prompt; undefined when none can be made (a path the shells could not take). */
	command(workspace: string): string | undefined;
	timers?: Partial<StandingTimers>;
	/** The platform of the Herdr the panes belong to (tests set it); on win32 the foreground group is not believed. */
	platform?: NodeJS.Platform;
	/** Whether a process runs (the resident tower that handed a pane over); the PID check of `remote.ts` by default. */
	alive?: (pid: number) => boolean;
}
/** What a prompt's poll is answered. */
export type PromptReply = { ok: true; label: string; state: ServiceStatus["state"]; queued: number; leave: boolean } | { ok: false; error: string; gone?: true };

interface Mine {
	target: StandingTarget;
	seen?: { pid: number; at: number };
	/** A run is about to start or holds the pane: the prompt is told to leave. */
	leaving: boolean;
	/** The boss took the shell with Ctrl+D: nothing is typed until a run takes the pane (`freed`) or Herdr restarts (`reset`). */
	parked: boolean;
	/** When the command was last typed. */
	launched?: number;
	/** Typings since the last poll: the wait before the next one doubles with each. */
	typings: number;
	/** The server knows the pane is a fresh shell: just made, just freed by a run, a resident tower's pane once its pi is gone, or after a Herdr restart. Where Herdr gives no foreground group, this is the only time the server types. */
	fresh: boolean;
	/** A resident tower handed this pane over and its pi may still run there: the pane counts as fresh only once that process is gone (`pid`, when the tower said it), and for no longer than `handMs` after the hand-over. */
	hand?: { pid?: number; at: number };
	/** When a fresh mark that came from a hand-over lapses (the pane is not believed to be a bare shell for ever on the word of a hand-over). */
	freshUntil?: number;
	/** Typings Herdr refused in a row. */
	failures: number;
	/** Looks in a row at which a held pane's busy programs were gone and the list showed shells only (Windows). */
	busyClear: number;
	/** The server said the prompt does not start. */
	noStart: boolean;
	/** The server said, once, that the prompt is gone from a pane it cannot type into (Windows, a pane that is not fresh). */
	lost: boolean;
	/** The last stand-in reported, and how often Herdr did not keep it in a row. */
	reported?: { message: string; at: number };
	misses: number;
	/** The server said the label is not kept, for the prompt with this pid. */
	unsupported?: number;
}

/** The short state the stand-in's message gives: `standing by`, `3 queued`, or `held`. */
export function standinMessage(status: Pick<ServiceStatus, "state" | "queued"> | undefined): string {
	if (status?.state === "held") return "held";
	return status && status.queued > 0 ? `${status.queued} queued` : "standing by";
}

const nameOf = (p: { argv0?: string; name?: string }) => String(p.argv0 ?? p.name ?? "").replace(/^-/, "").split(/[\\/]/).pop()!.toLowerCase().replace(/\.exe$/, "");
/** The programs in the pane's foreground that are no shell and not the tower prompt: what the boss runs there. Empty when none is listed or all are shells. */
export function programProcs(info: { foreground_processes?: unknown } | undefined): { pid?: number; name?: string; argv0?: string; cmdline?: string }[] {
	const procs = Array.isArray(info?.foreground_processes) ? (info!.foreground_processes as { pid?: number; name?: string; argv0?: string; cmdline?: string }[]) : [];
	return procs.filter((p) => !SHELLS.has(nameOf(p)) && !/\bprompt --workspace\b/.test(p.cmdline ?? ""));
}
/** What a notice calls a program: its executable's file name, never the path it ran from or the arguments it was given. */
export const programName = (p: { argv0?: string; name?: string }): string => String(p.argv0 ?? p.name ?? "").trim().split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, " ").split(" ")[0]!.slice(0, 60) || "?";
export const programsIn = (info: { foreground_processes?: unknown } | undefined): string[] => programProcs(info).map(programName);

/**
 * Whether Herdr's process info positively says the pane's foreground is its shell at an idle prompt. With the shell's pid and the foreground group (macOS, Linux) the groups decide. Without them (Windows lists the
 * shell alone whether a build runs under it or not) a list of shells is no proof of an idle prompt: it counts only for a pane the server knows is fresh (`fresh`), and an empty or missing list is unknown, never idle.
 * `groups: false` is Windows: Herdr's process-info there carries both numbers, but the group is always the shell's pid (B6 VM, F10: `ping -t` in the pane still said idle), so they prove nothing.
 */
export function idleShell(info: { shell_pid?: unknown; foreground_process_group_id?: unknown; foreground_processes?: unknown } | undefined, fresh = false, groups = true): boolean {
	if (!info) return false;
	if (groups && typeof info.shell_pid === "number" && typeof info.foreground_process_group_id === "number") return info.foreground_process_group_id === info.shell_pid;
	const procs = Array.isArray(info.foreground_processes) ? (info.foreground_processes as { name?: string; argv0?: string }[]) : [];
	return fresh && procs.length > 0 && procs.every((p) => SHELLS.has(nameOf(p)));
}

/** What the shells the panes run can take unquoted inside double quotes: letters, digits, spaces, and the punctuation of a path. A path with a quote, `$`, a backtick, `%`, or `!` makes no command. */
const SAFE = /^[\p{L}\p{N} ._:/\\@+=~,()-]+$/u;
/**
 * The line typed into a standing pane: `node "<cli>" prompt --workspace <id> --state-dir "<dir>"`, which sh, zsh, bash, fish, PowerShell, and cmd all take (a leading quoted word would need `&` in PowerShell, so
 * `node` is the first word; it is on the PATH of the shell the boss runs pi from). The prompt gets the state folder by flag because the pane's environment is the boss's, not the server's.
 */
export function promptCommand(cli: string, stateDir: string, workspace: string): string | undefined {
	if (!SAFE.test(cli) || !SAFE.test(stateDir) || !/^[\w.:-]+$/.test(workspace)) return undefined;
	return `node "${cli}" prompt --workspace ${workspace} --state-dir "${stateDir}"`;
}

export function createStanding(o: StandingOptions) {
	const t: StandingTimers = { ...STANDING, ...o.timers };
	const { run, api, world, sleep, now, log } = o;
	const alive = o.alive ?? pidAlive;
	const groups = (o.platform ?? process.platform) !== "win32";
	const mines = new Map<string, Mine>();
	let timer: ReturnType<typeof setInterval> | undefined, ticking: Promise<void> = Promise.resolve(), stopped = false;
	const error = (code: string, text: string, max = 300) => log.line("error", { code, text: text.slice(0, max) });

	const present = (m: Mine) => m.seen !== undefined && now() - m.seen.at < t.presentMs;
	const processInfo = async (pane: string) => {
		try {
			return JSON.parse(await run(["pane", "process-info", "--pane", pane])).result?.process_info as { shell_pid?: unknown; foreground_process_group_id?: unknown; foreground_processes?: { pid?: number }[] } | undefined;
		} catch {
			return undefined;
		}
	};
	/** Takes the stand-in away if the server reported one; the pane may be gone, or Herdr may have cleared it already. */
	const unreport = async (m: Mine) => {
		if (!m.reported) return;
		m.reported = undefined;
		await releaseStandin(api, m.target.pane()).catch(() => {});
	};
	const report = async (m: Mine, pane: Pane | undefined, message: string) => {
		// A label Herdr did not keep (it answered the report and the pane shows no stand-in at the next look) is counted; at the third in a row the server says so once and stops.
		if (m.reported && !(pane && isStandin(pane))) m.misses++;
		if (m.misses >= MISSES) {
			if (m.unsupported !== m.seen?.pid) {
				m.unsupported = m.seen?.pid;
				log.line("standin-unsupported", { workspace: m.target.workspace, pane: m.target.pane(), text: "Herdr did not keep the stand-in agent `tower` on the pane while the prompt runs there; the tower has no row in the Agents list between runs" });
			}
			return;
		}
		try {
			await reportStandin(api, m.target.pane(), message);
			m.reported = { message, at: now() };
		} catch (cause) {
			error("standin", `${m.target.workspace}: ${(cause as Error).message}`);
		}
	};

	/** A resident tower's hand-over frees the pane when its pi has left it: the process is gone (it said which), within `handMs`. The mark then lasts `handMs` more, or until the command is typed. */
	const proveHand = (m: Mine) => {
		if (m.freshUntil !== undefined && now() > m.freshUntil) Object.assign(m, { fresh: false, freshUntil: undefined });
		if (!m.hand) return;
		if (now() - m.hand.at > t.handMs) m.hand = undefined;
		else if (m.hand.pid === undefined || !alive(m.hand.pid)) Object.assign(m, { hand: undefined, fresh: true, freshUntil: now() + t.handMs, failures: 0 });
	};

	/** One look at one standing pane. */
	const look = async (m: Mine, panes: Pane[]) => {
		const target = m.target, pane = panes.find((p) => p.pane_id === target.pane());
		if (!pane || !target.live()) return;
		const status = target.status();
		// A held service waits for the boss's program to end: the pane's foreground is looked at, and the runs start again once it is back at its shell.
		if (target.paneBusy?.()) {
			const info = await processInfo(pane.pane_id);
			if (groups) {
				if (idleShell(info, true, groups)) target.paneFree?.();
				return;
			}
			// Without foreground groups (Windows) a list of shells is no proof that the program ended: the programs that held the pane must be gone themselves (not alive, not listed), and the list must show the shell alone
			// at two looks in a row. A build the boss started after the first ended is still invisible there; that is what the second look and the pane's own `Retry` are for (RV7-F003).
			const pids = target.busyPids?.() ?? [], listed = Array.isArray(info?.foreground_processes) ? (info!.foreground_processes as { pid?: number }[]).map((p) => p.pid) : [];
			m.busyClear = pids.length > 0 && pids.every((pid) => !alive(pid) && !listed.includes(pid)) && idleShell(info, true, groups) ? m.busyClear + 1 : 0;
			if (m.busyClear >= 2) {
				m.busyClear = 0;
				target.paneFree?.();
			}
			return;
		}
		// A run holds the pane (or is about to): the prompt has left or is leaving, and no stand-in stands over the run's pi.
		if (m.leaving || (status && ["waking", "running", "closing"].includes(status.state))) {
			if (m.reported && !isStandin(pane)) m.reported = undefined;
			return;
		}
		// Another agent holds the pane (a pi of the boss's own): the stand-in is not reported over it, and Herdr would not take it.
		if (pane.agent && !isStandin(pane)) {
			m.reported = undefined;
			return;
		}
		if (present(m)) {
			m.parked = false;
			if (isStandin(pane)) m.misses = 0;
			const message = standinMessage(status);
			if (!isStandin(pane) || !m.reported || m.reported.message !== message || now() - m.reported.at >= t.refreshMs) await report(m, pane, message);
			return;
		}
		// The prompt is not there. Herdr clears its label itself a moment after; a release makes it at once.
		await unreport(m);
		// The boss's Ctrl+D leaves the shell to them until a run takes the pane or Herdr restarts: no clock gives it back, since a prompt typed over their half-written line or the command they are about to run would run it.
		if (m.parked) return;
		// A run is about to take the pane (an event waits and its wake is due): the prompt is not typed, and the stand-in stays as it is.
		if (!present(m) && target.runWithin?.(RUN_SOON_MS)) return;
		// A wake is coming (the prompt posted the boss's words and left): a run takes the pane in a moment, and a prompt typed now would only have to leave again.
		if (m.launched !== undefined && now() - m.launched < Math.min(t.launchMs * 2 ** Math.max(0, m.typings - 1), t.launchMaxMs)) return;
		if (pane.agent) return;
		const command = o.command(target.workspace);
		if (!command) return;
		proveHand(m);
		// The resident tower's pi may still run in the pane: nothing is typed, and nothing is said about a prompt that is lost, until it has gone or the hand-over's time is up.
		if (m.hand) return;
		// Where Herdr gives no foreground group (Windows) only a fresh pane is typed into; a prompt that died in any other is said once, and the pane waits for the next run or Herdr restart.
		if (!groups && !m.fresh) {
			if (!m.lost) {
				m.lost = true;
				// A prompt that never started is no prompt that was lost: it is said as not starting (same once-only rule as elsewhere).
				if (m.typings > 0) log.line("prompt-not-starting", { workspace: target.workspace, pane: pane.pane_id, text: "The tower prompt did not start in this pane and Herdr cannot tell an idle shell from a running program here, so the server types nothing more; the prompt comes back after the next run or a Herdr restart" });
				else log.line("prompt-lost", { workspace: target.workspace, pane: pane.pane_id, text: "The tower prompt is gone from this pane and Herdr cannot tell an idle shell from a running program here, so the server types nothing; the prompt comes back after the next run or a Herdr restart" });
			}
			return;
		}
		// Typed only into a shell that waits at its prompt: a build the boss left running there, or an editor, is theirs.
		if (!idleShell(await processInfo(pane.pane_id), m.fresh, groups)) return;
		const wasFresh = m.fresh;
		m.launched = now();
		m.fresh = false;
		m.typings++;
		if (m.typings === NO_START + 1 && !m.noStart) {
			m.noStart = true;
			log.line("prompt-not-starting", { workspace: target.workspace, pane: pane.pane_id, text: `The tower prompt did not start after ${NO_START} tries (is node on the PATH of the shell in that pane, and can the shell take the command?); the server tries again at a slower pace, up to every ${Math.round(t.launchMaxMs / 60_000)} minutes` });
		}
		try {
			await run(["pane", "run", pane.pane_id, command]);
			m.freshUntil = undefined;
			m.failures = 0;
			log.line("prompt-typed", { workspace: target.workspace, pane: pane.pane_id });
		} catch (cause) {
			// Herdr refused: nothing was typed, so this is no prompt that failed to start. Its own words are logged in full (code, stderr), and the typing is tried again one `launchMs` later, a few times, while the pane is still believed fresh.
			const why = cause as Error & { stderr?: string; code?: unknown };
			error("prompt-typed", `${target.workspace}: herdr pane run ${pane.pane_id} failed${why.code !== undefined ? ` (exit ${String(why.code)})` : ""}: ${why.stderr || why.message}`, 4000);
			m.typings = Math.max(0, m.typings - 1);
			m.failures++;
			if (m.failures < TYPE_TRIES) {
				m.fresh = wasFresh;
				if (m.freshUntil !== undefined) m.freshUntil = now() + t.handMs;
			} else if (m.failures === TYPE_TRIES) {
				log.line("prompt-not-typed", { workspace: target.workspace, pane: pane.pane_id, text: `Herdr refused the command ${TYPE_TRIES} times in a row; the server types nothing more until a run frees the pane or Herdr restarts` });
				Object.assign(m, { freshUntil: undefined, lost: true });
			}
		}
	};

	/** One look at every standing pane (or one workspace's), one after another; a look that fails waits for the next. */
	const tick = (only?: string): Promise<void> => (ticking = ticking.then(async () => {
		if (stopped || !mines.size) return;
		let panes: Pane[];
		try {
			panes = (await world()).panes;
		} catch {
			return; // Herdr does not answer: nothing is known
		}
		for (const m of [...mines.values()]) {
			if (only && m.target.workspace !== only) continue;
			try {
				await look(m, panes);
			} catch (cause) {
				error("standing", `${m.target.workspace}: ${(cause as Error).message}`);
			}
		}
	}));

	return {
		/** `fresh`: the pane was just made, so it is known to be a shell nobody has used. */
		attach(target: StandingTarget, fresh = false) {
			const m = mines.get(target.workspace);
			if (m) m.target = target;
			else mines.set(target.workspace, { target, leaving: false, misses: 0, parked: false, typings: 0, fresh, noStart: false, lost: false, failures: 0, busyClear: 0 });
		},
		/** The service is gone: the stand-in is taken away, and the prompt, which polls a tower that is no more, leaves by itself. */
		async detach(workspace: string) {
			const m = mines.get(workspace);
			if (!m) return;
			mines.delete(workspace);
			m.leaving = true;
			await unreport(m);
		},
		/** The prompt's poll: it is there; the answer is what its screen shows and whether it must leave. */
		poll(workspace: string, pid: number): PromptReply {
			const m = mines.get(workspace);
			if (!m) return { ok: false, error: `The sb server stands in for no tower of workspace ${workspace}`, gone: true };
			m.seen = { pid, at: now() };
			m.typings = 0;
			m.noStart = false;
			m.lost = false;
			const status = m.target.status();
			return { ok: true, label: m.target.label(), state: status?.state ?? "standing", queued: status?.queued ?? 0, leave: m.leaving };
		},
		/** Ctrl+D at the prompt: the shell is the boss's until a run takes the pane and ends, or Herdr restarts. */
		async leave(workspace: string, pid: number): Promise<PromptReply | { ok: true }> {
			const m = mines.get(workspace);
			if (!m) return { ok: false, error: `The sb server stands in for no tower of workspace ${workspace}`, gone: true };
			if (m.seen?.pid === pid) m.seen = undefined;
			m.parked = true;
			await unreport(m);
			return { ok: true };
		},
		/** The prompt is exiting after it was told to leave, or on its own (the boss wrote: a run starts in about a second, and the next look does not type the command into the pane before it). */
		gone(workspace: string, pid: number) {
			const m = mines.get(workspace);
			if (m?.seen?.pid === pid) m.seen = undefined;
			if (m) {
				m.launched = now();
				m.typings = 0;
			}
			return { ok: true as const };
		},
		/** A run is about to start pi in the pane: the stand-in is taken away and the prompt told to leave; returns once it has gone, after Ctrl+C if it must (the prompt itself only). */
		async yieldPane(workspace: string) {
			const m = mines.get(workspace);
			if (!m) return;
			m.leaving = true;
			await unreport(m);
			for (let attempt = 0; attempt < 2 && present(m); attempt++) {
				for (const end = now() + t.leaveMs; present(m) && now() < end; ) await sleep(25);
				if (!present(m) || attempt) break;
				const info = await processInfo(m.target.pane());
				if (!info?.foreground_processes?.some((p) => p.pid === m.seen?.pid)) break;
				log.line("prompt-interrupt", { workspace, pid: m.seen?.pid });
				await run(["pane", "send-keys", m.target.pane(), "ctrl+c"]).catch(() => {});
			}
		},
		/** A local run ended: the pane is free for the prompt again, and the boss's Ctrl+D is over. */
		freed(workspace: string) {
			const m = mines.get(workspace);
			if (!m) return;
			m.leaving = false;
			Object.assign(m, { parked: false, launched: undefined, seen: undefined, reported: undefined, misses: 0, typings: 0, fresh: true, noStart: false, lost: false, hand: undefined, freshUntil: undefined, failures: 0 });
			void tick(workspace);
		},
		/** A resident tower (its pi has `pid`) handed this pane over and is quitting: once that process is gone the pane is a bare shell the server just got back, as after a run. The look proves it (`proveHand`); nothing is believed on the word of the hand-over alone. A prompt that polls is left alone. */
		handed(workspace: string, pid?: number) {
			const m = mines.get(workspace);
			if (!m || present(m)) return;
			m.hand = { ...(pid !== undefined ? { pid } : {}), at: now() };
			m.lost = false;
			void tick(workspace);
		},
		/** A new Herdr server: every pane is a fresh shell, so nothing is believed of what was there. */
		reset() {
			for (const m of mines.values()) Object.assign(m, { seen: undefined, leaving: false, parked: false, launched: undefined, reported: undefined, misses: 0, unsupported: undefined, typings: 0, fresh: true, noStart: false, lost: false, hand: undefined, freshUntil: undefined, failures: 0 });
		},
		/** The look at once (a service just went live), without waiting for the interval. */
		kick: (workspace: string) => void tick(workspace),
		tick,
		start() {
			timer ??= setInterval(() => void tick(), t.intervalMs);
			timer.unref();
		},
		async stop() {
			stopped = true;
			clearInterval(timer);
			timer = undefined;
			await ticking.catch(() => {});
		},
	};
}
export type Standing = ReturnType<typeof createStanding>;
