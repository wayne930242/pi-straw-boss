import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Party, stamp } from "../header.ts";
import { callControl, ControlError } from "../server/socket.ts";
import { readRecord, slotOf } from "../server/record.ts";
import { type Channel, type Kit, REGISTER } from "../state.ts";
import { createApproval } from "./approval.ts";
import { ASK_MS, HolderSlow, NO_HOLDER, SUMMARY_KEEP_MS, SUMMARY_MS } from "./guiport.ts";
import { readLinkConfig } from "./config.ts";
import type { AllyBoard, AllyTeam, ConfirmView, LinkSummary } from "./holder.ts";
import { createRemoteTurns } from "./hooks.ts";
import { HERE_ONLY } from "./request.ts";
import { readPolicy } from "./policy.ts";
import { type ServiceDeps } from "./service.ts";
import { type InboxItem, LinkStore } from "./store.ts";
import { restrictLabel } from "./text.ts";
import { MESSAGE_TYPE } from "./turn.ts";
import { NAMESPACE } from "./wire.ts";

// Straw Link inside a pi session (docs/specs/2026-10-25-straw-link.md, Architecture; docs/specs/2026-10-26-sb-backend.md, What moves out of pi sessions). The link holder is not
// in the session any more: it runs in the primary sb server (service.ts), and a session asks it for what it needs over the server's control socket (`link`). A tower still
// registers the intercom extension channel `straw-boss/link`: the server offers it an inbox message there, and a tower accepts an offer only from the session `holder.json` names.
//
// Nothing here runs on a computer that has set up no team: no team in config.json and no team file means no channel and no files.

/** Seams for tests: the service's own (shorter timers, a relay, an isolated home folder) and the session's. */
export interface LinkDeps extends ServiceDeps {
	/** How soon a held message is looked at again for an idle tower (default 500 ms). */
	pumpMs?: number;
	/** How long the gate waits for an answer (default 10 minutes), and how long an approval dialog of a `link_request` does. */
	gateMs?: number;
	requestMs?: number;
	/** How long the terminal's confirm of a link_request waits after the dialog is published (approval.ts). */
	terminalMs?: number;
	/** How long the GUI's summary read waits for the holder (default `SUMMARY_MS`). */
	summaryMs?: number;
	/** How long after it was read the last summary may still be served when the holder is slow (default `SUMMARY_KEEP_MS`). */
	summaryKeepMs?: number;
	/** Replaces the control socket: what a request to the holder is answered by (a test hands the session the service of its world). `from` is this session's intercom id. */
	ask?: (op: Record<string, unknown>, from: string, ms: number) => Promise<{ ok: boolean; error?: string; [key: string]: unknown }>;
	/** Hands the module to a test as soon as it is built. */
	created?: (link: Link) => void;
}

export { MESSAGE_TYPE };
/** The session entry that remembers which inbox messages this session has already taken, so a restart does not take one twice. */
export const SEEN = "straw-link-seen";
const LONG_WAIT_MS = 10 * 60_000;
export { ASK_MS };

type ChannelEvent = { type: string; fromSessionId?: string; payload?: unknown };
type Answer = { ok: boolean; error?: string; [key: string]: unknown };
interface Held { id: string; item: InboxItem; at: number; noticed: boolean }

export interface RemoteTower {
	remote: true;
	team: string;
	device: { id: string; shortId: string; label: string };
	online: boolean;
	seenSecondsAgo: number | null;
	workspace: string | null;
	tower: string;
	tabs: { label: string; state: string }[];
}
/** The ally towers `tower_list` adds: one row per workspace a teammate's presence names, or one row for a device whose presence says none. What a presence says is cut to the label character set. */
export function remoteTowers(teams: AllyTeam[]): RemoteTower[] {
	return teams.flatMap((team) => team.devices.flatMap((d): RemoteTower[] => {
		const base = { remote: true as const, team: team.name, device: { id: d.id, shortId: d.short, label: d.label }, online: d.online, seenSecondsAgo: d.ageMs === null ? null : Math.round(d.ageMs / 1000) };
		if (d.workspaces.length === 0) return [{ ...base, workspace: null, tower: "unknown", tabs: [] }];
		return d.workspaces.map((w) => ({ ...base, workspace: restrictLabel(w.label), tower: restrictLabel(w.tower), tabs: w.tabs.map((t) => ({ label: restrictLabel(t.label), state: restrictLabel(t.state) })) }));
	}));
}

