import { join } from "node:path";
import { capDir, readBudget, readDevice } from "../capacity.ts";
import { createReservations } from "../capres.ts";
import { readHold } from "../hold.ts";
import { type Opened, type OpenRequest, OpenLimitError, type PeerSender } from "../opener.ts";
import { admitPoints } from "../workercap.ts";
import type { Slip } from "../workerslip.ts";
import { modelRefusal, dropWorktree, type Git, prepareWorktree, readWorkers } from "./workeropen.ts";
import { bookOfAsk, putBook } from "./workerbook.ts";

// The box's door for a worker (docs/specs/2026-11-26-ally-workers.md, Device side): an ally run at `dispatch` calls `boss_open_main` `role: "worker"` on a `worker:` slip its device sent (runtools.ts reads it from the run's
// messages); this checks the config, the model, the route cap, and the capacity budget, makes the worktree, opens the worker's tab (opener.ts), and writes its route. Every refusal or failure answers the slip's ask by code
// with the reason, so the controller main hears it whatever the ally run does next. One open at a time per state folder, so two slips cannot both pass the budget.

/** What a worker open carries past the opener's own fields (runtools.ts sets it from the run's taken messages, never from the model's arguments). */
export interface WorkerSlip { spec: Slip; ask?: string }
export interface WorkerDoor {
	stateDir: string;
	home: string;
	now(): number;
	/** The workspace's checkout. */
	checkout(): Promise<string>;
	/** The project the run's team binds on this computer: the checkout must be inside it. */
	within?: string;
	/** Whether `dir` is inside `root` (link/routing.ts `inside`). */
	inside(dir: string, root: string): boolean;
	/** apps.json's integration bases of the checkout: no worker takes them. */
	reserved?(checkout: string): string[];
	/** Why no more mains may open for the device (allyroute.ts `openedRoom`). */
	room(): string | undefined;
	open(request: OpenRequest): Promise<Opened>;
	/** The worker's `opened` route, with its fields; written before the door lets the next open in. */
	route(opened: Opened, worker: NonNullable<import("./allyroute.ts").Route["worker"]>, ask: string | undefined): void;
	/** A `tower-reply` to the slip's ask, by code. */
	reply(ask: string, text: string): Promise<unknown>;
	log(event: string, facts: Record<string, string | number | boolean>): void;
	git?: Git;
	/** The run's team and the workspace, for the book. */
	team?: string;
	workspace?: string;
	/** The session file Herdr names for the worker's pane (its `agent_session`), when it is known yet; the sweep reads it again. */
	fileOf?(pane: string): Promise<string | undefined>;
}

/** A repeat of a slip already opened: its ask has a worker. Thrown before any reply, so the ask stays the worker's. */
export class WorkerRepeat extends Error {}

const turns = new Map<string, Promise<unknown>>();
const turnOf = <T>(key: string, f: () => Promise<T>): Promise<T> => {
	const run = (turns.get(key) ?? Promise.resolve()).then(f, f);
	turns.set(key, run.catch(() => undefined));
	return run;
};

export function openWorker(d: WorkerDoor, peer: PeerSender, request: OpenRequest & { slip: WorkerSlip }): Promise<Opened> {
	const { spec, ask } = request.slip;
	if (spec.resume !== undefined) return turnOf(d.stateDir, () => Promise.reject(new OpenLimitError("this box does not resume workers yet")));
	return turnOf(d.stateDir, async () => {
		let reservation: string | undefined, made: Awaited<ReturnType<typeof prepareWorktree>> | undefined, checkout = "", opened: Opened | undefined;
		const store = createReservations(capDir(join(d.stateDir, "board")), d.now);
		const prior = ask ? bookOfAsk(d.stateDir, d.now(), ask) : undefined;
		if (prior) throw new WorkerRepeat(`A worker was already opened for this slip (session ${prior.main}); its report answers the device's ask, so nothing was opened or sent again`);
		try {
			const config = readWorkers(d.stateDir), budget = readBudget(d.stateDir);
			if (!config) throw new OpenLimitError("this box opens no workers: config.json has no workers section");
			// A held box opens workers for its holder alone (docs/specs/2026-11-26-device-hold.md, D3): its room is that device's. The opener names a peer `link:<device id>`.
			const hold = readHold(capDir(join(d.stateDir, "board")), d.now());
			if (hold && peer.id.replace(/^link:/, "") !== hold.device) throw new OpenLimitError(`held by ${hold.label} (${hold.short}): its capacity is that device's`);
			if (budget === undefined) throw new OpenLimitError("this box opens no workers: config.json sets no capacity.budget");
			const model = modelRefusal(config.models, spec.model);
			if (model) throw new OpenLimitError(model);
			const full = d.room();
			if (full) throw new OpenLimitError(full);
			checkout = await d.checkout();
			if (d.within !== undefined && !d.inside(checkout, d.within)) throw new OpenLimitError("this workspace's checkout is outside the project the team binds on this computer");
			const got = admitPoints({ room: () => readDevice(capDir(join(d.stateDir, "board")), d.now()), store }, budget, spec.points, { session: "", worker: "", self: true });
			if ("refusal" in got) throw new OpenLimitError(`${got.refusal}: this worker needs ${spec.points}`);
			reservation = got.id;
			made = await prepareWorktree({ checkout, spec, home: d.home, ...(d.reserved ? { reserved: d.reserved(checkout) } : {}), ...(d.git ? { git: d.git } : {}) });
			opened = await d.open({ ...request, role: "worker", worker: { dir: made.dir, branch: made.branch, base: made.base, points: spec.points, label: spec.label, ...(spec.model ? { model: spec.model } : {}), ...(made.rework ? { rework: true } : {}) } });
			const file = await d.fileOf?.(opened.pane).catch(() => undefined);
			if (ask) putBook(d.stateDir, d.now(), { ask, main: opened.main, at: d.now(), device: peer.id.replace(/^link:/, ""), ...(d.team ? { team: d.team } : {}), ...(d.workspace ? { workspace: d.workspace } : {}), branch: made.branch, label: spec.label, path: made.dir, base: made.base, baseSha: made.baseSha, points: spec.points, ...(spec.model ? { model: spec.model } : {}), ...(file ? { file } : {}) });
			d.route(opened, { points: spec.points, branch: made.branch, path: made.dir, base: made.base, baseSha: made.baseSha, label: spec.label }, ask);
			try { store.claim(reservation, opened.main); } catch { /* it expires; the row counts the worker */ }
			d.log("worker-opened", { main: opened.main, branch: made.branch, points: spec.points, rework: made.rework === true });
			return opened;
		} catch (error) {
			// After the open returned the worker runs: its worktree, its reservation, and its ask are its own (RV-F004).
			if (opened) return (d.log("worker-route-failed", { main: opened.main, why: (error as Error).message.slice(0, 200) }), opened);
			if (reservation) try { store.drop(reservation); } catch { /* it expires */ }
			if (made) await dropWorktree({ checkout, prepared: made, ...(d.git ? { git: d.git } : {}) });
			const why = (error as Error).message;
			d.log("worker-refused", { branch: spec.branch, why: why.slice(0, 200) });
			if (ask) await d.reply(ask, `The box did not open worker ${spec.label} (branch ${spec.branch}): ${why}`).catch((e: Error) => d.log("worker-refused-reply-failed", { error: e.message.slice(0, 160) }));
			throw error;
		}
	});
}
