import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Device-wide worker admission (docs/specs/2026-11-24-capacity.md, The cap): the device row is sampled once a minute, so a launch holds its points in a reservation until a row counts its worker.
// One file per reservation in `<state dir>/capacity/_reserved/`, written under a temporary name and renamed, so every main's session on the device reads only whole ones. A reservation stands until
// its tool call failed or its turn ended without a result (`drop`), a device row sampled `RES_MARGIN_MS` after its launch reflects it, or `RES_EXPIRE_MS` after it was made.

const MIN = 60_000;
/** A launched worker shows in the device row this long after its launch at the latest: the server's minute, and the pane's subagent mark. */
export const RES_MARGIN_MS = 2 * MIN;
/** A reservation no device row counted goes after this long (the server stopped, or the worker never showed). */
export const RES_EXPIRE_MS = 10 * MIN;
const FOLDER = "_reserved", ID = /^[0-9a-z-]{8,64}$/;

/** `at`: when it was made, then when its launch returned; `launched`: its tool call returned without error, so a row sampled after it counts the worker. */
export interface Reservation { id: string; at: number; points: number; launched: boolean }
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
			return typeof r.at === "number" && Number.isFinite(r.at) && typeof r.points === "number" && r.points >= 0 && r.points <= 10 ? { id, at: r.at, points: r.points, launched: r.launched === true } : undefined;
		} catch {
			return undefined;
		}
	};
	return {
		/** The reservations that stand against a device row sampled at `rowAt`; the expired and reflected ones, and files that are not a reservation, are removed. */
		live(rowAt: number | undefined): Reservation[] {
			let names: string[] = [];
			try { names = readdirSync(folder).filter((n) => n.endsWith(".json")); } catch { /* none yet */ }
			const t = now();
			return names.flatMap((name): Reservation[] => {
				const id = name.slice(0, -".json".length), r = ID.test(id) ? read(id) : undefined;
				if (r && t - r.at <= RES_EXPIRE_MS && !(r.launched && rowAt !== undefined && rowAt > r.at + RES_MARGIN_MS)) return [r];
				rmSync(join(folder, name), { force: true });
				return [];
			});
		},
		/** A new reservation of `points`; its id. */
		add(points: number): string {
			const id = `${now().toString(36)}-${process.pid.toString(36)}-${randomBytes(4).toString("hex")}`;
			write({ id, at: now(), points, launched: false });
			return id;
		},
		/** Its launch returned: it stands until a row sampled after now counts the worker. */
		launched(id: string): void {
			if (read(id)) write({ ...read(id)!, at: now(), launched: true });
		},
		drop: (id: string) => void rmSync(file(id), { force: true }),
	};
}
