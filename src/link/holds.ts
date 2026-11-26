import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { safeSession } from "../board.ts";
import { idOk } from "./device.ts";

// The holds this device keeps on teammates' boxes (docs/specs/2026-11-26-device-hold.md, the controller's side): `<link dir>/holds.json`. A hold names the box, the team it is held in, the main of this device that holds it
// (its session id, which never leaves the computer: the board carries its entry id), since when, and until when if the boss set hours. The holder writes it on the boss's `/boss link hold` or an approved `link_request` hold,
// and drops an entry when its main is gone, its hours ran out, the main released it, or the box said it ended there; an ended entry is kept an hour, so the capacity watch tells its main once (server/capops.ts).

export interface Hold { team: string; device: string; session: string; since: number; until?: number }
export type HoldEnd = "released" | "lapsed" | "gone" | "ended-there";
export interface EndedHold extends Hold { at: number; reason: HoldEnd }
export interface HoldsFile { v: 1; holds: Hold[]; ended: EndedHold[] }

export const HOLDS_FILE = "holds.json", HOLDS_MAX = 8, ENDED_KEEP_MS = 3600_000;
const ENDS: readonly string[] = ["released", "lapsed", "gone", "ended-there"];
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 8.64e15 ? v : undefined);
const sessionOk = (v: unknown): v is string => typeof v === "string" && safeSession(v);
const holdOf = (x: Record<string, unknown> | null): Hold | undefined => {
	if (!x || typeof x.team !== "string" || !/^[0-9a-f]{32}$/.test(x.team) || !idOk(x.device) || !sessionOk(x.session) || num(x.since) === undefined) return undefined;
	return { team: x.team, device: x.device, session: x.session, since: x.since as number, ...(num(x.until) !== undefined ? { until: x.until as number } : {}) };
};

/** The file as it stands; anything that does not pass the checks is left out, and a missing or broken file is no holds. */
export function readHolds(dir: string, now: number): HoldsFile {
	let raw: { holds?: unknown; ended?: unknown } = {};
	try { raw = JSON.parse(readFileSync(join(dir, HOLDS_FILE), "utf8")) as typeof raw; } catch { /* none yet */ }
	const list = (v: unknown) => (Array.isArray(v) ? (v as (Record<string, unknown> | null)[]) : []);
	const holds = list(raw.holds).flatMap((x) => holdOf(x) ?? []).slice(0, HOLDS_MAX);
	const ended = list(raw.ended).flatMap((x) => { const h = holdOf(x), at = num(x?.at); return h && at !== undefined && now - at < ENDED_KEEP_MS && ENDS.includes(String(x?.reason)) ? [{ ...h, at, reason: x!.reason as HoldEnd }] : []; });
	return { v: 1, holds, ended };
}
export function writeHolds(dir: string, file: HoldsFile): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const path = join(dir, HOLDS_FILE), temp = `${path}.${process.pid}.tmp`;
	try {
		writeFileSync(temp, `${JSON.stringify(file)}\n`, { mode: 0o600 });
		renameSync(temp, path);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}
/** The file changed by `f` and written when it changed; the new file. */
export function changeHolds(dir: string, now: number, f: (file: HoldsFile) => HoldsFile): HoldsFile {
	const before = readHolds(dir, now), after = f({ ...before, holds: [...before.holds], ended: [...before.ended] });
	if (JSON.stringify(after) !== JSON.stringify(before)) writeHolds(dir, after);
	return after;
}
/** The holds that match `pick` end, for `reason`. */
export const endHolds = (dir: string, now: number, pick: (h: Hold) => boolean, reason: HoldEnd): Hold[] => {
	const gone: Hold[] = [];
	changeHolds(dir, now, (f) => ({ ...f, holds: f.holds.filter((h) => (pick(h) ? (gone.push(h), false) : true)), ended: [...f.ended, ...gone.map((h) => ({ ...h, at: now, reason }))].slice(-HOLDS_MAX * 4) }));
	return gone;
};
/** A hold of `device` set for `session` (one hold per box: a new one replaces this device's earlier hold of it). */
export function setHold(dir: string, now: number, h: Hold): void {
	changeHolds(dir, now, (f) => {
		const holds = [...f.holds.filter((x) => x.device !== h.device), h];
		if (holds.length > HOLDS_MAX) throw new Error(`This device holds ${HOLDS_MAX} boxes already: release one first`);
		return { ...f, holds };
	});
}
/** A rotation: the holds of the main that handed over are its successor's, with their times kept (rotclose.ts). */
export const moveHolds = (dir: string, now: number, from: string, to: string): void => {
	if (sessionOk(to)) changeHolds(dir, now, (f) => ({ ...f, holds: f.holds.map((h) => (h.session === from ? { ...h, session: to } : h)) }));
};
