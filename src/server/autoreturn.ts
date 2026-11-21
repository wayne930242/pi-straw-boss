import type { Reach } from "../reach.ts";
import type { Log } from "./log.ts";
import type { Slot } from "./record.ts";
import { backRows, closeGone, ownReturnedText, type ParkedRow, returnedText, returnParked, type Target } from "./autotower.ts";
import { iso } from "./towermemory.ts";
import { deliveryOf, NOTICE_WAIT_MS } from "./waitpress.ts";

// The end of an auto mode period for the towers (docs/specs/2026-11-21-auto-return.md, AR-D3, AR-D4; boss 2026-11-21: 「auto off 以後就直接發回原 agent 請他們再問、再要求一次」). Every parked card that still waits is closed at once
// and goes back to whoever raised it, so the tower never relays it: a session's card as one `wait_returned` message from the tower's identity, by the raiser's session id (never by name, as a press's notice); a tower's own
// card (and the head's own) as that tower's event. A raiser that left, a message the broker did not take, or a tower the server no longer serves closes the card as `gone`, with nothing left for the boss.

export interface ReturnDeps {
	slot: Slot;
	now(): number;
	log: Log;
	error(code: string, text: string): void;
	/** The towers and the head whose memory holds the cards. */
	targets: Target[];
	/** The identity a tower's messages go out as; absent when the server no longer serves that tower. */
	reach(workspace: string): Reach | undefined;
	/** A notice event for a tower's next run (runs.ts `notice`): false when the server serves no tower there. */
	notice(workspace: string, text: string, key: string): boolean;
	/** The head's workspace when `id` is the head tower this server serves: a card it raised goes back as its event, since its identity takes only a tower's answers (headgate.ts, AR-F003). */
	head?(id: string): string | undefined;
	/** How long a raiser's message may take before it counts as not reached. */
	waitMs?: number;
}

/** One raiser's message: `gone` when it is not live now, else what the broker answered; `failed` past the wait, the read of the net included, so a stop that drains the returns waits `ms` at most (AR-F004). */
async function tell(reach: Reach, to: string, text: string, wait: string, ms: number): Promise<string> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const cutOff = new Promise<string>((resolve) => { timer = setTimeout(() => resolve("failed"), ms); timer.unref?.(); });
	const send = async (): Promise<string> => {
		if (!(await reach.read()).sessions.some((x) => x.id === to)) return "gone";
		return deliveryOf((await reach.post(to, text, "wait_returned", "session", false, undefined, undefined, { wait })).status);
	};
	try {
		return await Promise.race([send(), cutOff]);
	} catch {
		return "failed";
	} finally {
		clearTimeout(timer);
	}
}

/** Closes every parked card and sends each back. `rows` are where each card goes as decided now (the return list is written with them at once); `settled`, the same rows once each raiser's message is known. */
export function returnAll(d: ReturnDeps): { rows: ParkedRow[]; settled: Promise<ParkedRow[]> } {
	const at = d.now(), until = iso(at), toHead = new Set<string>(), keyOf = (target: Target, id: string) => `${target.workspace}:${id}`;
	const back = returnParked(d.slot, at, d.targets, (target, entry) => {
		const from = entry.card?.from, what = entry.card?.do ?? entry.text, head = from && !from.gone ? d.head?.(from.id) : undefined;
		// The head raised it (a `tower_send` the tower recorded a wait for): it is told in its own queue, as a tower that records the wait again or asks as before; the tower's key keeps two towers' W1 apart.
		if (head) return d.notice(head, returnedText(entry.id, what, until, "tower"), `wait-returned:${keyOf(target, entry.id)}:${until}`) ? (toHead.add(keyOf(target, entry.id)), "raiser") : "gone";
		if (from) return from.gone || !d.reach(target.workspace) ? "gone" : "raiser";
		return d.notice(target.workspace, ownReturnedText(entry.id, what, until), `wait-returned:${entry.id}:${until}`) ? "tower" : "gone";
	});
	const rows = backRows(back);
	const settled = Promise.all(back.map(async (b, i): Promise<ParkedRow> => {
		const row = rows[i]!, from = b.entry.card?.from, reach = d.reach(b.target.workspace);
		if (toHead.has(keyOf(b.target, b.entry.id))) d.log.line("wait-returned", { workspace: b.target.workspace, id: b.entry.id, delivery: "head" });
		if (b.to !== "raiser" || !from || toHead.has(keyOf(b.target, b.entry.id))) return row;
		const status = reach ? await tell(reach, from.id, returnedText(b.entry.id, b.entry.card?.do ?? b.entry.text, until, from.role), b.entry.id, d.waitMs ?? NOTICE_WAIT_MS) : "gone";
		d.log.line("wait-returned", { workspace: b.target.workspace, id: b.entry.id, delivery: status });
		if (status === "delivered" || status === "queued") return row;
		try { closeGone(d.slot, d.now(), b.target.workspace, b.entry.id, status === "gone" ? "was gone" : "could not be reached"); } catch (cause) { d.error("wait-returned", (cause as Error).message); }
		return { ...row, returned: "gone" };
	}));
	return { rows, settled };
}

/** The end of auto mode as the towers hand it out (towers.ts): each call is `returnAll` over the deps of that moment, and the messages it sends are kept until they settle. */
export interface Returns {
	/** The end of the period (docs/specs/2026-11-21-auto-return.md, AR-D3, AR-D4): every parked card is closed and sent back to whoever raised it; `settled` holds the rows once each raiser's message is known. */
	returnParked(): { rows: ParkedRow[]; settled: Promise<ParkedRow[]> };
	/**
	 * Done when every return under way has settled (each is bounded by its wait). A stop or restart waits for it before the towers leave the broker (main.ts `shutdown`, AR-F004): the cards are closed as `raiser` in the
	 * switch's own write, so a message cut off by the stop would leave a raiser who was never told. A crash still loses it: the message goes at most once, never twice.
	 */
	returning(): Promise<void>;
}
export function returner(deps: () => ReturnDeps): Returns {
	const inFlight = new Set<Promise<unknown>>();
	return {
		returnParked: () => {
			const back = returnAll(deps()), held = back.settled.catch(() => {}).finally(() => inFlight.delete(held));
			inFlight.add(held);
			return back;
		},
		returning: async () => void (await Promise.all([...inFlight])),
	};
}
