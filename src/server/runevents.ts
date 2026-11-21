import { fieldsOf } from "../header.ts";
import type { Pane, Session } from "../herdr.ts";
import { nameOf } from "../reach.ts";
import type { Slot } from "./record.ts";
import type { RunWho } from "./rungate.ts";
import { readQueue } from "./towerstore.ts";

// What a tower run took, as its tools read it (towers.ts `runToolFor`): the intercom events of the run's queue that the run took, each checked against the broker and Herdr before it binds anything. The header is the sender's own words
// written by the sender's code, so the server reads fields, never text. Kept out of towers.ts, which carries a line budget.

const phrase = (value: unknown, max: number) => (typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");
export interface RunEventsDeps { slot: Slot; ws: string; who: RunWho; label: string; read(): Promise<{ sessions: Session[]; ps: Pane[] }> }
/** A main's `call_tower` that waits on a teammate device (docs/specs/2026-11-21-box-mac-waits.md §2.1), as its header says. */
export interface WaitEvent { id: string; from: { id: string; name?: string }; short: string; owner: string; what: string }

/** The waits-on events each run forwarded with `waitsOn.event` or answered with a `tower_reply` to its raiser, kept for the run's life (a restart forgets them, and the guard then names the event again). */
const handled = new Map<string, Set<string>>();
export const markHandled = (run: string, event: string) => {
	handled.set(run, (handled.get(run) ?? new Set()).add(event));
	for (const key of handled.keys()) if (handled.size > 200) handled.delete(key); else break;
};
const waitOf = (e: { id: string; from?: { id: string; name?: string }; text: string }): WaitEvent | undefined => {
	const f = fieldsOf(e.text);
	return f?.kind === "call_tower" && f["waits-on"] && f["waits-cancel"] !== "yes" && e.from ? { id: e.id, from: e.from, short: f["waits-on"], owner: f["waits-owner"] ?? "", what: f["waits-what"] ?? "" } : undefined;
};

export function runEvents(d: RunEventsDeps) {
	const taken = () => readQueue(d.slot, d.ws).filter((e) => e.taken?.run === d.who.id && e.kind === "intercom" && e.from);
	/**
	 * The sessions that sent this run a `call_tower` expecting an answer, among the events the run took: the header is the sender's own words, so each is checked against the broker and Herdr's pane token before it binds anything.
	 * An asker may be a main of any workspace on this computer; that is the only way a main outside this workspace becomes a target.
	 */
	const callers = () => new Set(taken().filter((e) => ((f) => f?.kind === "call_tower" && f.reply === "expected")(fieldsOf(e.text))).map((e) => e.from!.id));
	/**
	 * The live main named by id or name that an ask may be made for: a main of this tower's workspace, or a main of another workspace on this computer that called this run (`callers`).
	 * Throws when there is none, several, or it is neither; no other session is a target.
	 */
	const mainOf = async (query: string, byId = false) => {
		const net = await d.read(), named = net.sessions.filter((x) => x.id === query || (!byId && nameOf(x) === query));
		if (named.length !== 1) throw new Error(`${named.length ? "Several sessions are named" : "No live session is named or has the id"} "${query}"`);
		const pane = net.ps.find((p) => p.pane_id === named[0]!.herdrLocation?.paneId);
		if (pane?.tokens?.sb_role !== "main") throw new Error(`${query} is not a main of workspace ${d.label}: an ask for a main names one of its mains, or a main of another workspace that called this tower`);
		if (pane.workspace_id !== d.ws && !callers().has(named[0]!.id)) throw new Error(`${query} is not a main of workspace ${d.label}, and it did not call this tower in this run: an ask for a main of another workspace names one that did`);
		return { id: named[0]!.id, name: phrase(nameOf(named[0]!), 40) };
	};
	return {
		callers,
		mainOf,
		// Who asked this run for the work it sends a device: the one session that sent it a `call_tower` expecting an answer, if it is a live main (of this workspace or another on this computer). A second asker, or one that is no main, leaves it unknown.
		requester: async () => {
			const askers = callers();
			return askers.size === 1 ? mainOf([...askers][0]!, true).catch(() => undefined) : undefined;
		},
		// The `call_tower` events (why=shared) this run took: a car slip is forwarded by naming one, and the code stamps the sender the broker named for it (docs/specs/2026-11-07-train-workers.md §5.5).
		forwardEvent: (id: string) => {
			const event = taken().find((e) => e.id === id), fields = event && fieldsOf(event.text);
			return event && fields?.kind === "call_tower" && fields.why === "shared" ? { id: event.id, from: event.from!.id, text: event.text, at: Date.parse(event.at) } : undefined;
		},
		/** The waits-on `call_tower` this run took, by its id: `tower_send` `waitsOn.event` takes device, owner, what, and the raiser from it, so the model retypes nothing. */
		waitEvent: (id: string): WaitEvent | undefined => ((e) => (e ? waitOf(e) : undefined))(taken().find((e) => e.id === id)),
		/** A `tower_reply` to a raiser answers its waits-on events in this run: the guard lets the run end. */
		replied: (to: string) => taken().flatMap((e) => (e.from?.id === to && waitOf(e) ? [e.id] : [])).forEach((id) => markHandled(d.who.id, id)),
	};
}

/** The `tower_done` guard (§2.1): the first waits-on event the run took that it neither forwarded with `waitsOn.event` nor answered with `tower_reply` to its raiser, read from the recorded header. */
export function unforwardedWait(slot: Slot, ws: string, run: string): WaitEvent | undefined {
	const done = handled.get(run);
	for (const e of readQueue(slot, ws)) {
		if (e.taken?.run !== run || e.kind !== "intercom" || done?.has(e.id)) continue;
		const w = waitOf(e);
		if (w) return w;
	}
	return undefined;
}
