import { capLine, clock, type DeviceCap, joinCaps, type MainFacts, type MainRow, pauseText, purgeCaps, readCaps, readDevice, readSent, roomFor, SILENT_MS, THROTTLE_MS, underFor, writeDevice, writeSent } from "../capacity.ts";

// The capacity watch (docs/specs/2026-11-24-capacity.md): once a minute the sb server, with no model, joins the mains' capacity files with what runs, writes the device row, and raises the flags. A flag
// that is entered is one event to the tower of the main's workspace and to this device's standing main (`under` and `stale` to the main itself too); the same flag of the same main (or ally device) at
// most once per 30 minutes, and nothing when it clears except a quota that resumed. A main still under 30 minutes after its own notice, and an ally still silent 2 hours after its first, is escalated
// once. The reads of the machine and the sending are capops.ts's.

const MIN = 60_000;
/** An ally device as the link holder last heard of it: how old its last board is, whether it is online now, and whether that board had open work. */
/** `timed`: its board carries a capacity row, so it comes at least every 10 minutes and its age counts; an older build's board comes once an hour unchanged, and only its going offline counts. */
export interface AllySeen { key: string; label: string; short: string; online: boolean; boardAgeMs: number; timed: boolean; open: boolean }
export type CapKind = "under" | "under-30m" | "stale" | "quota" | "resumed" | "silent" | "silent-2h";
/** A device still silent this long after its first notice is escalated once, for the boss (`silent-2h`): the 2 hours are sb's, not a tower's or a standing main's own timer. */
export const SILENT_ESCALATE_MS = 2 * 3600_000;
/** The marks of a silence in `_sent.json`, kept while it lasts (not by the 30-minute throttle): when its first notice was told, and when its escalation was. */
const FIRST = "first:", ESCALATED = "escalated:";
/** A main still under capacity this long after its own `under` notice is escalated once per episode (`under-30m`), to its tower and the standing main; its marks are kept as a silence's are. */
export const UNDER_ESCALATE_MS = 30 * MIN;
const UFIRST = "under-first:", UESCALATED = "under-escalated:";
/** One event: `subject` is the main's session (none for an ally device), `workspace` its workspace, `standing` this device's standing main other than the subject, when there is one. */
/** `tag` is part of the flag's identity: a quota's resume time, so a new pause to another time is a new flag, told inside the 30 minutes. */
/** `main`: the subject main's own session, told too for `under` and `stale` (field, box 2 2026-11-24: notices to the standing main and the tower alone started nothing for hours). */
export interface CapEvent { kind: CapKind; key: string; text: string; subject?: string; workspace?: string; standing?: string; main?: string; tag?: string }
export interface CapDeps {
	/** The capacity folder (`<state dir>/capacity`). */
	dir: string;
	now(): number;
	log(event: string, facts: Record<string, string | number | boolean>): void;
	/** `capacity.budget` of config.json; none when unset. */
	budget(): number | undefined;
	load(): { load1: number; cores: number };
	unattended(): boolean;
	/** The live mains and trains; undefined when the net cannot be read (nothing is written then). */
	mains(): Promise<MainFacts[] | undefined>;
	allies(): AllySeen[];
	/** Delivers an event; true when someone took it. */
	tell(e: CapEvent): Promise<boolean>;
}

const q = (name: string) => JSON.stringify(name);
/** The event texts: terse, the main or device named, the flag, the numbers. */
export function capText(kind: CapKind, d: DeviceCap, now: number, row?: MainRow, ally?: AllySeen, since?: number): string {
	switch (kind) {
		case "under": return `capacity under · main ${q(row!.name)} · ${row!.ready} ready (smallest ${row!.minReady} pt) · ${capLine(d, now)} · held ${Math.floor((underFor(d, now) ?? 0) / MIN)} min`;
		case "under-30m": return `capacity under-30m · main ${q(row!.name)} · still under 30 min after its notice at ${clock(since ?? now, now)} · ${row!.ready} ready (smallest ${row!.minReady} pt) · ${capLine(d, now)} · ask it to dispatch or say why`;
		case "stale": return `capacity stale · main ${q(row!.name)} · ${row!.open} open todos · no move for ${d.unattended ? "30" : "120"}+ min · state of the device: ${capLine(d, now)}`;
		case "quota": return `capacity quota · main ${q(row!.name)} · ${pauseText(row!.paused ?? {}, now)}${row!.paused?.detail ? ` · ${row!.paused.detail}` : ""}`;
		case "resumed": return `capacity quota resumed · main ${q(row!.name)}`;
		case "silent": return `capacity device-silent · device ${q(ally!.label)} (${ally!.short}) · last board ${Math.floor(ally!.boardAgeMs / MIN)} min ago · ${ally!.online ? "online" : "offline"} · its last board had open work`;
		case "silent-2h": return `capacity device-silent-2h · device ${q(ally!.label)} (${ally!.short}) · still silent 2 h after the first notice at ${clock(since ?? now, now)} · last board ${Math.floor(ally!.boardAgeMs / MIN)} min ago · ${ally!.online ? "online" : "offline"} · needs the boss`;
	}
}

