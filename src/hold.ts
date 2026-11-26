import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEVICE_FRESH_MS, writeJson } from "./capacity.ts";

// A device hold as the box keeps it (docs/specs/2026-11-26-device-hold.md): the sb server's capacity watch judges each minute whether a teammate's hold of this box is honoured and writes `<state dir>/capacity/_hold.json`;
// the box's sessions, its link holder (the board's echo), and its views read it, and treat it as fresh for 5 minutes, as the device row. Strings and numbers only; a teammate's label is the roster's.

/** The hold this box honours: the team it is held in, the controller device (id, label, short id), its main (entry id and name), since when, and until when if set. */
export interface HeldBy { team: string; device: string; label: string; short: string; by: string; byName: string; since: number; until?: number }
export interface HoldFile { v: 1; at: number; held?: HeldBy }
const HOLD = "_hold.json";

export const writeHold = (dir: string, f: HoldFile) => writeJson(dir, HOLD, f);
/** The hold the box honours, when the file is under 5 minutes old and names one. */
export function readHold(dir: string, now: number): HeldBy | undefined {
	try {
		const f = JSON.parse(readFileSync(join(dir, HOLD), "utf8")) as Partial<HoldFile>;
		const h = f.held as Partial<HeldBy> | undefined;
		if (f.v !== 1 || typeof f.at !== "number" || now - f.at > DEVICE_FRESH_MS || !h) return undefined;
		return [h.team, h.device, h.label, h.short, h.by, h.byName].every((x) => typeof x === "string") && typeof h.since === "number" ? (h as HeldBy) : undefined;
	} catch { return undefined; }
}
/** How a main or the boss names the holder: `main "work-on" on "mac" (k3f9qa)`. */
export const holderName = (h: Pick<HeldBy, "byName" | "label" | "short">) => `main ${JSON.stringify(h.byName)} on ${JSON.stringify(h.label)} (${h.short})`;
