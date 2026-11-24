import { capLine, type DeviceCap, joinCaps, type MainFacts, type MainRow, pauseText, purgeCaps, readCaps, readSent, roomFor, SILENT_MS, THROTTLE_MS, underFor, writeDevice, writeSent } from "../capacity.ts";

// The capacity watch (docs/specs/2026-11-24-capacity.md): once a minute the sb server, with no model, joins the mains' capacity files with what runs, writes the device row, and raises the flags. A flag
// that is entered is one event to the tower of the main's workspace and to this device's standing main; the same flag of the same main (or ally device) at most once per 30 minutes, and nothing when it
// clears except a quota that resumed. The reads of the machine and the sending are capops.ts's.

const MIN = 60_000;
/** An ally device as the link holder last heard of it: how old its last board is, whether it is online now, and whether that board had open work. */
/** `timed`: its board carries a capacity row, so it comes at least every 10 minutes and its age counts; an older build's board comes once an hour unchanged, and only its going offline counts. */
export interface AllySeen { key: string; label: string; short: string; online: boolean; boardAgeMs: number; timed: boolean; open: boolean }
export type CapKind = "under" | "stale" | "quota" | "resumed" | "silent";
/** One event: `subject` is the main's session (none for an ally device), `workspace` its workspace, `standing` this device's standing main other than the subject, when there is one. */
/** `tag` is part of the flag's identity: a quota's resume time, so a new pause to another time is a new flag, told inside the 30 minutes. */
export interface CapEvent { kind: CapKind; key: string; text: string; subject?: string; workspace?: string; standing?: string; tag?: string }
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
export function capText(kind: CapKind, d: DeviceCap, now: number, row?: MainRow, ally?: AllySeen): string {
	switch (kind) {
		case "under": return `capacity under · main ${q(row!.name)} · ${row!.ready} ready (smallest ${row!.minReady} pt) · ${capLine(d, now)} · held ${Math.floor((underFor(d, now) ?? 0) / MIN)} min`;
		case "stale": return `capacity stale · main ${q(row!.name)} · ${row!.open} open todos · no move for ${d.unattended ? "30" : "120"}+ min · state of the device: ${capLine(d, now)}`;
		case "quota": return `capacity quota · main ${q(row!.name)} · ${pauseText(row!.paused ?? {}, now)}${row!.paused?.detail ? ` · ${row!.paused.detail}` : ""}`;
		case "resumed": return `capacity quota resumed · main ${q(row!.name)}`;
		case "silent": return `capacity device-silent · device ${q(ally!.label)} (${ally!.short}) · last board ${Math.floor(ally!.boardAgeMs / MIN)} min ago · ${ally!.online ? "online" : "offline"} · its last board had open work`;
	}
}

export function createCapWatch(d: CapDeps) {
	// `untold`: the flags whose last try nobody took, logged once per entry while they are tried again each minute.
	let underSince: number | undefined, active = new Set<string>(), untold = new Set<string>(), last: Map<string, MainRow> = new Map(), sent = readSent(d.dir);
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
			const of = (kind: CapKind, row: MainRow): CapEvent => ({ kind, key: row.session, text: capText(kind, dev, now, row), subject: row.session, workspace: row.workspace, ...(standing(row.session) ? { standing: standing(row.session)! } : {}) });
			const flagged: CapEvent[] = [
				...(underFor(dev, now) !== undefined ? dev.mains.filter((r) => r.minReady !== undefined && dev.points + r.minReady <= dev.budget!).map((r) => of("under", r)) : []),
				...dev.mains.filter((r) => r.stale && r.open > 0).map((r) => of("stale", r)),
				...dev.mains.filter((r) => r.paused).map((r) => ({ ...of("quota", r), tag: String(r.paused!.until ?? "") })),
				...d.allies().filter((a) => a.open && (!a.online || (a.timed && a.boardAgeMs > SILENT_MS))).map((a): CapEvent => ({ kind: "silent", key: a.key, text: capText("silent", dev, now, undefined, a), ...(standing() ? { standing: standing()! } : {}) })),
			];
			const next = new Set<string>();
			for (const e of flagged) if (active.has(markOf(e)) || (await send(e, now))) next.add(markOf(e));
			// A quota that cleared while its main still runs is told once: the main is back at work.
			const rows = new Map(dev.mains.map((r) => [r.session, r]));
			for (const mark of active) {
				const kind = mark.slice(0, mark.indexOf(":")), session = mark.slice(mark.indexOf(":") + 1).split("@")[0]!, row = rows.get(session);
				if (kind === "quota" && !flagged.some((e) => e.kind === "quota" && e.key === session) && row && last.has(session)) await send(of("resumed", row), now);
			}
			active = next;
			untold = new Set(flagged.map(markOf).filter((m) => untold.has(m)));
			last = rows;
			sent = Object.fromEntries(Object.entries(sent).filter(([, at]) => now - at < THROTTLE_MS));
			try { writeSent(d.dir, sent); } catch (error) { d.log("capacity-error", { text: (error as Error).message.slice(0, 200) }); }
			return dev;
		},
	};
}
