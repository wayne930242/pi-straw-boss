import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Device-wide worker admission (docs/specs/2026-11-24-capacity.md, The cap): the device row is sampled once a minute, so a launch holds its points in a reservation until a row shows its worker.
// One file per reservation in `<state dir>/capacity/_reserved/`, written under a temporary name and renamed, so every main's session on the device reads only whole ones. A reservation goes when
// its tool call failed or its turn ended without a result (`drop`), or `RES_EXPIRE_MS` after it was made. A launched one stops counting for a reader whose row shows its worker under its main
// (sampled after the launch), or whose row is no older than one that did (`seen`); a reader with an older row counts it still. A timestamp alone never retires one.

/** A reservation no device row showed goes after this long (the server stopped, the worker never showed, or it ended between two rows). */
export const RES_EXPIRE_MS = 10 * 60_000;
const FOLDER = "_reserved", ID = /^[0-9a-z-]{8,64}$/;

/** Whose launch it is: the main's session and the worker's name, case- and space-folded (empty for a nameless worker, which no row can show). */
export interface Holder { session: string; worker: string; /** A worker main opened for a teammate's device (docs/specs/2026-11-26-ally-workers.md): its own points, shown once a row lists its session. */ self?: true }
/** `at`: when it was made, then when its launch returned; `launched`: its tool call returned without error; `seen`: the sampling time of the first row that showed its worker. */
export interface Reservation extends Holder { id: string; at: number; points: number; launched: boolean; seen?: number }
export type Reservations = ReturnType<typeof createReservations>;

/** The reservations of the device under the capacity folder `dir` (capacity.ts `capDir`). File errors throw: the caller refuses the launch it cannot hold. */
export function createReservations(dir: string, now: () => number) {
	const folder = join(dir, FOLDER), file = (id: string) => join(folder, `${id}.json`);
	const write = (r: Reservation) => {
		mkdirSync(folder, { recursive: true, mode: 0o700 });
		const temp = `${file(r.id)}.${process.pid}.tmp`;
		try {
			writeFileSync(temp, `${JSON.stringify(r)}\n`, { mode: 0o600 });
			renameSync(temp, file(r.id));
		} catch (error) {
			rmSync(temp, { force: true });
			throw error;
		}
	};
	const read = (id: string): Reservation | undefined => {
		try {
			const r = JSON.parse(readFileSync(file(id), "utf8")) as Partial<Reservation>;
			const time = (v: unknown) => typeof v === "number" && Number.isFinite(v);
			if (!time(r.at) || typeof r.points !== "number" || r.points < 0 || r.points > 10 || typeof r.session !== "string" || typeof r.worker !== "string") return undefined;
			return { id, at: r.at!, points: r.points, session: r.session, worker: r.worker, ...(r.self === true ? { self: true as const } : {}), launched: r.launched === true, ...(time(r.seen) ? { seen: r.seen } : {}) };
		} catch {
			return undefined;
		}
	};
	return {
		/**
		 * The reservations that count against a device row sampled at `rowAt`, whose sampled workers `shows` tells. A launched one that row shows is marked `seen` and not counted; one a row no
		 * older than `rowAt` showed before is not counted either. The expired ones, and files that are not a reservation, are removed.
		 */
		live(rowAt: number, shows: (h: Holder) => boolean): Reservation[] {
			let names: string[] = [];
			try { names = readdirSync(folder).filter((n) => n.endsWith(".json")); } catch { /* none yet */ }
			const t = now();
			return names.flatMap((name): Reservation[] => {
				const id = name.slice(0, -".json".length), r = ID.test(id) ? read(id) : undefined;
				if (!r || t - r.at > RES_EXPIRE_MS) return rmSync(join(folder, name), { force: true }), [];
				if (r.launched && rowAt > r.at && shows(r)) {
					if (r.seen === undefined || rowAt < r.seen) try { write({ ...r, seen: rowAt }); } catch { /* the next reader marks it */ }
					return [];
				}
				return r.seen !== undefined && rowAt >= r.seen ? [] : [r];
			});
		},
		/** A new reservation of `points` for `who`; its id. */
		add(points: number, who: Holder): string {
			const id = `${now().toString(36)}-${process.pid.toString(36)}-${randomBytes(4).toString("hex")}`;
			write({ id, at: now(), points, session: who.session, worker: who.worker, ...(who.self ? { self: true as const } : {}), launched: false });
			return id;
		},
		/** Its launch returned: it counts until a row sampled after now shows the worker. */
		launched(id: string): void {
			const r = read(id);
			if (r) write({ ...r, at: now(), launched: true });
		},
		/** A worker main's open returned with its session: it counts until a row sampled after now lists that session. */
		claim(id: string, session: string): void {
			const r = read(id);
			if (r) write({ ...r, session, at: now(), launched: true });
		},
		drop: (id: string) => void rmSync(file(id), { force: true }),
	};
}
