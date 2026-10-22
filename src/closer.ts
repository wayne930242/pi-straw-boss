import type { Reply } from "./control.ts";
import { type HerdrRun, panes, type Session, type Sleep } from "./herdr.ts";
import { stashBase } from "./stash.ts";

// What the page's close buttons ask for. Closing is each session's own (index.ts): its bridge is asked to quit it as /boss close does, and its
// shutdown clears its tokens (a tower's clears the base's mains). One unit closes its own pane afterwards; for a squad or a base every agent
// of the net in it (mains, members, and the base's tower) quits first, then the tab or the workspace closes with what is left in it (shells,
// subagents). A session that refuses or does not answer stops the batch before anything closes, and so does one still running after EXIT_MS.
// The session that runs the server is asked last of all, through nothing: closing its tab or base ends it with the rest.
//   POST /<token>/api/close/unit {key}                 that session quits and closes its pane
//   POST /<token>/api/close/tab {workspace, tab}       every agent in the tab quits, then the tab closes
//   POST /<token>/api/close/base {workspace}           every agent in the workspace quits, then the workspace closes
//   POST /<token>/api/close/stash {workspace, name}    the base is checked and recorded first (stash.ts), then closed as above

const EXIT_MS = 30_000, JOINED = new Set(["main", "member", "tower"]);
/** `check` and `stateDir` are a stash's: without them this closer stashes nothing. */
export interface CloserDeps { run: HerdrRun; sleep: Sleep; me(): string; sessions(): Promise<Session[]>; ask(key: string, keepPane: boolean, ifStashable?: boolean): Promise<{ accepted: boolean; reason?: string } | undefined>; check?(key: string): Promise<{ reason?: string } | undefined>; stateDir?: string }
const no = (status: number, error: string, reason: string): Reply => ({ status, body: { error, reason } });

export function createCloser({ run, sleep, me, sessions, ask, check, stateDir }: CloserDeps) {
	let busy = false;
	const name = (s: Session) => s.name ?? s.id.slice(0, 8);

	/** `ifStashable`: a stash's batch, where each session quits only while it can still be stashed. */
	async function batch(workspace: string, tab?: string, ifStashable = false): Promise<Reply> {
		const here = (await panes(run, workspace)).filter((p) => (!tab || p.tab_id === tab) && JOINED.has(p.tokens?.sb_role ?? ""));
		if (!here.length && !(await panes(run, workspace)).some((p) => !tab || p.tab_id === tab)) return no(404, "not_found", tab ? "That squad is not open any more." : "That base is not open any more.");
		const targets = (await sessions()).filter((s) => s.id !== me() && here.some((p) => p.pane_id === s.herdrLocation?.paneId));
		const answers = await Promise.all(targets.map(async (s) => ({ s, r: await ask(s.id, true, ifStashable) })));
		const stuck = answers.filter(({ r }) => !r?.accepted).map(({ s, r }) => `${name(s)}${r?.reason ? ` (${r.reason})` : " (no answer)"}`);
		if (stuck.length) return no(409, "refused", `Nothing was closed: ${stuck.join(", ")} cannot be closed from here. Close them in their terminals first.`);
		const ids = new Set(targets.map((s) => s.id));
		for (let waited = 0; waited < EXIT_MS && (await sessions()).some((s) => ids.has(s.id)); waited += 500) await sleep(500);
		const left = (await sessions()).filter((s) => ids.has(s.id));
		if (left.length) return no(504, "still_running", `${left.map(name).join(", ")} did not quit within ${EXIT_MS / 1000} s; the ${tab ? "squad" : "base"} stays open.`);
		await run(tab ? ["tab", "close", tab] : ["workspace", "close", workspace]).catch(() => {}); // it may have closed itself with its last pane
		return { status: 200, body: { closed: targets.length } };
	}

	/** `refresh` reads the net again, so the hub learns of bridges that told it about themselves since (a stash's second round). */
	return async function handle(kind: string, json: Record<string, unknown>, refresh?: () => Promise<unknown>): Promise<Reply> {
		const str = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 200;
		if (kind === "unit") {
			if (!str(json.key)) return no(400, "bad_request", "A unit is named by its key.");
			const r = await ask(json.key, false);
			return r?.accepted ? { status: 200, body: { closing: true } } : no(409, "refused", r?.reason ?? "The session did not answer; close it in its terminal.");
		}
		if (kind === "stash" && check && stateDir) {
			if (busy) return no(429, "busy", "Another close is still on its way.");
			busy = true;
			try {
				return await stashBase({ run, sleep, sessions, check, stateDir }, json, (workspace) => batch(workspace, undefined, true), refresh);
			} catch (error) {
				return no(502, "stash_failed", (error as Error).message);
			} finally {
				busy = false;
			}
		}
		if (kind !== "tab" && kind !== "base") return no(404, "not_found", "No such action.");
		if (!str(json.workspace) || (kind === "tab" && !str(json.tab))) return no(400, "bad_request", "A squad is named by its workspace and tab, a base by its workspace.");
		if (busy) return no(429, "busy", "Another close is still on its way.");
		busy = true;
		try {
			return await batch(json.workspace, kind === "tab" ? (json.tab as string) : undefined);
		} catch (error) {
			return no(502, "close_failed", (error as Error).message);
		} finally {
			busy = false;
		}
	};
}
