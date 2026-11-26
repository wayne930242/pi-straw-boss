import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEVICE_FRESH_MS, SILENT_MS, writeJson } from "./capacity.ts";
import { shortId } from "./link/device.ts";
import type { AllySeen } from "./server/capwatch.ts";

// A device hold as the box keeps it (docs/specs/2026-11-26-device-hold.md): the sb server's capacity watch judges each minute whether a teammate's hold of this box is honoured and writes `<state dir>/capacity/_hold.json`;
// the box's sessions, its link holder (the board's echo), and its views read it, and treat it as fresh for 5 minutes, as the device row. Strings and numbers only; a teammate's label is the roster's.

/** The hold this box honours: the team it is held in, the controller device (id, label, short id), its main (entry id and name), since when, and until when if set. */
export interface HeldBy { team: string; device: string; label: string; short: string; by: string; byName: string; since: number; until?: number }
/** A hold this device has on a teammate's box, as the capacity watch saw it: the main that holds it, whether the box's board echoes it (`honoured`), and how old that board is. */
export interface Holding { device: string; label: string; short: string; main: string; since: number; until?: number; honoured: boolean; boxBoardSecondsAgo?: number }
/** `held`: the hold this box honours; `holds`: the holds this device has on teammates' boxes. */
export interface HoldFile { v: 1; at: number; held?: HeldBy; holds?: Holding[] }
const HOLD = "_hold.json";

export const writeHold = (dir: string, f: HoldFile) => writeJson(dir, HOLD, f);
/** The hold the box honours, when the file is under 5 minutes old (or `any` age) and names one. */
export function readHold(dir: string, now: number, any = false): HeldBy | undefined {
	try {
		const f = JSON.parse(readFileSync(join(dir, HOLD), "utf8")) as Partial<HoldFile>;
		const h = f.held as Partial<HeldBy> | undefined;
		if (f.v !== 1 || typeof f.at !== "number" || (!any && now - f.at > DEVICE_FRESH_MS) || !h) return undefined;
		return [h.team, h.device, h.label, h.short, h.by, h.byName].every((x) => typeof x === "string") && typeof h.since === "number" ? (h as HeldBy) : undefined;
	} catch { return undefined; }
}
/** The hold of the box whose state folder is `stateDir` (its capacity folder is `<state dir>/capacity`). */
export const heldHere = (stateDir: string, now: number) => readHold(join(stateDir, "capacity"), now);
/** How a main or the boss names the holder: `main "work-on" on "mac" (k3f9qa)`. */
export const holderName = (h: Pick<HeldBy, "byName" | "label" | "short">) => `main ${JSON.stringify(h.byName)} on ${JSON.stringify(h.label)} (${h.short})`;

/** Why a hold the box honoured ended, in the words its mains read. */
export type HoldEnd = "released" | "lapsed" | "revoked" | "ended here";
/** A hold the box's boss ended here (`/boss link held end`): that device's hold since that time is not honoured again. */
export interface Ignored { device: string; since: number }
export interface HoldVerdict { held?: HeldBy; /** Teammates that claim this box too and are refused (the first `since` wins, and a hold in force stays). */ contested: { label: string; short: string }[] }

/** Whether a teammate's claim is honoured now: an attended member at `dispatch` in this box's policy, its board at most 30 minutes old by its own clock, its hours not run out, and not ended here. */
function why(a: AllySeen, now: number, ignored: readonly Ignored[]): HoldEnd | undefined {
	const c = a.claim;
	if (!c) return "released";
	if (!c.attended || c.level !== "dispatch") return "revoked";
	if (ignored.some((i) => i.device === a.device && i.since === c.since)) return "ended here";
	if (now - c.ts > SILENT_MS || (c.until !== undefined && c.until <= now)) return "lapsed";
	return undefined;
}
const heldOf = (a: AllySeen): HeldBy => ({ team: a.team!, device: a.device!, label: a.label, short: a.short, by: a.claim!.by, byName: a.mains?.find((m) => m.id === a.claim!.by)?.name ?? "its main", since: a.claim!.since, ...(a.claim!.until !== undefined ? { until: a.claim!.until } : {}) });

/**
 * The box's judge (docs/specs/2026-11-26-device-hold.md, Who may hold): only an unattended box is held; of the teammates whose boards claim it and pass `why`, the hold in force (`was`) stays, else the first `since` wins; the rest
 * are contested. A box in two teams sees one device's claim once, its freshest board's.
 */
