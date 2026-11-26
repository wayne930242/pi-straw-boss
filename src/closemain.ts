import { randomUUID } from "node:crypto";
import { createDeadPanes } from "./deadpane.ts";
import { subagents } from "./netdata.ts";
import { type Pane, panes, type Session, waitFor, workspaces } from "./herdr.ts";
import { type HandedOver, readRecords } from "./roles.ts";
import { type Kit, REGISTER } from "./state.ts";
import { TRAIN } from "./trainrole.ts";

// A tower closes the mains it opened (boss_open_main), and a main that handed over to a live successor (boss_handover), whoever opened it (docs/specs/2026-11-23-tower-close-panes.md). It asks the main's own extension to quit as /boss close does, and the main decides: it checks that the
// request is from the tower of its workspace, that a tower opened it (its pane's `sb_opened_by` token) or it handed over (its `successor` entry), and that nothing running would be lost, as a stash
// checks. The ask goes over one intercom extension channel that towers, the mains a tower opened, and the mains that handed over register, `straw-boss/control`, with the "capable" audience;
// the sender id is the one the session reports to the broker (self-reported, a same-user trust boundary), and a request is for one session (`to`). It does not go through the GUI server, which may be stopped, and a bridge's close
// (bridge.ts) answers only that server.
//   {type: "close-main", to: <main session id>, reqId, interrupt?: true}       tower → main
//   {type: "close-main-result", to: <tower session id>, reqId, accepted, reason?}   main → tower
//   {type: "watch", to: <main session id>, reqId, key, state, text}   tower identity → main: a `boss_watch` line of the sb server (bosswatch.ts judges the sender)
//   {type: "watch-result", to: <tower session id>, reqId, accepted}   main → tower; also the answer to {type: "watch-ping", to, reqId}, whether this main takes watch lines from that tower identity now (a ward from the shell)
//   {type: "took-over", to: <old main session id>, reqId} / {type: "took-over-result", to: <successor id>, reqId, accepted}   a successor → the main that handed over to it (rotclose.ts)

export const CONTROL = "straw-boss/control";
const ASK_MS = 10_000, RETRY_MS = 15_000, RETRY_STEP_MS = 3000, QUIT_MS = 30_000;
type Event = { type: string; fromSessionId?: string; payload?: Record<string, unknown> };
interface Answer { from: string; accepted: boolean; reason?: string; busy?: boolean }
/** The word a tower's `boss_close_main` answers for a main of kind standing: it has no end and no done report, so only the boss closes it. Checked in the tools, not in `closeMain`: revoke.ts and a signed stop end a peer's main through it. */
export const STANDING_CLOSE = "is a standing main: it has no end and sends no done report, so only the boss closes it";
/** `stateDir`: where the role records are; a standing main whose record says it handed over has stepped down, so it is not refused. Left out (an ally run's check: a main opened for a device never hands over), none is read. */
export function refuseStanding(net: { sessions: { id: string; name?: string; herdrLocation?: { paneId?: string } }[]; ps: Pick<Pane, "pane_id" | "tokens" | "workspace_id" | "agent_session">[] }, query: string, stateDir?: string) {
	const named = net.sessions.filter((x) => x.id === query || x.name === query);
	if (named.length !== 1) return;
	const pane = net.ps.find((p) => p.pane_id === named[0]!.herdrLocation?.paneId);
	if (pane?.tokens?.sb_duty === "standing" && !(stateDir && handedOverOf(stateDir, pane))) throw new Error(`${named[0]!.name ?? named[0]!.id} ${STANDING_CLOSE}`);
}
/** A remote turn's refusal of a dead pane or the list of them (link/hooks.ts, tools.ts), as an ally run's (server/runtools.ts). */
export const REMOTE_CLOSE = "a remote turn closes only a main opened for its own device: dead panes and their list are the local tower's";
/**
 * A remote turn of a pi tower closes only a main opened for the device of every sender of the turn (its pane's `sb_opened_by` is `link:<device>`), as an ally run does (server/runtools.ts `refuseClose`): not a dead
 * pane, not the list, not a main the boss or a local tower opened, though it handed over. Returns the main's session id.
 */
