import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export function registerLedgerSweep(pi: ExtensionAPI, tool: (name: string, args: unknown, toolCallId?: string) => Promise<{ text: string; details?: unknown }>): void {
	pi.registerTool({ name: "ledger_sweep", label: "ledger_sweep", description: "Run the fixed prune and configured ledger janitor for the server's scheduled ledger_sweep event only. Returns matched left items to forward as data; writes unmatched items to the head work board.", parameters: Type.Object({}), execute: async (id) => {
		const done = await tool("ledger_sweep", {}, id);
		return { content: [{ type: "text", text: done.text }], details: done.details };
	} });
}

/** What the head tower's `tower_send` tells the model; `supersedes` is how a correction says which earlier broadcast it replaces (docs/specs/2026-11-07-head-log-cards.md). */
export const HEAD_REGISTERED_DESCRIPTION = "Forward a message to the tower of one workspace (its id or exact label; a sub workspace goes to its parent). The tower is opened when the workspace has none. Quote the boss's words and decisions verbatim. The result names the ask (H12) the tower's answer will carry; the answer comes back to you as a new event. When the boss corrects or replaces an instruction you already sent, set supersedes to the ask id (H12) of any message of that earlier broadcast on every call of the new one, so the boss's page folds the old order under the new. You cannot send to every tower, to a teammate's device, or to a main.";

/** The head tower's `tower_send`: one workspace's tower, no broadcast and no device (headtools.ts); the server opens that tower when it has none and opens the ask. */
export function registerHeadSend(pi: ExtensionAPI, tool: (name: string, args: unknown, toolCallId?: string) => Promise<{ text: string; details?: unknown }>): void {
	pi.registerTool({
		name: "tower_send", label: "tower_send",
		description: HEAD_REGISTERED_DESCRIPTION,
		parameters: Type.Object({
			workspace: Type.String({ description: "The workspace's id or exact label." }),
			message: Type.String({ description: "What the tower needs to do or know, 1 to 12,000 characters, the boss's instruction quoted verbatim." }),
			reply: Type.Optional(Type.Boolean({ description: "Whether the tower is asked to answer. Default true." })),
			supersedes: Type.Optional(Type.String({ description: "Only when this message corrects or replaces an instruction you already sent: the ask id (H12) of an earlier message of that broadcast. It must be an ask you opened before this one." })),
		}),
		execute: async (id, params) => {
			const done = await tool("tower_send", params, id);
			return { content: [{ type: "text", text: done.text }], details: done.details };
		},
	});
}

/** What the head's `boss_auto` tells the model (docs/specs/2026-11-09-auto-mode.md, §2; docs/specs/2026-11-21-auto-return.md, AR-D1). */
export const BOSS_AUTO_DESCRIPTION = "Switch auto mode (the boss is away: nothing may wait for them) on or off. Call it only when the boss's own words in the turn you are answering ask for it (for example 我要睡了 to start, 我起床了 to end); the server reads those words itself and refuses anything else, a tower's message or a board line included. Either direction takes effect at once: tell the boss it is on (or off), and that /boss auto off or the GUI switch ends it.";

/** The head's `boss_auto`. The run sends the starter of the turn with the call (the server checks it); the model only says the direction. */
export function registerBossAuto(pi: ExtensionAPI, tool: (name: string, args: unknown, toolCallId?: string) => Promise<{ text: string; details?: unknown }>): void {
	pi.registerTool({
		name: "boss_auto", label: "boss_auto", description: BOSS_AUTO_DESCRIPTION,
		parameters: Type.Object({ on: Type.Boolean({ description: "true: start auto mode; false: end it." }) }),
		execute: async (id, params) => {
			const done = await tool("boss_auto", params, id);
			return { content: [{ type: "text", text: done.text }], details: done.details };
		},
	});
}
