import { createHash, randomUUID } from "node:crypto";
import { createTab, report, panes, startPi, type HerdrRun, type Session, type Sleep, waitFor, workspaces } from "./herdr.ts";

// The one thing a tower does besides routing: when no session owns a request, it opens a main for it (docs/how-it-works.md, "Opening a main").
// It is narrow on purpose: one new tab in the tower's own workspace, started without focus, in which Straw Boss starts pi. It types into no pane
// that already exists, and `STRAW_BOSS_ROLE=main` makes that pi promote itself once it has joined (index.ts).

const MAIN_WAIT_MS = 60_000;
/** At most this many mains opened by towers are alive in one workspace, and at most one per sender. */
const MAX_OPENED_MAINS = 2;

/** A limit was hit: nothing opened, and the same request may be tried again once an opened main has finished. */
class OpenLimitError extends Error {}

export interface OpenerEnv {
	run: HerdrRun;
	sleep: Sleep;
	/** The tower's own workspace: a request for another workspace goes to that workspace's tower. */
	workspaceId: string;
	/** Where the new pi runs when the workspace has no checkout path of its own. */
	cwd: string;
	sessions(): Promise<Session[]>;
	send(to: string, message: string): Promise<{ status: string; code?: string; detail?: string }>;
	/** The tower itself: the main reports to it as well as to the sender, and it closes the main afterwards (closemain.ts). */
	tower(): { id: string; name: string };
}
export interface OpenRequest { request: string; sender: string; label?: string }
export interface Opened { tab: string; pane: string; main: string; sender: string; repeated?: true }

/** The text the new main starts from: who asked, and what, with nothing summarised. The main answers the sender and the tower that opened it, then waits to be closed. */
export const handoff = (workspace: string, sender: Session, request: string, tower: { id: string; name: string }) =>
	[
		`Straw Boss: the tower of workspace ${workspace} opened this tab for you because no session owned the request below, and you are its main agent.`,
		"Do the work, dispatching workers as your main agent prompt describes. When it is done, report the outcome with intercom send to both: the sender and the tower that opened this tab. Then wait; the tower closes this tab after your done report, so end it with the result and nothing you still have to do. If you wait for a boss decision, say so in your report and the tower leaves you open.",
		`Sender: ${sender.name ?? sender.id} (session id ${sender.id})`,
		`Tower: ${tower.name} (session id ${tower.id})`,
		"Request, verbatim:",
		request,
	].join("\n");

/**
 * Opens a main for a request, once, within the limits above. The same sender and request never open a second main, whether the first attempt is still running, succeeded,
 * or failed (a failed attempt closes the tab it created and is not retried: the sender hears of it instead).
 */
export function opener(env: OpenerEnv) {
	const seen = new Map<string, Promise<Opened>>();
	const open = async ({ request, sender: asked, label }: OpenRequest): Promise<Opened> => {
		const { run, sleep } = env;
		const sessions = await env.sessions();
		const matches = sessions.filter((s) => s.id === asked || s.name === asked);
		if (matches.length !== 1) throw new Error(`${matches.length ? "Several sessions are named" : "No live session is named or has the id"} "${asked}", so the new main could not report back to it`);
		const sender = matches[0]!;
		const workspace = (await workspaces(run)).find((w) => w.workspace_id === env.workspaceId);
		if (!workspace) throw new Error(`Workspace ${env.workspaceId} is not open any more`);
		// Limits come from live Herdr panes carrying the marker below, so they hold across a tower restart: a closed tab takes its marker with it, and
		// a main that died leaves one that expires with its token TTL. A restored main keeps its old marker (the asking session, now another id), so it counts toward the workspace cap only. Opens are serialised, so the count and the marker cannot race.
		const marked = (await panes(run, workspace.workspace_id)).filter((p) => p.tokens?.sb_opened_by);
		const ofSender = marked.filter((p) => p.tokens!.sb_opened_by === sender.id).length;
		if (ofSender) throw new OpenLimitError(`Sender ${sender.name ?? sender.id} already has ${ofSender === 1 ? "an opened main" : `${ofSender} opened mains`} running in workspace ${workspace.label}; a sender gets one at a time. Wait for it to finish, or send the request to it.`);
		if (marked.length >= MAX_OPENED_MAINS) throw new OpenLimitError(`Workspace ${workspace.label} already has ${marked.length} mains opened by its tower (the limit is ${MAX_OPENED_MAINS}); try again when one has finished.`);
		const { tabId, paneId } = await createTab(run, workspace.workspace_id, workspace.worktree?.checkout_path ?? env.cwd, ["STRAW_BOSS_ROLE=main"], label);
		try {
			// The marker counts toward the limits at once; sb_open_main authorises exactly one pi in this shell to promote itself (it consumes the token).
			await report(run, "pane", paneId, { sb_opened_by: sender.id, sb_open_main: "1" });
			// Herdr agent names are unique across workspaces and lowercase only.
			await startPi(run, sleep, `main-${randomUUID().slice(0, 8)}`, paneId, ["--name", `main · ${label ?? workspace.label}`]);
			// The pi is the tab's main once it has published its role; only then does it get the request, so its first prompt is the main agent's.
			const main = await waitFor(sleep, async () => {
				const role = (await panes(run, workspace.workspace_id)).find((p) => p.pane_id === paneId)?.tokens?.sb_role;
				return role === "main" ? (await env.sessions()).find((s) => s.herdrLocation?.paneId === paneId) : undefined;
			}, MAIN_WAIT_MS, 500);
			if (!main) throw new Error(`The pi in pane ${paneId} did not become the main agent of its tab within ${MAIN_WAIT_MS / 1000} s`);
			const sent = await env.send(main.id, handoff(workspace.label, sender, request, env.tower()));
			if (sent.status !== "sent") throw new Error(`The new main ${main.name ?? main.id} did not take the request: ${sent.status} ${sent.code ?? ""} ${sent.detail ?? ""}`.trim());
			return { tab: tabId, pane: paneId, main: main.id, sender: sender.id };
		} catch (error) {
			// Nothing was handed over, so no work is lost with the tab.
			await run(["tab", "close", tabId]).catch(() => {});
			throw error;
		}
	};
	let queue: Promise<unknown> = Promise.resolve();
	return (input: OpenRequest): Promise<Opened> => {
		const key = createHash("sha256").update(JSON.stringify([input.sender, input.request])).digest("hex");
		const prior = seen.get(key);
		if (prior) return prior.then((opened) => ({ ...opened, repeated: true as const }), (error: Error) => Promise.reject(new Error(`A main was already tried for this request and is not opened again: ${error.message}`)));
		const pending = queue.then(() => open(input), () => open(input));
		queue = pending.catch(() => {});
		seen.set(key, pending);
		pending.catch((error) => error instanceof OpenLimitError && seen.get(key) === pending && seen.delete(key));
		return pending;
	};
}