export function remoteCloseTarget(net: { sessions: { id: string; name?: string; herdrLocation?: { paneId?: string } }[]; ps: Pick<Pane, "pane_id" | "tokens">[] }, args: { main?: string; pane?: string }, devices: string[]): string {
	if (args.pane !== undefined || args.main === undefined) throw new Error(REMOTE_CLOSE);
	const named = net.sessions.filter((x) => x.id === args.main || x.name === args.main), no = new Error(`${args.main} was not opened for the device of this remote turn; ${REMOTE_CLOSE}`);
	if (named.length !== 1 || !devices.length) throw no;
	const token = net.ps.find((p) => p.pane_id === named[0]!.herdrLocation?.paneId)?.tokens?.sb_opened_by;
	const device = typeof token === "string" && token.startsWith("link:") ? token.replace(/^(link:)+/, "") : undefined;
	if (!device || devices.some((d) => d !== device)) throw no;
	return named[0]!.id;
}
/**
 * The handover mark (roles.ts `handedOver`) of the main a pane runs: from the role record of the session file Herdr names for the pane, else the newest main record of that pane and workspace. The main confirms it
 * itself when asked (its own `successor` entry), so a record alone closes nothing.
 */
export function handedOverOf(stateDir: string, pane: Pick<Pane, "pane_id" | "workspace_id" | "agent_session">): HandedOver | undefined {
	const file = pane.agent_session?.value;
	const mains = readRecords(stateDir).map((r) => r.record).filter((r) => r.role === "main" && r.pane === pane.pane_id && r.workspace === pane.workspace_id && (!file || r.file === file));
	return mains.sort((a, b) => b.at - a.at)[0]?.handedOver;
}
/** The successor's pane when it is live: the broker lists its session, and pi runs in the pane the broker places it in. */
export const liveSuccessor = (h: HandedOver, sessions: Session[], ps: Pane[]): Pane | undefined => {
	const at = sessions.find((x) => x.id === h.to)?.herdrLocation?.paneId;
	return at ? ps.find((p) => p.pane_id === at && p.agent === "pi") : undefined;
};
/** What a main that handed over tells its workspace's tower (§4): code-written, as a milestone that expects no reply. */
export const handedNotice = (name: string, id: string, next: { tab: string; main: string }) =>
	`Straw Boss: main ${name} (session ${id}) handed over to its successor in tab ${next.tab} (session ${next.main}), which took the handoff. ${name} steps down now and closes itself once its successor confirms the takeover and nothing of it runs; if it is still open later while its successor is live and it is idle, close it with boss_close_main with main "${id}".`;

interface Closed { text: string; main: string; name: string; closed: boolean }
/** `interrupt` (a stop's mode, docs/specs/2026-11-07-link-remote-stop.md, section 5): a main that is working aborts its turn and answers busy, so the next ask finds it idle; the tower skips its own idle pre-check for it. */
export type CloseMain = (query: string, opts?: { interrupt?: boolean }) => Promise<Closed>;
/** What an `interrupt` needs of the main's session: whether a turn runs, what an abort does not end (a dialog, a monitor), and the abort itself. */
export interface Turn { running(): boolean; blockers(): string | undefined; abort(): void }

