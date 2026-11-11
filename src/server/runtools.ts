import { readBoard } from "../boardread.ts";
import type { Control } from "../closemain.ts";
import { ForwardAsBefore, INTEGRATOR } from "../integrator.ts";
import type { Opened, OpenRequest, PeerSender } from "../opener.ts";
import { bodyOf } from "../header.ts";
import { headsIn, slipsInText } from "../train/cars.ts";
import { remoteTowers } from "../link/remotelist.ts";
import type { AllyBoard, AllyTeam } from "../link/holder.ts";
import { clean } from "../board.ts";
import type { Reach } from "../reach.ts";
import { trainLabel } from "../trainrole.ts";
import { headIdOf } from "../reachhead.ts";
import type { Kind, RunWho } from "./rungate.ts";
import type { TakeResult } from "./allows.ts";
import { randomBytes } from "node:crypto";
import { ASK_KEEP_MS, type AskEntry } from "./asks.ts";

// The tower tools a run calls (docs/specs/2026-10-26-sb-backend.md, Tower tools in a run). In a run each tool is a thin client of the server: the run's extension sends `run-tool { token, tool, args }`,
// and the server does the work as the workspace's tower identity (its reach, its opener, its control channel, the link holder), so the header of everything a run sends names the identity and replies
// come back to the server, not to a pi that has exited. The server also enforces the run's kind here, in addition to the hooks in the run: an ally run gets `boss_status` and nothing else.
// An ally run (B6) is a peer's message at a trust level: it gets `boss_status`, `tower_list` and `board_read` scoped to its sender's team, `tower_send` to its sender, and, past the gate, `tower_reply`, `boss_open_main`
// and `boss_close_main`. At `reply` and `forward` the server takes a gated call only against the Allow the dialog hub saw the gate close with (allows.ts), tied to the run's pane, the call id, and the
// arguments' digest, and only once; at `dispatch` the gate is off, as in a remote turn. `boss_server`, `call_tower`, and `link_request` are refused by the run's kind at every level.
// A project's integrator has one door, for either kind of run (`openIntegrator` below): a car slip the run took as a `call_tower` (why=shared), which the server finds itself and forwards as it came.
// (`tower_done` is the `run-done` request.)

export interface ToolResult { text: string; details?: unknown }
type Answer = { ok: boolean; error?: string; code?: string; [key: string]: unknown };
/** The sb server's own part of `boss_server`, which main.ts supplies. */
export interface ServerTools {
	status(): unknown;
	logs(lines: number): string[];
	/** Restarts the server; the one-a-minute limit is decided there, by the server. Rejects with the reason it refuses. */
	restart(reason: string, by: string): Promise<void>;
}
export interface ToolHost {
	reach: Reach;
	open(request: OpenRequest): Promise<Opened>;
	closeMain: Control["closeMain"];
	/** A request to the link holder as this tower's identity. */
	link(body: Record<string, unknown>): Promise<Answer>;
	/** The work board's folder. */
	boardDir: string;
	now(): number;
	server: ServerTools;
	/** A reply the run waits for: kept for the brief's open obligations. */
	expect(to: string, name: string, text: string): void;
	label: string;
	/** The run asking, and the identity it speaks as. */
	who: RunWho;
	identity: string;
	/** The server's check of a gated call of an ally run (allows.ts). */
	allow(q: { toolCallId: string; tool: string; args: unknown }): Promise<TakeResult>;
	/** The approval of a `link_request` of a local run (allows.ts) against the lines the holder said the request does. */
	allowRequest(q: { toolCallId: string; lines: string[] }): Promise<TakeResult>;
	/** The lines `request-open` answered, kept per request id until it is run or dropped. */
	requests: Map<string, string[]>;
	/** The asks this tower made for its mains (awaiting.json). */
	asks: { open(entry: AskEntry): void };
	/** The project folder the run's team binds on this computer, for the scope of an ally run's `tower_list`. */
	project?: string;
	/** Whether a session (id or name) is a tower identity of this machine (an ally run may not write to one). */
	isTower(session: string): Promise<boolean>;
	/** The device a main was opened for, when an ally run opened it and its route is still live (allyroute.ts); undefined for any other session. */
	openedFor?(session: string): string | undefined;
	/** The same asked of every workspace's route table of this server: a main opened for a device stays a peer's whichever tower it writes to (R151-F001). */
	openedAnywhere?(session: string): string | undefined;
	/** The live main of this tower's workspace named by id or name (a local run asks for it); throws when there is none or it is ambiguous. */
	mainOf(query: string): Promise<{ id: string; name: string }>;
	/** The one live main of this tower's workspace that sent the run a `call_tower` expecting an answer (the events the run took); undefined when there is none or there are several. */
	requester(): Promise<{ id: string; name: string } | undefined>;
	/** Whether an ask of the head tower to this tower's workspace is open (headasks.ts): a tower answers with `tower_send {head: true, inReplyTo}` only to one. */
	headAsked?(id: string): boolean;
	/** The `call_tower` event (why=shared) this run took, by its id: the code stamps its sender into a forwarded car slip (docs/specs/2026-11-07-train-workers.md §5.5). Undefined when the run took no such event. */
	forwardEvent?(id: string): { id: string; from: string; text: string; /** When the event came in. */ at?: number } | undefined;
	/**
	 * The `call_tower` messages (why=shared) this run took, oldest first, each with the sender the broker named, its own text, and the 16-hex id its forward is stamped with: a local run's events, and for an ally run
	 * what local sessions said to the tower for its device (allyroute.ts). The door of an integrator's open.
	 */
	slipEvents?(): SlipEvent[];
	/** The tower's opener for an integrator (opener.ts, `role: "integrator"`): the same one for a local and an ally run, and it leaves no ally route, since the integrator is the tower's own main. */
	openIntegrator?(request: OpenRequest): Promise<Opened>;
	/** What the server keeps of a forward it stamped, for the car book to check a slip's coordinator against. */
	noteForward?(f: { fwd: string; from: string; to: string[]; text: string }): void;
	/** Auto mode (§6): a reply to a session whose blocked `call_tower` this run took is noted with its gist and the `basis` the run named; the server checks the basis and records `none` for a missing or wrong one. */
	decided?(to: string, gist: string, basis: unknown): void;
	/** `tower_memory` of a local run (towermemory.ts): it proposes, and the boss confirms elsewhere. */
	memory(args: Record<string, unknown>): Promise<ToolResult>;
	now(): number;
	/** When this server started: the refusal of a forward whose slip came in before it says what a restart lost (todo #154). */
	startedAt?: number;
}