export function createCapWatch(d: CapDeps) {
	// `untold`: the flags whose last try nobody took, logged once per entry while they are tried again each minute.
	// The hold is read back from a fresh device row, so a restart neither restarts the 10 minutes nor ends an `under-30m` episode.
	let underSince: number | undefined = readDevice(d.dir, d.now())?.under, active = new Set<string>(), untold = new Set<string>(), last: Map<string, MainRow> = new Map(), sent = readSent(d.dir);
	/** Told, or held by the throttle: true. False when nobody took it, so the next look tries again. */
	const markOf = (e: CapEvent) => `${e.kind}:${e.key}${e.tag !== undefined ? `@${e.tag}` : ""}`;
	const send = async (e: CapEvent, now: number): Promise<boolean> => {
		const mark = markOf(e);
		if (now - (sent[mark] ?? -Infinity) < THROTTLE_MS) return d.log("capacity-held", { kind: e.kind, key: e.key }), true;
		const told = await d.tell(e).catch(() => false);
		if (told || !untold.has(mark)) d.log(told ? "capacity-told" : "capacity-untold", { kind: e.kind, key: e.key });
		if (told) (sent[mark] = now, untold.delete(mark));
		else untold.add(mark);
		return told;
	};
	return {
		/** One look: the device row written and returned, and the events of the flags entered since the last look. */
		async tick(): Promise<DeviceCap | undefined> {
			const now = d.now(), facts = await d.mains().catch(() => undefined);
			if (!facts) return undefined;
			purgeCaps(d.dir, new Set(facts.map((m) => m.session)), now);
			const { load1, cores } = d.load(), dev = joinCaps({ mains: facts, caps: readCaps(d.dir), budget: d.budget(), load1, cores, unattended: d.unattended(), now });
			underSince = roomFor(dev) ? (underSince ?? now) : undefined;
			if (underSince !== undefined) dev.under = underSince;
			writeDevice(d.dir, dev);
			const standing = (subject?: string) => dev.mains.find((r) => r.standing && r.session !== subject)?.session;
			const silent = d.allies().filter((a) => a.open && (!a.online || (a.timed && a.boardAgeMs > SILENT_MS))), silentKeys = new Set(silent.map((a) => a.key));
			const ally = (kind: CapKind, a: AllySeen, since?: number): CapEvent => ({ kind, key: a.key, text: capText(kind, dev, now, undefined, a, since), ...(standing() ? { standing: standing()! } : {}) });
			const of = (kind: CapKind, row: MainRow, since?: number): CapEvent => ({
				kind, key: row.session, text: capText(kind, dev, now, row, undefined, since), subject: row.session, workspace: row.workspace, ...(standing(row.session) ? { standing: standing(row.session)! } : {}),
				...(kind === "under" || kind === "stale" ? { main: row.session } : {}),
			});
			const under = underFor(dev, now) !== undefined ? dev.mains.filter((r) => r.minReady !== undefined && dev.points + r.minReady <= dev.budget!) : [], underKeys = new Set(under.map((r) => r.session));
			const flagged: CapEvent[] = [
				...under.map((r) => of("under", r)),
				...dev.mains.filter((r) => r.stale && r.open > 0).map((r) => of("stale", r)),
				...dev.mains.filter((r) => r.paused).map((r) => ({ ...of("quota", r), tag: String(r.paused!.until ?? "") })),
				...silent.map((a) => ally("silent", a)),
			];
			const next = new Set<string>();
			for (const e of flagged) {
				const mark = markOf(e), episode = `episode:${mark}`;
				if (active.has(mark) || (e.kind === "stale" && sent[episode] !== undefined) || (await send(e, now))) {
					next.add(mark);
					if (e.kind === "stale") sent[episode] ??= now;
				}
			}
			// A silence is escalated once, 2 hours after its first notice was told, and routed as that notice; it ends when the device is no longer flagged.
			for (const a of silent) {
				if (next.has(`silent:${a.key}`)) sent[FIRST + a.key] ??= now;
				const first = sent[FIRST + a.key];
				if (first !== undefined && sent[ESCALATED + a.key] === undefined && now - first >= SILENT_ESCALATE_MS && (await send(ally("silent-2h", a, first), now))) sent[ESCALATED + a.key] = now;
			}
			// A main still under 30 minutes after its own notice is escalated once, to its tower and the standing main; the episode ends when the main is no longer under.
			for (const r of under) {
				if (next.has(`under:${r.session}`)) sent[UFIRST + r.session] ??= now;
				const first = sent[UFIRST + r.session];
				if (first !== undefined && sent[UESCALATED + r.session] === undefined && now - first >= UNDER_ESCALATE_MS && (await send(of("under-30m", r, first), now))) sent[UESCALATED + r.session] = now;
			}
			// A quota that cleared while its main still runs is told once: the main is back at work.
			const rows = new Map(dev.mains.map((r) => [r.session, r]));
			for (const mark of active) {
				const kind = mark.slice(0, mark.indexOf(":")), session = mark.slice(mark.indexOf(":") + 1).split("@")[0]!, row = rows.get(session);
				if (kind === "quota" && !flagged.some((e) => e.kind === "quota" && e.key === session) && row && last.has(session)) await send(of("resumed", row), now);
			}
			active = next;
			untold = new Set(flagged.map(markOf).filter((m) => untold.has(m)));
			last = rows;
			const spell = (k: string) => [FIRST, ESCALATED].find((p) => k.startsWith(p)), episode = (k: string) => [UFIRST, UESCALATED].find((p) => k.startsWith(p));
			sent = Object.fromEntries(Object.entries(sent).filter(([k, at]) => (k.startsWith("episode:stale:") ? next.has(k.slice("episode:".length)) : episode(k) ? underKeys.has(k.slice(episode(k)!.length)) : spell(k) ? silentKeys.has(k.slice(spell(k)!.length)) : now - at < THROTTLE_MS)));
			try { writeSent(d.dir, sent); } catch (error) { d.log("capacity-error", { text: (error as Error).message.slice(0, 200) }); }
			return dev;
		},
	};
}
