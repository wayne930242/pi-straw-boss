import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { restrictNotice } from "./text.ts";
import { join } from "node:path";
import type { Session } from "../herdr.ts";
import { startOf } from "../startof.ts";
import { type Channel, type Kit, REGISTER } from "../state.ts";
import type { DeviceKeys } from "./device.ts";
import { holderAlive, LinkElection } from "./election.ts";
import { LinkHolder, type HolderOptions, type RelayPort, type SendResult } from "./holder.ts";
import { WAIT_STATES, type WaitWire } from "./kinds.ts";
import { createLevelOf } from "./level.ts";
import { createOperateNotes, type Policy, type PolicyDeps, POLICY_PATH, policyStamp, readEffectiveConfig, readPolicy, unattendedNow } from "./policy.ts";
import { RelayClient } from "./relay.ts";
import type { NetView, ServedTower } from "./routing.ts";
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
	/** How often a box reads its own net for the transcript ledger while its policy grants operate and no session or page asks for a reading (default 30 s; server/operatewire.ts). */
	operateNetMs?: number;
	/** How often `caps` is sent unchanged, and the least time between two (default an hour and 15 s). */
	capsMs?: number;
	capsMinMs?: number;
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
	/** An unattended device: takes a `dialog-answer` the holder has checked (src/link/dialogs-out.ts). */
	dialogAnswer?: HolderOptions["dialogAnswer"];
	/** Where an accepted `unit-stop` goes (src/server/towers.ts `unitStop`); with it the box lists `unit-stop` in its caps. */
	unitStop?: HolderOptions["unitStop"];
	/** Where a taken `operate` message goes (src/server/operatebox.ts `take`): given to the holders of an unattended device only, which then list `operate/1` in their caps. */
	operate?: HolderOptions["operate"];
	/** Told when this unattended device's policy gains or loses an `operate` grant (the holder reads it at each tick, and at the first): the box's side starts or stops what it does only while someone may operate. */
	operateWatch?: HolderOptions["operateChanged"];
	/**
	 * The controller's end of operate (src/server/operatehost.ts): given to the holders of an attended device only, in place of `operate` (one device is never both). Its `receive` is the holder's one operate sink there, so the attended
	 * holder lists `operate/1` in its caps (a box sends `accept` only to a peer whose caps list it); `status`, `off` and `on` answer `/boss link operate`, `/boss link operate off` and `/boss link operate on`.
	 */
	controller?: { receive: NonNullable<HolderOptions["operate"]>; status(): unknown[]; /** When the boss turned operate off here, or nothing. */ offSince(): number | undefined; off(): { saved: boolean }; on(): { saved: boolean } };
	/** Told right after a team's roster changed and when a team stops (operatebox.ts `onRoster`): given to every holder this service builds, since it builds a new one at each gain. */
	onRoster?: HolderOptions["onRoster"];
	/** Told after a holder runs and after it is gone (the operate host's clock follows the holder: one that comes after a page is connected must start it). */
	onHolder?: () => void;
	/** The tower service of the same server (towers.ts), when it runs: the asks local towers made for their mains, and what to tell when messages wait for a tower identity it runs. */
	tower?: Pick<HolderOptions, "asks" | "served" | "openTower" | "waits"> & {
		/** The wait router's holder ops (src/server/linkwaitsops.ts `WAIT_OPS`): a main's `linkWait` and `waitsOn`, and the `waits` section of `board_read`. */
		waitOps?: (body: Record<string, unknown>, from: string) => Promise<unknown>;
		/** An answer to a `forward` confirm for a tower identity the server runs (an ally run waits for it): true when the server took it, so it is not published on the channel. */
		confirmed?: (tower: string, dialogId: string, allow: boolean) => boolean;
		/** The tower identities the server runs with no pane (`towerRuns.headless` only; towers.ts `servedTowers`): the holder's net lists them (routing.ts `NetView.served`). */
		servedTowers?: () => ServedTower[];
	};
}

/** Whether a policy grants anyone `operate`: an unattended policy that reads, with at least one device named (a malformed `operate` has turned it off). */
export const operateGranted = (policy: Policy): boolean => policy.mode === "unattended" && policy.operateRefused === undefined && policy.operate.size > 0;