export interface SlipEvent { fwd: string; from: { id: string; name?: string }; text: string }

/** The refusal of an ally `tower_reply` target held for another device; it does not repeat what the run named. A target that does not exist, or is ambiguous, is not refused here: it goes on to the gate like one that exists, so a run below `dispatch` is told the same of both and learns nothing about what sessions exist (RR3-F002). */
const NO_TARGET = "tower_reply has no such target: no session of this computer that an ally run may write to has that name or id";

/**
 * A main opened for one device reports to that device: another device's write, with its expected reply, would take the next report (spec 2026-11-04-link-relay.md, Wrong thread). Two witnesses say who it was opened for:
 * this workspace's route table, which only the server writes, and the main's own pane token (`sb_opened_by`, kept while it lives, in any workspace). Either one naming another device refuses the write, so a token a local
 * process can set never outvotes the table (RR2-F001). The check runs before the gate, so a refusal spends no Allow. A target that is missing or ambiguous passes it: the gate and the lookup after it answer as they do for any target.
 */
async function refuseTarget(host: ToolHost, query: string): Promise<void> {
	const net = await host.reach.read(), named = net.sessions.filter((s) => s.id === query || s.name === query);
	if (named.length !== 1) return;
	const token = net.ps.find((p) => p.pane_id === named[0]!.herdrLocation?.paneId)?.tokens?.sb_opened_by;
	const byToken = typeof token === "string" && token.startsWith("link:") ? token.replace(/^(link:)+/, "") : undefined;
	for (const held of [byToken, host.openedFor?.(named[0]!.id)]) if (held !== undefined && held !== host.who.device) throw new Error(NO_TARGET);
}

const NO_CLOSE = "boss_close_main has no such target: no main opened for this run's device has that name or id";

/**
 * An ally run closes only a main opened for its own device (docs/specs/2026-11-07-link-remote-stop.md, decision 7). Unlike `refuseTarget`, a target that is missing, ambiguous, or held by no ally route is refused too:
 * the route table must name this run's device, and the pane token, when it names a device, must agree. It runs before the gate, so a refusal spends no Allow, and the one message does not tell which case it was.
 */
async function refuseClose(host: ToolHost, query: string): Promise<string> {
	const net = await host.reach.read(), named = net.sessions.filter((s) => s.id === query || s.name === query);
	if (named.length !== 1 || !host.who.device) throw new Error(NO_CLOSE);
	const token = net.ps.find((p) => p.pane_id === named[0]!.herdrLocation?.paneId)?.tokens?.sb_opened_by;
	const byToken = typeof token === "string" && token.startsWith("link:") ? token.replace(/^(link:)+/, "") : undefined;
	if (host.openedFor?.(named[0]!.id) !== host.who.device || (byToken !== undefined && byToken !== host.who.device)) throw new Error(NO_CLOSE);
	return named[0]!.id;
}

/** The tools an ally run may call at all; `call_tower`, `boss_server`, and `link_request` are refused by its kind. */
const ALLY = new Set(["boss_status", "tower_list", "board_read", "tower_send", "tower_reply", "boss_open_main", "boss_close_main"]);
export const TOOLS = ["boss_status", "tower_list", "board_read", "call_tower", "tower_send", "tower_reply", "boss_open_main", "boss_close_main", "boss_server", "link_request", "tower_memory"] as const;
/** The tools an ally run's gate lets through without a confirm below `dispatch`: reading, and writing to its sender (checked below). */
const FREE = new Set(["boss_status", "tower_list", "board_read"]);

const str = (args: Record<string, unknown>, name: string, max = 100_000): string => {
	const v = args[name];
	if (typeof v !== "string" || !v.trim() || v.length > max) throw new Error(`${name} has to be text of 1 to ${max} characters`);
	return v;
};
const opt = (args: Record<string, unknown>, name: string): string | undefined => (typeof args[name] === "string" && args[name] ? (args[name] as string) : undefined);
const json = (result: unknown): ToolResult => ({ text: JSON.stringify(result, null, 2), details: result });
const NO_HOLDER = new Set(["no_holder", "no_link"]);
const ASK = /^[0-9a-f]{32}$/;