/** `closeSelf` quits this session as /boss close does; `check` says why it cannot be stashed now (the bridge's check: a turn, a queue, a dialog, a monitor); `turn` lets an `interrupt` abort a turn (a tower service has none and never receives one). */
export function createCloseMain({ pi, cfg, s, me, guiDir }: Kit, { closeSelf, check, turn }: { closeSelf(keepPane: boolean): string | undefined; check(): string | undefined; turn?: Turn }) {
	const { run, sleep } = cfg;
	let channel: { publish(payload: unknown, options?: { audience?: "owner" | "capable" }): void } | undefined;
	const answers = new Map<string, Answer>();
	let onWatch: ((from: string, payload: Record<string, unknown>) => Promise<boolean>) | undefined, onTook: ((from: string) => boolean) | undefined;
	const send = (payload: Record<string, unknown>) => channel?.publish({ version: 1, ...payload }, { audience: "capable" });

	/** Why this main will not close for `from`; none when it will. `busy`: something running would be lost, which may pass; the rest is a no. */
	const judge = async (from: string, interrupt = false): Promise<{ reason: string; busy?: true } | undefined> => {
		const no = (reason: string) => ({ reason });
		if (s.isTower) return no("this session is a tower");
		if (!s.joined) return no("this session has not joined the net");
		const [all, workspace] = await Promise.all([panes(run), workspaces(run).then((list) => list.find((w) => w.workspace_id === s.at.workspaceId))]);
		const mine = all.find((p) => p.pane_id === s.at.paneId);
		// A main that handed over (its own `successor` entry, written once the successor took the handoff) has stepped down: its workspace's tower may close it, whoever opened it.
		if (!mine?.tokens?.sb_opened_by && !s.saved.successor?.main) return no("no tower opened this main, so only the boss closes it");
		if (!workspace?.tokens?.tower || workspace.tokens.tower !== from) return no("the request is not from the tower of this workspace");
		const running = subagents(mine, all, cfg.now()).filter((row) => !row.ended).length;
		const subs = running && `${running} subagent${running > 1 ? "s are" : " is"} running`;
		// An interrupt aborts the turn in flight, and only that: a dialog, a monitor or a subagent is work the abort does not end, so they still refuse. A queue that survives the abort (pi's TUI clears it; an RPC or SDK abort does not) is another busy answer at the next ask.
		if (interrupt && turn?.running()) {
			const others = [turn.blockers(), subs].filter(Boolean).join(", ");
			if (others) return { reason: others, busy: true };
			turn.abort();
			return { reason: "its turn was interrupted; it quits once it is idle", busy: true };
		}
		const busy = [check(), subs].filter(Boolean).join(", ");
		return busy ? { reason: busy, busy: true } : undefined;
	};
	const answer = async (from: string, reqId: string, interrupt: boolean) => {
		const refused = await judge(from, interrupt).catch((error: Error) => ({ reason: `it could not check itself: ${error.message}` }));
		const quit = refused ? undefined : closeSelf(false);
		const why = refused ?? (quit ? { reason: quit } : undefined);
		send({ type: "close-main-result", to: from, reqId, accepted: !why, ...(why ?? {}) });
	};
	const onEvent = (event: Event) => {
		const p = event.payload, from = event.fromSessionId;
		if (event.type !== "message" || p?.version !== 1 || !from || typeof p.reqId !== "string" || p.reqId.length > 64) return;
		if (p.type === "close-main" && p.to === me()) void answer(from, p.reqId, p.interrupt === true);
		if ((p.type === "watch" || p.type === "watch-ping") && p.to === me()) void (onWatch?.(from, p) ?? Promise.resolve(false)).catch(() => false).then((accepted) => send({ type: "watch-result", to: from, reqId: p.reqId, accepted }));
		if (p.type === "took-over" && p.to === me()) send({ type: "took-over-result", to: from, reqId: p.reqId, accepted: onTook?.(from) === true });
		if ((p.type === "close-main-result" || p.type === "watch-result" || p.type === "took-over-result") && p.to === me() && typeof p.accepted === "boolean") answers.set(p.reqId, { from, accepted: p.accepted, ...(typeof p.reason === "string" ? { reason: p.reason.slice(0, 300) } : {}), ...(p.busy === true ? { busy: true } : {}) });
	};

	/** The ask: the answer of the session asked, or none within ASK_MS (an older pi-straw-boss never registered the channel). */
	const ask = async (main: string, interrupt: boolean) => {
		const reqId = randomUUID().slice(0, 12);
		send({ type: "close-main", to: main, reqId, ...(interrupt ? { interrupt: true } : {}) });
		const got = await waitFor(sleep, () => (answers.get(reqId)?.from === main ? answers.get(reqId) : undefined), ASK_MS, 100);
		answers.delete(reqId);
		return got;
	};

	const dead = createDeadPanes({ run, sessions: () => s.c.listSessions(), here: () => ({ workspace: s.at.workspaceId, pane: s.at.paneId }), stateDir: guiDir, now: cfg.now });
	return {
		/** Every tower, every main a tower opened, and every main that handed over hears and answers asks; registering twice is a no-op. */
		register() {
			if (channel) return;
			pi.events.emit(REGISTER, { namespace: CONTROL, ownerEligible: false, onReady: (c: NonNullable<typeof channel>) => (channel = c), onEvent });
			if (!channel) throw new Error("pi-intercom is not loaded (Straw Boss needs pi-intercom >= 0.17.1)");
		},
		/** The tower's side: a main this workspace's tower opened, by intercom name or session id. */
		closeMain: (async (query: string, opts?: { interrupt?: boolean }) => {
			const interrupt = opts?.interrupt === true;
			if (!channel) throw new Error("This session cannot reach the mains' control channel yet");
			const [sessions, all] = await Promise.all([s.c.listSessions(), panes(run)]);
			const found = sessions.filter((x) => x.id === query || x.name === query);
			if (found.length !== 1) throw new Error(`${found.length ? "Several sessions are named" : "No live session is named or has the id"} "${query}"`);
			const main = found[0]!, name = main.name ?? main.id, pane = all.find((p) => p.pane_id === main.herdrLocation?.paneId);
			if (pane?.workspace_id !== s.at.workspaceId) throw new Error(`${name} is not in this workspace; a tower closes only the mains it opened here`);
			if (pane.tokens?.sb_role !== "main" && pane.tokens?.sb_role !== TRAIN) throw new Error(`${name} is not a main agent`);
			const handed = pane.tokens.sb_role === "main" ? handedOverOf(guiDir, pane) : undefined;
			if (!pane.tokens.sb_opened_by && !handed) throw new Error(`${name} was not opened by a tower (the boss opened it), so only the boss closes it`);
			// A main that handed over is closed once its successor is live: until then the old main is the one session that holds the work.
			if (handed && !liveSuccessor(handed, sessions, all)) throw new Error(`${name} handed over to session ${handed.to.slice(0, 8)}${handed.tab ? ` (tab ${handed.tab})` : ""}, which is not live (no pi runs it, or the broker does not list it); the old main stays open until its successor is live, or the boss closes it`);
			if (!interrupt && !["idle", "done"].includes(pane.agent_status ?? "")) throw new Error(`${name} is ${pane.agent_status ?? "in an unknown state"}; try again when it is idle`);
			// A main reports its outcome in the turn that ends right after, so a refusal for something running is asked again for a while; any other refusal is final.
			let got = await ask(main.id, interrupt);
			for (let waited = 0; got?.busy && waited < RETRY_MS; waited += RETRY_STEP_MS) (await sleep(RETRY_STEP_MS), (got = await ask(main.id, interrupt)));
			if (!got) throw new Error(`${name} did not answer the close request within ${ASK_MS / 1000} s (an older pi-straw-boss, or a stuck session); close it in its terminal`);
			if (!got.accepted) throw new Error(`${name} will not close: ${got.reason ?? "refused"}`);
			const gone = await waitFor(sleep, async () => !(await s.c.listSessions().catch(() => [main])).some((x) => x.id === main.id), QUIT_MS, 500);
			return { text: gone ? `${name} quit and its pane closed.` : `${name} accepted and is shutting down; its pane closes once pi has exited.`, main: main.id, name, closed: Boolean(gone) };
		}) as CloseMain,
		/** The main's side of a watch line (bosswatch.ts): the handler that judges the sender and hands the line to pi. */
		onWatch: (handler: NonNullable<typeof onWatch>) => void (onWatch = handler),
		/** The old main's side of a takeover (rotclose.ts): whether `from` is its successor, which this main then closes itself for. */
		onTook: (handler: NonNullable<typeof onTook>) => void (onTook = handler),
		/** The tower identity's side: a watch line to a main, and whether it took it within ASK_MS; `type` took-over: a successor's word to the main that handed over to it. */
		async notify(to: string, payload: { text: string; key: string; state: string } | Record<string, never>, type = "watch"): Promise<boolean> {
			if (!channel) return false;
			const reqId = randomUUID().slice(0, 12);
			send({ type, to, reqId, ...payload });
			const got = await waitFor(sleep, () => (answers.get(reqId)?.from === to ? answers.get(reqId) : undefined), ASK_MS, 100);
			answers.delete(reqId);
			return got?.accepted === true;
		},
		/** The tower's side: the dead agent panes of this workspace (deadpane.ts), and the close of one. */
		deadPanes: () => dead.list(),
		closePane: (pane: string) => dead.close(pane),
	};
}
export type Control = ReturnType<typeof createCloseMain>;
