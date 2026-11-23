import { readFileSync, statSync } from "node:fs";
import { basename, dirname, sep } from "node:path";
import { canonical } from "../history.ts";
import { launchScripts } from "../netdata.ts";

// The tie between a pi-herdr-agents child and the session that dispatched it (docs/specs/2026-11-23-lite-b2-d-e-f.md §2.3), proven by pi-herdr-agents' own files as the retired watchdog's `watch-report` proved it (0.80.0 to 0.82.x). The
// child's sb sends what its launch (or resume) script put in its environment: its session file, its id, and its activity file.
//   1. The activity file is a real file `<parent artifacts>/subagent-activity/<child>.json` under pi's sessions folder, and the session path is under that folder too. The parent's session id is the artifacts folder's name.
//   2. A script of that parent's `subagent-scripts` (a launch script `<name>-<id>.sh` or a resume `<name>-resume-<ts>.sh`) carries the child's id and names that session file. Its `<name>` is the child's name as pi-herdr-agents
//      wrote it (`safeName` of the `name` the parent gave `subagent`).
// None of this authenticates the caller: the control socket carries no peer credentials, so any process of the same user can speak in a child's name to that child's parent's threads. A child cannot name another parent: its
// environment is fixed by its launch script.

const ID = /^[A-Za-z0-9_.:@-]{1,128}$/;
export interface TieQuery { session: string; child: string; activityFile: string }
/** A child proven: its parent's session id, its name as its script carries it, and its activity file (canonical). */
export interface Tie { parent: string; name: string; child: string; activityFile: string }

/** pi-herdr-agents' own `safeName` (maestro launch-command.ts): the name a launch script's file carries for the `name` given to `subagent`. */
export const safeName = (name: string) => name.toLowerCase().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");

const isFile = (path: string) => { try { return statSync(path).isFile(); } catch { return false; } };

/** The request's tie fields, or undefined when one is missing or out of shape. */
export function tieQuery(request: Record<string, unknown>): TieQuery | undefined {
	const path = (v: unknown) => (typeof v === "string" && v.length > 0 && v.length <= 4096 ? v : undefined);
	const session = path(request.session), activityFile = path(request.activityFile), child = typeof request.child === "string" && ID.test(request.child) ? request.child : undefined;
	return session && activityFile && child ? { session, child, activityFile } : undefined;
}

/** Whether a child's run is over: pi-herdr-agents recorded it done, or its activity file is gone. */
export function childEnded(activityFile: string): boolean {
	try {
		return (JSON.parse(readFileSync(activityFile, "utf8")) as { phase?: unknown } | null)?.phase === "done";
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT"; // a file pi-herdr-agents is writing is not done
	}
}

/** Ties a child to its parent by checks 1 and 2 above; a child that is done is refused. */
export function tieChild(sessionsDir: string, q: TieQuery): { tie: Tie } | { error: string } {
	const root = canonical(sessionsDir)!, under = (path: string | undefined): path is string => path !== undefined && path.startsWith(root + sep);
	const activity = canonical(q.activityFile), session = canonical(q.session), activityDir = activity && dirname(activity), art = activityDir && dirname(activityDir);
	if (!under(activity) || !under(session) || !art || basename(activity) !== `${q.child}.json` || basename(activityDir!) !== "subagent-activity" || basename(dirname(art)) !== "artifacts" || !isFile(activity)) return { error: "outside the sessions folder" };
	const tie = launchScripts(art).find((s) => s.id === q.child && canonical(s.session) === session);
	if (!tie) return { error: `no launch script ties ${q.child} to that session` };
	if (childEnded(activity)) return { error: "that child is done" };
	const name = tie.script.endsWith(`-${q.child}.sh`) ? tie.script.slice(0, -`-${q.child}.sh`.length) : tie.script.replace(/-resume-[^-]*\.sh$/, "").replace(/\.sh$/, "");
	return { tie: { parent: basename(art), name, child: q.child, activityFile: activity } };
}