/** The kept integrators the door named for a slip (`ForwardAsBefore`), by the tower and the slip's event id: a forward of that slip goes to one of them and to no other session. Kept for the server's life; the door is asked again after a restart. */
const namedFor = new Map<string, readonly string[]>();
/**
 * What the refusal of a forward the door did not name adds when the slip came in before this server started (todo #154): a run that outlived a restart holds the slip's event (the queue is on disk) but the door's answer is gone, and it is
 * not read back from anywhere (a file here is one a train can write). The way back is the door again, which is the same call.
 */
const restartWord = (host: ToolHost, at: number | undefined) => (host.startedAt !== undefined && at !== undefined && at < host.startedAt ? ` The sb server started at ${new Date(host.startedAt).toISOString()}, after this slip came in, and keeps the door's answer in memory only: if the door named this slip's integrators before that, its answer is gone with the restart, so ask the door again the same way and forward then.` : "");
const PEERS_SLIP = (name: string, id: string) => `${clean(name, 40)} (session ${id}) was opened for a teammate's device, so its slip is a peer's: it reaches the integrator through the ally run of its device, which marks it origin=remote and asks the boss below dispatch, and never through a local run. Forward nothing of it; it sends the slip again to the tower that opened it.`;

/**
 * `forward` on `tower_send` and `tower_reply`: the server finds the event the model names among the ones this run took and writes `fwd` and `fwd-from` from it; the model can name neither a sender nor an event it did not take.
 * What is forwarded is the event's own text, never the run's message, so a run cannot change a slip's `auth` here either (RR151-F002). A slip of a main opened for a teammate's device is not forwarded (the two witnesses of `slipOf`),
 * and a `tower_reply` goes only to an integrator the door named for this slip, which was not opened for a device either.
 */
async function forwardOf(host: ToolHost, args: Record<string, unknown>, to?: string): Promise<{ fwd: string; fwdFrom: string; body: string } | undefined> {
	const id = opt(args, "forward");
	if (id === undefined) return undefined;
	const event = host.forwardEvent?.(id);
	if (!event) throw new Error(`forward ${id.slice(0, 40)} is no call_tower event (why=shared) that this run took: forward a car slip with the id its event header shows. A slip's event is held only while the run that took it lives and for 24 h: ask its sender to send the slip to the tower again (call_tower why=shared) and forward the new event's id`);
	const net = await host.reach.read(), peers = (session: string) => deviceToken(net, session) !== undefined || (host.openedAnywhere ?? host.openedFor)?.(session) !== undefined;
	if (peers(event.from)) throw new Error(PEERS_SLIP(event.from, event.from));
	if (to !== undefined && !namedFor.get(`${host.identity} ${event.id}`)?.includes(to)) throw new Error(`forward ${event.id} goes only to an integrator the door named for this slip: call boss_open_main with role "integrator", the slip as the request, and its sender, and forward to one of the sessions its answer names.${restartWord(host, event.at)}`);
	if (to !== undefined && peers(to)) throw new Error(`Session ${to} was opened for a teammate's device, so no slip is forwarded to it. The boss closes it or renames it.`);
	return { fwd: event.id, fwdFrom: event.from, body: bodyOf(event.text) };
}
const sentTo = (details: unknown): string[] => ((details as { results?: { id: string; status: string }[] } | undefined)?.results ?? []).filter((r) => r.status === "sent").map((r) => r.id);

export interface CallExtra { toolCallId?: string; /** The id of the taken event that started the run's current turn, as the run's extension reports it (the head's relay); the server checks it. */ turn?: string }

export async function runTool(host: ToolHost, kind: Kind, name: string, args: Record<string, unknown>, extra: CallExtra = {}): Promise<ToolResult> {
	if (!(TOOLS as readonly string[]).includes(name)) throw new Error(`No such tool: ${name}`);
	if (kind === "ally") return allyTool(host, name, args, extra);
	return localTool(host, name, args, extra);
}

// --- an ally run -----------------------------------------------------------------------------------------------------------------------------------------------

/** Whether the argument of `tower_send`/`device` names the run's own device (its id, short id, or label). */
const isSender = (who: RunWho, device: string) => device === who.device || device === who.device?.slice(0, 6) || device === who.deviceLabel;

/**
 * The sender of an ally run as a main's sender, when the run names it as its header does (`link:<device id>`, or the short id): the device the run serves, never another. The id is the claim's, not the argument's, so the server
 * decides who a main reports for. A bare label or short id is not taken, because a session of this computer may carry it; such a sender is looked up among the sessions as for a local run.
 */
const peerSender = (who: RunWho, sender: string): PeerSender | undefined => {
	if (!sender.startsWith("link:") || !who.device) return undefined;
	// The header's `id=` already reads `link:<device id>`: a model that adds the prefix again names the same device.
	const named = sender.replace(/^(link:)+/, "");
	return named === who.device || named === who.device.slice(0, 6) ? { id: `link:${who.device}`, label: who.deviceLabel ?? who.device.slice(0, 6), short: who.deviceShort ?? who.device.slice(0, 6) } : undefined;
};

