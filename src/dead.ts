import type { RoleRecord } from "./roles.ts";

// Whether a main (or a train) that has a role record is dead, from one table (docs/specs/2026-11-23-tower-revive.md §2), the way typegate.ts decides a typed start: the callers gather the facts, and this
// module alone gives the answer. It reads no file and asks nobody.
//
// | state     | evidence                                                                                          | the tower                                                 |
// |-----------|---------------------------------------------------------------------------------------------------|-----------------------------------------------------------|
// | closed    | no role record: a close on purpose forgets it                                                     | never                                                     |
// | invalid   | the record or its session file fails the checks of revive.ts (`fileRefusal`)                      | never; the reason is listed                               |
// | live      | a pane runs the file, the broker lists the session id, or the file moved in the last 60 s          | no                                                        |
// | quit      | the record's `ended` mark is a quit (/quit, Ctrl-D, /new, /resume, /fork)                         | not unasked: listed, revived only when a request names it |
// | stale     | the file has not moved for 24 h                                                                    | listed only                                               |
// | restoring | Herdr's recovery window is open, or the death was seen in fewer than 2 looks 60 s apart            | waits                                                     |
// | dead      | none of the above: a crash, a kill, a pane or tab Herdr closed (no shutdown ran), or a signal      | raises `main_died`; a run decides with boss_revive_main   |

export type DeadState = "closed" | "invalid" | "live" | "quit" | "stale" | "restoring" | "dead";
/** How long a moving session file counts as held, how old a file is stale, and how far apart the two looks that confirm a death must be. */
export const LIVE_MS = 60_000, STALE_MS = 24 * 3600_000, CONFIRM_MS = 60_000, LOOKS = 2;

export interface DeadFacts {
	now: number;
	/** The session's role record, or undefined when there is none. */
	record?: Pick<RoleRecord, "role" | "ended">;
	/** Why the record or its file proves nothing (revive.ts `fileRefusal`). */
	invalid?: string;
	/** The session file's mtime; undefined when the file is gone. */
	mtimeMs?: number;
	/** A pane of Herdr runs the session file (`agent_session`). */
	held: boolean;
	/** The broker lists the session id. */
	listed: boolean;
	/** Herdr's recovery window after a restart is open (towers.ts `recoverUntil`). */
	recovering: boolean;
	/** The looks that found this death before, the first one's time: absent for an explicit call, which needs no second look. */
	seen?: { first: number; looks: number };
}
export interface DeadVerdict { state: DeadState; reason: string; /** For `dead`: how it ended, as far as the record says. */ how?: "crash" | "signal" }

export function classify(f: DeadFacts): DeadVerdict {
	if (!f.record) return { state: "closed", reason: "no role record: it was closed on purpose, or never was a main" };
	if (f.invalid) return { state: "invalid", reason: f.invalid };
	if (f.mtimeMs === undefined) return { state: "invalid", reason: "its session file is gone" };
	if (f.held) return { state: "live", reason: "a pane runs its session file" };
	if (f.listed) return { state: "live", reason: "the broker lists its session" };
	if (f.now - f.mtimeMs < LIVE_MS) return { state: "live", reason: "its session file moved in the last minute" };
	const ended = f.record.ended;
	if (ended && ended.reason !== "signal") return { state: "quit", reason: `it quit (${ended.reason}) at ${new Date(ended.at).toISOString()}` };
	if (f.now - f.mtimeMs > STALE_MS) return { state: "stale", reason: "its session file has not moved for over 24 h" };
	if (f.recovering) return { state: "restoring", reason: "Herdr is restoring its panes" };
	if (f.seen && (f.seen.looks < LOOKS - 1 || f.now - f.seen.first < CONFIRM_MS)) return { state: "restoring", reason: "seen ended once; a second look a minute later confirms it" };
	return ended
		? { state: "dead", how: "signal", reason: `pi ended on a signal (a SIGHUP or SIGTERM) at ${new Date(ended.at).toISOString()} with no close` }
		: { state: "dead", how: "crash", reason: "it ended with no shutdown: a crash, a kill, or its pane or tab closed in Herdr" };
}
