import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Session } from "../herdr.ts";
import { startOf } from "../startof.ts";
import { type Channel, type Kit, REGISTER } from "../state.ts";
import { readLinkConfig } from "./config.ts";
import type { DeviceKeys } from "./device.ts";
import { holderAlive, LinkElection } from "./election.ts";
import { LinkHolder, type RelayPort, type SendResult } from "./holder.ts";
import { type PolicyDeps, readPolicy } from "./policy.ts";
import { RelayClient } from "./relay.ts";
import type { NetView } from "./routing.ts";
import { type HolderRecord, LinkStore } from "./store.ts";
import { chunks, NAMESPACE, Reassembler } from "./wire.ts";

// The link holder inside the sb server (docs/specs/2026-10-26-sb-backend.md, What moves out of pi sessions; docs/specs/2026-10-25-straw-link.md, Link holder). Before this
// the holder was elected among the pi sessions of a computer (election.ts) and tower sessions talked to it on the intercom extension channel `straw-boss/link`. Now the
// primary sb server is the only candidate: it takes `holder.json` and `holder.lock` like any holder did, runs the relay streams (holder.ts), and answers the requests
// sessions put to it on the control socket (server/main.ts, `link`). The channel stays for the previous build: its sessions' requests are answered on it, and the
// server's offers of an inbox message to a resident tower (and the answer to a `forward` confirm) still travel on it.
//
// This file reaches no pi-tui, typebox, or pi-coding-agent: the server bundle must load it under plain node.
//
// Nothing here runs on a computer that has set up no team: no team in config.json and no team file means no channel, no election, no files.

/** Seams for tests: shorter timers, a relay behind a fake `fetch`, a stand-in for "the holder's process is gone", and an isolated home folder. */
export interface ServiceDeps {
	tickMs?: number;
	drainMs?: number;
	presenceMs?: number;
	/** The least time between two boards to a team (default 15 s). */
	boardMs?: number;
	offerAgainMs?: number;
	relay?: (url: string, device: DeviceKeys) => RelayPort;
	alive?: (record: HolderRecord) => boolean;
	home?: string;
	/** Where the unattended policy file is and who owns what (policy.ts); the real device reads the fixed path. */
	policy?: PolicyDeps;
}

export interface ServiceOptions {
	/** The headless kit of the server: its event bus carries the channel registration, its config the Herdr reading, and `me()` the server's own intercom id. */
	kit: Pick<Kit, "pi" | "cfg" | "me">;
	/** The state directory: config.json, `link/`, `board/`, and `gui.json` are in it. */
	stateDir: string;
	/** The server's pi-straw-boss version, which ranks it against a holder of the previous build (election.ts `outranks`). */
	version: string;
	/** This process's start time, when it is known (the record carries it); the election asks again at each look. */
	started?: () => string | undefined;
	/** This process's id, which the holder record names (default `process.pid`; a test that runs several servers in one process gives each its own). */
	pid?: number;
	/** A notice for the boss. The server has no screen: it goes to the log, and the last few are in `status()`. */
	notify: (text: string, level?: "info" | "warning" | "error") => void;
	deps?: ServiceDeps;
}

const NOTICES = 10;

export interface Notice { at: number; level: "info" | "warning" | "error"; text: string }
type Answer = { ok: boolean; error?: string; [key: string]: unknown };
type ChannelEvent = { type: string; fromSessionId?: string; payload?: unknown };

