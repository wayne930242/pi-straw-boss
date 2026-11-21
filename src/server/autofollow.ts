import { readRecord, type Slot } from "./record.ts";
import { callControl, type Reply, type Request } from "./socket.ts";
import { type AutoState, isOwn, readAuto, readOwn } from "../autostate.ts";
import { endEvent } from "./autotower.ts";
import { type Change, type AutoMode, readReportFile, type View } from "./automode.ts";

// A secondary Herdr slot's part of auto mode (docs/specs/2026-11-09-auto-mode.md, §1 and §10: one computer, every Herdr slot on it; AMC-F002). Only the primary server writes `auto.json` and holds the record of what it wrote, so a
// secondary server follows the same files: it answers a session's `auto-check` from them, forwards every other `auto-*` request to the primary server's socket, and gives its towers the primary's state, so the brief line, the
// parking of open waits, and the return of the parked cards at the end of the period reach this slot too.

/** What the tower service and the backstop of a secondary server read: the primary's state from the files, and what must reach the primary's records forwarded. */
export type AutoFollower = Pick<AutoMode, "view" | "note" | "decided" | "bossAuto" | "onSwitch" | "check"> & { tick(): void; reply(request: Request): Promise<Reply> | undefined };
export interface FollowDeps {
	/** The primary slot's folder (the state root). */
	dir: string;
	/** The primary server's slot: its record names the socket. */
	primary: Slot;
	log(event: string, facts: Record<string, string | number | boolean | undefined>): void;
	/**
	 * This slot's towers: the waits parked at the switch on are told by the tower service itself; at the end of the period every parked card goes back to whoever raised it and is closed (docs/specs/2026-11-21-auto-return.md,
	 * AR-D3, AR-D4), and the head is told once. The return list is the primary's: this slot's cards are not on it.
	 */
	returnParked?(): { settled: Promise<unknown> } | undefined;
	tellHead?(text: string): void;
	/** A seam for tests: one request to the primary server. */
	call?(request: Request): Promise<Reply>;
}
export const PRIMARY_UNREACHABLE = "the primary sb server of this computer is not running, so auto mode cannot be changed from here";
const FORWARDED = ["auto-state", "auto-on", "auto-off", "auto-confirm", "auto-note", "auto-decided"];

export function createAutoFollower(d: FollowDeps): AutoFollower {
	const listeners = new Set<(change: Change) => void>();
	const off = (since?: string): AutoState => ({ v: 1, rev: 0, hash: "", on: false, by: { via: "pi", name: "server" }, ...(since ? { since } : {}) });
	/** The primary's own state: `auto.json` when it is the primary's own write; nothing otherwise (a foreign or unreadable file is the primary's to put back). */
	const read = (): AutoState | undefined => {
		const seen = readAuto(d.dir), own = readOwn(d.dir);
		if (seen.kind !== "ok" || !own || !isOwn(seen.state, own)) return undefined;
		return seen.state.rev === own.rev ? seen.state : own.state;
	};
	let last: AutoState | undefined = read();
	const call = d.call ?? (async (request: Request): Promise<Reply> => {
		try {
			const record = readRecord(d.primary);
			if (!record) return { ok: false, error: PRIMARY_UNREACHABLE };
			return (await callControl(record.socket, record.secret, request, 10_000)).reply ?? { ok: false, error: PRIMARY_UNREACHABLE };
		} catch {
			return { ok: false, error: PRIMARY_UNREACHABLE };
		}
	});
	const check = (rev: unknown, hash: unknown) => { const own = readOwn(d.dir); return Boolean(own && rev === own.rev && hash === own.hash); };
	const view = (): View => {
		const s = last ?? read() ?? off();
		return { on: s.on, ...(s.since ? { since: s.since } : {}), rev: s.rev, hash: s.hash, by: s.by, foreign: 0 };
	};
	const tick = () => {
		const next = read();
		if (!next || (last && next.rev === last.rev && next.hash === last.hash)) return;
		const from = last ?? off();
		last = next;
		if (next.on === from.on) return;
		try {
			if (!next.on) {
				void d.returnParked?.()?.settled.catch((error: Error) => d.log("auto-return", { text: error.message }));
				const report = readReportFile(d.dir);
				if (report) d.tellHead?.(endEvent(report));
			}
		} catch (error) { d.log("auto-follow", { text: (error as Error).message }); }
		for (const l of listeners) { try { l({ from, to: next }); } catch (error) { d.log("auto-listener", { text: (error as Error).message }); } }
	};
	return {
		view, tick,
		// The primary's own record decides what is its write: this server only compares.
		check,
		note: (raw) => { void call({ cmd: "auto-note", ...raw }); return { ok: true }; },
		decided: (entry) => void call({ cmd: "auto-decided", ...entry }),
		// The boss's words are read against the primary's list of words used: that stays with the primary, which a head tower here cannot reach in one step.
		bossAuto: () => ({ ok: false, error: "auto mode is held by the primary server of this computer: use the page's switch or /boss auto in a session" }),
		onSwitch: (l) => (listeners.add(l), () => void listeners.delete(l)),
		reply: (request) => {
			if (request.cmd === "auto-check") return Promise.resolve({ ok: true, own: check(request.rev, request.hash), on: view().on });
			return FORWARDED.includes(request.cmd) ? call(request) : undefined;
		},
	};
}
