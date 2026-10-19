import { Type, type Static, type TSchema } from "typebox";
import type { Membership } from "./membership.ts";
import { opener } from "./opener.ts";
import type { Reach } from "./reach.ts";
import type { Kit } from "./state.ts";

/** The tools the agent calls: what a joined session has (status, call_tower, broadcast, rename, promote), and the tower's boss_open_main. */
export function createTools({ pi, cfg, s, role }: Kit, { send, openTower, status, broadcast, promote }: Pick<Reach, "send" | "openTower" | "status" | "broadcast"> & Pick<Membership, "promote">) {
	const tool = <P extends TSchema>(name: string, description: string, parameters: P, body: (params: Static<P>) => Promise<{ text: string; details?: unknown }>) =>
		pi.registerTool({
			name, label: name, description, parameters,
			execute: async (_id, params) => {
				const { text, details } = await body(params);
				return { content: [{ type: "text", text }], details };
			},
		});
	return {
		addNetTools() {
			tool("boss_status", "Show this workspace's Straw Boss coordinators: each tab's main agent, this workspace's tower, the head tower, and the other towers.", Type.Object({}), async () => {
				const result = await status();
				return { text: JSON.stringify(result, null, 2), details: result };
			});
			tool("call_tower", "Send a message to the tower of your workspace, or of another workspace by id or exact label. Opens the tower tab when none is running; the tower replies through intercom.",
				Type.Object({
					message: Type.String({ description: "What the tower needs to know or do: at most two sentences, details by reference." }),
					workspace: Type.Optional(Type.String({ description: "Another workspace's id or exact label. Omit for your own." })),
				}),
				async ({ message, workspace }) => {
					const tower = await openTower(workspace);
					const result = await send(tower.id, message);
					if (result.status !== "sent") throw new Error(`The tower of ${tower.target.label} did not take the message: ${result.status} ${result.code ?? ""} ${result.detail ?? ""}`.trim());
					const via = tower.routed ? ` (${tower.routed.label} is a sub workspace)` : "";
					const text = `Sent to the tower of ${tower.target.label}${via}${tower.opened ? " (opened it)" : ""}. It replies through intercom.`;
					return { text, details: { workspace: tower.target.workspace_id, towerId: tower.id, opened: tower.opened, status: result.status } };
				});
			tool("boss_broadcast", "Send one message to every other session in a scope. tab, workspace, and towers reach only sessions that joined the net; all reaches every pi session on this machine (for notices such as the boss going to sleep).",
				Type.Object({
					message: Type.String({ description: "The message, once; receivers do not re-broadcast it." }),
					scope: Type.Optional(Type.Union([Type.Literal("tab"), Type.Literal("workspace"), Type.Literal("towers"), Type.Literal("all")], { description: "Default workspace." })),
				}),
				({ message, scope }) => broadcast(message, scope ?? "workspace"));
			// The session's name is what the net, the GUI, and (through pi-auto-tab-name) the Herdr tab show for it. A tower keeps its own.
			if (!s.isTower) tool("boss_rename", "Name this session with a short phrase for the work it is doing now, at most 16 characters (e.g. \"MP-3584 cost mask\", \"重構通知模組\"). The net and the GUI show it, and pi-auto-tab-name renames the Herdr tab after it.",
				Type.Object({ name: Type.String({ description: "The phrase: what this session works on now, at most 16 characters so the tab label shows it whole." }) }),
				async ({ name }) => {
					const phrase = name.replace(/\s+/g, " ").trim();
					if (!phrase) throw new Error("The name is empty");
					if (Array.from(phrase).length > 40) throw new Error(`The name has ${Array.from(phrase).length} characters; keep it a short phrase (at most 16 fit the tab)`);
					pi.setSessionName(phrase);
					return { text: `This session is now named "${phrase}".`, details: { name: phrase } };
				});
		},
		addPromote() {
			tool("boss_promote", "Become the main agent of this Herdr tab when your work grows: several steps, dispatching workers, or touching more than one app. Refused when the tab already has a main agent.", Type.Object({}), async () => {
				const { promoted, text } = await promote(false);
				if (!promoted) throw new Error(text);
				return { text, details: { role: role() } };
			});
		},
		// Tower only. The tower runs no commands: this is its one way to start work, in a new tab of its own workspace.
		addOpenMain() {
			const open = opener({ run: cfg.run, sleep: cfg.sleep, workspaceId: s.at.workspaceId, cwd: process.cwd(), sessions: () => s.c.listSessions(), send });
			tool("boss_open_main", "Open a new tab in this workspace with a new pi as its main agent and hand it a request that no session owns. Does not ask the boss and does not take focus. Opens at most one main per request; when it fails, tell the sender.",
				Type.Object({
					request: Type.String({ description: "The sender's request exactly as it reached you, with every boss decision it quotes kept verbatim." }),
					sender: Type.String({ description: "The intercom name or session id of the session that made the request; the new main reports back to it." }),
					label: Type.Optional(Type.String({ description: "A short label for the new tab." })),
				}),
				async (input) => {
					const opened = await open(input);
					const text = opened.repeated ? `A main was already opened for this request (tab ${opened.tab}); nothing new opened.` : `Opened tab ${opened.tab} with a main agent (session ${opened.main}) and handed it the request. It reports to ${opened.sender}.`;
					return { text, details: opened };
				});
		},
	};
}
export type Tools = ReturnType<typeof createTools>;
