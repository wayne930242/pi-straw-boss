import { createHash, randomUUID } from "node:crypto";
import { createTab, panes, startPi, type HerdrRun, type Session, type Sleep, waitFor, workspaces } from "./herdr.ts";

// The one thing a tower does besides routing: when no session owns a request, it opens a main for it (docs/how-it-works.md, "Opening a main").
// It is narrow on purpose: one new tab in the tower's own workspace, started without focus, in which Straw Boss starts pi. It types into no pane
// that already exists, and `STRAW_BOSS_ROLE=main` makes that pi promote itself once it has joined (index.ts).

const MAIN_WAIT_MS = 60_000;

export interface OpenerEnv {
	run: HerdrRun;
	sleep: Sleep;
	/** The tower's own workspace: a request for another workspace goes to that workspace's tower. */
	workspaceId: string;
	/** Where the new pi runs when the workspace has no checkout path of its own. */
	cwd: string;
	sessions(): Promise<Session[]>;
	send(to: string, message: string): Promise<{ status: string; code?: string; detail?: string }>;
}
export interface OpenRequest { request: string; sender: string; label?: string }
export interface Opened { tab: string; pane: string; main: string; sender: string; repeated?: true }

/** The text the new main starts from: who asked, and what, with nothing summarised. */
export const handoff = (workspace: string, sender: Session, request: string) =>
	[
		`Straw Boss: the tower of workspace ${workspace} opened this tab for you because no session owned the request below, and you are its main agent.`,
		"Do the work, dispatching workers as your main agent prompt describes, and report the outcome to the sender with intercom send.",
		`Sender: ${sender.name ?? sender.id} (session id ${sender.id})`,
		"Request, verbatim:",
		request,
	].join("\n");

/**
 * Opens a main for a request, once. The same sender and request never open a second main, whether the first attempt is still running, succeeded,
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
		const { tabId, paneId } = await createTab(run, workspace.workspace_id, workspace.worktree?.checkout_path ?? env.cwd, ["STRAW_BOSS_ROLE=main"], label);
		try {
			// Herdr agent names are unique across workspaces and lowercase only.
			await startPi(run, sleep, `main-${randomUUID().slice(0, 8)}`, paneId, ["--name", `main · ${label ?? workspace.label}`]);
			// The pi is the tab's main once it has published its role; only then does it get the request, so its first prompt is the main agent's.
			const main = await waitFor(sleep, async () => {
				const role = (await panes(run, workspace.workspace_id)).find((p) => p.pane_id === paneId)?.tokens?.sb_role;
				return role === "main" ? (await env.sessions()).find((s) => s.herdrLocation?.paneId === paneId) : undefined;
			}, MAIN_WAIT_MS, 500);
			if (!main) throw new Error(`The pi in pane ${paneId} did not become the main agent of its tab within ${MAIN_WAIT_MS / 1000} s`);
			const sent = await env.send(main.id, handoff(workspace.label, sender, request));
			if (sent.status !== "sent") throw new Error(`The new main ${main.name ?? main.id} did not take the request: ${sent.status} ${sent.code ?? ""} ${sent.detail ?? ""}`.trim());
			return { tab: tabId, pane: paneId, main: main.id, sender: sender.id };
		} catch (error) {
			// Nothing was handed over, so no work is lost with the tab.
			await run(["tab", "close", tabId]).catch(() => {});
			throw error;
		}
	};
	return (input: OpenRequest): Promise<Opened> => {
		const key = createHash("sha256").update(JSON.stringify([input.sender, input.request])).digest("hex");
		const prior = seen.get(key);
		if (prior) return prior.then((opened) => ({ ...opened, repeated: true as const }), (error: Error) => Promise.reject(new Error(`A main was already tried for this request and is not opened again: ${error.message}`)));
		const pending = open(input);
		seen.set(key, pending);
		return pending;
	};
}
