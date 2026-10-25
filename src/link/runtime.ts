import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Party, stamp } from "../header.ts";
import type { Session } from "../herdr.ts";
import { startOf } from "../remote.ts";
import { type Channel, type Kit, REGISTER } from "../state.ts";
import { readLinkConfig } from "./config.ts";
import type { DeviceKeys } from "./device.ts";
import { holderAlive, LinkElection } from "./election.ts";
import { type AllyTeam, LinkHolder, type RelayPort, type SendResult } from "./holder.ts";
import { RelayClient } from "./relay.ts";
import type { NetView } from "./routing.ts";
import { type HolderRecord, type InboxItem, LinkStore } from "./store.ts";
import { restrictLabel } from "./text.ts";
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
	offerAgainMs?: number;
	/** How soon a held message is looked at again for an idle tower (default 500 ms). */
	pumpMs?: number;
	relay?: (url: string, device: DeviceKeys) => RelayPort;
	alive?: (record: HolderRecord) => boolean;
	home?: string;
}

/** A remote delivery is a custom message of this type, in the session and for step 4 to classify a run by. */
export const MESSAGE_TYPE = "straw-link";
/** The session entry that remembers which inbox messages this session has already taken, so a restart does not take one twice. */
export const SEEN = "straw-link-seen";
const LONG_WAIT_MS = 10 * 60_000;
const ASK_MS = 30_000;
const NO_HOLDER = "No link holder is running on this computer yet. Straw Link starts within a few seconds of a team being set up; if it stays so, a team file or its config.json entry is missing";

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
	const inUse = () => config().teams.size > 0 || store.teamIds().length > 0;
	const nonce = randomUUID().slice(0, 8);
	let channel: Channel | undefined, election: LinkElection | undefined, holder: LinkHolder | undefined;
	let mySession = "", stopped = false, told = false, started: string | undefined;
	let ticker: ReturnType<typeof setInterval> | undefined, looking: Promise<void> | undefined;
	let lastCtx: Pick<ExtensionContext, "isIdle" | "hasPendingMessages"> | undefined;
	const sid = () => me() || mySession;
	let lookError = "";
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
			store, isHolder: () => Boolean(election?.isHolder()), config, net, offer, notify: tell,
			relay: opts.relay ?? ((url, device) => new RelayClient({ url, device })),
			onDisplaced: () => void look().catch(() => undefined),
			drainMs: opts.drainMs, presenceMs: opts.presenceMs, offerAgainMs: opts.offerAgainMs,
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
		election ??= new LinkElection({ store, self, alive: opts.alive ?? holderAlive(), now: cfg.now, onGain: gained, onLose: lost });
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
		const op = body as { op?: unknown; device?: unknown; workspace?: unknown; text?: unknown; reply?: unknown };
		if (!holder?.active || !election?.isHolder()) return { ok: false, error: "This session is not the link holder; ask again in a moment" };
		if (op.op === "list") return { ok: true, teams: holder.list() };
		if (op.op === "send" && typeof op.device === "string" && typeof op.text === "string") return holder.send({ fromSession: from, device: op.device, text: op.text, reply: op.reply === true, ...(typeof op.workspace === "string" && op.workspace ? { workspace: op.workspace } : {}) });
		return { ok: false, error: "unknown request" };
	};
	const ask = async (op: Record<string, unknown>): Promise<{ ok: boolean; error?: string; [key: string]: unknown }> => {
		const record = store.readHolder();
		if (!record || !(opts.alive ?? holderAlive())(record)) throw new Error(NO_HOLDER);
		if (holder && election?.isHolder()) return (await handle(op, sid())) as { ok: boolean };
		if (!channel) throw new Error(NO_HOLDER);
		const reqId = `${sid()}-${nonce}-${pending.size}-${Date.now()}`;
		const answered = new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => (pending.delete(reqId), reject(new Error("The link holder did not answer within 30 s"))), ASK_MS);
			pending.set(reqId, { resolve, reject, holder: record.session, timer });
		});
		for (const c of chunks("req", record.session, reqId, op)) publish(c);
		return (await answered) as { ok: boolean };
	};

	const onEvent = (event: ChannelEvent) => {
		const p = event.payload as Record<string, unknown> | undefined, from = event.fromSessionId;
		if (event.type !== "message" || !p || p.version !== 1 || !from || from === sid() || p.to !== sid()) return;
		if (p.type === "offer" && typeof p.id === "string" && from === store.readHolder()?.session) takeOffer(p.id);
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

	// ---- Session hooks -------------------------------------------------------------------------------------------------------------------

	pi.on("session_start", (_event, ctx) => {
		stopped = false;
		lastCtx = ctx;
		seen.clear();
		for (const entry of ctx.sessionManager.getBranch()) {
			const e = entry as { type: string; customType?: string; data?: { id?: unknown } };
			if (e.type === "custom" && e.customType === SEEN && typeof e.data?.id === "string") seen.add(e.data.id);
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
		await looking?.catch(() => undefined);
		await election?.release().catch(() => undefined);
		await lost();
	});

	return {
		/** Sends `text` to a teammate's tower: the holder checks the device, signs, encrypts, and posts it. */
		async send(req: { device: string; workspace?: string; text: string; reply: boolean }) {
			if (!inUse()) throw new Error("Straw Link is not set up on this computer: no team in config.json (link.teams) and no team file");
			const answer = await ask({ op: "send", ...req });
			if (!answer.ok) throw new Error(answer.error);
			return { text: String(answer.text), details: answer.details };
		},
		/** The ally towers for `tower_list`; undefined when Straw Link is not set up here. */
		async remote(): Promise<RemoteTower[] | undefined> {
			if (!inUse()) return undefined;
			try {
				const answer = await ask({ op: "list" });
				return answer.ok ? remoteTowers(answer.teams as AllyTeam[]) : [];
			} catch {
				return [];
			}
		},
		/** Whether the election and the stream run in this session. */
		get holding(): boolean {
			return Boolean(election?.holding);
		},
	};
}
export type Link = ReturnType<typeof createLink>;