export function createLink({ pi, cfg, s, guiDir, me, tell }: Kit) {
	const opts: LinkDeps = cfg.link ?? {};
	const stateDir = cfg.stateDir ?? guiDir;
	const store = new LinkStore(join(stateDir, "link"));
	const home = opts.home ?? homedir(), agentDir = cfg.env.PI_CODING_AGENT_DIR ?? join(home, ".pi", "agent");
	const config = () => readLinkConfig(stateDir, { home, agentDir });
	const inUse = () => config().teams.size > 0 || store.teamIds().length > 0 || store.enabled;
	/** Whether this computer's policy leaves it attended: the GUI's team changes and `link_request` are for an attended computer only. */
	const attended = () => readPolicy(opts.policy).mode === "attended";
	const approval = createApproval({ bus: pi.events, timeoutMs: opts.requestMs, terminalDelayMs: opts.terminalMs, onError: (what, error) => store.log({ event: "approval-failed", what, error: error.message }) });
	let channel: Channel | undefined;
	let stopped = false, told = false;
	let ticker: ReturnType<typeof setInterval> | undefined;
	let lastCtx: Pick<ExtensionContext, "isIdle" | "hasPendingMessages"> | undefined;
	const sid = () => me();
	let lastSummary: { at: number; summary: LinkSummary } | undefined;
	const failed = (what: string) => (error: Error) => store.log({ event: `${what}-failed`, error: error.message });

	// ---- The channel (a tower only) ----------------------------------------------------------------------------------------------------

	const connect = (): boolean => {
		if (channel) return true;
		pi.events.emit(REGISTER, { namespace: NAMESPACE, ownerEligible: false, onReady: (c: Channel) => (channel = c), onEvent: (e: ChannelEvent) => onEvent(e) });
		if (!channel && !told) {
			told = true;
			tell("Straw Link needs pi-intercom 0.17.1 or newer; it is not loaded, so no team message reaches this computer", "warning");
		}
		return Boolean(channel);
	};
	/** A tower takes the server's offers on the channel; every other session has no need of it, and takes no part in the holder. */
	const look = () => {
		if (stopped || !inUse() || !s.holdsTower || !sid()) return;
		connect();
	};

	// ---- The tower's side: take a message when idle -----------------------------------------------------------------------------------

	const seen = new Set<string>(), held: Held[] = [];
	let pumpTimer: ReturnType<typeof setTimeout> | undefined;
	const schedule = (ms = opts.pumpMs ?? 500) => {
		if (stopped || pumpTimer || held.length === 0) return;
		pumpTimer = setTimeout(() => ((pumpTimer = undefined), pump()), ms);
		pumpTimer.unref();
	};
	/** The holder is told the message is in this session, so it leaves the inbox. */
	const confirm = (id: string) => void ask({ op: "taken", id }).catch(failed("taken"));
	const lineFor = (item: InboxItem): string => {
		const mine: Party = { name: s.ownName || pi.getSessionName() || sid(), id: sid(), role: "tower", ...(s.info.workspace ? { workspace: s.info.workspace } : {}) };
		const from: Party = { name: item.fromLabel, id: `link:${item.from}`, role: "tower", ...(item.fromWorkspace ? { workspace: item.fromWorkspace } : {}) };
		const team = config().teams.get(item.team)?.name ?? item.team.slice(0, 6);
		return stamp({ from, kind: "tower_send", scope: "tower", to: [mine], reply: item.replyExpected, remote: { device: item.fromLabel, short: item.fromShort, team } }, item.text);
	};
	/** At most one message per tick, and only when the tower is idle in that same tick: a message sent with `triggerTurn` into a busy run would steer it. */
	const pump = () => {
		const next = held[0];
		if (!next || stopped) return;
		let idle = false;
		try {
			idle = Boolean(lastCtx?.isIdle() && !lastCtx.hasPendingMessages());
		} catch { /* a context that went stale with its session */ }
		if (cfg.now() - next.at > LONG_WAIT_MS && !next.noticed) {
			next.noticed = true;
			tell(`Straw Link: a message from ${next.item.fromLabel} has waited more than 10 minutes for this tower to be idle`, "warning");
		}
		if (idle) {
			held.shift();
			// What the holder has done since the offer counts: the file is gone when another tower took the message or its sender left the team, and this session may have stopped being a tower.
			const item = s.holdsTower ? store.readInbox(next.id) : undefined;
			if (!item) return void schedule(0);
			try {
				pi.sendMessage({ customType: MESSAGE_TYPE, content: lineFor(item), display: true, details: { id: next.id, team: item.team, from: item.from, label: item.fromLabel, short: item.fromShort, seq: item.seq, sentAt: item.sentAt } }, { triggerTurn: true });
			} catch (error) {
				tell(`Straw Link: a message from ${item.fromLabel} could not be put into this session: ${(error as Error).message}`, "error");
				return void schedule();
			}
			seen.add(next.id);
			pi.appendEntry(SEEN, { id: next.id });
			confirm(next.id);
		}
		schedule();
	};
	/** The holder offers an inbox message: it is queued once, and a message already taken is confirmed again (the holder that offered it may have changed). */
	const takeOffer = (id: string) => {
		if (!s.holdsTower || stopped) return;
		if (seen.has(id)) return confirm(id);
		if (held.some((h) => h.id === id)) return;
		const item = store.readInbox(id);
		if (!item) return;
		held.push({ id, item, at: cfg.now(), noticed: false });
		schedule(0);
	};

	// ---- Requests to the holder, over the sb server's control socket ------------------------------------------------------------------

	/** The server's answer to a request: its holder's, or a failure told in words (the server is not running, is restarting, did not answer in time). */
	const askServer = async (op: Record<string, unknown>, ms: number): Promise<Answer> => {
		const record = readRecord(slotOf(stateDir, cfg.env));
		if (!record?.socket || !record.secret) throw new Error(NO_HOLDER);
		let reply;
		try {
			reply = (await callControl(record.socket, record.secret, { cmd: "link", from: sid(), body: op }, ms)).reply;
		} catch (error) {
			if (error instanceof ControlError) {
				if (error.failure === "timeout") throw new HolderSlow(`The link holder did not answer within ${ms / 1000} s`);
				if (error.failure === "no-server") throw new Error(NO_HOLDER);
				throw new Error(`The sb server did not take the request: ${error.message}`);
			}
			throw error;
		}
		if (!reply?.ok) throw new Error(reply?.error === "restarting" ? "The sb server is restarting; ask again in a moment" : `The sb server refused the request: ${String(reply?.error ?? "no answer")}`);
		return reply.answer as Answer;
	};
	/** A request that outlasts `ms` is a holder that is slow, whichever way it was put (the socket enforces it itself; a replaced `ask` is held to it here). */
	const within = <T>(work: Promise<T>, ms: number): Promise<T> => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const late = new Promise<never>((_, reject) => void (timer = setTimeout(() => reject(new HolderSlow(`The link holder did not answer within ${ms / 1000} s`)), ms)));
		return Promise.race([work, late]).finally(() => clearTimeout(timer));
	};
	const ask = async (op: Record<string, unknown>, ms = ASK_MS): Promise<Answer> => {
		const answer = await (opts.ask ? within(opts.ask(op, sid(), ms), ms) : askServer(op, ms));
		// The server has no holder (yet): told as the missing holder is, so a caller can tell "not there" from "refused".
		if (!answer.ok && answer.code === "no_holder") throw new Error(NO_HOLDER);
		return answer;
	};

	const onEvent = (event: ChannelEvent) => {
		const p = event.payload as Record<string, unknown> | undefined, from = event.fromSessionId;
		if (event.type !== "message" || !p || p.version !== 1 || !from || from === sid() || p.to !== sid()) return;
		if (p.type === "offer" && typeof p.id === "string" && from === store.readHolder()?.session) takeOffer(p.id);
		else if (p.type === "confirmed" && typeof p.id === "string" && typeof p.allow === "boolean" && from === store.readHolder()?.session) answerForward(p.id, p.allow);
	};

	// ---- Remote turns --------------------------------------------------------------------------------------------------------------------

	const remote = createRemoteTurns({
		pi, now: cfg.now, config, policy: opts.policy, home, agentDir, linkDir: join(stateDir, "link"), gateMs: opts.gateMs,
		setOrigin: (origin) => void (s.remoteOrigin = origin), tower: () => s.ownName || pi.getSessionName() || sid(),
		log: (event) => store.log(event), tell,
		ask: (op) => ask(op),
	});
	const { answerForward } = remote;

	// ---- Session hooks -------------------------------------------------------------------------------------------------------------------

	pi.on("session_start", (_event, ctx) => {
		stopped = false;
		lastCtx = ctx;
		seen.clear();
		// Every entry of the session file, not only this branch: a crash between sending a message and writing the `seen` entry, or a restart on another branch, must not take it twice.
		for (const entry of ctx.sessionManager.getEntries()) {
			const e = entry as { type: string; customType?: string; data?: { id?: unknown }; details?: { id?: unknown } };
			if (e.type === "custom" && e.customType === SEEN && typeof e.data?.id === "string") seen.add(e.data.id);
			if (e.type === "custom_message" && e.customType === MESSAGE_TYPE && typeof e.details?.id === "string") seen.add(e.details.id);
		}
		clearInterval(ticker);
		ticker = setInterval(look, opts.tickMs ?? 2000);
		ticker.unref();
		look();
	});
	// The context pi hands every event is how a tower asks whether it is idle; a run that ends is the moment to look for a held message.
	pi.on("before_agent_start", (_event, ctx) => void (lastCtx = ctx));
	pi.on("agent_end", (_event, ctx) => void ((lastCtx = ctx), schedule(0)));
	pi.on("agent_settled", (_event, ctx) => void ((lastCtx = ctx), schedule(0)));
	pi.on("session_shutdown", async () => {
		stopped = true;
		clearInterval(ticker);
		clearTimeout(pumpTimer);
		pumpTimer = undefined;
		held.length = 0;
		approval.dispose();
	});

	const api = {
		/** The confirm requests other devices put to this one, waiting for its boss (the GUI of a later step shows them). */
		async confirms(): Promise<ConfirmView[]> {
			const answer = await ask({ op: "confirms" });
			return answer.ok ? (answer.confirms as ConfirmView[]) : [];
		},
		/** This device's boss allows or denies a confirm request; the answer goes back to the requesting device. */
		async answerConfirm(dialogId: string, allow: boolean): Promise<void> {
			const answer = await ask({ op: "answer-confirm", dialogId, allow });
			if (!answer.ok) throw new Error(answer.error);
		},
		/** Sends `text` to a teammate's tower: the holder checks the device, signs, encrypts, and posts it. */
		async send(req: { device: string; workspace?: string; text: string; reply: boolean }) {
			if (!inUse()) throw new Error("Straw Link is not set up on this computer: no team in config.json (link.teams) and no team file");
			const answer = await ask({ op: "send", ...req });
			if (!answer.ok) throw new Error(answer.error);
			return { text: String(answer.text), details: answer.details };
		},
		/** The ally towers for `tower_list`; undefined when Straw Link is not set up here. `teams` limits them to those teams (a remote turn sees its senders' teams only). */
		async remote(teams?: readonly string[]): Promise<RemoteTower[] | undefined> {
			if (!inUse()) return undefined;
			try {
				const answer = await ask({ op: "list", ...(teams ? { teams } : {}) });
				return answer.ok ? remoteTowers(answer.teams as AllyTeam[]) : [];
			} catch {
				return [];
			}
		},
		/** The allies' work boards for `board_read`; undefined when Straw Link is not set up here. A device that is not found, or is ambiguous, is an error that says so. */
		async boards(o: { teams?: readonly string[]; device?: string } = {}): Promise<AllyBoard[] | undefined> {
			if (!inUse()) return undefined;
			let answer;
			try {
				answer = await ask({ op: "board-read", ...(o.teams ? { teams: o.teams } : {}), ...(o.device !== undefined ? { device: o.device } : {}) });
			} catch (error) {
				if (o.device !== undefined) throw error;
				return [];
			}
			if (!answer.ok) {
				if (o.device !== undefined) throw new Error(answer.error);
				return [];
			}
			return answer.boards as AllyBoard[];
		},
		/** The teams of the senders of the current remote turn and the one project they all bind, or undefined outside a remote turn (spec, Reading: `board_read`, in a remote turn). */
		remoteScope(): { teams: string[]; project: string | undefined } | undefined {
			return remote.scope();
		},
		/** Whether this computer is attended (no unattended policy file). */
		attended,
		/** Sets Straw Link up on this computer without a team yet (the GUI's Team settings): the server's holder starts within a few seconds. */
		async enable(): Promise<void> {
			await store.withLock(() => store.enable());
			look();
		},
		/** A change or a reading for the GUI, through the holder in the server; only the GUI's host session is taken. */
		async gui(name: string, args: Record<string, unknown> = {}): Promise<{ ok: boolean; error?: string; code?: string; [key: string]: unknown }> {
			try {
				return await ask({ op: "gui", name, args });
			} catch (error) {
				const message = (error as Error).message;
				return { ok: false, error: message, ...(message === NO_HOLDER ? { code: "no_holder" } : {}) };
			}
		},
		/** The compact reading the net snapshot carries; undefined when Straw Link is not set up or no holder answers. */
		async summary(): Promise<LinkSummary | undefined> {
			if (!inUse()) return (lastSummary = undefined), undefined;
			try {
				const answer = await ask({ op: "gui", name: "summary", args: {} }, opts.summaryMs ?? SUMMARY_MS);
				lastSummary = answer.ok ? { at: cfg.now(), summary: answer.summary as LinkSummary } : undefined;
				return lastSummary?.summary;
			} catch (error) {
				// A holder that is slow: the last reading while it is fresh, so the map does not flicker. One that is gone or refuses shows nothing.
				if (!(error instanceof HolderSlow) || !lastSummary || cfg.now() - lastSummary.at > (opts.summaryKeepMs ?? SUMMARY_KEEP_MS)) lastSummary = undefined;
				return lastSummary?.summary;
			}
		},
		/**
		 * `link_request`: the holder checks the request and says what it does, the boss approves it in the GUI, a paired device, or the terminal, and only
		 * then does the holder carry it out. Never runs unasked: no approval, no action. Throws with the reason when it does not run.
		 */
		async request(r: { action: string; args: Record<string, string>; reason: string; toolCallId: string; asker: string; ui?: Parameters<typeof approval.approve>[0]["ui"]; signal?: AbortSignal }): Promise<string> {
			if (!attended()) throw new Error("link_request is refused on an unattended device: its teams and trust come from its infra's policy file and join.txt only");
			const opened = await ask({ op: "request-open", action: r.action, args: r.args, reason: r.reason });
			if (!opened.ok) throw new Error(opened.error);
			const id = String(opened.id), lines = [...(opened.lines as string[]), `Asked by session: ${r.asker} (${sid().slice(0, 8)})`, `Reason: ${String(opened.reason)}`];
			const verdict = await approval.approve({ hereOnly: (HERE_ONLY as readonly string[]).includes(r.action), toolCallId: r.toolCallId, lines, asker: r.asker, ui: r.ui, signal: r.signal });
			if (!verdict.approved) {
				await ask({ op: "request-drop", id }).catch(() => undefined);
				throw new Error(verdict.reason);
			}
			const ran = await ask({ op: "request-run", id });
			if (!ran.ok) throw new Error(ran.error);
			return String(ran.text);
		},
	};
	opts.created?.(api as Link);
	return api;
}
export type Link = ReturnType<typeof createLink>;
