import { join } from "node:path";
import { capDir, DEFAULT_POINTS, nameKey, readDevice } from "./capacity.ts";
import { createReservations, type Holder, type Reservations } from "./capres.ts";
import { dutyOfAgent } from "./duty.ts";
import { todosOf } from "./items.ts";
import { snapshotScan } from "./todo.ts";

// The cap on a session's concurrent workers (docs/specs/2026-11-23-lite-main.md §3): at most 4 `worker` subagents run at once, counted from pi-herdr-agents' registry of the children this process
// launched and is still waiting on (orphan.ts `tracked` reads the same slot), plus the worker calls admitted in the message being prepared: pi prepares every tool call of an assistant message before any
// runs, so the registry holds none of them yet. Scouts, planners, reviewers, and resumes are not workers and are never held. A registry that cannot be read holds nothing back.

export const WORKER_CAP = 4;
const REGISTRY = Symbol.for("pi-subagents/runtime");

/** The workers pi-herdr-agents runs for this process, or undefined when its registry cannot be read. */
function runningWorkers(): number | undefined {
	const map = (globalThis as Record<symbol, { runningSubagents?: unknown } | undefined>)[REGISTRY]?.runningSubagents;
	if (!(map instanceof Map)) return undefined;
	let n = 0;
	for (const run of map.values()) if (dutyOfAgent((run as { agent?: unknown } | null)?.agent as string | undefined) === "worker") n++;
	return n;
}

/** The device's capacity as the sb server last wrote it (capacity.ts `readDevice`): points in use, the budget when one is set, when the row was sampled, and the mains it sampled with their running workers. */
export interface Room { points: number; budget?: number | undefined; at?: number; mains?: readonly { session: string; workers?: readonly string[] }[] }
/** What the cap reads of the device: its row, the reservations every main of it shares (capres.ts), and this main's session id. */
export interface DeviceSide { room(): Room | undefined; store: Reservations; session(): string | undefined }

// With a capacity budget (docs/specs/2026-11-24-capacity.md, The cap) the device's points decide instead of the count of 4: a worker starts while the points in use, the points the device's
// reservations hold (launches of any main that no row shows yet), and its own fit the budget. Its reservation is written before the row and the sum are read, so two mains that launch at once
// see each other. Only a main the row lists takes this path: the server samples the mains of its own Herdr slot, so a main of another slot, or one not sampled yet, keeps the count of 4 and
// holds nothing device-wide. A device row that is missing or stale falls back to the count.
/** The device row and reservations beside the board folder under `guiDir`, for the main whose session id `me` gives. */
export const deviceRoom = (guiDir: string, me: () => string | undefined): DeviceSide => {
	const dir = capDir(join(guiDir, "board"));
	return { room: () => readDevice(dir, Date.now()), store: createReservations(dir, Date.now), session: me };
};
/** The row shows a launch: it lists the main's session with a running worker of the launch's (folded) name. */
const shows = (r: Room, h: Holder) => h.worker !== "" && (r.mains?.find((m) => m.session === h.session)?.workers ?? []).some((w) => nameKey(w) === h.worker);

export function createWorkerCap(cap = WORKER_CAP, device?: DeviceSide) {
	/** Worker calls admitted whose tool has not returned yet: the registry may not hold them. With a budget, each holds a reservation (its id). */
	const admitted = new Map<string, string | undefined>();
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
		/** pi's `tool_call` for `subagent`: a refusal when `input.agent` is a worker and the budget, or `cap` workers already run or are admitted, leave no room. `branch`: the main's session entries, for the todo's weight. */
		admit(toolCallId: string, input: unknown, branch?: () => readonly unknown[]): { block: true; reason: string } | undefined {
			const { agent, name } = (input ?? {}) as { agent?: unknown; name?: unknown };
			if (typeof agent !== "string" || dutyOfAgent(agent) !== "worker") return undefined;
			const me = device?.session(), listed = (r: Room | undefined): r is Room & { budget: number } => r?.budget !== undefined && me !== undefined && (r.mains ?? []).some((m) => m.session === me);
			if (device && listed(device.room())) {
				const need = weight(name, branch);
				let id: string | undefined, r: Room | undefined, held = 0;
				try {
					id = device.store.add(need, { session: me!, worker: typeof name === "string" ? nameKey(name) : "" });
					r = device.room(); // read after the reservation is published
					if (listed(r)) held = device.store.live(r.at ?? -Infinity, (h) => shows(r!, h)).filter((x) => x.id !== id).reduce((n, x) => n + x.points, 0);
				} catch (error) {
					try { if (id !== undefined) device.store.drop(id); } catch { /* it expires */ }
					return { block: true, reason: `sb: the device's capacity reservation could not be written (${(error as Error).message}): no worker starts until it can.` };
				}
				if (!listed(r)) device.store.drop(id); // the row went stale or no longer lists this main: the count of 4 below
				else if (r.points + held + need > r.budget) {
					device.store.drop(id);
					return { block: true, reason: `sb: the device runs ${r.points} of its ${r.budget} capacity points, ${Math.round(held * 100) / 100} more held by launches it does not count yet: this worker needs ${need}. Wait for a result, then dispatch the next; a scout, a planner, or a reviewer may run now.` };
				} else return void admitted.set(toolCallId, id);
			}
			const running = runningWorkers();
			if (running === undefined) return undefined;
			if (running + admitted.size >= cap) return { block: true, reason: `sb: ${cap} workers run for this main already (${running} running, ${admitted.size} starting in this message): wait for a result, then dispatch the next; a scout, a planner, or a reviewer may run now.` };
			admitted.set(toolCallId, undefined);
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
			for (const id of admitted.values()) if (id !== undefined && device) try { device.store.drop(id); } catch { /* it expires */ }
			admitted.clear();
		},
	};
}
