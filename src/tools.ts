import { Type, type Static, type TSchema } from "typebox";
import type { Digest } from "./digest.ts";
import type { Membership } from "./membership.ts";
import type { CloseMain } from "./closemain.ts";
import type { Link } from "./link/runtime.ts";
import { opener } from "./opener.ts";
import type { Reach } from "./reach.ts";
import type { Kit } from "./state.ts";

/** The tab label for a name, cut at 16 characters as pi-auto-tab-name cuts it, so that extension takes the label as its own and keeps it. */
export const tabLabel = (name: string): string => Array.from(name).length > 16 ? `${Array.from(name).slice(0, 16).join("").trimEnd()}…` : name;

/** The tools the agent calls: what a joined session has (status, call_tower, broadcast, rename, promote), and the tower's boss_open_main. */
export function createTools({ pi, cfg, s, me, role }: Kit, { post, callTower, status, broadcast, towerList, towerSend, promote, digest, closeMain, link }: Pick<Reach, "post" | "callTower" | "status" | "broadcast" | "towerList" | "towerSend"> & Pick<Membership, "promote"> & { digest: Digest; closeMain: CloseMain; link: Link }) {
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
			tool("call_tower", "Send a message to the tower of your workspace, or of another workspace by id or exact label. Opens the tower tab when none is running. The message goes out under a header the code writes (your name, role, and workspace, the recipient, and whether you expect a reply). A tower replies through intercom unless you say reply is false.",
				Type.Object({
					message: Type.String({ description: "What the tower needs to know or do: at most two sentences, details by reference." }),
					workspace: Type.Optional(Type.String({ description: "Another workspace's id or exact label. Omit for your own." })),
					reply: Type.Optional(Type.Boolean({ description: "Whether you wait for the tower's answer. Default true; false for a notice." })),
				}),
				({ message, workspace, reply }) => callTower(message, workspace, reply ?? true));
			tool("boss_broadcast", "Send one message to every other session in a scope. tab, workspace, and towers reach only sessions that joined the net (towers: each workspace's tower, else its mains, else its members); all reaches every pi session on this machine (for notices such as the boss going to sleep). The message goes out under a header the code writes (your name and role, the scope, every recipient). A tower reaches other towers with tower_send instead.",
				Type.Object({
					message: Type.String({ description: "The message, once; receivers do not re-broadcast it." }),
					scope: Type.Optional(Type.Union([Type.Literal("tab"), Type.Literal("workspace"), Type.Literal("towers"), Type.Literal("all")], { description: "Default workspace." })),
					reply: Type.Optional(Type.Boolean({ description: "Whether you wait for answers. Default false." })),
				}),
				({ message, scope, reply }) => broadcast(message, scope ?? "workspace", reply ?? false));
			const arg = (description: string) => Type.Optional(Type.String({ description }));
			pi.registerTool({
				name: "link_request", label: "link_request",
				description: "Ask for a Straw Link action (teams across computers). It never runs unasked: the boss gets an approval dialog that shows the action, every argument, your reason, and this session, and the action runs only when they approve it (in the GUI, from a paired device, or in the terminal); no answer in 10 minutes refuses it. Actions: create (relay, project; opens the Create team screen, where the boss types the relay's token), invite (team; returns an invite text), invite-unattended (team, device id of the unattended computer), join (text; opens the Join screen with the invite filled in, the boss compares the safety words), trust (device, level reply|forward|dispatch), leave (team), and for an admin remove (team, device), role (team, device, role admin|member), rotate (team). Refused on an unattended device.",
				parameters: Type.Object({
					action: Type.Union(["create", "invite", "invite-unattended", "join", "trust", "leave", "remove", "role", "rotate"].map((a) => Type.Literal(a))),
					args: Type.Optional(Type.Object({
						team: arg("A team's id, an id prefix of 6 or more characters, or its name (the project folder's name)."), relay: arg("The relay's origin, e.g. https://relay.example."), project: arg("An absolute project folder."), share: arg("presence or status."),
						device: arg("A device's id, short id, or label; for invite-unattended its 26-character id."), level: arg("reply, forward, or dispatch."), role: arg("admin or member."), text: arg("The invite text, strawlink1:…"), label: arg("This computer's label in the team."),
					})),
					reason: Type.String({ description: "One line: why you ask. The boss reads it in the dialog." }),
				}),
				execute: async (toolCallId, params, signal, _update, ctx) => {
					const text = await link.request({ action: params.action, args: Object.fromEntries(Object.entries(params.args ?? {}).filter((e): e is [string, string] => typeof e[1] === "string")), reason: params.reason, toolCallId, asker: s.ownName || pi.getSessionName() || me(), ...(ctx.hasUI ? { ui: ctx.ui } : {}), ...(signal ? { signal } : {}) });
					return { content: [{ type: "text", text }], details: { action: params.action } };
				},
			});
			// The session's name is what the net and the GUI show for it. A main agent names its tab too: the tab is its squad, and pi-auto-tab-name
			// leaves a tab alone once anyone else labelled it. A tower keeps its own name.
			if (!s.isTower) tool("boss_rename", "Name this session with a short phrase for the work it is doing now, at most 16 characters (e.g. \"MP-3584 cost mask\", \"重構通知模組\"). The net and the GUI show it, and a main agent's Herdr tab takes it as its label.",
				Type.Object({ name: Type.String({ description: "The phrase: what this session works on now, at most 16 characters so the tab label shows it whole." }) }),
				async ({ name }) => {
					const phrase = name.replace(/\s+/g, " ").trim();
					if (!phrase) throw new Error("The name is empty");
					if (Array.from(phrase).length > 40) throw new Error(`The name has ${Array.from(phrase).length} characters; keep it a short phrase (at most 16 fit the tab)`);
					const was = pi.getSessionName() || s.ownName || me().slice(0, 8);
					pi.setSessionName(phrase);
					const label = tabLabel(phrase);
					const failed = role() !== "main" ? undefined : await cfg.run(["tab", "rename", s.at.tabId, label]).then(() => "", (err: unknown) => String(err)); // "" when relabelled
					const tab = failed === undefined ? "" : failed ? ` The tab kept its label: ${failed}` : ` The tab is now labelled "${label}".`;
					if (s.joined) await digest.note(s.at.workspaceId, `${was} renamed itself "${phrase}" (tab ${failed === "" ? label : s.info.tab})`).catch(() => {});
					return { text: `This session is now named "${phrase}".${tab}`, details: { name: phrase } };
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
			// The request reaches the new main under a header, and names the tower the main reports to as well as the sender.
			const open = opener({ run: cfg.run, sleep: cfg.sleep, workspaceId: s.at.workspaceId, cwd: process.cwd(), sessions: () => s.c.listSessions(), send: (to, message) => post(to, message, "handoff", "main", true), tower: () => ({ id: me(), name: s.ownName || me() }) });
			tool("boss_open_main", "Open a new tab in this workspace with a new pi as its main agent and hand it a request that no session owns. Does not ask the boss and does not take focus. Opens at most one main per request; when it fails, tell the sender. The main reports its outcome to the sender and to you; close it with boss_close_main after its done report.",
				Type.Object({
					request: Type.String({ description: "The sender's request exactly as it reached you, with every boss decision it quotes kept verbatim." }),
					sender: Type.String({ description: "The intercom name or session id of the session that made the request; the new main reports back to it." }),
					label: Type.Optional(Type.String({ description: "A short label for the new tab." })),
				}),
				async (input) => {
					const opened = await open(input);
					const text = opened.repeated ? `A main was already opened for this request (tab ${opened.tab}); nothing new opened.` : `Opened tab ${opened.tab} with a main agent (session ${opened.main}) and handed it the request. It reports to ${opened.sender} and to you.`;
					return { text, details: opened };
				});
		},
		// Tower only. Towers talk to each other with these: who is out there, and one message to one tower or all. Closing is for the mains a tower opened itself.
		addTowerComms() {
			tool("tower_list", "List every workspace's tower: its workspace, whether it is the head tower or you, who a message for it reaches (its tower; in a workspace without one, its mains, else its members), that session's state (idle or working), and what its tabs are working on (each tab's main and members by the names they gave themselves). When Straw Link is set up, `remote` lists the towers of teammates' computers from their last presence: device label and id, whether it is online, the workspace and tower state, and its tabs. Send to one with tower_send and its device.", Type.Object({}), async () => {
				const local = await towerList();
				const remote = await link.remote();
				if (!remote) return local;
				const result = { ...(local.details as object), remote };
				return { text: JSON.stringify(result, null, 2), details: result };
			});
			tool("tower_send", "Send one message to another tower (workspace id or exact label), or to every other tower when workspace is omitted. A workspace without a tower is reached through its mains, else its members, and the result says so. The message goes out under a header the code writes (your name, role, and workspace, every recipient, whether you expect a reply): do not send again to a tower the header of a message you got already names as a recipient. With device (a short id, an id, or a label from tower_list's remote list) the message goes over Straw Link to the tower of that teammate's computer instead: workspace then names one of its workspaces, or is omitted for the one bound to your project; an ambiguous device is an error that lists the candidates.",
				Type.Object({
					message: Type.String({ description: "The message, once: what the other towers need to know or do, details by reference." }),
					workspace: Type.Optional(Type.String({ description: "One workspace's id or exact label. Omit for every other tower. With device: a workspace label on that device." })),
					device: Type.Optional(Type.String({ description: "A teammate's device (short id, id, or label) to send over Straw Link. Omit for towers on this computer." })),
					reply: Type.Optional(Type.Boolean({ description: "Whether you wait for an answer. Default false; true only when you act on it." })),
				}),
				({ message, workspace, device, reply }) => device === undefined ? towerSend(message, workspace, reply ?? false) : link.send({ device, text: message, reply: reply ?? false, ...(workspace !== undefined ? { workspace } : {}) }));
			tool("boss_close_main", "Close a main you opened with boss_open_main: ask it to quit as /boss close would, so its pane and tab close. Only mains opened by a tower in your workspace, never one the boss opened. Refused while it has a running turn, a queued message, an open dialog, a monitor, or a subagent; try again later. Close an opened main after its done report, unless it waits for a boss decision.",
				Type.Object({ main: Type.String({ description: "The opened main's intercom name or session id." }) }),
				async ({ main }) => {
					const closed = await closeMain(main);
					return { text: closed.text, details: closed };
				});
		},
	};
}
export type Tools = ReturnType<typeof createTools>;
