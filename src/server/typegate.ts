// The gate: every decision "may the server type the tower prompt's command into this standing pane now" is made here, and nowhere else (docs/how-it-works.md, The standing pane).
//
// The rule behind all of them is F10: the server never types into a pane that runs a program of the boss's, a prompt that polls, an agent, or a shell the boss took with Ctrl+D. Reviews RV10 to RV14 reopened it three
// times because each fix touched one path (the look, `freed`, Retry, the table read, the two-look proof). The callers (standing.ts, runs.ts, towers.ts) therefore only gather facts and act on the answer; they hold no
// rule of their own. A rule is added, changed or dropped here, in the table test of tests/typegate.test.ts.
//
// The gate has one question and the proofs that feed it:
// - `typeGate`: may the look type the command now (type / no, with the rule that said no).
// - the marks the typing rests on, which a caller may only set through these: `giveBackGate` (a run ended, a Retry, the table proof), `settleGate` (a hand-over's proof and the lapse of a mark), `handGate` (a hand-over is
//   believed), `holdGate` (a held pane is free again), `retryGate` and `tableGate` (what a Retry may do, and what a read of the process table proves), `runEndGate` (what a run's end says of the pane).
// All of them are pure: the facts come in, the answer goes out, and the caller changes its own state by it.

export const SHELLS = new Set(["zsh", "bash", "fish", "sh", "dash", "ksh", "tcsh", "csh", "nu", "login", "pwsh", "powershell", "cmd"]);
export const nameOf = (p: { argv0?: string; name?: string }) => String(p.argv0 ?? p.name ?? "").replace(/^-/, "").split(/[\\/]/).pop()!.toLowerCase().replace(/\.exe$/, "");

/** What Herdr's `pane process-info` says of a pane. */
export interface ProcessInfo { shell_pid?: unknown; foreground_process_group_id?: unknown; foreground_processes?: unknown }

/**
 * Whether Herdr's process info positively says the pane's foreground is its shell at an idle prompt. With the shell's pid and the foreground group (macOS, Linux) the groups decide. Without them (Windows lists the
 * shell alone whether a build runs under it or not) a list of shells is no proof of an idle prompt: it counts only for a pane the server knows is fresh (`fresh`), and an empty or missing list is unknown, never idle.
 * `groups: false` is Windows: Herdr's process-info there carries both numbers, but the group is always the shell's pid (B6 VM, F10: `ping -t` in the pane still said idle), so they prove nothing.
 */
export function idleShell(info: ProcessInfo | undefined, fresh = false, groups = true): boolean {
	if (!info) return false;
	if (groups && typeof info.shell_pid === "number" && typeof info.foreground_process_group_id === "number") return info.foreground_process_group_id === info.shell_pid;
	const procs = Array.isArray(info.foreground_processes) ? (info.foreground_processes as { name?: string; argv0?: string }[]) : [];
	return fresh && procs.length > 0 && procs.every((p) => SHELLS.has(nameOf(p)));
}

// --- the question: may the look type now ------------------------------------------------------------------------------------------------------------------------------------

/** The rule that said no, in the order the gate asks them. */
export type NoReason =
	/** The pane is not listed, or the service's identity is not registered: there is nothing to type into. */
	| "absent"
	/** The service is held because the pane runs a program of the boss's (runs.ts): only `holdGate` may end that. */
	| "busy"
	/** A run holds the pane or is about to: the prompt has left or is leaving. */
	| "run"
	/** Another agent holds the pane (a pi of the boss's own). */
	| "agent"
	/** The prompt polls: it is there. */
	| "prompt"
	/** The boss took the shell with Ctrl+D: no clock gives it back. */
	| "parked"
	/** A run is about to take the pane (its wake is due within a few seconds). */
	| "run-soon"
	/** The command was typed lately, or the prompt posted the boss's words and left: a run takes the pane in a moment. */
	| "launch-wait"
	/** The server's own stand-in label still stands, though the prompt does not poll: Herdr clears it a moment later. */
	| "stand-in"
	/** No command can be made (a path the shells could not take). */
	| "no-command"
	/** A resident tower's pi may still run in the pane. */
	| "hand"
	/** Herdr refused the command a few times in a row. */
	| "gave-up"
	/** Windows, a held service: the start failed and nothing proves the pane is a bare shell (RV10-F002). */
	| "held"
	/** Windows: the pane is not known to be a fresh shell, and the foreground list cannot tell an idle shell from a running program there. */
	| "unproven"
	/** The foreground is not a shell at its idle prompt: a build, an editor, a program of the boss's. */
	| "not-idle";