/** The holder's one operate sink: the controller's on an attended device, the box's on an unattended one, and none where the option was not given (one device is never both, and a holder with no sink lists no `operate/1` in its caps). */
export function operateSink(attended: boolean, o: Pick<ServiceOptions, "operate" | "controller">): Pick<HolderOptions, "operate"> {
	const sink = attended ? o.controller?.receive : o.operate;
	return sink ? { operate: sink } : {};
}

const NOTICES = 10;
/** The holder ops the wait router answers (src/server/linkwaitsops.ts). */
const WAIT_OPS = ["device-resolve", "wait-act", "wait-cancel", "waits-read", "standing-send"];
/** A wait a send carries, checked as the wire's encoder will check it again. */
const waitOf = (v: unknown): WaitWire | undefined => {
	const w = v as Partial<WaitWire> | null;
	return typeof w === "object" && w !== null && typeof w.id === "string" && typeof w.state === "string" && (WAIT_STATES as readonly string[]).includes(w.state) && typeof w.owner === "string" && typeof w.what === "string" && typeof w.handle === "string" ? (w as WaitWire) : undefined;
};
/** What a request is told when nothing is set up: no holder is coming until someone presses Set up, so it is not told to ask again. */
const NOT_SET_UP = "Straw Link is not set up on this computer: no link holder runs here. Open Teams in the GUI and press Set up";

export interface Notice { at: number; level: "info" | "warning" | "error"; text: string }
type Answer = { ok: boolean; error?: string; [key: string]: unknown };
type ChannelEvent = { type: string; fromSessionId?: string; payload?: unknown };

