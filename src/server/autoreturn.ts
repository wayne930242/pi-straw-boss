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
	/** How long a raiser's message may take before it counts as not reached. */
	waitMs?: number;
}

/** One raiser's message: `gone` when it is not live now, else what the broker answered (`failed` past the wait). */
async function tell(reach: Reach, to: string, text: string, wait: string, ms: number): Promise<string> {
	try {
		if (!(await reach.read()).sessions.some((x) => x.id === to)) return "gone";
		let timer: ReturnType<typeof setTimeout> | undefined;
		const cutOff = new Promise<{ status?: string }>((resolve) => { timer = setTimeout(() => resolve({ status: "failed" }), ms); timer.unref?.(); });
		try {
			return deliveryOf((await Promise.race([reach.post(to, text, "wait_returned", "session", false, undefined, undefined, { wait }), cutOff])).status);
		} finally {
			clearTimeout(timer);
		}
	} catch {
		return "failed";
	}
}

/** Closes every parked card and sends each back. `rows` are where each card goes as decided now (the return list is written with them at once); `settled`, the same rows once each raiser's message is known. */
export function returnAll(d: ReturnDeps): { rows: ParkedRow[]; settled: Promise<ParkedRow[]> } {
	const at = d.now(), until = iso(at);
	const back = returnParked(d.slot, at, d.targets, (target, entry) => {
		const from = entry.card?.from;
		if (from) return from.gone || !d.reach(target.workspace) ? "gone" : "raiser";
		return d.notice(target.workspace, ownReturnedText(entry.id, entry.card?.do ?? entry.text, until), `wait-returned:${entry.id}:${until}`) ? "tower" : "gone";
	});
	const rows = backRows(back);
	const settled = Promise.all(back.map(async (b, i): Promise<ParkedRow> => {
		const row = rows[i]!, from = b.entry.card?.from, reach = d.reach(b.target.workspace);
		if (b.to !== "raiser" || !from) return row;
		const status = reach ? await tell(reach, from.id, returnedText(b.entry.id, b.entry.card?.do ?? b.entry.text, until, from.role), b.entry.id, d.waitMs ?? NOTICE_WAIT_MS) : "gone";
		d.log.line("wait-returned", { workspace: b.target.workspace, id: b.entry.id, delivery: status });
		if (status === "delivered" || status === "queued") return row;
		try { closeGone(d.slot, d.now(), b.target.workspace, b.entry.id, status === "gone" ? "was gone" : "could not be reached"); } catch (cause) { d.error("wait-returned", (cause as Error).message); }
		return { ...row, returned: "gone" };
	}));
	return { rows, settled };
}
