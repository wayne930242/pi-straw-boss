import { readBoard } from "../boardread.ts";
import type { Control } from "../closemain.ts";
import type { Opened, OpenRequest } from "../opener.ts";
import { remoteTowers } from "../link/remotelist.ts";
import type { AllyBoard, AllyTeam } from "../link/holder.ts";
import { clean } from "../board.ts";
import type { Reach } from "../reach.ts";
import type { Kind } from "./rungate.ts";

// The tower tools a run calls (docs/specs/2026-10-26-sb-backend.md, Tower tools in a run). In a run each tool is a thin client of the server: the run's extension sends `run-tool { token, tool, args }`,
// and the server does the work as the workspace's tower identity (its reach, its opener, its control channel, the link holder), so the header of everything a run sends names the identity and replies
// come back to the server, not to a pi that has exited. The server also enforces the run's kind here, in addition to the hooks in the run: an ally run gets `boss_status` and nothing else.
// (`tower_done` is the `run-done` request and `link_request` stays in the run, which asks the boss; neither is here.)

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
}

/** The tools an ally run may call (B6 widens this with the gate and the scope of a remote turn). */
const ALLY = new Set(["boss_status"]);
export const TOOLS = ["boss_status", "tower_list", "board_read", "call_tower", "tower_send", "tower_reply", "boss_open_main", "boss_close_main", "boss_server"] as const;

const str = (args: Record<string, unknown>, name: string, max = 100_000): string => {
	const v = args[name];
	if (typeof v !== "string" || !v.trim() || v.length > max) throw new Error(`${name} has to be text of 1 to ${max} characters`);
	return v;
};
const opt = (args: Record<string, unknown>, name: string): string | undefined => (typeof args[name] === "string" && args[name] ? (args[name] as string) : undefined);
const json = (result: unknown): ToolResult => ({ text: JSON.stringify(result, null, 2), details: result });
const NO_HOLDER = new Set(["no_holder", "no_link"]);

export async function runTool(host: ToolHost, kind: Kind, name: string, args: Record<string, unknown>): Promise<ToolResult> {
	if (!(TOOLS as readonly string[]).includes(name)) throw new Error(`No such tool: ${name}`);
	if (kind === "ally" && !ALLY.has(name)) throw new Error(`${name} is not available in an ally run`);
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
			const device = opt(args, "device"), message = str(args, "message"), reply = args.reply === true;
			if (device !== undefined) {
				const answer = await host.link({ op: "send", device, text: message, reply, ...(opt(args, "workspace") ? { workspace: opt(args, "workspace") } : {}) });
				if (!answer.ok) throw new Error(String(answer.error));
				return { text: String(answer.text), details: answer.details };
			}
			return reach.towerSend(message, opt(args, "workspace"), reply);
		}
		case "tower_reply": {
			const to = str(args, "to", 200), message = str(args, "message", 16_384), net = await reach.read();
			const named = net.sessions.filter((s) => s.id === to || s.name === to);
			if (named.length !== 1) throw new Error(`${named.length ? "Several sessions are named" : "No live session is named or has the id"} "${to}"`);
			const target = named[0]!, shown = clean(target.name ?? target.id, 40);
			const result = await reach.post(target.id, message, "tower_reply", "session", args.reply === true);
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
