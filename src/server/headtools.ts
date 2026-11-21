import { isHead, isSub, parentOf } from "../herdr.ts";
import { type CallExtra, runTool, type ToolHost, type ToolResult } from "./runtools.ts";

// The tools of a head run (docs/specs/2026-11-04-head-tower.md, Tools and limits, Forwarding, and the answers): it lists the towers, reads the board, forwards to one workspace tower, keeps its memory, and sees the server. It has no
// broadcast, no `device`, no way to open a main or a tab, and no tool to answer a peer: the server refuses everything else by the run's kind, as the run's hook does.

/** What the head's forwards need of the server. */
export interface HeadPort {
	/** The tower of a workspace, opened when there is none (`ensure-tower`: the tab and its standing pane, no pi). */
	ensureTower(workspace: string): Promise<{ id: string; opened: boolean }>;
	/** Opens the ask `H<n>` for a forward; closes it again when the delivery failed. */
	openAsk(d: { workspace: string; label: string; first: string; relay?: string; boss?: string; supersedes?: string }): { id: string };
	closeAsk(id: string): void;
	/** Throws for a `supersedes` that names no earlier ask of the file; asked before a tower is opened for the forward. */
	checkSupersedes(id: string): void;
	/** `boss:<event id>` when `turn` names a boss event this run took; the model never says it, the run's extension reports which taken event started the turn and the server checks it. */
	relay(turn: string | undefined): string | undefined;
	/** The boss's own words of the boss event `turn` names, for the card of the ask (docs/specs/2026-11-07-head-log-cards.md); read from the queue by the server, never said by the model. */
	boss(turn: string | undefined): string | undefined;
	/** `boss_auto`: switches auto mode on or off only on the boss's own matching words in this turn, which the server reads itself (automode.ts `bossAuto`); throws when it refuses. */
	auto(on: boolean): ToolResult;
}
/** The result of `boss_auto` as the model reads it: a refusal throws, and either direction switches at once (AR-D1). */
export function autoAnswer(on: boolean, out: { ok: true; [key: string]: unknown } | { ok: false; error: string }): ToolResult {
	if (!out.ok) throw new Error(out.error);
	return { text: out.changed === false ? "Auto mode is already in that state." : on ? "Auto mode is on." : "Auto mode is off.", details: { changed: out.changed !== false } };
}
export type HeadHost = ToolHost & { head: HeadPort };
/** The head tower's tool host: it opens no tab and closes no main (HT-D2), so those seams refuse; its forwards go to the workspace towers, opened when needed. */
export const headHost = (host: ToolHost, head: HeadPort): HeadHost => {
	const no = () => Promise.reject(new Error("The head tower opens and closes no mains: forward to the tower that owns the work"));
	return { ...host, open: no, closeMain: no as never, head };
};

const str = (args: Record<string, unknown>, name: string, max: number): string => {
	const v = args[name];
	if (typeof v !== "string" || !v.trim() || v.length > max) throw new Error(`${name} has to be text of 1 to ${max} characters`);
	return v;
};
const json = (result: unknown): ToolResult => ({ text: JSON.stringify(result, null, 2), details: result });

export async function headTool(host: HeadHost, name: string, args: Record<string, unknown>, extra: CallExtra = {}): Promise<ToolResult> {
	switch (name) {
		case "tower_list": {
			// The list as a tower sees it, with each workspace's checkout folder (the head decides which workspace owns an instruction); `head` is itself. The head workspace is never a row.
			const listed = await host.reach.towerList(), net = await host.reach.read();
			const folders = new Map(net.all.map((w) => [w.workspace_id, w.worktree?.checkout_path] as const));
			const details = listed.details as { towers: { workspace: { id: string } }[] };
			return json({ ...details, towers: details.towers.map((t) => ({ ...t, folder: folders.get(t.workspace.id) ?? null })) });
		}
		case "tower_send": return forward(host, args, extra);
		case "boss_auto": {
			if (typeof args.on !== "boolean") throw new Error("on has to be true or false");
			return host.head.auto(args.on);
		}
		case "board_read": case "tower_memory": case "boss_server": return runTool(host, "local", name, args, extra);
		default: throw new Error(`${name} is not available to the head tower: it lists, reads the board, forwards with tower_send, keeps its memory, switches auto mode on the boss's words with boss_auto, and sees the server`);
	}
}

/** One forward to one workspace's tower. The ask is opened before the send (its id is in the header) and closed again when the send fails. */
async function forward(host: HeadHost, args: Record<string, unknown>, extra: CallExtra): Promise<ToolResult> {
	for (const key of ["device", "for", "inReplyTo", "head"]) if (args[key] !== undefined) throw new Error(`${key} is not for the head tower: it forwards to the towers of this computer, one workspace at a time`);
	const workspace = str(args, "workspace", 300), message = str(args, "message", 12_000), net = await host.reach.read();
	const found = net.all.filter((w) => w.workspace_id === workspace || w.label === workspace);
	if (found.length !== 1) throw new Error(`${found.length ? "Several workspaces match" : "No workspace matches"} "${workspace}". Workspaces: ${net.all.filter((w) => !isHead(w)).map((w) => `${w.workspace_id} (${w.label})`).join(", ")}`);
	const supersedes = args.supersedes === undefined ? undefined : str(args, "supersedes", 12);
	const asked = found[0]!, target = isSub(asked) ? parentOf(net.all, asked) : asked;
	if (isHead(asked)) throw new Error("That is the head tower's own workspace: it has no tower to forward to");
	if (!target) throw new Error(`${asked.label} is a sub workspace with no open parent workspace, so it has no tower; ask the boss to open the parent workspace first`);
	if (supersedes) host.head.checkSupersedes(supersedes);
	const ensured = await host.head.ensureTower(target.workspace_id);
	const relay = host.head.relay(extra.turn), boss = relay ? host.head.boss(extra.turn) : undefined, ask = host.head.openAsk({ workspace: target.workspace_id, label: target.label, first: message, ...(relay ? { relay } : {}), ...(boss ? { boss } : {}), ...(supersedes ? { supersedes } : {}) });
	try {
		const sent = await host.reach.forward(ensured.id, message, { ask: ask.id, ...(relay ? { relay } : {}) }, args.reply !== false);
		if (sent.status !== "sent") throw new Error(`The tower of ${target.label} did not take the message: ${sent.status} ${sent.code ?? ""} ${sent.detail ?? ""}`.trim());
	} catch (cause) {
		host.head.closeAsk(ask.id);
		throw cause;
	}
	const via = target !== asked ? ` (${asked.label} is a sub workspace)` : "";
	return { text: `sent to the tower of ${target.label}${via} as ask ${ask.id}${ensured.opened ? " (its tower was opened)" : ""}`, details: { ask: ask.id, workspace: target.workspace_id, towerId: ensured.id, opened: ensured.opened, ...(relay ? { relay } : {}), ...(supersedes ? { supersedes } : {}) } };
}
