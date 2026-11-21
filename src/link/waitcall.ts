import { Type, type Static, type TSchema } from "typebox";
import type { Reach } from "../reach.ts";
import { waitOwner, waitWhat } from "./kinds.ts";
import type { Link } from "./runtime.ts";

// `call_tower`, a joined session's call to its tower, with the two parts of a link wait (docs/specs/2026-11-21-box-mac-waits.md): `waitsOn` says the task ends at a step only a teammate device can take, and the tower forwards it as a
// wait the other end must route (§2.1); `linkWait` answers a wait a teammate device has on this workspace (§2.4). The router in the sb server acts first, so a refusal sends nothing. Kept out of tools.ts, which carries a line budget.

type Tool = <P extends TSchema>(name: string, description: string, parameters: P, body: (params: Static<P>) => Promise<{ text: string; details?: unknown }>) => void;
export const CALL_TOWER_DESCRIPTION = "Send a message to the tower of your workspace, or of another workspace by id or exact label. Opens the tower tab when none is running. why: milestone (something landed; reply false unless you need an answer), shared (a heads-up before you change something outside your tab, reply false: go ahead, the tower answers only on a clash), or blocked (you wait on someone outside your tab). Routine progress goes on your work board, not here. The message goes out under a header the code writes (your name, role, and workspace, the recipient, whether you expect a reply, and why). A tower replies through intercom unless you say reply is false.";

