import { homedir } from "node:os";
import { join } from "node:path";
import type { IntercomLike } from "./kit.ts";
import type { Reply, Request } from "./socket.ts";
import { createWatchRead, type WatchNet, type WatchQuery, type WatchReadDeps } from "./watchread.ts";
import { createWatchReport, reportQuery } from "./watchreport.ts";

// The server's side of the watchdog (docs/specs/2026-11-09-agent-kinds.md §10): the control-socket commands `watch-read` (watchread.ts) and `watch-report` (watchreport.ts), their requests checked, and the two built for the server. Kept out
// of main.ts, which carries a line budget.

export interface Watchdog { read: { read(q: WatchQuery): Promise<Reply> }; report: { report(q: NonNullable<ReturnType<typeof reportQuery>>): Promise<Reply> } }
const no = (error: string): Promise<Reply> => Promise.resolve({ ok: false, error });
const number = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** A watchdog child's two requests. Undefined for a command that is not the watchdog's. */
export function watchdogReply(dog: Watchdog | undefined, request: Request): Promise<Reply> | undefined {
	if (request.cmd !== "watch-read" && request.cmd !== "watch-report") return undefined;
	if (!dog) return no("the server is still starting");
	if (request.cmd === "watch-report") {
		const q = reportQuery(request);
		return q ? dog.report.report(q) : no("watch-report needs session, child, and activityFile");
	}
	const { key, since, deadline, quietMs, loadMax } = request;
	if (typeof key !== "string" || key.length < 1 || key.length > 200) return no("key is 1 to 200 characters");
	if (deadline !== undefined && !(number(deadline) && deadline > 0)) return no("deadline is a time in epoch ms");
	if (quietMs !== undefined && !(number(quietMs) && quietMs >= 60_000)) return no("quietMs is at least 60000");
	if (loadMax !== undefined && !(number(loadMax) && loadMax > 0)) return no("loadMax is a number over 0");
	return dog.read.read({ key, ...(typeof since === "string" ? { since } : {}), ...(deadline !== undefined ? { deadline } : {}), ...(quietMs !== undefined ? { quietMs } : {}), ...(loadMax !== undefined ? { loadMax } : {}) });
}

export interface StartWatchdog {
	net: WatchNet;
	env: NodeJS.ProcessEnv;
	now(): number;
	client(): Pick<IntercomLike, "listSessions" | "send"> | undefined;
	log(event: string, facts: Record<string, number | string | boolean>): void;
	stops: (() => void)[];
	/** The seams of a test: the hold's length, the read interval, the timer. */
	over?: Partial<Pick<WatchReadDeps, "holdMs" | "readMs" | "timer">>;
}
/** The watchdog routes of this server: the holds on the GUI host's readings, and the reports through the server's own intercom connection. The holds' timers stop with the server. */
export function startWatchdog(o: StartWatchdog): Watchdog {
	const read = createWatchRead({ net: o.net, now: o.now, ...o.over });
	o.stops.push(() => read.stop());
	return { read, report: createWatchReport({ sessionsDir: join(o.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "sessions"), now: o.now, intercom: o.client, log: o.log }) };
}