async function allyTool(host: ToolHost, name: string, args: Record<string, unknown>, extra: CallExtra): Promise<ToolResult> {
	const { who } = host;
	if (!ALLY.has(name)) throw new Error(`${name} is not available in an ally run`);
	if (args.forward !== undefined) throw new Error("An ally run forwards no car slip: forward is for the tower runs of this computer");
	if (who.gone) throw new Error("The sender of this run is no longer a member of its team: the run is ending");
	const level = who.level ?? "reply", gated = level !== "dispatch" && !FREE.has(name);
	// A target on this computer that is a tower identity would carry a peer's text into a local run: refused outright, whatever the level or an Allow.
	// And a device other than its sender is refused the same way: an Allow the boss gave for it would otherwise send the text to the sender, not to the device the boss approved.
	if (name === "tower_send") {
		if (args.head !== undefined) throw new Error("An ally run does not answer the head tower: head is for the tower runs of this computer");
		const device = opt(args, "device");
		if (device === undefined) throw new Error("An ally run writes to its sender only: give device (the sender's id, short id, or label)");
		if (!isSender(who, device)) throw new Error("An ally run writes to its sender only: that device is not the sender of this run");
	}
	// A main opened for a `link:` sender reports for the device the run serves, and for no other: another device's id is refused here rather than looked up among the sessions of this computer.
	if (name === "boss_open_main") {
		// The one door to an integrator: a car slip a main opened for this run's device sent the tower. It is looked up here as well, before the gate, so a call with no such slip spends no Allow and asks the boss nothing.
		if (args.role === INTEGRATOR) {
			const slip = await slipOf(host, args, true);
			if (gated) await askOpener(host, slip, true, true);
		} else if (args.role !== undefined) throw new Error("An ally run opens no train: a train is opened by the tower of this computer on an integrator's manifest");
		else {
			const sender = str(args, "sender", 300);
			if (sender.startsWith("link:") && !peerSender(who, sender)) throw new Error("An ally run opens a main for its own sender only: that device is not the sender of this run");
		}
	}
	if (name === "tower_reply") {
		const to = str(args, "to", 200);
		if (await host.isTower(to)) throw new Error("An ally run may not write to a tower identity of this computer: it would carry a peer's text into a local run");
		await refuseTarget(host, to);
	}
	if (name === "boss_close_main") await refuseClose(host, str(args, "main", 300));
	// The sender's own device is the one write the allowlist lets through; everything else outside the free reads needs the Allow of the gate.
	if (gated && name !== "tower_send") {
		if (!extra.toolCallId) throw new Error(`${name} needs the boss's confirm in this run, and the call carried no tool call id`);
		const taken = await host.allow({ toolCallId: extra.toolCallId, tool: name, args });
		if (!taken.ok) throw new Error(`${name} was not allowed: ${taken.reason}`);
	}
	switch (name) {
		case "boss_status": return json(await host.reach.status({ project: host.project }));
		case "tower_list": return scopedList(host);
		case "board_read": return scopedBoards(host, args);
		case "tower_send": return towerSendDevice(host, args, who.device!, true);
		default: return localTool(host, name, args, extra, true);
	}
}

/** `tower_list` for an ally run: the local workspaces inside the project its sender's team binds, and that team's allies. */
async function scopedList(host: ToolHost): Promise<ToolResult> {
	const { who } = host;
	const local = await host.reach.towerList({ project: host.project });
	const answer = await host.link({ op: "list", teams: [who.team ?? ""] }).catch(() => undefined);
	if (!answer || !answer.ok) return local;
	return json({ ...(local.details as object), remote: remoteTowers(answer.teams as AllyTeam[]) });
}
async function scopedBoards(host: ToolHost, args: Record<string, unknown>): Promise<ToolResult> {
	const scope = args.scope === "local" || args.scope === "remote" ? args.scope : "all", device = opt(args, "device"), team = host.who.team ?? "";
	const link = {
		remoteScope: () => ({ teams: [team], project: host.project }),
		async boards(o: { teams?: readonly string[]; device?: string } = {}): Promise<AllyBoard[] | undefined> {
			const answer = await host.link({ op: "board-read", teams: [team], ...(o.device !== undefined ? { device: o.device } : {}) }).catch((error: Error) => ({ ok: false, error: error.message }) as Answer);
			if (!answer.ok) {
				if (o.device !== undefined && !NO_HOLDER.has(String(answer.code))) throw new Error(String(answer.error));
				return NO_HOLDER.has(String(answer.code)) ? undefined : [];
			}
			return answer.boards as AllyBoard[];
		},
	};
	return json(await readBoard({ dir: host.boardDir, now: host.now(), net: await host.reach.read(), link, scope, ...(device !== undefined ? { device } : {}) }));
}

// --- the integrator's door ----------------------------------------------------------------------------------------------------------------------------------------------------

