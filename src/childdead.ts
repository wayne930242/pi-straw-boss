// Whether a subagent run died under its live launcher, from one table (docs/specs/2026-11-24-worker-revive.md §1 and §2), the way dead.ts decides a main: the callers gather the facts, and this module
// alone gives the answer. It reads no file and asks nobody.
//
// pi-herdr-agents ends a run on the child's `.exit` sidecar (done, error, ping), on its launch script's `__SUBAGENT_DONE_<code>__` sentinel, or on its pane's disappearance, and hands the launcher one
// `subagent_result`. The child writes `.exit` before it exits, so a report always comes through the sidecar; a result with neither a sidecar's error nor a zero exit is a pi that ended without one.
//
// | details                                                   | death                                              |
// |-----------------------------------------------------------|----------------------------------------------------|
// | `error: "cancelled"` or a `cancellation`                  | no: the launcher cancelled it                      |
// | `error: "persistent-crash"`                               | no: a persistent specialist, which cannot come back |
// | `exitCode: 0`                                             | no: it completed                                   |
// | an `errorMessage` other than the host's three below      | no: the child reported an error (a provider error) |
// | the host's "pane disappeared", "native execution ended", "process exited" | yes: its pane or process went first |
// | no `errorMessage`, exit 130 (SIGINT)                      | no: a Ctrl-C in its pane                           |
// | no `errorMessage`, any other exit                         | yes: a crash (1), a kill (137), another signal     |
//
// | state      | evidence                                                                                              | the launcher      |
// |------------|-------------------------------------------------------------------------------------------------------|-------------------|
// | refused    | no launch script, a command that cannot be read, a persistent run, a session that never started, a revive of the file that failed in 24 h or came in the last 10 minutes | tells, never revives |
// | live       | a pane runs the file, the broker lists its session, or the file moved in the last 60 s                | waits             |
// | confirming | seen dead in fewer than 2 looks 60 s apart                                                             | waits             |
// | dead       | none of the above                                                                                      | revives           |

import { CONFIRM_MS, LIVE_MS, LOOKS } from "./dead.ts";

/** What maestro writes as the error of a run whose pane or process went away before any evidence of its own (adapters/pi/completion.ts). */
export const HOST_DEATHS = [
	"Subagent pane disappeared before completion evidence was recorded.",
	"Subagent native execution ended before completion evidence was recorded.",
	"Subagent process exited before completion evidence was recorded.",
];
const SIGNALS: Record<number, string> = { 1: "SIGHUP", 2: "SIGINT", 6: "SIGABRT", 9: "SIGKILL", 10: "SIGBUS", 11: "SIGSEGV", 15: "SIGTERM" };

export interface Death { file: string; name: string; /** How it ended, as a clause. */ why: string }

/** The death a `subagent_result`'s details describe, or undefined when the run ended any other way. */
export function deathOf(details: unknown): Death | undefined {
	if (!details || typeof details !== "object") return undefined;
	const d = details as { sessionFile?: unknown; exitCode?: unknown; errorMessage?: unknown; error?: unknown; cancellation?: unknown; name?: unknown };
	if (typeof d.sessionFile !== "string" || !d.sessionFile || d.error !== undefined || d.cancellation !== undefined) return undefined;
	const code = typeof d.exitCode === "number" ? d.exitCode : undefined, name = typeof d.name === "string" && d.name ? d.name : "subagent";
	if (code === 0) return undefined;
	if (d.errorMessage !== undefined) {
		const host = HOST_DEATHS.indexOf(String(d.errorMessage));
		return host < 0 ? undefined : { file: d.sessionFile, name, why: ["its pane closed", "its process ended", "its process ended"][host]! };
	}
	if (code === undefined || code === 130) return undefined;
	const signal = code > 128 ? SIGNALS[code - 128] : undefined;
	return { file: d.sessionFile, name, why: signal ? `its pi was ended by ${signal} (exit ${code})` : `its pi exited with code ${code} and no report` };
}

export type ChildDeadState = "refused" | "live" | "confirming" | "dead";
export interface ChildFacts {
	now: number;
	/** Why the run may not be revived (childrevive.ts `refusal`), or undefined when it may. */
	refusal?: string;
	/** A pane of Herdr runs the session file. */
	held: boolean;
	/** The broker lists the session's id. */
	listed: boolean;
	/** The session file's mtime; undefined when the file is gone (that is a refusal). */
	mtimeMs?: number;
	/** The looks that found it dead before this one, the first one's time. */
	seen: { first: number; looks: number };
}

export function classify(f: ChildFacts): { state: ChildDeadState; reason: string } {
	if (f.refusal) return { state: "refused", reason: f.refusal };
	if (f.held) return { state: "live", reason: "a pane runs its session file" };
	if (f.listed) return { state: "live", reason: "the broker lists its session" };
	if (f.mtimeMs !== undefined && f.now - f.mtimeMs < LIVE_MS) return { state: "live", reason: "its session file moved in the last minute" };
	if (f.seen.looks < LOOKS - 1 || f.now - f.seen.first < CONFIRM_MS) return { state: "confirming", reason: "seen dead once; a second look a minute later confirms it" };
	return { state: "dead", reason: "its pi is gone, no pane runs its session, and nothing else holds it" };
}
