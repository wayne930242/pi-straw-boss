import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, sep } from "node:path";
import { stamp } from "../header.ts";
import { canonical } from "../history.ts";
import { agentOfSession, launchScripts } from "../netdata.ts";
import type { IntercomLike } from "./kit.ts";
import type { Reply } from "./socket.ts";

// The sb server's `watch-report` route (docs/specs/2026-11-09-agent-kinds.md §10): one message from a watchdog child to the session that dispatched it. The child's sb sends what its launch (or resume) script put in its environment: its
// session file, its id, and its activity file. The server ties the three together by pi-herdr-agents' own files (linking by session file, AK3-F002):
//   1. the activity file is a real file `<parent artifacts>/subagent-activity/<child>.json` under pi's sessions folder and does not say `done`; the session path is under that folder too. The parent's session id is the artifacts folder's name.
//   2. a script of that parent's `subagent-scripts` (a launch script or a `-resume-` one) carries the child's id and names that session file.
//   3. the session file's first `straw-boss { agent }` entry says `watchdog`; while it holds none (pi writes the file with the first message, and the entry at the first turn), a launch script that names the session carries
//      `PI_SUBAGENT_AGENT='watchdog'`. A session file that does not exist passes only by the script of check 2 itself.
// None of this authenticates the caller: the control socket has no peer credentials, so any process of the same user can send a report in a watchdog's name to that watchdog's parent, and the harm is a false message. A watchdog cannot name
// another parent: it has no shell and its environment is fixed. There is no target parameter: the message goes to the parent and nowhere else.
//
// One report every 30 s per session file, and never the same text as the last one; a refused or undelivered report counts for neither.

export const RATE_MS = 30_000, MAX_TEXT = 2000;
const ID = /^[A-Za-z0-9_.:@-]{1,128}$/;
/** Plain: no control or format character but a line break or a tab. */
const CONTROL = /[\p{Cc}\p{Cf}\u2028\u2029]/u;

export interface ReportQuery { session: string; child: string; activityFile: string; text: string }
export interface WatchReportDeps {
	/** pi's sessions folder of this server (`PI_CODING_AGENT_DIR/sessions`). */
	sessionsDir: string;
	now(): number;
	/** The server's own intercom connection; undefined while the broker is not connected. */
	intercom(): Pick<IntercomLike, "listSessions" | "send"> | undefined;
	log?(event: string, facts: Record<string, string | number | boolean>): void;
}

const no = (error: string): Reply => ({ ok: false, error });
const isFile = (path: string) => { try { return statSync(path).isFile(); } catch { return false; } };
const hashOf = (text: string) => createHash("sha256").update(text).digest("hex");

export function createWatchReport(d: WatchReportDeps) {
	/** The last report that went out, by session file. */
	const last = new Map<string, { at: number; text: string }>();
	return {
		async report(q: ReportQuery): Promise<Reply> {
			if (typeof q.text !== "string" || !q.text.trim() || q.text.length > MAX_TEXT || CONTROL.test(q.text.replace(/[\n\t]/g, " "))) return no(`text is 1 to ${MAX_TEXT} plain characters`);
			const root = canonical(d.sessionsDir)!, under = (path: string | undefined): path is string => path !== undefined && path.startsWith(root + sep);
			// Check 1: both paths resolve (links and dots included) under pi's sessions folder, and the activity file is the child's own, where pi-herdr-agents keeps it.
			const activity = canonical(q.activityFile), session = canonical(q.session), activityDir = activity && dirname(activity), art = activityDir && dirname(activityDir);
			if (!under(activity) || !under(session) || !art || basename(activity) !== `${q.child}.json` || basename(activityDir!) !== "subagent-activity" || basename(dirname(art)) !== "artifacts" || !isFile(activity)) return no("outside the sessions folder");
			const parent = basename(art);
			// Check 2: a script of the same parent carries the child's id and names the session file.
			const scripts = launchScripts(art).map((s) => ({ ...s, session: canonical(s.session) })), tie = scripts.find((s) => s.id === q.child && s.session === session);
			if (!tie) return no(`no launch script ties ${q.child} to that session`);
			let phase: unknown;
			try { phase = (JSON.parse(readFileSync(activity, "utf8")) as { phase?: unknown } | null)?.phase; } catch { /* a file pi-herdr-agents is writing: not done */ }
			if (phase === "done") return no("that child is done");
			// Check 3: the session is a watchdog's.
			const written = isFile(session), agent = written ? agentOfSession(session) : undefined;
			const watchdog = agent !== undefined ? agent === "watchdog" : written ? scripts.some((s) => s.session === session && s.agent === "watchdog") : tie.agent === "watchdog";
			if (!watchdog) return no("not a watchdog's session");
			const was = last.get(session), now = d.now(), text = hashOf(q.text);
			if (was && now - was.at < RATE_MS) return no(`rate: one report every ${RATE_MS / 1000} s`);
			if (was?.text === text) return no("same text as the last report");
			const intercom = d.intercom();
			if (!intercom) return no("pi-intercom is not connected");
			let to: { id: string; name?: string } | undefined;
			try { to = (await intercom.listSessions()).find((s) => s.id === parent); } catch (error) { return no(`pi-intercom cannot list its sessions: ${(error as Error).message}`); }
			if (!to) return { ok: true, delivery: "gone" };
			// A first launch's script is `<name>-<id>.sh`, a resume's `<name>-resume-<ts>.sh` (netdata.ts `subagents`).
			const name = tie.script.endsWith(`-${q.child}.sh`) ? tie.script.slice(0, -`-${q.child}.sh`.length) : tie.script.replace(/-resume-[^-]*\.sh$/, "").replace(/\.sh$/, "");
			const message = stamp({ from: { name: `watchdog ${name}`, id: q.child, role: "session" }, kind: "watch_report", scope: "session", to: [{ name: to.name ?? to.id, id: to.id, role: "session" }], reply: false }, q.text);
			let sent: Awaited<ReturnType<IntercomLike["send"]>>;
			try { sent = await intercom.send(to.id, { text: message, messageId: `watch-report-${randomUUID()}` }); } catch (error) { return no(`not delivered: ${(error as Error).message}`); }
			const delivery = !sent.delivered ? undefined : sent.delivery === "queued" ? "queued" : sent.delivery === undefined || sent.delivery === "socket_delivered" ? "delivered" : undefined;
			d.log?.("watch-report", { child: q.child, parent, delivery: delivery ?? "failed" });
			if (!delivery) return no(`not delivered: ${sent.reason ?? String(sent.delivery ?? "the broker did not take it")}`);
			if (last.size > 2000) last.clear();
			last.set(session, { at: now, text });
			return { ok: true, delivery };
		},
	};
}
export type WatchReport = ReturnType<typeof createWatchReport>;

/** The request's fields as the route takes them, or undefined when one is missing or out of shape. */
export function reportQuery(request: Record<string, unknown>): ReportQuery | undefined {
	const path = (v: unknown) => (typeof v === "string" && v.length > 0 && v.length <= 4096 ? v : undefined);
	const session = path(request.session), activityFile = path(request.activityFile), child = typeof request.child === "string" && ID.test(request.child) ? request.child : undefined;
	return session && activityFile && child ? { session, child, activityFile, text: request.text as string } : undefined;
}