export type TypeVerdict = { type: true } | { type: false; reason: NoReason };

/**
 * What the look knows of one standing pane. The plain values are read before anything is awaited. The functions are asked in the gate's order and only when the rules before them passed, because they are read after
 * the stand-in was taken away (`gone`), which awaits Herdr, or because they upkeep state (`settle`) or cost a call to Herdr (`read`).
 */
export interface TypeFacts {
	/** The pane is listed and the service's identity is registered. */
	attached: boolean;
	/** Herdr gives the foreground group (false on win32). */
	groups: boolean;
	/** The service is held because the pane runs a program of the boss's. */
	busy: boolean;
	/** The service is held (its crash loop or a start that failed). */
	held: boolean;
	/** A run holds the pane or is about to (`leaving`, or the state waking, running, closing). */
	run: boolean;
	/** The agent Herdr shows on the pane: none, the server's stand-in `tower`, or another. */
	agent: "none" | "stand-in" | "other";
	/** The prompt polled lately. */
	prompt: boolean;
	/** Called once, when the prompt is not there and nothing above said no: the caller takes the stand-in away. The facts below are read after it. */
	gone(): Promise<void>;
	parked(): boolean;
	runSoon(): boolean;
	launchWait(): boolean;
	/** Whether a command can be made. */
	command(): boolean;
	/** Upkeeps the hand-over's proof and the lapse of a mark (`settleGate`), and tells whether a resident tower's pi may still run and whether Herdr's refusals ended the typing. */
	settle(): { hand: boolean; giveUp: boolean };
	/** Whether the server knows the pane is a fresh shell; read again after `read`, since the answer may change while Herdr answers. */
	fresh(): boolean;
	/** Herdr's process info of the pane. */
	read(): Promise<ProcessInfo | undefined>;
}

/** May the look type the command into this pane now. The first rule that says no is the answer; `type: true` only when none does. */
export async function typeGate(f: TypeFacts): Promise<TypeVerdict> {
	const no = (reason: NoReason): TypeVerdict => ({ type: false, reason });
	if (!f.attached) return no("absent");
	if (f.busy) return no("busy");
	if (f.run) return no("run");
	if (f.agent === "other") return no("agent");
	if (f.prompt) return no("prompt");
	await f.gone();
	if (f.parked()) return no("parked");
	if (f.runSoon()) return no("run-soon");
	if (f.launchWait()) return no("launch-wait");
	if (f.agent !== "none") return no("stand-in");
	if (!f.command()) return no("no-command");
	const settled = f.settle();
	if (settled.hand) return no("hand");
	if (settled.giveUp) return no("gave-up");
	if (!f.groups && f.held) return no("held");
	if (!f.groups && !f.fresh()) return no("unproven");
	if (!idleShell(await f.read(), f.fresh(), f.groups)) return no("not-idle");
	return { type: true };
}

// --- the proofs the marks rest on ------------------------------------------------------------------------------------------------------------------------------------------

/** What a held pane's look knows: the answer is whether the service may start again (`paneFree`). */
export interface HoldFacts {
	groups: boolean;
	/** The pane's foreground is a shell at an idle prompt (`idleShell(info, true, groups)`). */
	idle: boolean;
	/** Windows: the programs that held the pane are named, none of them is alive, and none is listed. */
	gone: boolean;
	/** Looks in a row at which the above held on Windows. */
	clear: number;
}
export type HoldVerdict = { free: boolean; clear: number };
/**
 * A held service waits for the boss's program to end. Where Herdr gives foreground groups the idle shell is proof enough. Without them (Windows) a list of shells is no proof that the program ended: the programs that
 * held the pane must be gone themselves, and the list must show the shell alone at two looks in a row (RV7-F003). A build the boss started after the first is invisible there; that is what the second look and Retry are for.
 */
export function holdGate(f: HoldFacts): HoldVerdict {
	if (f.groups) return { free: f.idle, clear: f.clear };
	const clear = f.gone && f.idle ? f.clear + 1 : 0;
	return clear >= 2 ? { free: true, clear: 0 } : { free: false, clear };
}

