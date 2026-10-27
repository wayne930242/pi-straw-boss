import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Party, stamp } from "../header.ts";
import type { Session } from "../herdr.ts";
import { startOf } from "../startof.ts";
import { type Channel, type Kit, REGISTER } from "../state.ts";
import { createApproval } from "./approval.ts";
import { ASK_MS, HolderSlow, NO_HOLDER, SUMMARY_KEEP_MS, SUMMARY_MS } from "./guiport.ts";
import { readLinkConfig } from "./config.ts";
import type { DeviceKeys } from "./device.ts";
import { readFileSync } from "node:fs";
import { holderAlive, LinkElection } from "./election.ts";
import { type AllyBoard, type AllyTeam, type ConfirmView, LinkHolder, type LinkSummary, type RelayPort, type SendResult } from "./holder.ts";
import { RelayClient } from "./relay.ts";
import { HERE_ONLY } from "./request.ts";
import type { NetView } from "./routing.ts";
import { type PolicyDeps, readPolicy } from "./policy.ts";
import { createRemoteTurns } from "./hooks.ts";
import { type HolderRecord, type InboxItem, LinkStore } from "./store.ts";
import { restrictLabel } from "./text.ts";
import { MESSAGE_TYPE } from "./turn.ts";
import { chunks, NAMESPACE, Reassembler } from "./wire.ts";

// Straw Link inside a pi session (docs/specs/2026-10-25-straw-link.md, Architecture, Link holder). Every joined session, and every tower, is a
// candidate for the link holder; the one the election names (election.ts) runs the relay streams (holder.ts). Towers talk to it, and it to them,
// on the intercom extension channel `straw-boss/link` (wire.ts); a tower accepts an offer only from the session `holder.json` names.
//
// Nothing here runs on a computer that has set up no team: no team in config.json and no team file means no channel, no election, no files.

/** Seams for tests: shorter timers, a relay behind a fake `fetch`, a stand-in for "the holder's process is gone", and an isolated home folder. */
export interface LinkDeps {
	tickMs?: number;
	drainMs?: number;
	presenceMs?: number;
	/** The least time between two boards to a team (default 15 s). */
	boardMs?: number;
	offerAgainMs?: number;
	/** How soon a held message is looked at again for an idle tower (default 500 ms). */
	pumpMs?: number;
	relay?: (url: string, device: DeviceKeys) => RelayPort;
	alive?: (record: HolderRecord) => boolean;
	home?: string;
	/** Where the unattended policy file is and who owns what (policy.ts); the real device reads the fixed path. */
	policy?: PolicyDeps;
	/** How long the gate waits for an answer (default 10 minutes), and how long an approval dialog of a `link_request` does. */
	gateMs?: number;
	requestMs?: number;
	/** How long the terminal's confirm of a link_request waits after the dialog is published (approval.ts). */
	terminalMs?: number;
	/** How long the GUI's summary read waits for the holder (default `SUMMARY_MS`). */
	summaryMs?: number;
	/** How long after it was read the last summary may still be served when the holder is slow (default `SUMMARY_KEEP_MS`). */
	summaryKeepMs?: number;
	/** Hands the module to a test as soon as it is built. */
	created?: (link: Link) => void;
}

export { MESSAGE_TYPE };
/** The session entry that remembers which inbox messages this session has already taken, so a restart does not take one twice. */
export const SEEN = "straw-link-seen";
const LONG_WAIT_MS = 10 * 60_000;
export { ASK_MS };

