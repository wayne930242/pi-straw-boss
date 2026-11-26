import type { Stop } from "./allyroute.ts";
import type { RunSignal } from "./runs.ts";

// Ending what a controller started (docs/specs/2026-11-05-link-shared-box.md, section 3). A main an ally run opened for a device has the full rights of a main on peer text, and it outlives the run that opened it. When
// that device leaves the team, or no longer has `dispatch`, the box asks the main to quit, as `boss_close_main` does (the main decides: it refuses while a turn runs, a subagent works, or a dialog is open, and the
// sweep asks again), and tells the team's admins. It acts on a device it has found short of `dispatch` in two sweeps in a row, so one bad read of the policy file or the roster ends nothing. A main opened below `dispatch` (with the boss's Allow for that one call) is not a controller's work and is left alone. An ally run needs none of this: the server
// already ends it when its sender leaves the roster or loses `dispatch` (runs.ts, the watcher's tick).
//
// A second reason: a stop (docs/specs/2026-11-07-link-remote-stop.md, section 5). A row with a `stop` on it, put there by unitstop.ts for a signed request of the dispatcher or a team admin, is asked on the first sweep after it was accepted, whatever
// the device's level is and whether or not the holder can read the roster: a signed stop is no read of the policy. Its notices are the `main-stop` ones (pending once, stopped, manual), which name the requester and the reason and everything else is the machinery above.

/** A main an ally run opened for a device, as the route table keeps it. `level` is the level the run had when it opened the main; a row from before the level was kept counts as `dispatch`. */
export interface OpenedMain { workspace: string; label: string; main: string; name: string; device: string; deviceLabel: string; team: string; level?: string; /** The main's Herdr pane, when the route kept it: a second witness that it is gone. */ pane?: string; /** A stop the box accepted for this main: a second reason to ask it to quit. */ stop?: Stop; /** A worker (docs/specs/2026-11-26-ally-workers.md): ended with `interrupt`, so a working one aborts its turn. */ worker?: true }
export interface RevokerDeps {
	/** The mains ally runs opened that are on record, in every live service. */
	opened(): OpenedMain[];
	/** Whether the link holder can tell who is in `team` and at which level right now (it is running, the team runs, its roster reads): a device is never taken as gone while this is false. */
	known(team: string): boolean;
	/** What this computer gives the device now; nothing when it is no longer a member of the team. */
	standing(device: string, team: string): { level: string } | undefined;
	/** Asks the main to quit like `boss_close_main`; resolves once it accepted, rejects with the reason it did not. `interrupt` is a stop's mode: a main that is working aborts its turn (and answers busy). */
	close(workspace: string, main: string, mode?: "quit" | "interrupt"): Promise<void>;
	/** Whether Herdr no longer lists `pane` (a read that fails, or a row with no pane, is `false`: not confirmed gone). */
	paneGone(workspace: string, pane: string | undefined): Promise<boolean>;
	/** Lets the route go (the main is gone, or has quit). */
	forget(workspace: string, main: string): void;
	/** Tells the admins; resolves `false` when nobody was addressed (no admin is attended at `dispatch`), so the notice is tried again at a later sweep. */
	signal(s: RunSignal): void | boolean | Promise<boolean | undefined | void>;
	log(entry: Record<string, unknown>): void;
	/** What a requester's label is in a stop's notices (the roster's); absent: the device's short id. */
	label?(team: string, device: string): string;
	/** The holder's link.log: a stop that was carried out or ended as gone (`unit-stop-done`: ids and an outcome, never the reason). */
	audit?(entry: Record<string, unknown>): void;
}

/**
 * Why a close may have failed for good: there is nothing there to close (the main is gone, is no main now, or was never a tower's to close). The broker's list misses a main that is reconnecting, and a main can clear its own
 * `sb_opened_by`, so the route goes only on two sweeps in a row with these AND the main's pane absent from Herdr; a main still there is reported to the admins, not forgotten (g346-F002). Anything else is a main that may quit later.
 */
const GONE = /No live session is named|is not in this workspace|is not a main agent|was not opened by a tower/;