export function createLinkService({ kit, stateDir, version, started, pid = process.pid, notify, deps: opts = {}, tower, dialogAnswer, unitStop, operate, operateWatch, controller, onRoster, onHolder }: ServiceOptions) {
	const { pi, cfg } = kit;
	const store = new LinkStore(join(stateDir, "link"), { unattended: () => unattendedNow(policyDeps), unattendedStamp: () => policyStamp(policyDeps.path ?? POLICY_PATH) }); // an unattended box keeps its operate audit in link.log longer (decision 16)
	const home = opts.home ?? homedir(), agentDir = cfg.env.PI_CODING_AGENT_DIR ?? join(home, ".pi", "agent");
	/** The policy file's reading, with this server's home and agent folder for the projects of its teams. */
	const policyDeps: PolicyDeps = { home, agentDir, ...opts.policy };
	const policy = () => readPolicy(policyDeps);
	/** The teams and trust every reader sees: the policy file's on an unattended device, config.json's otherwise (policy.ts `readEffectiveConfig`). */
	const config = () => readEffectiveConfig(policy(), stateDir, { home, agentDir });
	/** An unattended device is in use before it has a team, so its first look makes `device.json` and `device.id` for the infra to read. */
	const inUse = () => policy().mode === "unattended" || config().teams.size > 0 || store.teamIds().length > 0 || store.enabled;
	/** Whether this computer's policy leaves it attended: the GUI's team changes and `link_request` are for an attended computer only. */
	const attended = () => policy().mode === "attended";
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
	let lookError = "", refusedTold = "";
	/** A malformed `operate` in the policy and the devices it names with no effect, each said once (policy.ts). */
	const operateNotes = createOperateNotes((entry) => store.log(entry));
	const sid = () => kit.me();
	const note = (raw: string, level: "info" | "warning" | "error" = "info") => {
		const text = restrictNotice(raw);
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
	/** Why no holder runs, when the policy is refused. */
	const refusal = (): string | undefined => {
		const found = policy();
		return found.mode === "refused" ? `Straw Link: unattended mode is refused (${found.reason}); no link holder runs on this computer` : undefined;
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
		const served = tower?.servedTowers?.() ?? [], extra = served.length ? { served } : {};
		if (!withTabs) return { sessions, panes: world.panes, workspaces: world.workspaces, tabs: [], ...extra };
		const bound = world.workspaces.filter((w) => world.panes.some((p) => p.workspace_id === w.workspace_id && p.tokens?.sb_role === "tower"));
		const tabs = (await Promise.all(bound.map((w) => cfg.world(w.workspace_id).then((x) => x.tabs).catch(() => [])))).flat();
		return { sessions, panes: world.panes, workspaces: world.workspaces, tabs, ...extra };
	};
	/** Tells a tower a message waits in the inbox for it. A resident tower takes it from the inbox when idle and answers `taken`. */
	const offer = (tower: Session, id: string) => void publish({ version: 1, type: "offer", to: tower.id, id });
	/** A hook of the server runs after the holder changed; its failure is not the election's. */
	const hooked = (hook?: () => void) => { try { hook?.(); } catch { /* the server's own */ } };
	const gained = async () => {
		const fresh = new LinkHolder({
			store, boardDir: join(stateDir, "board"), isHolder: () => Boolean(election?.isHolder()), config, stateDir, home, agentDir, attended, net, offer, notify: note,
			relay: opts.relay ?? ((url, device) => new RelayClient({ url, device })),
			onDisplaced: () => void look().catch(() => undefined),
			confirmed: (to, dialogId, allow) => {
				if (!tower?.confirmed?.(to, dialogId, allow)) void publish({ version: 1, type: "confirmed", to, id: dialogId, allow });
			},
			drainMs: opts.drainMs, presenceMs: opts.presenceMs, boardMinMs: opts.boardMs, offerAgainMs: opts.offerAgainMs, capsMs: opts.capsMs, capsMinMs: opts.capsMinMs,
			...(tower?.asks ? { asks: tower.asks } : {}), ...(tower?.served ? { served: tower.served } : {}), ...(dialogAnswer ? { dialogAnswer } : {}), ...(unitStop ? { unitStop } : {}), ...operateSink(attended(), { operate, controller }), ...(operate && !attended() ? { operateOn: () => operateGranted(policy()), ...(operateWatch ? { operateChanged: operateWatch } : {}) } : {}), ...(onRoster ? { onRoster } : {}), ...(tower?.openTower ? { openTower: tower.openTower } : {}), ...(tower?.waits ? { waits: tower.waits } : {}),
		});
		holder = fresh;
		await fresh.start();
		hooked(onHolder);
	};
	const lost = async () => {
		const old = holder;
		holder = undefined;
		await old?.stop();
		hooked(onHolder);
	};
	/**
	 * The server ranks as a tower: it is the only candidate now, and a holder of the previous build that is a session cannot outrank it by build or by role (election.ts
	 * `outranks`). Sessions of the previous build still contest a record that is vacant or whose process is gone, and the server takes it back at its next look.
	 */
	const self = () => ({ session: sid(), version, tower: true, pid, started: started?.() ?? (startedAt ??= startOf(process.pid)) });
	/** One look at the election, serialised: the server looks at the record, and takes it when the rules say it may. */
	const look = (): Promise<void> => (looking ??= (async () => {
		if (stopped) return;
		// A refused policy means no holder: the election is left (a holder that ran is stopped) and the reason is said once.
		const found = policy();
		if (found.mode === "refused") {
			if (refusedTold !== found.reason) (refusedTold = found.reason, store.log({ event: "policy-refused", reason: found.reason }), note(`Straw Link: unattended mode is refused (${found.reason}); no link holder runs on this computer`, "error"));
			return void (await election?.release());
		}
		refusedTold = "";
		operateNotes(found);
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
	const handle = async (body: unknown, from: string, served = false): Promise<unknown> => {
		const op = (typeof body === "object" && body !== null ? body : {}) as { op?: unknown; device?: unknown; workspace?: unknown; text?: unknown; reply?: unknown; allow?: unknown; team?: unknown; dialogId?: unknown; digest?: unknown; tool?: unknown; args?: unknown; tower?: unknown; id?: unknown };
		if (!holder?.active || !election?.isHolder()) return { ok: false, code: "no_holder", error: refusal() ?? (inUse() ? "The link holder is not running in the sb server yet; ask again in a moment" : NOT_SET_UP) };
		const only = Array.isArray((body as { teams?: unknown }).teams) ? ((body as { teams: unknown[] }).teams.filter((t) => typeof t === "string") as string[]) : undefined;
		if (op.op === "list") return { ok: true, teams: holder.list(only) };
		if (op.op === "board-read") return holder.boards({ ...(only ? { only } : {}), ...(typeof op.device === "string" ? { device: op.device } : {}) });
		if (op.op === "send" && typeof op.device === "string" && typeof op.text === "string") {
			const r = body as { awaitsReply?: unknown; inReplyTo?: unknown; wait?: unknown };
			const wait = waitOf(r.wait);
			return holder.send({ fromSession: from, ...(served ? { served } : {}), device: op.device, text: op.text, reply: op.reply === true, ...(typeof op.workspace === "string" && op.workspace ? { workspace: op.workspace } : {}), ...(typeof r.awaitsReply === "string" ? { awaitsReply: r.awaitsReply } : {}), ...(typeof r.inReplyTo === "string" ? { inReplyTo: r.inReplyTo } : {}), ...(wait ? { wait } : {}) });
		}
		if (typeof op.op === "string" && WAIT_OPS.includes(op.op)) return tower?.waitOps ? tower.waitOps(body as Record<string, unknown>, from) : { ok: false, error: "This server keeps no link waits" };
		if (op.op === "taken" && typeof op.id === "string") return (await holder.taken(op.id, from), { ok: true });
		if (op.op === "confirm-request" && [op.team, op.device, op.dialogId, op.digest, op.tool, op.args, op.tower].every((v) => typeof v === "string")) {
			return holder.requestConfirm({ fromSession: from, ...(served ? { served } : {}), team: op.team as string, device: op.device as string, dialogId: op.dialogId as string, digest: op.digest as string, tool: op.tool as string, args: op.args as string, tower: op.tower as string });
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
		if (name === "operate") return { ok: true, sessions: controller?.status() ?? [], ...(controller?.offSince() !== undefined ? { off: controller.offSince() } : {}) };
		if (!attended()) return { ok: false, error: "This computer is unattended: its teams and trust come from its infra's policy file" };
		switch (name) {
			case "operate-off": return { ok: true, ...(controller?.off() ?? { saved: true }) };
			case "operate-on": return { ok: true, ...(controller?.on() ?? { saved: true }) };
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
			case "dialog-answer": return typeof a.answer === "object" && a.answer !== null && !Array.isArray(a.answer) ? h.answerDialog(text("device"), text("dialogId"), text("digest"), JSON.stringify(a.answer)) : { ok: false, error: "Answer the question" };
			// An admin's (or a dispatcher's) request that an unattended box stop one main: the holder keeps the checks (an attended asker, an unattended member, the box's caps, the handle, the mode), the box decides.
			case "unit-stop": return typeof a.reason === "string" || a.reason === undefined ? h.requestUnitStop(text("team"), text("device"), { handle: text("handle"), mode: text("mode"), reason: text("reason") }) : { ok: false, error: "A reason is text" };
			case "confirm-answer": return typeof a.allow !== "boolean" ? { ok: false, error: "Allow or deny" } : typeof a.digest !== "string" ? { ok: false, error: "Look at the request again" } : h.answerConfirm(text("dialogId"), a.allow, a.digest); // the page names the request it showed: a body without its digest is refused
			default: return { ok: false, error: "unknown request" };
		}
	};
	/**
	 * A request from a session (the control socket) or from the server itself; a failure is an answer, never a rejection. `served`: the server makes it as one of its own runs (main.ts), whose tower
	 * identity it registered itself; only the server's own code passes it.
	 */
	const request = (body: unknown, from: string, served = false): Promise<Answer> => handle(body, from, served).then((answer) => answer as Answer, (error: Error): SendResult => ({ ok: false, error: error.message }));

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
		/** The policy as the file reads now, and the path the box watches (operatebox.ts). */
		policyNow: (): Policy => policy(),
		policyPath: policyDeps.path,
		/** How the policy file reads now: a refused one means the box cannot tell who may do what (g346-F003). */
		policyMode: (): "attended" | "unattended" | "refused" => policy().mode,
		/** The policy mode and the effective config from one read of the policy file, so the two cannot disagree. */
		policyLook(): { mode: "attended" | "unattended" | "refused"; config: ReturnType<typeof config> } {
			const p = policy();
			return { mode: p.mode, config: readEffectiveConfig(p, stateDir, { home, agentDir }) };
		},
		/** The teams and projects of config.json, read fresh. */
		config,
		/** The level this computer gives a device (the policy file's, else `link.trust`, else `reply`): an ally run is claimed at it. */
		levelOf: createLevelOf({ config, policy: policyDeps, log: (event) => store.log(event), tell: (text, level) => note(text, level) }),
	};
	return api;
}
export type LinkService = ReturnType<typeof createLinkService>;