export function createLinkService({ kit, stateDir, version, started, pid = process.pid, notify, deps: opts = {} }: ServiceOptions) {
	const { pi, cfg } = kit;
	const store = new LinkStore(join(stateDir, "link"));
	const home = opts.home ?? cfg.env.HOME ?? cfg.env.USERPROFILE ?? homedir(), agentDir = cfg.env.PI_CODING_AGENT_DIR ?? join(home, ".pi", "agent");
	const config = () => readLinkConfig(stateDir, { home, agentDir });
	const inUse = () => config().teams.size > 0 || store.teamIds().length > 0 || store.enabled;
	/** Whether this computer's policy leaves it attended: the GUI's team changes and `link_request` are for an attended computer only. */
	const attended = () => readPolicy(opts.policy).mode === "attended";
	/** The session that hosts the GUI server (gui.json): the only one whose GUI requests the holder takes, besides this server itself once it hosts the GUI. */
	const guiOwner = (): string | undefined => {
		try {
			return (JSON.parse(readFileSync(join(stateDir, "gui.json"), "utf8")) as { ownerSession?: string }).ownerSession || undefined;
		} catch {
			return undefined;
		}
	};
	let channel: Channel | undefined, election: LinkElection | undefined, holder: LinkHolder | undefined;
	let stopped = false, told = false, startedAt: string | undefined;
	let ticker: ReturnType<typeof setInterval> | undefined, looking: Promise<void> | undefined;
	const holderUp = opts.alive ?? holderAlive();
	const notices: Notice[] = [];
	let lookError = "";
	const sid = () => kit.me();
	const note = (text: string, level: "info" | "warning" | "error" = "info") => {
		notices.push({ at: cfg.now(), level, text });
		if (notices.length > NOTICES) notices.shift();
		notify(text, level);
	};
	/** A look that failed (the holder could not start, the lock was not free, a disk error): in the log, and once per message in the notices. */
	const lookFailed = (error: Error) => {
		store.log({ event: "look-failed", error: error.message });
		if (error.message === lookError) return;
		lookError = error.message;
		note(`Straw Link: the link holder could not start: ${error.message}`, "error");
	};
	const failed = (what: string) => (error: Error) => store.log({ event: `${what}-failed`, error: error.message });

	// ---- The channel ---------------------------------------------------------------------------------------------------------------

	const publish = (payload: unknown) => channel?.publish(payload, { audience: "capable" });
	const connect = (): boolean => {
		if (channel) return true;
		pi.events.emit(REGISTER, { namespace: NAMESPACE, ownerEligible: false, onReady: (c: Channel) => (channel = c), onEvent: (e: ChannelEvent) => onEvent(e) });
		if (!channel && !told) {
			told = true;
			note("Straw Link needs pi-intercom 0.18.1 or newer with the extension bus; it is not available, so no team message reaches this computer", "warning");
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
	/** Tells a tower a message waits in the inbox for it. A resident tower takes it from the inbox when idle and answers `taken`. */
	const offer = (tower: Session, id: string) => void publish({ version: 1, type: "offer", to: tower.id, id });
	const gained = async () => {
		const fresh = new LinkHolder({
			store, boardDir: join(stateDir, "board"), isHolder: () => Boolean(election?.isHolder()), config, stateDir, home, agentDir, attended, net, offer, notify: note,
			relay: opts.relay ?? ((url, device) => new RelayClient({ url, device })),
			onDisplaced: () => void look().catch(() => undefined),
			confirmed: (tower, dialogId, allow) => void publish({ version: 1, type: "confirmed", to: tower, id: dialogId, allow }),
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
	/**
	 * The server ranks as a tower: it is the only candidate now, and a holder of the previous build that is a session cannot outrank it by build or by role (election.ts
	 * `outranks`). Sessions of the previous build still contest a record that is vacant or whose process is gone, and the server takes it back at its next look.
	 */
	const self = () => ({ session: sid(), version, tower: true, pid, started: started?.() ?? (startedAt ??= startOf(process.pid)) });
	/** One look at the election, serialised: the server looks at the record, and takes it when the rules say it may. */
	const look = (): Promise<void> => (looking ??= (async () => {
		if (stopped) return;
		if (!inUse()) return void (await election?.release());
		if (!sid()) return;
		if (!connect()) return;
		election ??= new LinkElection({ store, self, alive: holderUp, now: cfg.now, onGain: gained, onLose: lost });
		await election.tick();
	})().finally(() => (looking = undefined)));

	// ---- Requests --------------------------------------------------------------------------------------------------------------------

	const reassembler = new Reassembler();
	/** The previous build's request, answered on the channel in chunks. Nothing here may reject: a promise nobody awaits that rejects ends the process. */
	const serve = async (from: string, reqId: string, body: unknown) => {
		try {
			const answer = await request(body, from);
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
	/** What the holder does for a request; the holder itself checks that the sender is the tower of a bound workspace. */
	const handle = async (body: unknown, from: string): Promise<unknown> => {
		const op = (typeof body === "object" && body !== null ? body : {}) as { op?: unknown; device?: unknown; workspace?: unknown; text?: unknown; reply?: unknown; allow?: unknown; team?: unknown; dialogId?: unknown; digest?: unknown; tool?: unknown; args?: unknown; tower?: unknown; id?: unknown };
		if (!holder?.active || !election?.isHolder()) return { ok: false, error: "The link holder is not running in the sb server yet; ask again in a moment", code: "no_holder" };
		const only = Array.isArray((body as { teams?: unknown }).teams) ? ((body as { teams: unknown[] }).teams.filter((t) => typeof t === "string") as string[]) : undefined;
		if (op.op === "list") return { ok: true, teams: holder.list(only) };
		if (op.op === "board-read") return holder.boards({ ...(only ? { only } : {}), ...(typeof op.device === "string" ? { device: op.device } : {}) });
		if (op.op === "send" && typeof op.device === "string" && typeof op.text === "string") return holder.send({ fromSession: from, device: op.device, text: op.text, reply: op.reply === true, ...(typeof op.workspace === "string" && op.workspace ? { workspace: op.workspace } : {}) });
		if (op.op === "taken" && typeof op.id === "string") return (await holder.taken(op.id, from), { ok: true });
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
	 * What the GUI asks of the holder (gui.ts reaches it through control.ts). Only the session that hosts the GUI server may, and this server once it hosts it: identities
	 * on the control socket and in pi-intercom are self-reported, so this is the same trust the dialog bridges place in gui.json's owner. Reads work on any computer; every
	 * change needs an attended one.
	 */
	const gui = async (h: LinkHolder, name: unknown, raw: unknown, from: string): Promise<unknown> => {
		if (!from || (from !== sid() && from !== guiOwner())) return { ok: false, error: "Only the session that hosts the GUI may change Straw Link teams" };
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
	/** A request from a session (the control socket) or from the server itself; a failure is an answer, never a rejection. */
	const request = (body: unknown, from: string): Promise<Answer> => handle(body, from).then((answer) => answer as Answer, (error: Error): SendResult => ({ ok: false, error: error.message }));

	const onEvent = (event: ChannelEvent) => {
		const p = event.payload as Record<string, unknown> | undefined, from = event.fromSessionId;
		if (event.type !== "message" || !p || p.version !== 1 || !from || from === sid() || p.to !== sid()) return;
		// A resident tower of the previous build confirms an inbox message on the channel; the current build says it on the socket (`taken`).
		if (p.type === "taken" && typeof p.id === "string" && holder) void holder.taken(p.id, from).catch(failed("taken"));
		else if (p.type === "req") {
			const got = reassembler.push(`req/${from}`, p, cfg.now());
			if (got) void serve(from, got.reqId, got.body);
		}
	};

	const api = {
		/** Starts the look every `tickMs`, and the first one now. */
		start() {
			stopped = false;
			clearInterval(ticker);
			ticker = setInterval(() => void look().catch(lookFailed), opts.tickMs ?? 2000);
			ticker.unref();
			return look().catch(lookFailed);
		},
		look,
		request,
		/** The server ends: its record goes, so the next candidate takes over at its next look, and the streams stop. */
		async stop(): Promise<void> {
			stopped = true;
			clearInterval(ticker);
			await looking?.catch(() => undefined);
			await election?.release().catch(() => undefined);
			await lost();
		},
		/** What `status` tells of the link: whether this server holds it and the last notices. */
		status() {
			return { inUse: inUse(), holding: Boolean(election?.holding), active: Boolean(holder?.active), session: sid(), notices: notices.map((n) => ({ ...n })) };
		},
		get holder(): LinkHolder | undefined {
			return holder;
		},
		get store(): LinkStore {
			return store;
		},
		attended,
	};
	return api;
}
export type LinkService = ReturnType<typeof createLinkService>;
