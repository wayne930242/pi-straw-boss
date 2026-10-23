import { randomUUID } from "node:crypto";
import { subagents } from "./dashboard.ts";
import { panes, waitFor, workspaces } from "./herdr.ts";
import { type Kit, REGISTER } from "./state.ts";

// A tower closes the mains it opened (boss_open_main). It asks the main's own extension to quit as /boss close does, and the main decides: it checks that the
// request is from the tower of its workspace, that a tower opened it (its pane's `sb_opened_by` token), and that nothing running would be lost, as a stash
// checks. The ask goes over one intercom extension channel every joined session and every tower registers, `straw-boss/control`, with the "capable" audience;
// the broker names the sender, and a request is for one session (`to`). It does not go through the GUI server, which may be stopped, and a bridge's close
// (bridge.ts) answers only that server.
//   {type: "close-main", to: <main session id>, reqId}                          tower → main
//   {type: "close-main-result", to: <tower session id>, reqId, accepted, reason?}   main → tower

export const CONTROL = "straw-boss/control";
const ASK_MS = 10_000, RETRY_MS = 15_000, RETRY_STEP_MS = 3000, QUIT_MS = 30_000;
type Event = { type: string; fromSessionId?: string; payload?: Record<string, unknown> };
interface Answer { from: string; accepted: boolean; reason?: string; busy?: boolean }
interface Closed { text: string; main: string; name: string; closed: boolean }
export type CloseMain = (query: string) => Promise<Closed>;

/** `closeSelf` quits this session as /boss close does; `check` says why it cannot be stashed now (the bridge's check: a turn, a queue, a dialog, a monitor). */
export function createCloseMain({ pi, cfg, s, me }: Kit, { closeSelf, check }: { closeSelf(keepPane: boolean): string | undefined; check(): string | undefined }) {
	const { run, sleep } = cfg;
	let channel: { publish(payload: unknown, options?: { audience?: "owner" | "capable" }): void } | undefined;
	const answers = new Map<string, Answer>();
	const send = (payload: Record<string, unknown>) => channel?.publish({ version: 1, ...payload }, { audience: "capable" });

	/** Why this main will not close for `from`; none when it will. `busy`: something running would be lost, which may pass; the rest is a no. */
	const judge = async (from: string): Promise<{ reason: string; busy?: true } | undefined> => {
		const no = (reason: string) => ({ reason });
		if (s.isTower) return no("this session is a tower");
		if (!s.joined) return no("this session has not joined the net");
		const [all, workspace] = await Promise.all([panes(run), workspaces(run).then((list) => list.find((w) => w.workspace_id === s.at.workspaceId))]);
		const mine = all.find((p) => p.pane_id === s.at.paneId);
		if (!mine?.tokens?.sb_opened_by) return no("no tower opened this main, so only the boss closes it");
		if (!workspace?.tokens?.tower || workspace.tokens.tower !== from) return no("the request is not from the tower of this workspace");
		const running = subagents(mine, all, cfg.now()).filter((row) => !row.ended).length;
		const busy = [check(), running && `${running} subagent${running > 1 ? "s are" : " is"} running`].filter(Boolean).join(", ");
		return busy ? { reason: busy, busy: true } : undefined;
	};
	const answer = async (from: string, reqId: string) => {
		const refused = await judge(from).catch((error: Error) => ({ reason: `it could not check itself: ${error.message}` }));
		const quit = refused ? undefined : closeSelf(false);
		const why = refused ?? (quit ? { reason: quit } : undefined);
		send({ type: "close-main-result", to: from, reqId, accepted: !why, ...(why ?? {}) });
	};
	const onEvent = (event: Event) => {
		const p = event.payload, from = event.fromSessionId;
		if (event.type !== "message" || p?.version !== 1 || !from || typeof p.reqId !== "string" || p.reqId.length > 64) return;
		if (p.type === "close-main" && p.to === me()) void answer(from, p.reqId);
		if (p.type === "close-main-result" && p.to === me() && typeof p.accepted === "boolean") answers.set(p.reqId, { from, accepted: p.accepted, ...(typeof p.reason === "string" ? { reason: p.reason.slice(0, 300) } : {}), ...(p.busy === true ? { busy: true } : {}) });
	};

	/** The ask: the answer of the session asked, or none within ASK_MS (an older pi-straw-boss never registered the channel). */
	const ask = async (main: string) => {
		const reqId = randomUUID().slice(0, 12);
		send({ type: "close-main", to: main, reqId });
		const got = await waitFor(sleep, () => (answers.get(reqId)?.from === main ? answers.get(reqId) : undefined), ASK_MS, 100);
		answers.delete(reqId);
		return got;
	};

	return {
		/** Every joined session, and every tower, hears and answers asks; registering twice is a no-op. */
		register() {
			if (channel) return;
			pi.events.emit(REGISTER, { namespace: CONTROL, ownerEligible: false, onReady: (c: NonNullable<typeof channel>) => (channel = c), onEvent });
			if (!channel) throw new Error("pi-intercom is not loaded (Straw Boss needs pi-intercom >= 0.17.1)");
		},
		/** The tower's side: a main this workspace's tower opened, by intercom name or session id. */
		closeMain: (async (query: string) => {
			if (!channel) throw new Error("This session cannot reach the mains' control channel yet");
			const [sessions, all] = await Promise.all([s.c.listSessions(), panes(run)]);
			const found = sessions.filter((x) => x.id === query || x.name === query);
			if (found.length !== 1) throw new Error(`${found.length ? "Several sessions are named" : "No live session is named or has the id"} "${query}"`);
			const main = found[0]!, name = main.name ?? main.id, pane = all.find((p) => p.pane_id === main.herdrLocation?.paneId);
			if (pane?.workspace_id !== s.at.workspaceId) throw new Error(`${name} is not in this workspace; a tower closes only the mains it opened here`);
			if (pane.tokens?.sb_role !== "main") throw new Error(`${name} is not a main agent`);
			if (!pane.tokens.sb_opened_by) throw new Error(`${name} was not opened by a tower (the boss opened it), so only the boss closes it`);
			if (!["idle", "done"].includes(pane.agent_status ?? "")) throw new Error(`${name} is ${pane.agent_status ?? "in an unknown state"}; try again when it is idle`);
			// A main reports its outcome in the turn that ends right after, so a refusal for something running is asked again for a while; any other refusal is final.
			let got = await ask(main.id);
			for (let waited = 0; got?.busy && waited < RETRY_MS; waited += RETRY_STEP_MS) (await sleep(RETRY_STEP_MS), (got = await ask(main.id)));
			if (!got) throw new Error(`${name} did not answer the close request within ${ASK_MS / 1000} s (an older pi-straw-boss, or a stuck session); close it in its terminal`);
			if (!got.accepted) throw new Error(`${name} will not close: ${got.reason ?? "refused"}`);
			const gone = await waitFor(sleep, async () => !(await s.c.listSessions().catch(() => [main])).some((x) => x.id === main.id), QUIT_MS, 500);
			return { text: gone ? `${name} quit and its pane closed.` : `${name} accepted and is shutting down; its pane closes once pi has exited.`, main: main.id, name, closed: Boolean(gone) };
		}) as CloseMain,
	};
}
export type Control = ReturnType<typeof createCloseMain>;
