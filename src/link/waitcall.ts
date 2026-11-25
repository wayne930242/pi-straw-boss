import { Type, type Static, type TSchema } from "typebox";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Asked, type BossAsk, bossOf, bossParameter, withBoss } from "../bossask.ts";
import type { Reach } from "../reach.ts";
import { waitOwner, waitWhat } from "./kinds.ts";
import type { Link } from "./runtime.ts";

// `call_tower`, a joined session's call to its tower, with the two parts of a link wait (docs/specs/2026-11-21-box-mac-waits.md): `waitsOn` says the task ends at a step only a teammate device can take, and the tower forwards it as a
// wait the other end must route (§2.1); `linkWait` answers a wait a teammate device has on this workspace (§2.4). The router in the sb server acts first, so a refusal sends nothing. Kept out of tools.ts, which carries a line budget.

/** What a tool body gets besides its parameters: the call's signal and pi's context, for a dialog in the pane. */
export type ToolCtx = Pick<ExtensionContext, "hasUI" | "ui">;
type Tool = <P extends TSchema>(name: string, description: string, parameters: P, body: (params: Static<P>, signal?: AbortSignal, ctx?: ToolCtx, id?: string) => Promise<{ text: string; details?: unknown }>) => void;
export const CALL_TOWER_DESCRIPTION = "Send one message to your workspace's tower, or another by workspace, at three points only: why milestone (something landed; reply false unless needed), shared (a heads-up before you change something outside your tab; reply false; go ahead, the tower answers only on a clash), blocked (you wait on someone outside your tab, or on a decision your authorizations do not cover; the boss's own decision: boss, asked in your pane). Opens the tower when none runs; the code writes the header; it answers through intercom unless reply is false. Progress goes on your board, not here.";

/** `bossAsk` (bossask.ts) draws a `boss` question in a local main's pane; without it (a tower run) the question goes to the tower in the message. */
export function callTowerTool(tool: Tool, towerCall: boolean, callTower: Reach["callTower"], link: Pick<Link, "waitOp">, bossAsk?: BossAsk): void {
	// A main says why it calls (required); a tower's call is a blocked one, so it may leave it out and the header says unspecified.
	const whyType = Type.Union([Type.Literal("milestone"), Type.Literal("shared"), Type.Literal("blocked")], { description: "milestone, shared, or blocked." });
	const whyField = towerCall ? Type.Optional(whyType) : whyType;
	tool("call_tower", CALL_TOWER_DESCRIPTION,
		Type.Object({
			message: Type.String({ description: "Briefly, details by reference. A block the tower forwards (a car slip, a train: manifest) goes whole and verbatim. With linkWait done or declined: your answer to the device, sent as written." }),
			why: whyField,
			workspace: Type.Optional(Type.String({ description: "Another workspace's id or exact label." })),
			reply: Type.Optional(Type.Boolean({ description: "Default true." })),
			waitsOn: Type.Optional(Type.Object({
				device: Type.String({ description: "Label, short id, or id." }),
				owner: Type.Optional(Type.String({ description: "Who there owns the step: a main's name or board id b:<16 hex>; at most 40 characters." })),
				what: Type.Optional(Type.String({ description: "The step you wait on, one line of at most 200 bytes." })),
				cancel: Type.Optional(Type.Boolean({ description: "With why milestone: withdraw your open wait." })),
			}, { description: "With why blocked: your task ends at a step only that teammate device can take; the tower forwards it as a wait." })),
			linkWait: Type.Optional(Type.Object({
				id: Type.String({ description: "L<n> from board_read, section waits." }),
				state: Type.Union([Type.Literal("taken"), Type.Literal("done"), Type.Literal("declined"), Type.Literal("escalated")], { description: "taken: you own it; done/declined: message goes to the device and it closes; escalated (with why blocked): you leave it to the boss." }),
			}, { description: "Answer a teammate device's wait on this workspace (kind=link_wait)." })),
			standing: Type.Optional(Type.Object({
				device: Type.String({ description: "Label, short id, or id." }),
				what: Type.Optional(Type.String({ description: "One line of at most 200 bytes; default the message's first line." })),
			}, { description: "Instead of your tower: that device's standing main, a question (why blocked) or a notice (why milestone)." })),
			boss: bossParameter(),
		}),
		async ({ message, why, workspace, reply, waitsOn, linkWait, standing, boss }, signal, ctx, id) => {
			if ([waitsOn, linkWait, standing, boss].filter(Boolean).length > 1) throw new Error("waitsOn, linkWait, standing, and boss do not go together");
			if (boss) {
				// A decision only the boss can make (bossask.ts): drawn in this pane, its answer the result and nothing sent; else the tower gets it as blocked.
				if (why !== "blocked") throw new Error("boss goes with why blocked: a decision only the boss can make");
				const q = bossOf(boss), asked: Asked = bossAsk ? await bossAsk(q, signal, ctx, id) : { kind: "tower" };
				if (asked.kind !== "tower") return { text: asked.text, details: { boss: asked.kind } };
				const sent = await callTower(withBoss(message, q), workspace, reply ?? true, why);
				return { text: asked.note ? `${sent.text} ${asked.note}` : sent.text, details: { ...sent.details, boss: "tower" } };
			}
			if (standing) {
				// D13: the code sends it as the workspace's tower identity; the tower gets no call for it.
				if (why !== "blocked" && why !== "milestone") throw new Error("standing goes with why blocked (a question) or milestone (a notice)");
				const sent = await link.waitOp({ op: "standing-send", device: standing.device, kind: why === "blocked" ? "question" : "notice", what: standing.what ?? "", message });
				return { text: String(sent.text), details: sent.details };
			}
			if (linkWait) {
				if (linkWait.state === "escalated" && why !== "blocked") throw new Error("linkWait escalated goes with why blocked: you leave the decision to the boss");
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