/** The device a session's pane says it was opened for (`sb_opened_by=link:<device id>`), when it says one. */
const deviceToken = (net: Awaited<ReturnType<Reach["read"]>>, session: string): string | undefined => {
	const token = net.ps.find((p) => p.pane_id === net.sessions.find((s) => s.id === session)?.herdrLocation?.paneId)?.tokens?.sb_opened_by;
	return typeof token === "string" && token.startsWith("link:") ? token.replace(/^(link:)+/, "") : undefined;
};
/** A slip's text as a confirm compares it: line ends and trailing blanks aside. */
const sameText = (a: string, b: string) => ((n: (t: string) => string) => n(a) === n(b))((t) => t.replace(/\r\n?/g, "\n").split("\n").map((l) => l.trimEnd()).join("\n").trim());

/**
 * The car slip an integrator's open is for: the newest `call_tower` (why=shared) this run took from the session `sender` names whose text carries every `head:` of the request. The run names the slip by its sender and its
 * heads, which it can read; the event, its sender, and the text that is forwarded are the server's (a tower run is shown no event id). An ally run's slip comes from a main opened for its own device and from no other
 * session: the route table says so, and the main's pane token, when it names a device, must agree (as for `boss_close_main`). A local run's slip comes from no main opened for a device (R151-F001): such a main's `call_tower`
 * can reach a local run (it named another workspace's tower, its route aged out, or a local run's newer expectation outranked it), and its slip would then go on without `origin=remote` and without the gate; either witness, its pane
 * token or any workspace's route table, refuses it here. Below `dispatch` the boss's confirm shows the call's arguments, so the ally run's request has to be the slip's own text: what the boss allows is what is forwarded (R151-F004).
 */
async function slipOf(host: ToolHost, args: Record<string, unknown>, ally: boolean): Promise<{ project?: string; event: SlipEvent }> {
	const project = args.project === undefined || args.project === null ? undefined : String(args.project).slice(0, 200), sender = str(args, "sender", 300), request = str(args, "request"), heads = headsIn(request);
	if (!heads.length) throw new Error("An integrator is opened on a car slip: pass the slip as it came as the request (its head: line names the car)");
	const none = new Error(`No car slip with head ${heads[0]!.slice(0, 12)} from ${clean(sender, 40)} is among the call_tower messages (why=shared) this run took${ally ? " from a main opened for its sender" : ""}: an integrator is opened on such a slip, and on no other request`);
	const event = [...(host.slipEvents?.() ?? [])].reverse().find((e) => (e.from.id === sender || e.from.name === sender) && heads.every((h) => headsIn(e.text).includes(h)) && slipsInText(bodyOf(e.text)).length > 0);
	if (!event) throw none;
	const byToken = deviceToken(await host.reach.read(), event.from.id);
	if (ally) {
		if (!host.who.device || host.openedFor?.(event.from.id) !== host.who.device || (byToken !== undefined && byToken !== host.who.device)) throw none;
		if ((host.who.level ?? "reply") !== "dispatch" && !sameText(request, bodyOf(event.text))) throw new Error(`Below dispatch the boss confirms the slip that is forwarded, so the request has to be the slip exactly as it came, its whole text and nothing more. Call again with this text as the request:\n${bodyOf(event.text)}`);
	} else if (byToken !== undefined || (host.openedAnywhere ?? host.openedFor)?.(event.from.id) !== undefined)
		throw new Error(PEERS_SLIP(event.from.name ?? event.from.id, event.from.id));
	return { ...(project !== undefined ? { project } : {}), event };
}

/**
 * The opener asked for the slip's integrator, or with `dry` only for its refusals: an ally run below `dispatch` asks so before the gate, so a call the opener refuses spends no Allow (RR151-F005).
 * The project is the checkout's, read by the opener; the run's word, when it gives one, only has to agree. An ally run's open stays inside the project its team binds here.
 */
function askOpener(host: ToolHost, { project, event }: { project?: string; event: SlipEvent }, ally: boolean, dry = false): Promise<Opened> {
	if (!host.openIntegrator) throw new Error("This tower opens no integrator");
	return host.openIntegrator({ request: bodyOf(event.text), sender: event.from.id, role: INTEGRATOR, ...(project !== undefined ? { project } : {}), ...(ally ? { within: host.project ?? "" } : {}), ...(dry ? { dry } : {}) }).catch((error: Error) => {
		// The project runs integrators of its own (0.73: the boss's, one per app): the door opened nothing, and a local run forwards the slip as it did then. It is told here the event id it is shown nowhere else, so `forward` can name it.
		if (!(error instanceof ForwardAsBefore)) throw error;
		// The route tables are the second witness here too: a peer's main that answers as an integrator (its pane token cleared) is no target of a forward.
		const peers = error.mains.filter((m) => (host.openedAnywhere ?? host.openedFor)?.(m.id) !== undefined);
		if (peers.length) throw new Error(`${peers.map((m) => `${m.name} (session ${m.id})`).join(", ")} answers as an integrator of this project and was opened for a teammate's device, so no slip goes to it and nothing opens beside it. The boss closes it or renames it.`);
		// The forward of this slip goes to one of the integrators named here and to no other session.
		if (!ally) (namedFor.size > 500 && namedFor.clear(), namedFor.set(`${host.identity} ${event.fwd}`, error.mains.map((m) => m.id)));
		throw new Error(`${error.message} ${ally ? "An ally run forwards no slip: tell the sender that its car waits for the boss of this computer, whose integrators take slips from this computer's own tower runs." : `Forward it in this run with tower_reply: to (that integrator's session id), message (the slip exactly as it came), forward: "${event.fwd}" (the id of the event this slip came in; the code stamps its sender from it and sends the event's own text).`}`);
	});
}

