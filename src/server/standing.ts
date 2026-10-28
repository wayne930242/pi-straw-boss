import { type HerdrApi, type HerdrRun, type HerdrWorld, isStandin, type Pane, releaseStandin, reportStandin, type Sleep } from "../herdr.ts";
import type { Log } from "./log.ts";
import type { ServiceStatus } from "./runs.ts";

// The standing pane between runs (docs/how-it-works.md, The standing pane; docs/specs/2026-10-26-sb-backend.md, The tower service). A tower's standing pane is no bare shell: the server types the tower prompt's
// command into it (`cli.mjs prompt`, src/towerprompt/), and while that process polls, it reports a stand-in agent `tower` on the pane, so the tower keeps its row in Herdr's Agents list (and in the
// net view) between runs. Herdr clears a reported agent about a second after the pane's foreground is back at its idle shell prompt, whatever the label (docs of Herdr, "Release on exit", and checked on
// 0.9.5), so the label is kept by the prompt being there, and the server has the prompt come back whenever the pane is free: after a run, a Herdr restart, a crashed prompt. It never types into a pane
// that runs something, that has an agent, or that the boss took with Ctrl+D (parked), and it releases the stand-in and has the prompt leave before a run starts pi there (Herdr starts an agent only in an
// available shell).

export interface StandingTimers {
	/** How often the server looks at every standing pane. */
	intervalMs: number;
	/** How long after its last poll the prompt still counts as there. */
	presentMs: number;
	/** How long the pane stays the boss's after Ctrl+D; the end of a run ends it sooner. */
	parkMs: number;
	/** How long after the command was typed nothing is typed again. */
	launchMs: number;
	/** How long a run's start waits for the prompt to leave, and then again after Ctrl+C. */
	leaveMs: number;
	/** How long a reported stand-in stands before it is reported again (Herdr keeps it without a refresh; the report also repairs a label Herdr lost). */
	refreshMs: number;
}
export const STANDING: StandingTimers = { intervalMs: 3000, presentMs: 6000, parkMs: 30 * 60_000, launchMs: 15_000, leaveMs: 3000, refreshMs: 4 * 60_000 };
/** Reports of the stand-in that Herdr did not keep, in a row, before the server says so (once) and stops asking for this prompt. */
const MISSES = 3;
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
}
/** What a prompt's poll is answered. */
export type PromptReply = { ok: true; label: string; state: ServiceStatus["state"]; queued: number; leave: boolean } | { ok: false; error: string; gone?: true };

interface Mine {
	target: StandingTarget;
	seen?: { pid: number; at: number };
	/** A run is about to start or holds the pane: the prompt is told to leave. */
	leaving: boolean;
	/** The boss took the shell with Ctrl+D: until when nothing is typed. */
	parked?: number;
	/** When the command was last typed. */
	launched?: number;
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

/** Whether Herdr's process info says the pane's foreground is its shell at an idle prompt. */
export function idleShell(info: { shell_pid?: unknown; foreground_process_group_id?: unknown; foreground_processes?: unknown } | undefined): boolean {
	if (!info) return false;
	if (typeof info.shell_pid === "number" && typeof info.foreground_process_group_id === "number") return info.foreground_process_group_id === info.shell_pid;
	const procs = Array.isArray(info.foreground_processes) ? (info.foreground_processes as { name?: string; argv0?: string }[]) : [];
	return procs.every((p) => SHELLS.has(String(p.argv0 ?? p.name ?? "").replace(/^-/, "").split(/[\\/]/).pop()!.toLowerCase().replace(/\.exe$/, "")));
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
	const mines = new Map<string, Mine>();
	let timer: ReturnType<typeof setInterval> | undefined, ticking: Promise<void> = Promise.resolve(), stopped = false;
	const error = (code: string, text: string) => log.line("error", { code, text: text.slice(0, 300) });

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

	/** One look at one standing pane. */
	const look = async (m: Mine, panes: Pane[]) => {
		const target = m.target, pane = panes.find((p) => p.pane_id === target.pane());
		if (!pane || !target.live()) return;
		const status = target.status();
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
			m.parked = undefined;
			if (isStandin(pane)) m.misses = 0;
			const message = standinMessage(status);
			if (!isStandin(pane) || !m.reported || m.reported.message !== message || now() - m.reported.at >= t.refreshMs) await report(m, pane, message);
			return;
		}
		// The prompt is not there. Herdr clears its label itself a moment after; a release makes it at once.
		await unreport(m);
		if (m.parked !== undefined && now() < m.parked) return;
		if (m.launched !== undefined && now() - m.launched < t.launchMs) return;
		if (pane.agent) return;
		const command = o.command(target.workspace);
		if (!command) return;
		// Typed only into a shell that waits at its prompt: a build the boss left running there, or an editor, is theirs.
		if (!idleShell(await processInfo(pane.pane_id))) return;
		m.launched = now();
		try {
			await run(["pane", "run", pane.pane_id, command]);
			log.line("prompt-typed", { workspace: target.workspace, pane: pane.pane_id });
		} catch (cause) {
			error("prompt-typed", `${target.workspace}: ${(cause as Error).message}`);
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
		attach(target: StandingTarget) {
			const m = mines.get(target.workspace);
			if (m) m.target = target;
			else mines.set(target.workspace, { target, leaving: false, misses: 0 });
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
			const status = m.target.status();
			return { ok: true, label: m.target.label(), state: status?.state ?? "standing", queued: status?.queued ?? 0, leave: m.leaving };
		},
		/** Ctrl+D at the prompt: the shell is the boss's until a run ends or the park time passes. */
		async leave(workspace: string, pid: number): Promise<PromptReply | { ok: true }> {
			const m = mines.get(workspace);
			if (!m) return { ok: false, error: `The sb server stands in for no tower of workspace ${workspace}`, gone: true };
			if (m.seen?.pid === pid) m.seen = undefined;
			m.parked = now() + t.parkMs;
			await unreport(m);
			return { ok: true };
		},
		/** The prompt is exiting after it was told to leave, or on its own. */
		gone(workspace: string, pid: number) {
			const m = mines.get(workspace);
			if (m?.seen?.pid === pid) m.seen = undefined;
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
			m.parked = undefined;
			m.launched = undefined;
			m.seen = undefined;
			m.reported = undefined;
			m.misses = 0;
			void tick(workspace);
		},
		/** A new Herdr server: every pane is a fresh shell, so nothing is believed of what was there. */
		reset() {
			for (const m of mines.values()) Object.assign(m, { seen: undefined, leaving: false, parked: undefined, launched: undefined, reported: undefined, misses: 0, unsupported: undefined });
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
