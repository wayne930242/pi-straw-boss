import { readBoard } from "../boardread.ts";
import type { Control } from "../closemain.ts";
import type { Opened, OpenRequest } from "../opener.ts";
import { remoteTowers } from "../link/remotelist.ts";
import type { AllyBoard, AllyTeam } from "../link/holder.ts";
import { clean } from "../board.ts";
import type { Reach } from "../reach.ts";
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
	/** The live main of this tower's workspace named by id or name (a local run asks for it); throws when there is none or it is ambiguous. */
	mainOf(query: string): Promise<{ id: string; name: string }>;
	/** `tower_memory` of a local run (towermemory.ts): the quote rule is checked there against the boss messages this run took. */
	memory(args: Record<string, unknown>): Promise<ToolResult>;
	now(): number;
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

export interface CallExtra { toolCallId?: string }

export async function runTool(host: ToolHost, kind: Kind, name: string, args: Record<string, unknown>, extra: CallExtra = {}): Promise<ToolResult> {
	if (!(TOOLS as readonly string[]).includes(name)) throw new Error(`No such tool: ${name}`);
	if (kind === "ally") return allyTool(host, name, args, extra);
	return localTool(host, name, args, extra);
}

// --- an ally run -----------------------------------------------------------------------------------------------------------------------------------------------

/** Whether the argument of `tower_send`/`device` names the run's own device (its id, short id, or label). */
const isSender = (who: RunWho, device: string) => device === who.device || device === who.device?.slice(0, 6) || device === who.deviceLabel;

async function allyTool(host: ToolHost, name: string, args: Record<string, unknown>, extra: CallExtra): Promise<ToolResult> {
	const { who } = host;
	if (!ALLY.has(name)) throw new Error(`${name} is not available in an ally run`);
	if (who.gone) throw new Error("The sender of this run is no longer a member of its team: the run is ending");
	const level = who.level ?? "reply", gated = level !== "dispatch" && !FREE.has(name);
	// A target on this computer that is a tower identity would carry a peer's text into a local run: refused outright, whatever the level or an Allow.
	// And a device other than its sender is refused the same way: an Allow the boss gave for it would otherwise send the text to the sender, not to the device the boss approved.
	if (name === "tower_send") {
		const device = opt(args, "device");
		if (device === undefined) throw new Error("An ally run writes to its sender only: give device (the sender's id, short id, or label)");
		if (!isSender(who, device)) throw new Error("An ally run writes to its sender only: that device is not the sender of this run");
	}
	if (name === "tower_reply") {
		const to = str(args, "to", 200);
		if (await host.isTower(to)) throw new Error("An ally run may not write to a tower identity of this computer: it would carry a peer's text into a local run");
	}
	// The sender's own device is the one write the allowlist lets through; everything else outside the free reads needs the Allow of the gate.
	if (gated && name !== "tower_send") {
		if (!extra.toolCallId) throw new Error(`${name} needs the boss's confirm in this run, and the call carried no tool call id`);
		const taken = await host.allow({ toolCallId: extra.toolCallId, tool: name, args });
		if (!taken.ok) throw new Error(`${name} was not allowed: ${taken.reason}`);
	}
	switch (name) {
		case "boss_status": return json(await host.reach.status());
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

// --- Straw Link sends --------------------------------------------------------------------------------------------------------------------------------------------

/** `tower_send` with a device: over Straw Link. An ally run's goes to its sender's full id with `inReplyTo` checked against its own asks; a local run's may carry `for` (an ask for a main). */
async function towerSendDevice(host: ToolHost, args: Record<string, unknown>, forced?: string, ally = false): Promise<ToolResult> {
	const device = forced ?? opt(args, "device")!, message = str(args, "message"), reply = args.reply === true, inReplyTo = opt(args, "inReplyTo"), forWho = opt(args, "for");
	if (inReplyTo !== undefined && (!ally || !(host.who.asks ?? []).includes(inReplyTo))) throw new Error("inReplyTo has to be the ask id of one of this run's messages (see its brief)");
	if (forWho !== undefined && ally) throw new Error("An ally run asks for no main");
	if (forWho !== undefined && !reply) throw new Error("An ask for a main has to expect a reply (reply: true)");
	let main: { id: string; name: string } | undefined, ask: string | undefined;
	if (forWho !== undefined) {
		main = await host.mainOf(forWho);
		ask = randomBytes(16).toString("hex");
	}
	const answer = await host.link({ op: "send", device, text: message, reply, ...(opt(args, "workspace") ? { workspace: opt(args, "workspace") } : {}), ...(ask ? { awaitsReply: ask } : {}), ...(inReplyTo ? { inReplyTo } : {}) });
	if (!answer.ok) throw new Error(String(answer.error));
	const details = (answer.details ?? {}) as { team?: string; device?: string; id?: string; asked?: boolean };
	let text = String(answer.text);
	if (main && ask) {
		if (details.asked === true && details.team && details.device && details.id) {
			host.asks.open({ ask, envelope: details.id, device: details.device, team: details.team, for: main.id, forName: main.name, workspace: host.who.workspace, tower: host.identity, at: host.now(), expires: host.now() + ASK_KEEP_MS });
			text += ` The answer will come to ${main.name} directly.`;
		} else text += ` The answer will not come to ${main.name}: it will reach an ally run here, whose brief names the main that asked.`;
	}
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
			const done = await reach.callTower(str(args, "message"), opt(args, "workspace"), args.reply !== false);
			if (args.reply !== false) host.expect(String((done.details as { towerId: string }).towerId), host.label, str(args, "message"));
			return done;
		}
		case "tower_send": {
			if (opt(args, "device") !== undefined) return towerSendDevice(host, args);
			if (opt(args, "for") !== undefined || opt(args, "inReplyTo") !== undefined) throw new Error("for and inReplyTo go with a device");
			return reach.towerSend(str(args, "message"), opt(args, "workspace"), args.reply === true);
		}
		case "tower_reply": {
			const to = str(args, "to", 200), message = str(args, "message", 16_384), net = await reach.read();
			const named = net.sessions.filter((s) => s.id === to || s.name === to);
			if (named.length !== 1) throw new Error(`${named.length ? "Several sessions are named" : "No live session is named or has the id"} "${to}"`);
			const target = named[0]!, shown = clean(target.name ?? target.id, 40);
			// The server stamps `origin=remote:<device id>` on what an ally run sends to a local session, so the receiver knows a peer's text started it.
			const result = await reach.post(target.id, message, "tower_reply", "session", args.reply === true, ally && host.who.device ? `remote:${host.who.device}` : undefined);
			if (result.status !== "sent") throw new Error(`${shown} did not take the message: ${result.status} ${result.code ?? ""} ${result.detail ?? ""}`.trim());
			if (args.reply === true) host.expect(target.id, shown, message);
			return { text: `Sent to ${shown}.`, details: { to: target.id, status: result.status } };
		}
		case "boss_open_main": {
			const opened = await host.open({ request: str(args, "request"), sender: str(args, "sender", 300), ...(opt(args, "label") ? { label: opt(args, "label")! } : {}) });
			const text = opened.repeated ? `A main was already opened for this request (tab ${opened.tab}); nothing new opened.` : `Opened tab ${opened.tab} with a main agent (session ${opened.main}) and handed it the request. It reports to ${opened.sender} and to you.`;
			return { text, details: opened };
		}
		case "boss_close_main": {
			const closed = await host.closeMain(str(args, "main", 300));
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
