import { type Reply, runRoute, type TowerPanel } from "./control.ts";
import { HEAD_KEY, HEAD_NEEDS_SERVICE } from "./headkey.ts";

// The head tower's routes (docs/specs/2026-11-04-head-tower.md, The GUI channel, Posting): the composer of its session key and `POST api/head/<action>` run the tower panel's functions with the head's key, so a paired
// device may do exactly what it may do for a tower (control.ts has checked the origin, the CSRF secret, and the body before it gets here). The panel makes the head workspace when a message finds none.

const no = (status: number, error: string, reason: string): Reply => ({ status, body: { error, reason } });
const STANDING = "The head tower is standing by: no run is live, so there is no terminal. Write to it in the composer; that wakes it.";
const done = (r: { ok: boolean; error?: string }, ok: Reply, refused = "The head tower refused it."): Reply => (r.ok ? ok : no(409, "refused", r.error ?? refused));

/** The wait for the boss a message answers (`answers: "W3"` beside its text): undefined when it names none, a 400 when it is not a wait's id, which is told before anything is sent. */
export function answersOf(json: Record<string, unknown>): string | Reply | undefined {
	const named = json.answers;
	return named === undefined ? undefined : typeof named === "string" && /^W\d+$/.test(named) ? named : no(400, "bad_request", "answers names a wait: W and its number");
}
/**
 * The conversation's two commands, as at a tower's composer: exactly `/quit` leaves it and `/new` starts over; undefined when the text is neither, or the panel has no conversation (it is a message then). Sent with `answers`
 * it is refused (`not_an_answer`): the wait's box is for words to the tower, and a command typed there would change the conversation and read as the answer, which marks nothing.
 */
export async function commandReply(tower: TowerPanel, key: string, typed: string, answers: string | undefined, refused: string): Promise<Reply | undefined> {
	const command = typed.trim() === "/quit" ? "leave" : typed.trim() === "/new" ? "new" : undefined;
	if (!command || !tower.conversation) return undefined;
	if (answers) return no(400, "not_an_answer", "A command is not an answer to a wait; type it in the tower's comms.");
	return done(await tower.conversation(key, command), { status: 200, body: { accepted: true, command } }, refused);
}
/** The tower took a message that answers a wait: the memory marks it `answered`. `answered` is the wait's id, or false when the memory no longer has it (dropped, resolved, or never for the boss): the message went all the same. */
export async function markAnswered(tower: TowerPanel, workspace: string, id: string): Promise<{ answered: string | false }> {
	return { answered: (await tower.memory?.(workspace, { op: "answer", id }))?.status === 200 ? id : false };
}

/**
 * One request on the head: `scope` is `head` (the buttons, `head/<action>`) or `sessions` on the head's key (`sessions/<key>/<action>`). The reply is the route's own, or undefined for a session action the generic route takes
 * from here (the keys, mirror, focus, and commands of a live run's pane). `text` is control.ts's check of a composer's text.
 */
export async function headRoutes(tower: TowerPanel | undefined, [scope, key = "", action = ""]: string[], json: Record<string, unknown>, text: (value: unknown) => string | Reply, far = false, door: "gui" | "phone" | "box" = far ? "phone" : "gui"): Promise<Reply | undefined> {
	if (!tower?.has(HEAD_KEY)) return no(409, "refused", HEAD_NEEDS_SERVICE);
	if (scope === "sessions") {
		if (action === "input") {
			const typed = text(json.text), answers = answersOf(json);
			if (typeof typed !== "string") return typed;
			if (typeof answers === "object") return answers;
			// `@<workspace>` at the head's composer (docs/specs/2026-11-23-f-entry.md §2.4): the page read it and sends `to`; the server never reads `@` out of the text. A paired device may, as it may write to that tower's page.
			if (json.to !== undefined) {
				if (typeof json.to !== "string" || !json.to || json.to.length > 300 || answers) return no(400, "bad_request", "`to` names one workspace, and a direct line answers no wait.");
				if (!tower.direct) return no(409, "refused", "This server takes no direct line.");
				const sent = await tower.direct(json.to, typed, far ? undefined : "page");
				return done(sent, { status: 200, body: { accepted: true, woke: true, to: sent.label ?? json.to } }, "The tower did not take it.");
			}
			const command = await commandReply(tower, HEAD_KEY, typed, answers, "The head tower refused it.");
			if (command) return command;
			const sent = await tower.event(HEAD_KEY, typed, far ? undefined : "page");
			return done(sent, { status: 200, body: { accepted: true, woke: true, ...(answers && sent.ok ? await markAnswered(tower, HEAD_KEY, answers) : {}) } }, "The head tower did not take it.");
		}
		if (action === "dequeue") return no(409, "server_queue", "These messages wait in the sb server's queue for the head tower's next run; they are taken when it runs.");
		return ["keys", "mirror", "focus"].includes(action) && !tower.live(HEAD_KEY) ? no(409, "standing", STANDING) : undefined;
	}
	if (key === "dialog" && !action) return runRoute(tower, HEAD_KEY, "dialog", json, far);
	if (action) return no(404, "not_found", "No such action.");
	if (key === "memory") return tower.memory ? tower.memory(HEAD_KEY, json, door) : no(404, "not_found", "No such action.");
	if (key === "close") return tower.close ? done(await tower.close(HEAD_KEY), { status: 200, body: {} }) : no(404, "not_found", "No such action.");
	if (key === "leave" || key === "new") {
		if (!tower.conversation) return no(404, "not_found", "No such action.");
		const said = await tower.conversation(HEAD_KEY, key);
		return done(said, { status: 200, body: { ...(said.left !== undefined ? { left: said.left } : {}), ...(said.fresh ? { fresh: true } : {}) } });
	}
	if (key !== "retry" && key !== "deliver" && key !== "drop") return no(404, "not_found", "No such action.");
	const id = typeof json.id === "string" && json.id.length <= 64 ? json.id : undefined;
	if (key !== "retry" && !id) return no(400, "bad_request", "Name the parked event.");
	return done(await tower.act(HEAD_KEY, key, id), { status: 200, body: {} });
}