export function callTowerTool(tool: Tool, towerCall: boolean, callTower: Reach["callTower"], link: Pick<Link, "waitOp">): void {
	// A main says why it calls (required); a tower's call is a blocked one, so it may leave it out and the header says unspecified.
	const whyType = Type.Union([Type.Literal("milestone"), Type.Literal("shared"), Type.Literal("blocked")], { description: "Why you call: milestone, shared, or blocked. The tower reads it in the header." });
	const whyField = towerCall ? Type.Optional(whyType) : whyType;
	tool("call_tower", CALL_TOWER_DESCRIPTION,
		Type.Object({
			message: Type.String({ description: "What the tower needs to know or do, stated briefly with details by reference. A block the tower forwards or acts on (a car slip, a train: manifest) goes whole and verbatim. With linkWait done or declined: your answer to the teammate device, which leaves this computer as written." }),
			why: whyField,
			workspace: Type.Optional(Type.String({ description: "Another workspace's id or exact label. Omit for your own." })),
			reply: Type.Optional(Type.Boolean({ description: "Whether you wait for the tower's answer. Default true; false for a milestone or a notice." })),
			waitsOn: Type.Optional(Type.Object({
				device: Type.String({ description: "The teammate device that has to act: its label, short id, or id (tower_list shows them)." }),
				owner: Type.Optional(Type.String({ description: "Who there owns the step, at most 40 characters: a main's name as that device's board or tab shows it, or a board entry id b:<16 hex>." })),
				what: Type.Optional(Type.String({ description: "One line, at most 200 bytes: the step you wait on (a merge, a review, a credential, a login)." })),
				cancel: Type.Optional(Type.Boolean({ description: "true (with why milestone): withdraw your open wait to that device; it is told." })),
			}, { description: "With why blocked: your task ends at a step only another device can take. The tower forwards it as a wait that device must route to its owner or its boss. Not for a milestone report." })),
			linkWait: Type.Optional(Type.Object({
				id: Type.String({ description: "The wait's id on this computer (L3), from board_read section waits." }),
				state: Type.Union([Type.Literal("taken"), Type.Literal("done"), Type.Literal("declined")], { description: "taken: you own it now (no card goes to the boss); done or declined: message goes to the device and the wait closes." }),
			}, { description: "Answer a teammate device's wait on this workspace (you were told with kind=link_wait)." })),
			standing: Type.Optional(Type.Object({
				device: Type.String({ description: "The teammate device: its label, short id, or id (tower_list shows them)." }),
				what: Type.Optional(Type.String({ description: "One line, at most 200 bytes: what you ask or tell. Left out, the message's first line." })),
			}, { description: "Instead of your tower: message goes to that device's standing main, as a question with why blocked (its answer comes to you) or a notice with why milestone (nothing comes back). An ally run opened you: only that device." })),
		}),
		async ({ message, why, workspace, reply, waitsOn, linkWait, standing }) => {
			if ([waitsOn, linkWait, standing].filter(Boolean).length > 1) throw new Error("waitsOn, linkWait, and standing do not go together");
			if (standing) {
				// D13: the code sends it as the workspace's tower identity; the tower gets no call for it.
				if (why !== "blocked" && why !== "milestone") throw new Error("standing goes with why blocked (a question) or milestone (a notice)");
				const sent = await link.waitOp({ op: "standing-send", device: standing.device, kind: why === "blocked" ? "question" : "notice", what: standing.what ?? "", message });
				return { text: String(sent.text), details: sent.details };
			}
			if (linkWait) {
				const acted = await link.waitOp({ op: "wait-act", id: linkWait.id, state: linkWait.state, ...(linkWait.state !== "taken" ? { message } : {}) });
				const sent = await callTower(message, workspace, reply ?? false, why, { wait: /^L\d{1,6}$/.test(linkWait.id) ? linkWait.id : undefined });
				return { text: `${String(acted.text)} ${sent.text}`, details: { ...sent.details, linkWait } };
			}
			if (!waitsOn) return callTower(message, workspace, reply ?? true, why);
			if (waitsOn.cancel) {
				if (why !== "milestone") throw new Error("waitsOn cancel goes with why milestone");
				const target = await link.waitOp({ op: "device-resolve", device: waitsOn.device }), withdrawn = await link.waitOp({ op: "wait-cancel", device: waitsOn.device });
				const sent = await callTower(message, workspace, reply ?? false, why, { waitsOn: { short: String(target.short), cancel: true } });
				return { text: `${String(withdrawn.text)} ${sent.text}`, details: sent.details };
			}
			if (why !== "blocked") throw new Error("waitsOn goes with why blocked: you wait on a step only that device can take (a milestone report carries no waitsOn)");
			const what = waitWhat(waitsOn.what ?? "");
			if (!what) throw new Error("waitsOn.what is required: one line saying the step you wait on");
			const target = await link.waitOp({ op: "device-resolve", device: waitsOn.device, raise: true });
			const sent = await callTower(message, workspace, reply ?? true, why, { waitsOn: { short: String(target.short), what, ...(waitsOn.owner ? { owner: waitOwner(waitsOn.owner) } : {}) } });
			return { text: `${sent.text} It waits on ${String(target.label)} (${String(target.short)}): the tower forwards it as a wait that device has to route, and you hear each step.`, details: { ...sent.details, waitsOn: target.short } };
		});
}

/** `ally_escalate` (§3) as an ally run registers it (runmode.ts): a client of the server's `run-tool`, which runs it free at every level. */
export const ALLY_ESCALATE_DESCRIPTION = "Hand one item of your sender's message to this computer's people, free at every level: use it when the message says it waits on someone here, names a local main, says no main here owns the work, or reports an incident that touches work here. The server tells the owner you name (a main from Mains here), else the standing main here, else the boss's list, and tells the device each step; a message that expects no answer becomes a notice for the standing main, with no card. Nothing of the text goes into a session. Once per item, at most 5 per run; then close the message with tower_done.";
export const allyEscalateParameters = () => Type.Object({
	what: Type.Optional(Type.String({ description: "One line, at most 200 bytes: what the device waits on or reports. Left out, a first line [waits on you: …] of the message gives it." })),
	owner: Type.Optional(Type.String({ description: "The local main the message names (its name or board id from Mains here), if it names one." })),
	kind: Type.Optional(Type.Union([Type.Literal("wait"), Type.Literal("incident")], { description: "wait (default): the device waits for an answer; incident: it reports a problem here and expects none." })),
});
