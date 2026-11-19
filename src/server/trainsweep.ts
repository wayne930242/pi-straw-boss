import { lstatSync, rmSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Board, carsDir, expired, readTrainboards, readYard, trainboardDir, type Writer, yardPath } from "../train/board.ts";
import { carFileName } from "../train/cars.ts";
import { carsFolderOk } from "../trainboard.ts";
import { integrationOff } from "../trainswitch.ts";
import { writerAlive } from "./traingate.ts";

// Spec §10: a trainboard outlives its session on purpose, and the server deletes it at last: an ended one 7 days after its last update, a stale one only after `train clear` and the same 7 days (`expired` in train/board.ts decides;
// a live one is never deleted). With the board go the car files its cars name (`<app>-<head12>.json` and its notice file), unless another board or a yard still carries the car. Nothing is guessed: a board that does not read is kept,
// and in a project where a board or the yard does not read, no car file is deleted, because what it carries is unknown.

export interface SweepDeps {
	stateDir: string;
	now?: () => number;
	/** Whether a board's writer is still running (see `writerAlive`). */
	alive?: (writer: Writer) => boolean;
}
export interface Sweep { removed: { project: string; code: string; cars: number }[]; problems: string[] }

/** The heads a board carries: its cars, and the cars its round left out (their files are its too, TB-F004). */
const headsOf = (board: Board): string[] => [...board.cars.map((c) => c.head), ...(board.removed ?? []).flatMap((r) => (r.head ? [r.head] : []))];

const isFolder = (path: string) => { try { return lstatSync(path).isDirectory(); } catch { return false; } };

/** Deletes the expired trainboards under the state folder and their car files. Never throws for a file; what could not be removed is in `problems`. */
export function sweepTrainboards(d: SweepDeps): Sweep {
	const now = (d.now ?? Date.now)(), alive = d.alive ?? ((w: Writer) => writerAlive(w));
	const out: Sweep = { removed: [], problems: [] };
	const { trains, unlisted } = readTrainboards(d.stateDir, { max: Number.MAX_SAFE_INTEGER });
	out.problems.push(...unlisted);
	const gone = trains.flatMap((t) => (t.ok && expired(t.board, { now, alive: alive(t.board.writer), ...(t.end ? { end: t.end } : {}) }) ? [t] : []));
	if (!gone.length) return out;
	// What the boards and yards that stay carry, by project: a car file of one of these is kept; a project with one that does not read is not cleaned of car files at all.
	const goneSet = new Set(gone);
	const carried = new Set<string>(), unsure = new Set<string>();
	for (const t of trains) {
		if (!t.ok) unsure.add(t.project);
		else if (!goneSet.has(t)) for (const head of headsOf(t.board)) carried.add(`${t.project}\n${t.board.app}\n${head}`);
	}
	for (const project of new Set(gone.map((t) => t.project))) {
		const yard = readYard(yardPath(d.stateDir, project));
		if (yard.ok) for (const t of yard.yard.trains) for (const c of t.cars) carried.add(`${project}\n${t.app}\n${c.head}`);
		else if (yard.reason !== "cannot read: ENOENT") unsure.add(project);
	}
	for (const t of gone) {
		if (!t.ok) continue;
		const folder = dirname(t.file);
		if (dirname(dirname(folder)) !== trainboardDir(d.stateDir) || !isFolder(folder)) continue; // a link in its place is not followed
		try {
			rmSync(folder, { recursive: true, force: true });
		} catch (error) {
			out.problems.push(`train ${t.project}/${t.code} was not removed: ${(error as Error).message}`);
			continue;
		}
		let cars = 0;
		if (!unsure.has(t.project) && carsFolderOk(d.stateDir, t.project)) {
			for (const head of new Set(headsOf(t.board))) {
				if (carried.has(`${t.project}\n${t.board.app}\n${head}`)) continue;
				try {
					const name = carFileName(t.board.app, head), file = join(carsDir(d.stateDir, t.project), name);
					for (const path of [file.replace(/\.json$/, ".notice.json"), file]) {
						try { unlinkSync(path); if (path === file) cars++; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
					}
				} catch (error) { out.problems.push(`car file of ${head.slice(0, 12)} in ${t.project} was not removed: ${(error as Error).message}`); }
			}
		}
		out.removed.push({ project: t.project, code: t.code, cars });
	}
	return out;
}

export interface SweepStart extends SweepDeps {
	env: NodeJS.ProcessEnv;
	log: (event: string, facts: Record<string, string | number>) => void;
	/** True while the server is stopping or restarting. */
	skip: () => boolean;
	/** Calls `fn` every `ms` until the returned function is called (an hour; tests give their own). */
	every?: (fn: () => void, ms: number) => () => void;
}
export const SWEEP_MS = 60 * 60_000;

/** Sweeps once now and then every hour, and returns the stop. Nothing is read or deleted with the merge train off; a sweep that fails is logged, not thrown. */
export function startTrainSweep(o: SweepStart): () => void {
	const line = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").slice(0, 300);
	const sweep = () => {
		if (o.skip() || integrationOff(o.env, o.stateDir)) return;
		try {
			const swept = sweepTrainboards({ stateDir: o.stateDir, ...(o.now ? { now: o.now } : {}), ...(o.alive ? { alive: o.alive } : {}) });
			if (swept.removed.length || swept.problems.length) o.log("train-sweep", { removed: swept.removed.length, cars: swept.removed.reduce((n, r) => n + r.cars, 0), ...(swept.problems.length ? { problems: line(swept.problems.slice(0, 3).join("; ")) } : {}) });
		} catch (error) {
			o.log("error", { code: "train-sweep", text: line((error as Error).message) });
		}
	};
	sweep();
	return (o.every ?? ((fn, ms) => ((timer) => (timer.unref(), () => clearInterval(timer)))(setInterval(fn, ms))))(sweep, SWEEP_MS);
}