/** What a give-back asks: `fresh` false when the run's pi never started in the pane; `keepParked` for a Retry or the tower's own proof, which never ends the boss's Ctrl+D park. */
export interface GiveBackFacts { fresh: boolean; keepParked: boolean; parked: boolean; prompt: boolean; now: number; markMs: number }
export type GiveBackVerdict = { apply: false } | { apply: true; unpark: boolean; fresh: boolean; freshUntil: number | undefined };
/**
 * The pane is given back to the look. A Retry or proof (`keepParked`) changes nothing while the prompt polls (the pane is not free: clearing what is known of the prompt would let the look type into it, RV14-F001), never
 * ends the park, marks no parked pane fresh (RV14-F002), and its mark expires after `markMs` like a hand-over's. A run's end clears the park and marks the pane fresh unless its pi never started there (RV10-F002).
 */
export function giveBackGate(f: GiveBackFacts): GiveBackVerdict {
	if (f.keepParked && f.prompt) return { apply: false };
	const fresh = f.fresh && !(f.keepParked && f.parked);
	return { apply: true, unpark: !f.keepParked, fresh, freshUntil: f.keepParked && fresh ? f.now + f.markMs : undefined };
}

/** What a run's end says of the standing pane: a local run whose pi never started there leaves it unmarked (RV10-F002). */
export const runEndGate = (unstarted: boolean): { fresh: false } | undefined => (unstarted ? { fresh: false } : undefined);

/** A resident tower's hand-over is believed only while the prompt does not poll: the pane is then not free. */
export const handGate = (prompt: boolean): boolean => !prompt;

export interface SettleFacts {
	fresh: boolean;
	freshUntil: number | undefined;
	hand: { pid?: number; at: number } | undefined;
	now: number;
	/** How long a hand-over is waited on, and how long the pane it freed is believed to be a bare shell after that. */
	handMs: number;
	alive: (pid: number) => boolean;
}
export interface SettleVerdict { fresh: boolean; freshUntil: number | undefined; hand: { pid?: number; at: number } | undefined; failures0: boolean }
/**
 * A fresh mark that came from a hand-over or a Retry lapses after `handMs`. A hand-over frees the pane when its pi has left it: the process is gone (it said which), within `handMs`; the mark then lasts `handMs`
 * more, or until the command is typed. Nothing is believed on the word of the hand-over alone.
 */
export function settleGate(f: SettleFacts): SettleVerdict {
	let { fresh, freshUntil, hand } = f, failures0 = false;
	if (freshUntil !== undefined && f.now > freshUntil) (fresh = false, freshUntil = undefined);
	if (hand) {
		if (f.now - hand.at > f.handMs) hand = undefined;
		else if (hand.pid === undefined || !f.alive(hand.pid)) (hand = undefined, fresh = true, freshUntil = f.now + f.handMs, failures0 = true);
	}
	return { fresh, freshUntil, hand, failures0 };
}

/** What a read of the process table proves of the pane (Windows). */
export type TableVerdict = "unreadable" | "program" | "empty";
/** A read that failed proves nothing; a program of the boss's found below the shell holds the pane; only a read that succeeds and finds none proves it empty (RV12-F001). */
export const tableGate = (found: readonly unknown[] | undefined): TableVerdict => (found === undefined ? "unreadable" : found.length ? "program" : "empty");

/** What Retry does to the pane: read the process table first (Windows), give the pane back, or leave it to the run (or the program) that holds it. */
export type RetryPlan = "prove" | "give-back" | "none";
export interface RetryFacts { win: boolean; run: boolean; queued: boolean; wasBusy: boolean }
/**
 * With a run live or an event waiting the run's start decides, and nothing is given back. With neither, Retry gives the pane back as a run's end would, the prompt is typed again (RV11-F001): on Windows never before
 * the process table shows the pane holds nothing, whatever the service believes of the pane (RV12-F001, RV13-F001); elsewhere not where a program of the boss's holds the pane (`wasBusy`), which only the look's proof ends.
 */
export function retryGate(f: RetryFacts): RetryPlan {
	if (f.run || f.queued) return "none";
	if (f.win) return "prove";
	return f.wasBusy ? "none" : "give-back";
}