/**
 * `boss_open_main` with `role: "integrator"`: the project's one integrator is found or opened as the tower's own main (opener.ts), and the slip is forwarded to it as its sender wrote it, under the stamp a forward carries
 * (`fwd`, `fwd-from`), so the car book and the integrator's guard know its coordinator. Nothing of the forwarded text is the run's: a run that a peer's words reach cannot change a slip's `auth`.
 */
async function openIntegrator(host: ToolHost, args: Record<string, unknown>, ally: boolean): Promise<ToolResult> {
	const slip = await slipOf(host, args, ally), { project, event } = slip;
	const body = bodyOf(event.text), stamped = { fwd: event.fwd, fwdFrom: event.from.id };
	const opened = await askOpener(host, slip, ally), named = opened.integrator ?? project ?? "";
	// The route tables are the second witness that the main found is no device's (the first is its pane token, integrator.ts): a peer's main takes no project's slips, whatever name and kind it carries, in whichever workspace it was opened.
	if ((host.openedAnywhere ?? host.openedFor)?.(opened.main) !== undefined) throw new Error(`The main that answers as the integrator of project ${named} (session ${opened.main}) was opened for a teammate's device, so no slip goes to it; a project's integrator is this computer's own. The boss closes it or renames it.`);
	const result = await host.reach.post(opened.main, body, "tower_reply", "session", false, ally && host.who.device ? `remote:${host.who.device}` : undefined, undefined, stamped);
	if (result.status !== "sent") throw new Error(`The integrator of project ${named} (session ${opened.main}) ${opened.repeated ? "runs" : "was opened"} but did not take the slip: ${result.status} ${result.code ?? ""} ${result.detail ?? ""}`.trim());
	host.noteForward?.({ fwd: stamped.fwd, from: stamped.fwdFrom, to: [opened.main], text: body });
	const text = `${opened.repeated ? `The integrator of project ${named} already runs (session ${opened.main}); nothing opened.` : `Opened tab ${opened.tab} with the integrator of project ${named} (session ${opened.main}), this tower's own main.`} The slip of ${clean(event.from.name ?? event.from.id, 40)} was forwarded to it as it came, stamped with its sender. The sb server tells the sender what becomes of the car; relay nothing back.`;
	return { text, details: { ...opened, fwd: stamped.fwd } };
}

// --- Straw Link sends --------------------------------------------------------------------------------------------------------------------------------------------

/** `tower_send` with a device: over Straw Link. An ally run's goes to its sender's full id with `inReplyTo` checked against its own asks; a local run's may carry `for` (an ask for a main). */
async function towerSendDevice(host: ToolHost, args: Record<string, unknown>, forced?: string, ally = false): Promise<ToolResult> {
	const device = forced ?? opt(args, "device")!, message = str(args, "message"), reply = args.reply === true, inReplyTo = opt(args, "inReplyTo"), forWho = opt(args, "for");
	if (inReplyTo !== undefined && (!ally || !(host.who.asks ?? []).includes(inReplyTo))) throw new Error("inReplyTo has to be the ask id of one of this run's messages (see its brief)");
	if (forWho !== undefined && ally) throw new Error("An ally run asks for no main");
	if (forWho !== undefined && !reply) throw new Error("An ask for a main has to expect a reply (reply: true)");
	let main: { id: string; name: string } | undefined, ask: string | undefined;
	// A tower that sends for a local session records who asked, by the server and not by the model's memory: the device's answer never enters a tower run, so without an ask nobody here would get it.
	// `for` names the main; without it the run's one requester is taken, and with none or several nothing is guessed.
	const requester = forWho === undefined && !ally && reply ? await host.requester() : undefined;
	if (forWho !== undefined) main = await host.mainOf(forWho);
	else if (requester) main = requester;
	if (main) ask = randomBytes(16).toString("hex");
	const answer = await host.link({ op: "send", device, text: message, reply, ...(opt(args, "workspace") ? { workspace: opt(args, "workspace") } : {}), ...(ask ? { awaitsReply: ask } : {}), ...(inReplyTo ? { inReplyTo } : {}) });
	if (!answer.ok) throw new Error(String(answer.error));
	const details = (answer.details ?? {}) as { team?: string; device?: string; id?: string; asked?: boolean };
	let text = String(answer.text);
	if (main && ask) {
		if (details.asked === true && details.team && details.device && details.id) {
			host.asks.open({ ask, envelope: details.id, device: details.device, team: details.team, for: main.id, forName: main.name, workspace: host.who.workspace, tower: host.identity, at: host.now(), expires: host.now() + ASK_KEEP_MS });
			text += ` The answer will come to ${main.name} directly${forWho === undefined ? " (the main that called you for this; pass for to name another)" : ""}.`;
		} else text += ` The answer will not come to ${main.name}: it will reach an ally run here, whose brief names the main that asked.`;
	} else if (!ally && reply) text += " No session is bound to this send. The answer reaches an ally run here, not you or any session; pass for with a main of this workspace, or one of another workspace that called you in this run, to have it delivered there; if there is none, tell the requester that nobody gets the answer.";
	return { text, details: { ...(answer.details as object | undefined), ...(main ? { for: main.id } : {}) } };
}

