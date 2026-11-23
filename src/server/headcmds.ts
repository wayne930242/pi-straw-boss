import type { Requester } from "../autostate.ts";
import { HEAD_KEY } from "../headkey.ts";
import type { Towers } from "./towers.ts";

// The control commands behind `/boss head` (docs/specs/2026-11-04-head-tower.md, Reaching it): the same functions the head page's routes reach through the tower panel. They are the boss's: a run's token is refused them (rungate.ts).

/** The tower took a message that answers a wait: the memory marks it `answered` (the GUI's composer does the same, headroutes.ts `markAnswered`). The wait's id, or false when the memory no longer has it. */
export async function markWaitAnswered(t: Towers, workspace: string, id: string): Promise<string | false> {
	return (await t.memory(workspace, { op: "answer", id })).status === 200 ? id : false;
}
const NOT_OPEN = "The head tower is not open: its first message opens it.";
/** `head-open` makes the head workspace when there is none and names its tab; `head-event` is the boss's words (a boss event with `present`); `head-leave`, `head-new`, and `head-close` are the conversation's buttons, and `head-retry`, `head-deliver`, and `head-drop` the notices' (with `answers` a `head-event` marks the wait answered once the head took it; with `door` it was written at the head's own pane, as a `tower-event` says of a tower's). */
export async function headCommand(t: Towers, cmd: string, text: string | undefined, extra: { answers?: string; id?: string; requester?: Requester; door?: "pane" | "viewer" | "page" } = {}): Promise<Record<string, unknown>> {
	if (cmd === "head-open") {
		const got = await t.head.ensure();
		return { workspace: got.workspace, tab: got.tab, pane: got.pane, label: got.label, opened: got.opened };
	}
	if (cmd === "head-event") {
		if (!text) throw new Error("head-event needs text");
		const queued = (await t.head.event(text, extra.requester, extra.door)).id;
		return { queued, ...(extra.answers ? { answered: await markWaitAnswered(t, HEAD_KEY, extra.answers) } : {}) };
	}
	if (cmd === "head-close") return { closed: Boolean(await t.head.close()) };
	const workspace = t.head.status()?.workspace;
	if (!workspace) throw new Error(NOT_OPEN);
	if (cmd === "head-retry") return t.runs.retry(workspace), {};
	if (cmd === "head-deliver" || cmd === "head-drop") {
		if (!extra.id) throw new Error(`${cmd} needs an event id`);
		return (cmd === "head-drop" ? t.runs.dropParked(workspace, extra.id) : t.runs.deliverAgain(workspace, extra.id)), {};
	}
	return { ...(cmd === "head-leave" ? await t.runs.leave(workspace) : await t.runs.fresh(workspace)) };
}