export function holdOf(allies: readonly AllySeen[], o: { unattended: boolean; now: number; ignored: readonly Ignored[]; was?: Pick<HeldBy, "device" | "since"> }): HoldVerdict {
	if (!o.unattended) return { contested: [] };
	const fresh = new Map<string, AllySeen>();
	for (const a of allies) if (a.claim && a.device && a.team && !why(a, o.now, o.ignored) && (fresh.get(a.device)?.claim?.ts ?? -1) < a.claim.ts) fresh.set(a.device, a);
	const all = [...fresh.values()].sort((x, y) => x.claim!.since - y.claim!.since), kept = all.find((a) => a.device === o.was?.device && a.claim!.since === o.was!.since) ?? all[0];
	return { ...(kept ? { held: heldOf(kept) } : {}), contested: all.filter((a) => a !== kept).map((a) => ({ label: a.label, short: a.short })) };
}
/** Why the hold of `device` since `since` is no longer honoured: its claim as the allies show it now, and `revoked` when the device is no longer a teammate. */
export function endOf(allies: readonly AllySeen[], h: Pick<HeldBy, "device" | "since">, now: number, ignored: readonly Ignored[]): HoldEnd {
	const seen = allies.filter((a) => a.device === h.device);
	if (!seen.length) return "revoked";
	const same = seen.find((a) => a.claim?.since === h.since);
	return same ? (why(same, now, ignored) ?? "released") : "released";
}
/** A device's short id, for a holder no ally shows any more. */
export const shortOf = (device: string) => shortId(device);

const IGNORED = "_hold-ignored.json", IGNORED_KEEP_MS = 7 * 24 * 3600_000;
/** The holds the box's boss ended here, kept 7 days (a teammate's board names a hold by its `since`, so an ended one never comes back). */
export function readIgnored(dir: string, now: number): (Ignored & { at: number })[] {
	try {
		const list = (JSON.parse(readFileSync(join(dir, IGNORED), "utf8")) as { ignored?: unknown }).ignored;
		return (Array.isArray(list) ? list : []).filter((x): x is Ignored & { at: number } => typeof x?.device === "string" && typeof x.since === "number" && typeof x.at === "number" && now - x.at < IGNORED_KEEP_MS);
	} catch { return []; }
}
export const addIgnored = (dir: string, now: number, i: Ignored) => writeJson(dir, IGNORED, { ignored: [...readIgnored(dir, now), { ...i, at: now }].slice(-50) });

/** This device's holds on teammates' boxes as the capacity watch last saw them, when the file is fresh. */
export function readHolding(dir: string, now: number): Holding[] {
	try {
		const f = JSON.parse(readFileSync(join(dir, HOLD), "utf8")) as Partial<HoldFile>;
		return f.v === 1 && typeof f.at === "number" && now - f.at <= DEVICE_FRESH_MS && Array.isArray(f.holds) ? f.holds.filter((h) => typeof h?.device === "string" && typeof h.label === "string" && typeof h.main === "string" && typeof h.since === "number").slice(0, 8) : [];
	} catch { return []; }
}
const minutesAgo = (ms: number) => Math.max(0, Math.round(ms / 60_000));
/** The view's words for both sides (`/boss board`, the head page's fold): `held by main "work-on" on "mac" (k3f9qa) since 12 min`, `holds "box 2" (k3f9qa) · work-on · honoured`. */
export function holdLines(dir: string, now: number): string[] {
	const h = readHold(dir, now);
	return [...(h ? [`held by ${holderName(h)} since ${minutesAgo(now - h.since)} min`] : []), ...readHolding(dir, now).map((x) => `holds ${JSON.stringify(x.label)} (${x.short}) · ${x.main} · ${x.honoured ? "honoured" : "not honoured (its policy level or build, or its board has not echoed it yet)"}`)];
}
/** `board_read`'s sections (docs/specs/2026-11-26-device-hold.md, Box views and Controller): `held` on a held box, `holds` on a device that holds one. */
export function holdSections(dir: string, now: number): { held?: { device: string; label: string; short: string; main: string; sinceSecondsAgo: number }; holds?: (Omit<Holding, "since" | "until"> & { sinceSecondsAgo: number; untilSeconds?: number })[] } {
	const h = readHold(dir, now), mine = readHolding(dir, now), secs = (ms: number) => Math.max(0, Math.round(ms / 1000));
	return {
		...(h ? { held: { device: h.device, label: h.label, short: h.short, main: h.byName, sinceSecondsAgo: secs(now - h.since) } } : {}),
		...(mine.length ? { holds: mine.map(({ since, until, ...x }) => ({ ...x, sinceSecondsAgo: secs(now - since), ...(until !== undefined ? { untilSeconds: secs(until - now) } : {}) })) } : {}),
	};
}