// --- a local run ---------------------------------------------------------------------------------------------------------------------------------------------------

async function localTool(host: ToolHost, name: string, args: Record<string, unknown>, extra: CallExtra, ally = false): Promise<ToolResult> {
	const { reach } = host;
	switch (name) {
		case "boss_status":
			return json(await reach.status());
		case "tower_list": {
			const local = await reach.towerList();
			const answer = await host.link({ op: "list" }).catch(() => undefined);
			if (!answer || !answer.ok) return local;
			const result = { ...(local.details as object), remote: remoteTowers(answer.teams as AllyTeam[]) };
			return json(result);
		}
		case "board_read": {
			const scope = args.scope === "local" || args.scope === "remote" ? args.scope : "all", device = opt(args, "device");
			const link = {
				remoteScope: () => undefined,
				async boards(o: { teams?: readonly string[]; device?: string } = {}): Promise<AllyBoard[] | undefined> {
					const answer = await host.link({ op: "board-read", ...(o.device !== undefined ? { device: o.device } : {}) }).catch((error: Error) => ({ ok: false, error: error.message }) as Answer);
					if (!answer.ok) {
						if (o.device !== undefined && !NO_HOLDER.has(String(answer.code))) throw new Error(String(answer.error));
						return NO_HOLDER.has(String(answer.code)) ? undefined : [];
					}
					return answer.boards as AllyBoard[];
				},
			};
			return json(await readBoard({ dir: host.boardDir, now: host.now(), net: await reach.read(), link, scope, ...(device !== undefined ? { device } : {}) }));
		}
		case "call_tower": {
			const done = await reach.callTower(str(args, "message"), opt(args, "workspace"), args.reply !== false, opt(args, "why"));
			if (args.reply !== false) host.expect(String((done.details as { towerId: string }).towerId), host.label, str(args, "message"));
			return done;
		}
		case "tower_send": {
			if (args.head === true) return answerHead(host, args);
			if (opt(args, "device") !== undefined) return towerSendDevice(host, args);
			if (opt(args, "for") !== undefined || opt(args, "inReplyTo") !== undefined) throw new Error("for and inReplyTo go with a device");
			const stamped = await forwardOf(host, args), message = stamped?.body ?? str(args, "message");
			const done = await reach.towerSend(message, opt(args, "workspace"), args.reply === true, stamped ? { fwd: stamped.fwd, fwdFrom: stamped.fwdFrom } : {});
			if (stamped) host.noteForward?.({ fwd: stamped.fwd, from: stamped.fwdFrom, to: sentTo(done.details), text: message });
			for (const id of sentTo(done.details)) host.decided?.(id, message, args.basis);
			return done;
		}
		case "tower_reply": {
			const to = str(args, "to", 200), message = str(args, "message", 16_384);
			// An ally run's target is checked again after the Allow: the session may have changed in between.
			if (ally) await refuseTarget(host, to);
			const net = await reach.read();
			const named = net.sessions.filter((s) => s.id === to || s.name === to);
			if (named.length !== 1) throw new Error(`${named.length ? "Several sessions are named" : "No live session is named or has the id"} "${to}"`);
			const target = named[0]!, shown = clean(target.name ?? target.id, 40);
			// The head's gate takes a `tower_send` that names its ask, never a `tower_reply`: say so here, before anything is sent, instead of leaving the run to read a refused receipt (or none) as an answer given.
			if (!ally && target.id === headIdOf(net.all)) throw new Error("Not delivered: the head tower takes no tower_reply. Answer it with tower_send {head: true, inReplyTo: \"H<n>\", message} (H<n> is the ask id in the header of its message).");
			// The server stamps `origin=remote:<device id>` on what an ally run sends to a local session, so the receiver knows a peer's text started it.
			const stamped = await forwardOf(host, args, target.id), sent = stamped?.body ?? message;
			const result = await reach.post(target.id, sent, "tower_reply", "session", args.reply === true, ally && host.who.device ? `remote:${host.who.device}` : undefined, undefined, stamped ? { fwd: stamped.fwd, fwdFrom: stamped.fwdFrom } : {});
			if (result.status !== "sent") throw new Error(`${shown} did not take the message: ${result.status} ${result.code ?? ""} ${result.detail ?? ""}`.trim());
			if (stamped) host.noteForward?.({ fwd: stamped.fwd, from: stamped.fwdFrom, to: [target.id], text: sent });
			host.decided?.(target.id, message, args.basis);
			if (args.reply === true) host.expect(target.id, shown, message);
			return { text: `Sent to ${shown}.${stamped ? " The slip went as its sender wrote it, from the event: nothing of your message was sent." : ""}`, details: { to: target.id, status: result.status } };
		}
		case "boss_open_main": {
			if (args.role === INTEGRATOR) return openIntegrator(host, args, ally);
			const sender = str(args, "sender", 300), peer = ally ? peerSender(host.who, sender) : undefined;
			const opened = await host.open({ request: str(args, "request"), sender: peer?.id ?? sender, ...(peer ? { peer } : {}), ...(opt(args, "label") ? { label: opt(args, "label")! } : {}), ...(opt(args, "role") ? { role: opt(args, "role")! } : {}) });
			if (opened.train) return { text: opened.repeated ? `A train was already opened for this request (tab ${opened.tab}); nothing new opened.` : `Opened tab ${opened.tab} with ${trainLabel(opened.train.code)} (session ${opened.main}) and handed it the manifest. It reports to you; close it with boss_close_main after its milestone report.`, details: opened };
			const text = opened.repeated ? `A main was already opened for this request (tab ${opened.tab}); nothing new opened.` : `Opened tab ${opened.tab} with a main agent (session ${opened.main}) and handed it the request. ${peer ? `It reports to the tower only; each report wakes a run for ${peer.label} that sends it to the sender.` : `It reports to ${opened.sender} and to you.`}`;
			return { text, details: opened };
		}
		case "boss_close_main": {
			// An ally run closes the session its own check resolved, not the name again: the name may have been reused since.
			const main = str(args, "main", 300), closed = await host.closeMain(ally ? await refuseClose(host, main) : main);
			return { text: closed.text, details: closed };
		}
		case "link_request":
			return linkRequest(host, args, extra);
		case "tower_memory":
			return host.memory(args);
		default: {
			// boss_server
			const action = args.action;
			if (action === "status") return json(host.server.status());
			if (action === "logs") {
				const lines = typeof args.lines === "number" && Number.isInteger(args.lines) ? Math.min(Math.max(args.lines, 1), 200) : 200, text = host.server.logs(lines).join("\n");
				return { text: text || "(the log is empty)", details: { lines: text ? text.split("\n").length : 0 } };
			}
			if (action !== "restart") throw new Error("action is status, logs, or restart");
			const reason = typeof args.reason === "string" ? args.reason.trim() : "";
			if (!reason || reason.length > 200 || /[\r\n]/.test(reason)) throw new Error("A restart needs a reason: one line of 1 to 200 characters");
			await host.server.restart(reason, `tower run of ${host.label}`);
			return { text: "The sb server is restarting; pages reconnect on the same URL, and this run keeps its claim through the restart.", details: { restarting: true } };
		}
	}
}