type ChannelEvent = { type: string; fromSessionId?: string; payload?: unknown };
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
	const store = new LinkStore(join(guiDir, "link"));
	const home = opts.home ?? homedir(), agentDir = cfg.env.PI_CODING_AGENT_DIR ?? join(home, ".pi", "agent");
	const config = () => readLinkConfig(guiDir, { home, agentDir });
	const inUse = () => config().teams.size > 0 || store.teamIds().length > 0 || store.enabled;
	/** Whether this computer's policy leaves it attended: the GUI's team changes and `link_request` are for an attended computer only. */
	const attended = () => readPolicy(opts.policy).mode === "attended";
	/** The session that hosts the GUI server (gui.json): the only one whose GUI requests the holder takes. */
	const guiOwner = (): string | undefined => {
		try {
			return (JSON.parse(readFileSync(join(guiDir, "gui.json"), "utf8")) as { ownerSession?: string }).ownerSession || undefined;
		} catch {
			return undefined;
		}
	};
	const approval = createApproval({ bus: pi.events, timeoutMs: opts.requestMs, terminalDelayMs: opts.terminalMs, onError: (what, error) => store.log({ event: "approval-failed", what, error: error.message }) });
	const nonce = randomUUID().slice(0, 8);
	let channel: Channel | undefined, election: LinkElection | undefined, holder: LinkHolder | undefined;
	let mySession = "", stopped = false, told = false, started: string | undefined;
	let ticker: ReturnType<typeof setInterval> | undefined, looking: Promise<void> | undefined;
	let lastCtx: Pick<ExtensionContext, "isIdle" | "hasPendingMessages"> | undefined;
	const sid = () => me() || mySession;
	const holderUp = opts.alive ?? holderAlive();
	let lookError = "";
	let lastSummary: { at: number; summary: LinkSummary } | undefined;
	/** A look that failed (the holder could not start, the lock was not free, a disk error): in the log, and once per message to the boss. */
	const lookFailed = (error: Error) => {
		store.log({ event: "look-failed", error: error.message });
		if (error.message === lookError) return;
		lookError = error.message;
		tell(`Straw Link: this session could not start the link holder: ${error.message}`, "error");
	};
	const failed = (what: string) => (error: Error) => store.log({ event: `${what}-failed`, error: error.message });

	// ---- The channel ---------------------------------------------------------------------------------------------------------------

	const publish = (payload: unknown) => channel?.publish(payload, { audience: "capable" });
	const connect = (): boolean => {
		if (channel) return true;
		pi.events.emit(REGISTER, { namespace: NAMESPACE, ownerEligible: false, onReady: (c: Channel) => (channel = c), onEvent: (e: ChannelEvent) => onEvent(e) });
		if (!channel && !told) {
			told = true;
			tell("Straw Link needs pi-intercom 0.17.1 or newer; it is not loaded, so no team message reaches this computer", "warning");
		}
		return Boolean(channel);
	};

	// ---- The election and the holder ------------------------------------------------------------------------------------------------

	/** One reading of Herdr and pi-intercom for the holder (deliveries, sends, presence). */
	const net = async (withTabs = false): Promise<NetView> => {
		const [sessions, world] = await Promise.all([channel!.listSessions(), cfg.world()]);
		if (!withTabs) return { sessions, panes: world.panes, workspaces: world.workspaces, tabs: [] };
		const bound = world.workspaces.filter((w) => world.panes.some((p) => p.workspace_id === w.workspace_id && p.tokens?.sb_role === "tower"));
		const tabs = (await Promise.all(bound.map((w) => cfg.world(w.workspace_id).then((x) => x.tabs).catch(() => [])))).flat();
		return { sessions, panes: world.panes, workspaces: world.workspaces, tabs };
	};
	/** Tells a tower a message waits for it: in this process directly, else over the channel. */
	const offer = (tower: Session, id: string) => {
		if (tower.id === sid()) return takeOffer(id);
		publish({ version: 1, type: "offer", to: tower.id, id });
	};
	const gained = async () => {
		const fresh = new LinkHolder({
			store, boardDir: join(guiDir, "board"), isHolder: () => Boolean(election?.isHolder()), config, stateDir: guiDir, home, agentDir, attended, net, offer, notify: tell,
			relay: opts.relay ?? ((url, device) => new RelayClient({ url, device })),
			onDisplaced: () => void look().catch(() => undefined),
			confirmed: (tower, dialogId, allow) => (tower === sid() ? answerForward(dialogId, allow) : publish({ version: 1, type: "confirmed", to: tower, id: dialogId, allow })),
			drainMs: opts.drainMs, presenceMs: opts.presenceMs, boardMinMs: opts.boardMs, offerAgainMs: opts.offerAgainMs,
		});
		holder = fresh;
		await fresh.start();
	};
	const lost = async () => {
		const old = holder;
		holder = undefined;
		await old?.stop();
	};
	const self = () => ({ session: sid(), version: cfg.version, tower: s.holdsTower, pid: process.pid, started: (started ??= startOf(process.pid)) });
	/** One look at the election, serialised: a candidate looks at the record, and takes it when the rules say it may. */
	const look = (): Promise<void> => (looking ??= (async () => {
		if (stopped) return;
		if (!inUse()) return void (await election?.release());
		if (!(s.holdsTower || s.joined) || !me()) return;
		mySession = me();
		if (!connect()) return;
		election ??= new LinkElection({ store, self, alive: holderUp, now: cfg.now, onGain: gained, onLose: lost });
		await election.tick();
	})().finally(() => (looking = undefined)));

	// ---- The tower's side: take a message when idle -----------------------------------------------------------------------------------

	const seen = new Set<string>(), held: Held[] = [];
	let pumpTimer: ReturnType<typeof setTimeout> | undefined;
	const schedule = (ms = opts.pumpMs ?? 500) => {
		if (stopped || pumpTimer || held.length === 0) return;
		pumpTimer = setTimeout(() => ((pumpTimer = undefined), pump()), ms);
		pumpTimer.unref();
	};
	/** The holder is told the message is in this session, so it leaves the inbox. */
	const confirm = (id: string) => {
		const record = store.readHolder();
		if (!record) return;
		if (holder && election?.isHolder()) void holder.taken(id, sid()).catch(failed("taken"));
		else publish({ version: 1, type: "taken", to: record.session, id });
	};
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

	// ---- Requests from towers to the holder ------------------------------------------------------------------------------------------

	const reassembler = new Reassembler(), pending = new Map<string, { resolve: (body: unknown) => void; reject: (error: Error) => void; holder: string; timer: ReturnType<typeof setTimeout> }>();
	const serve = async (from: string, reqId: string, body: unknown) => {
		// Nothing here may reject: a promise nobody awaits that rejects ends the pi process.
		try {
			const answer = await handle(body, from).catch((error: Error): SendResult => ({ ok: false, error: error.message }));
			let parts;
			try {
				parts = chunks("res", from, reqId, answer);
			} catch {
				parts = chunks("res", from, reqId, { ok: false, error: "The answer was too large to hand back; the teammates' presence is bigger than a request may hold" });
			}
			for (const c of parts) publish(c);
		} catch (error) {
			store.log({ event: "serve-failed", from, error: String(error) });
		}
	};
	/** What the holder does for a tower's request; the holder itself checks that the sender is the tower of a bound workspace. */
	const handle = async (body: unknown, from: string): Promise<unknown> => {
		const op = body as { op?: unknown; device?: unknown; workspace?: unknown; text?: unknown; reply?: unknown; allow?: unknown; team?: unknown; dialogId?: unknown; digest?: unknown; tool?: unknown; args?: unknown; tower?: unknown };
		if (!holder?.active || !election?.isHolder()) return { ok: false, error: "This session is not the link holder; ask again in a moment" };
		const only = Array.isArray((body as { teams?: unknown }).teams) ? ((body as { teams: unknown[] }).teams.filter((t) => typeof t === "string") as string[]) : undefined;
		if (op.op === "list") return { ok: true, teams: holder.list(only) };
		if (op.op === "board-read") return holder.boards({ ...(only ? { only } : {}), ...(typeof op.device === "string" ? { device: op.device } : {}) });
		if (op.op === "send" && typeof op.device === "string" && typeof op.text === "string") return holder.send({ fromSession: from, device: op.device, text: op.text, reply: op.reply === true, ...(typeof op.workspace === "string" && op.workspace ? { workspace: op.workspace } : {}) });
		if (op.op === "confirm-request" && [op.team, op.device, op.dialogId, op.digest, op.tool, op.args, op.tower].every((v) => typeof v === "string")) {
			return holder.requestConfirm({ fromSession: from, team: op.team as string, device: op.device as string, dialogId: op.dialogId as string, digest: op.digest as string, tool: op.tool as string, args: op.args as string, tower: op.tower as string });
		}
		if (op.op === "confirms") return { ok: true, confirms: holder.confirmRequests() };
		if (op.op === "gui") return gui(holder, (body as { name?: unknown }).name, (body as { args?: unknown }).args, from);
		if (op.op === "request-open") return holder.requests.open(from, (body as { action?: unknown }).action, (body as { args?: unknown }).args ?? {}, String((body as { reason?: unknown }).reason ?? ""));
		if (op.op === "request-run" && typeof (body as { id?: unknown }).id === "string") return holder.requests.run((body as { id: string }).id, from);
		if (op.op === "request-drop" && typeof (body as { id?: unknown }).id === "string") return (holder.requests.drop((body as { id: string }).id, from), { ok: true });
		if (op.op === "answer-confirm" && typeof op.dialogId === "string" && typeof op.allow === "boolean") return holder.answerConfirm(op.dialogId, op.allow);
		if (op.op === "forget-confirm" && typeof op.dialogId === "string") return (holder.forgetConfirm(op.dialogId), { ok: true });
		return { ok: false, error: "unknown request" };
	};
	/**
	 * What the GUI asks of the holder (gui.ts reaches it through control.ts). Only the session that hosts the GUI server may: pi-intercom identities are
	 * self-reported, so this is the same trust the dialog bridges place in gui.json's owner. Reads work on any computer; every change needs an attended one.
	 */
	const gui = async (h: LinkHolder, name: unknown, raw: unknown, from: string): Promise<unknown> => {
		if (!from || from !== guiOwner()) return { ok: false, error: "Only the session that hosts the GUI may change Straw Link teams" };
		const a = (typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
		const text = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : "");
		const maybe = (k: string) => (typeof a[k] === "string" && a[k] ? { [k]: a[k] as string } : {});
		if (name === "state") return { ok: true, view: h.view() };
		if (name === "summary") return { ok: true, summary: h.summary() };
		if (!attended()) return { ok: false, error: "This computer is unattended: its teams and trust come from its infra's policy file" };
		switch (name) {
			case "create": return h.admin.createTeam({ relay: text("relay"), token: text("token"), project: text("project"), ...(a.share === "presence" || a.share === "status" ? { share: a.share } : {}), ...maybe("label") });
			case "invite": return h.admin.invite({ team: text("team"), ...maybe("forDevice") });
			case "invite-text": return h.admin.inviteText(text("hash"));
			case "invite-cancel": return h.admin.cancelInvite(text("hash"));
			case "decide": return h.admin.decide({ id: text("id"), ...(typeof a.pick === "number" ? { pick: a.pick } : {}), ...(typeof a.approve === "boolean" ? { approve: a.approve } : {}) });
			case "join-start": return h.admin.joinStart({ text: text("text"), ...maybe("label") });
			case "join-project": return h.admin.joinProject({ project: text("project"), ...(a.share === "presence" || a.share === "status" ? { share: a.share } : {}) });
			case "join-cancel": return (h.admin.cancelJoin(), { ok: true });
			case "prefill-clear": return (h.admin.setPrefill(undefined), { ok: true });
			case "remove": return h.admin.remove({ team: text("team"), device: text("device") });
			case "role": return h.admin.role({ team: text("team"), device: text("device"), role: text("role") === "admin" ? "admin" : "member" });
			case "rotate": return h.admin.rotate({ team: text("team") });
			case "trust": return h.admin.trust({ device: text("device"), level: text("level") as "reply" });
			case "leave": return h.admin.leave({ team: text("team"), force: a.force === true });
			case "confirm-answer": return typeof a.allow === "boolean" ? h.answerConfirm(text("dialogId"), a.allow) : { ok: false, error: "Allow or deny" };
			default: return { ok: false, error: "unknown request" };
		}
	};
	const ask = async (op: Record<string, unknown>, ms = ASK_MS): Promise<{ ok: boolean; error?: string; [key: string]: unknown }> => {
		const record = store.readHolder();
		if (!record || !holderUp(record)) throw new Error(NO_HOLDER);
		if (holder && election?.isHolder()) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const late = new Promise<never>((_, reject) => void (timer = setTimeout(() => reject(new HolderSlow(`The link holder did not answer within ${ms / 1000} s`)), ms)));
			try {
				return (await Promise.race([handle(op, sid()), late])) as { ok: boolean };
			} finally {
				clearTimeout(timer);
			}
		}
		if (!channel && !connect()) throw new Error(NO_HOLDER);
		const reqId = `${sid()}-${nonce}-${pending.size}-${Date.now()}`;
		const answered = new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => (pending.delete(reqId), reject(new HolderSlow(`The link holder did not answer within ${ms / 1000} s`))), ms);
			pending.set(reqId, { resolve, reject, holder: record.session, timer });
		});
		for (const c of chunks("req", record.session, reqId, op)) publish(c);
		return (await answered) as { ok: boolean };
	};

	const onEvent = (event: ChannelEvent) => {
		const p = event.payload as Record<string, unknown> | undefined, from = event.fromSessionId;
		if (event.type !== "message" || !p || p.version !== 1 || !from || from === sid() || p.to !== sid()) return;
		if (p.type === "offer" && typeof p.id === "string" && from === store.readHolder()?.session) takeOffer(p.id);
		else if (p.type === "confirmed" && typeof p.id === "string" && typeof p.allow === "boolean" && from === store.readHolder()?.session) answerForward(p.id, p.allow);
		else if (p.type === "taken" && typeof p.id === "string" && holder) void holder.taken(p.id, from).catch(failed("taken"));
		else if (p.type === "req") {
			const got = reassembler.push(`req/${from}`, p, cfg.now());
			if (got) void serve(from, got.reqId, got.body);
		} else if (p.type === "res") {
			const got = reassembler.push(`res/${from}`, p, cfg.now());
			const wait = got && pending.get(got.reqId);
			if (got && wait && wait.holder === from) (clearTimeout(wait.timer), pending.delete(got.reqId), wait.resolve(got.body));
		}
	};

	// ---- Remote turns --------------------------------------------------------------------------------------------------------------------

	const remote = createRemoteTurns({
		pi, now: cfg.now, config, policy: opts.policy, home, agentDir, linkDir: join(guiDir, "link"), gateMs: opts.gateMs,
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
		ticker = setInterval(() => void look().catch(lookFailed), opts.tickMs ?? 2000);
		ticker.unref();
		void look().catch(lookFailed);
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
		for (const [id, wait] of pending) (clearTimeout(wait.timer), wait.reject(new Error("The session ended")), pending.delete(id));
		approval.dispose();
		await looking?.catch(() => undefined);
		await election?.release().catch(() => undefined);
		await lost();
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
		/** Sets Straw Link up on this computer without a team yet (the GUI's Team settings): the election starts within a few seconds. */
		async enable(): Promise<void> {
			await store.withLock(() => store.enable());
			void look().catch(lookFailed);
		},
		/** A change or a reading for the GUI, through the holder (this session, or another over the channel); only the GUI's host session is taken. */
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
		/** Whether the election and the stream run in this session. */
		get holding(): boolean {
			return Boolean(election?.holding);
		},
	};
	opts.created?.(api as Link);
	return api;
}
export type Link = ReturnType<typeof createLink>;
