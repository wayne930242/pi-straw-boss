import { join } from "node:path";
import { capDir, DEFAULT_POINTS, nameKey, readBudget, readDevice } from "./capacity.ts";
import { createReservations, type Holder, type Reservations } from "./capres.ts";
import { dutyOfAgent } from "./duty.ts";
import { todosOf } from "./items.ts";
import { snapshotScan } from "./todo.ts";
import { readRuns, type RunEvents } from "./trackedruns.ts";

// Worker admission (docs/specs/2026-11-24-capacity.md, The cap). sb holds back no worker by count: on an attended device (the boss's own, who watches it) nothing gates a worker, and its
// `capacity.budget` only feeds the board and the capacity notices. On an unattended device the device's points gate `worker` subagents against `capacity.budget`, read from config.json at
// each admission (a change applies at once; none set: no cap, and no built-in figure). Scouts, planners, reviewers, and resumes are not workers and are never held.

/** The device's capacity as the sb server last wrote it (capacity.ts `readDevice`): points in use, when the row was sampled, and the mains it sampled with their running workers. */
export interface Room { points: number; at?: number; mains?: readonly { session: string; workers?: readonly string[] }[] }
/** What the cap reads of the device: its fresh row, the reservations every main of it shares (capres.ts), this main's session id, the budget now, and whether a person is at it. */
export interface DeviceSide { room(): Room | undefined; store: Reservations; session(): string | undefined; budget(): number | undefined; attended(): boolean }

// A worker starts while the points in use, the points the device's reservations hold (launches of any main that no row shows yet), and its own fit the budget. Its reservation is written
// before the row and the sum are read, so two mains that launch at once see each other. The server samples only the mains of its own Herdr slot: a main the row does not list (another slot,
// not sampled yet) or any main while no fresh row exists still reserves device-wide, and adds its own running workers from its registry, which no row counts, in place of its own launched reservations.
/** The device row, reservations, and budget of the state folder `stateDir`, for the main whose session id `me` gives; `attended` says whether a person is at the device (the link's policy). */
export const deviceRoom = (stateDir: string, me: () => string | undefined, attended: () => boolean): DeviceSide => {
	const dir = capDir(join(stateDir, "board"));
	return { room: () => readDevice(dir, Date.now()), store: createReservations(dir, Date.now), session: me, budget: () => readBudget(stateDir), attended };
};
/** The row shows a launch: it lists the main's session with a running worker of the launch's (folded) name. */
const shows = (r: Room, h: Holder) => (h.self ? h.session !== "" && (r.mains ?? []).some((m) => m.session === h.session) : h.worker !== "" && (r.mains?.find((m) => m.session === h.session)?.workers ?? []).some((w) => nameKey(w) === h.worker));
const sum = (xs: readonly number[]) => xs.reduce((n, x) => n + x, 0);
const pts = (n: number) => Math.round(n * 100) / 100;

/**
 * The admission both a main's `subagent` call and the box's worker door (server/workerally.ts) run: a reservation of `need` for `who` is written first, then the row and the other reservations are read, and it stays when
 * all of it fits `budget`. For a main absent from that same row, `local` reads its workers instead of counting its launched reservations. Throws when the reservation cannot be written.
 */
export function admitPoints(device: Pick<DeviceSide, "room" | "store">, budget: number, need: number, who: Holder, local?: { workers(): string[] | undefined; weigh(name: string): number }): { id: string } | { refusal: string } {
	const id = device.store.add(need, who);
	try {
		const r = device.room(); // read after the reservation is published
		const unlisted = local && !r?.mains?.some((m) => m.session === who.session), own = unlisted ? local.workers() : undefined;
		if (unlisted && !own) {
			device.store.drop(id);
			return { refusal: "this main is not in the device row and its running workers are unknown" };
		}
		const used = (r?.points ?? 0) + (own ? sum(own.map(local!.weigh)) : 0);
		const held = sum(device.store.live(r?.at ?? -Infinity, (h) => r !== undefined && shows(r, h)).filter((x) => x.id !== id && !(own && !who.self && x.session === who.session && x.launched)).map((x) => x.points));
		if (used + held + need <= budget) return { id };
		device.store.drop(id);
		return { refusal: `the device runs ${pts(used)} of its ${budget} capacity points, ${pts(held)} more held by launches it does not count yet` };
	} catch (error) {
		try { device.store.drop(id); } catch { /* it expires */ }
		throw error;
	}
}

export function createWorkerCap(device?: DeviceSide, events?: RunEvents) {
	/** Worker calls admitted whose tool has not returned yet, each with its reservation's id. */
	const admitted = new Map<string, string>();
	const snapshotOf = snapshotScan();
	/** The `metadata.points` of the main's own open todo whose `owner` is the subagent's `name` (read as capfill.ts reads the list), as the board's headroom weighs a ready todo; 1 without one. */
	const weight = (name: unknown, branch?: () => readonly unknown[]): number => {
		if (typeof name !== "string" || !name.trim() || !branch) return DEFAULT_POINTS;
		let list: readonly unknown[] = [];
		try { list = branch(); } catch { /* a replaced session's context throws: no todo */ }
		const mine = (todosOf(snapshotOf(list)) ?? []).filter((t) => t.status !== "completed" && t.owner !== undefined && nameKey(t.owner) === nameKey(name));
		return (mine.find((t) => t.status === "in_progress") ?? mine[0])?.points ?? DEFAULT_POINTS;
	};
	return {
		/** pi's `tool_call` for `subagent`: on an unattended device with a budget, a refusal when `input.agent` is a worker the device's points leave no room for. `branch`: the main's session entries, for the todo's weight. */
		admit(toolCallId: string, input: unknown, branch?: () => readonly unknown[]): { block: true; reason: string } | undefined {
			const { agent, name } = (input ?? {}) as { agent?: unknown; name?: unknown };
			if (typeof agent !== "string" || dutyOfAgent(agent) !== "worker" || !device || device.attended()) return undefined;
			const budget = device.budget();
			if (budget === undefined) return undefined;
			const me = device.session() ?? "", need = weight(name, branch);
			let got: ReturnType<typeof admitPoints>;
			try {
				got = admitPoints(device, budget, need, { session: me, worker: typeof name === "string" ? nameKey(name) : "" }, {
					workers: () => readRuns(events).runs?.filter((r) => dutyOfAgent(r.agent) === "worker").map((r) => r.name), weigh: (w) => weight(w, branch),
				});
			} catch (error) {
				return { block: true, reason: `sb: the device's capacity reservation could not be written (${(error as Error).message}): no worker starts until it can.` };
			}
			if ("refusal" in got) return { block: true, reason: `sb: ${got.refusal}: this worker needs ${need}. Wait for a result, then dispatch the next; a scout, a planner, or a reviewer may run now.` };
			admitted.set(toolCallId, got.id);
			return undefined;
		},
		/** pi's `tool_result` for `subagent`: the launch ended, and the registry holds the worker if it started. A reservation stays for a launch that returned, and goes for one that failed. */
		ran(toolCallId: string, failed = false): void {
			const id = admitted.get(toolCallId);
			admitted.delete(toolCallId);
			if (id !== undefined && device) try { if (failed) device.store.drop(id); else device.store.launched(id); } catch { /* it expires */ }
		},
		/** The turn ended: every call of it has run, or was blocked by another extension, which leaves no result: its reservation goes. */
		settle(): void {
			for (const id of admitted.values()) if (device) try { device.store.drop(id); } catch { /* it expires */ }
			admitted.clear();
		},
	};
}