/** A tower's answer to the head tower's ask: only to an open ask the head made to this tower's workspace; the head's gate checks the same again. */
async function answerHead(host: ToolHost, args: Record<string, unknown>): Promise<ToolResult> {
	const id = opt(args, "inReplyTo"), message = str(args, "message", 12_000);
	if (!id || !/^H\d{1,6}$/.test(id)) throw new Error("head needs inReplyTo, the ask id (H12) of the head tower's message you answer");
	if (opt(args, "device") !== undefined || opt(args, "for") !== undefined) throw new Error("An answer to the head tower goes to the head tower alone: leave device and for out");
	if (!host.headAsked?.(id)) throw new Error(`The head tower has no open ask ${id} to this workspace, so there is nothing to answer`);
	const sent = await host.reach.answerHead(message, id);
	if (sent.status !== "sent") throw new Error(`The head tower did not take the answer: ${sent.status} ${sent.code ?? ""} ${sent.detail ?? ""}`.trim());
	return { text: `Sent to the head tower as the answer to ${id}.`, details: { to: "head", ask: id, status: sent.status } };
}

/**
 * `link_request` in a local run, in two steps because the approval is a dialog in the run's own pi: `open` asks the holder what the request does (and keeps those lines), the run shows the boss the approval,
 * and `run` carries the request out only when the hub saw that approval close with a yes for this call id over those lines (allows.ts), once. `drop` withdraws one the boss refused.
 */
async function linkRequest(host: ToolHost, args: Record<string, unknown>, extra: CallExtra): Promise<ToolResult> {
	const phase = args.phase;
	if (phase === "open") {
		const answer = await host.link({ op: "request-open", action: args.action, args: args.args ?? {}, reason: typeof args.reason === "string" ? args.reason : "" });
		if (!answer.ok) throw new Error(String(answer.error));
		host.requests.set(String(answer.id), (answer.lines as string[]) ?? []);
		return { text: "The request is waiting for the boss's approval.", details: { id: answer.id, lines: answer.lines, reason: answer.reason } };
	}
	const id = str(args, "id", 200);
	if (phase === "drop") {
		host.requests.delete(id);
		await host.link({ op: "request-drop", id }).catch(() => undefined);
		return { text: "The request was withdrawn.", details: { id } };
	}
	if (phase !== "run") throw new Error("phase is open, run, or drop");
	const lines = host.requests.get(id);
	if (!lines) throw new Error("This run opened no such request");
	if (!extra.toolCallId) throw new Error("A link_request is carried out only against the approval of its tool call");
	const taken = await host.allowRequest({ toolCallId: extra.toolCallId, lines });
	if (!taken.ok) throw new Error(`link_request was not approved: ${taken.reason}`);
	host.requests.delete(id);
	const ran = await host.link({ op: "request-run", id });
	if (!ran.ok) throw new Error(String(ran.error));
	return { text: String(ran.text), details: { id } };
}