export function createRevoker(d: RevokerDeps) {
	/** The notices told, per main and outcome: a main that stays busy is told once. */
	const told = new Set<string>();
	/** The mains found short of `dispatch` at the last sweep. */
	let low = new Set<string>();
	/** The mains whose close was answered "gone" at the last sweeps, and how many sweeps in a row. */
	let goneSeen = new Map<string, number>();
	let running: Promise<void> | undefined, again = false;
	const pass = async (): Promise<void> => {
		const now = new Set<string>(), gone = new Map<string, number>();
		for (const row of d.opened()) {
			const stop = row.stop;
			if (!stop) {
				if (row.level !== undefined && row.level !== "dispatch") continue;
				if (!d.known(row.team)) continue;
				const standing = d.standing(row.device, row.team);
				if (standing?.level === "dispatch") continue;
				now.add(row.main);
				if (!low.has(row.main)) continue;
			}
			const standing = stop ? undefined : d.standing(row.device, row.team);
			const why = stop ? "a stop was asked" : standing ? "the device lost dispatch" : "the device left the team", who = `The main "${row.name}" opened for ${row.deviceLabel}`;
			const by = stop ? (d.label?.(row.team, stop.by) ?? stop.by.slice(0, 6)) : "", because = stop?.reason ? ` Reason: ${stop.reason}` : "";
			try {
				await d.close(row.workspace, row.main, stop?.mode === "interrupt" || row.worker ? "interrupt" : "quit");
			} catch (cause) {
				const reason = (cause as Error).message;
				if (GONE.test(reason)) {
					const seen = (goneSeen.get(row.main) ?? 0) + 1;
					gone.set(row.main, seen);
					if (seen < 2) continue;
					if (await d.paneGone(row.workspace, row.pane)) {
						d.log({ event: "revoke-gone", workspace: row.workspace, main: row.main });
						d.forget(row.workspace, row.main);
						gone.delete(row.main);
						if (stop) {
							d.audit?.({ event: "unit-stop-done", workspace: row.workspace, main: row.main, stopId: stop.stopId, outcome: "gone" });
							d.signal({ kind: "main-stop", workspace: row.workspace, label: row.label, ally: true, device: row.device, ...(row.team ? { team: row.team } : {}), main: row.main, outcome: "stopped", stopId: stop.stopId, text: `${who} is gone (stop asked by ${by}).${because}` });
						}
						continue;
					}
				}
				const manual = /was not opened by a tower/.test(reason), key = `${row.main}/${stop ? "stop-" : ""}${manual ? "manual" : "pending"}`;
				// The broker's miss names the session id, which stays on the box.
				const unlisted = GONE.test(reason) && !manual, shown = unlisted ? "" : reason;
				d.log({ event: "revoke-waiting", workspace: row.workspace, main: row.main, why });
				if (!told.has(key)) {
					const peer = { workspace: row.workspace, label: row.label, ally: true as const, device: row.device, ...(row.team ? { team: row.team } : {}), main: row.main };
					const sent = await d.signal(stop
						? { kind: "main-stop", ...peer, outcome: manual ? "manual" : "pending", stopId: stop.stopId, text: manual ? `${who} was asked to stop by ${by} but still runs and cannot be ended by the box (${shown}). Close it by hand.${because}` : `${who} is being stopped at ${by}'s request (${stop.mode}), ${unlisted ? "and the broker no longer lists it but its pane is still open" : `and it is busy (${shown})`}. The box asks again until it quits.${because}` }
						: { kind: "revoked", ...peer, ended: false, ...(manual ? { manual: true } : {}), text: manual ? `${who} still runs and cannot be ended by the box (${shown}). Close it by hand.` : `${who} could not be ended yet (${unlisted ? "the broker no longer lists it but its pane is still open" : shown}). The box asks again until it quits.` });
					if (sent !== false) {
						told.add(key);
						while (told.size > 256) told.delete(told.values().next().value!);
					}
				}
				continue;
			}
			d.log({ event: "revoke-ended", workspace: row.workspace, main: row.main, why });
			d.forget(row.workspace, row.main);
			const peer = { workspace: row.workspace, label: row.label, ally: true as const, device: row.device, ...(row.team ? { team: row.team } : {}), main: row.main };
			if (stop) {
				d.audit?.({ event: "unit-stop-done", workspace: row.workspace, main: row.main, stopId: stop.stopId });
				d.signal({ kind: "main-stop", ...peer, outcome: "stopped", stopId: stop.stopId, text: `${who} was stopped at ${by}'s request.${because}` });
			} else d.signal({ kind: "revoked", ...peer, ended: true, text: `${who} was ended: ${why}.` });
		}
		low = now;
		goneSeen = gone;
	};
	const loop = async (): Promise<void> => {
		do {
			again = false;
			await pass().catch((cause: Error) => d.log({ event: "revoke-failed", error: cause.message.slice(0, 200) }));
		} while (again);
		running = undefined;
	};
	return {
		/**
		 * One look at every opened main; looks that overlap share the one in flight. With `follow` (a stop was just written) a pass already in flight, which read the rows before it, is followed by one more. A failure is logged and the next sweep tries again.
		 */
		sweep: (follow = false): Promise<void> => {
			if (running) {
				if (follow) again = true;
				return running;
			}
			return (running = loop());
		},
	};
}
