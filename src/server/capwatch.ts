import { snoozeId } from "../snooze.ts";
import { capLine, clock, DEVICE_FRESH_MS, type DeviceCap, joinCaps, LOAD_SHARE, type MainFacts, type MainRow, pauseText, purgeCaps, readCaps, type SnoozeEnds, readDevice, readSent, roomFor, SILENT_MS, STALE_DEFAULTS, type StaleMs, THROTTLE_MS, UNDER_HOLD_MS, underFor, writeDevice, writeSent } from "../capacity.ts";
import { endOf, type HeldBy, holderName, holdOf, readHold, readIgnored, shortOf, writeHold } from "../hold.ts";
import type { EndedHold, Hold } from "../link/holds.ts";
import { heldRoomText, heldText, holdEndedText, holdEndedThereText, HOLDER_CAP_HINT } from "../moments.ts";

// The capacity watch (docs/specs/2026-11-24-capacity.md): once a minute the sb server, with no model, joins the mains' capacity files with what runs, writes the device row, and raises the flags. A flag
// that is entered is one event to the tower of the main's workspace and to this device's standing main (`under` and `stale` to the main itself too, unless its Herdr pane is working); the same flag of the same main (or ally device) at
// most once per 30 minutes, and nothing when it clears except a quota that resumed. A main still under 30 minutes after its own notice, and an ally still silent 2 hours after its first, is escalated
// once. The reads of the machine and the sending are capops.ts's. A stale episode (docs/specs/2026-11-28-stale-snooze.md) is the main's last move and its open todos: while they stay, it is told again to the main alone each
// interval; a snooze that ended starts a new one, once (r2-F002).

const MIN = 60_000;
/** An ally device as the link holder last heard of it: how old its last board is, whether it is online now, and whether that board had open work. */
/** `timed`: its board carries a capacity row, so it comes at least every 10 minutes and its age counts; an older build's board comes once an hour unchanged, and only its going offline counts. */
/** `mains` and `paused`: the board's entries by id with their main's name, and the paused ones of its capacity row (field 2026-11-25: box 2's mains ran out of Claude quota for 3 hours and this device's standing main heard nothing). */
/** `team`, `device`, `claim`, `echo`, `cap` (docs/specs/2026-11-26-device-hold.md): its team and full id; its board's hold of this device with the facts the box judges it by (the board's `ts`, the roster's attended flag, this device's trust
 *  of it); its echo of the hold this device has on it; its capacity row's numbers. */
export interface AllySeen {
	key: string; label: string; short: string; online: boolean; boardAgeMs: number; timed: boolean; open: boolean; mains?: { id: string; name: string }[]; paused?: { id: string; until?: number }[];
	team?: string; device?: string; claim?: HoldClaim; echo?: { by: string; since: number }; cap?: { points: number; budget?: number; load1: number; cores: number };
}
export interface HoldClaim { by: string; since: number; until?: number; ts: number; attended: boolean; level: string }
export type CapKind = "under" | "under-30m" | "stale" | "quota" | "resumed" | "silent" | "silent-2h" | "held" | "hold-ended" | "held-room";
/** A device still silent this long after its first notice is escalated once, for the boss (`silent-2h`): the 2 hours are sb's, not a tower's or a standing main's own timer. */
export const SILENT_ESCALATE_MS = 2 * 3600_000;
/** The marks of a silence in `_sent.json`, kept while it lasts (not by the 30-minute throttle): when its first notice was told, and when its escalation was. */
const FIRST = "first:", ESCALATED = "escalated:";
/** A main still under capacity this long after its own `under` notice is escalated once per episode (`under-30m`), to its tower and the standing main; its marks are kept as a silence's are. */
export const UNDER_ESCALATE_MS = 30 * MIN;
const UFIRST = "under-first:", UESCALATED = "under-escalated:";
/** The stale reminder's marks in `_sent.json` (docs/specs/2026-11-28-stale-snooze.md): a snooze's first end and its told wake, by `snoozeId`; a main's last notice, its move then, and its open todos then (its episode), kept while it is live or for a day. */
const SNOOZE_END = "snooze-end:", WAKE = "wake:", NOTICE = "notice:", NOTICE_MOVED = "notice-moved:", NOTICE_TODOS = "notice-todos:";
/** One event: `subject` is the main's session (none for an ally device), `workspace` its workspace, `standing` this device's standing main other than the subject, when there is one. */
/** `tag` is part of the flag's identity: a quota's resume time, so a new pause to another time is a new flag, told inside the 30 minutes. */
/** `main`: the subject main's own session, told too for `under` and `stale` (field, box 2 2026-11-24: notices to the standing main and the tower alone started nothing for hours). */
/** Device hold (docs/specs/2026-11-26-device-hold.md): `also`, the coordinator mains told too (a box's `held` and `hold-ended`); `mainOnly`, told to `main` alone (the holder's `held-room` and `hold-ended`); `mainText`, the main's copy
 *  when it is not `text` plus `MAIN_CAP_HINT`; `held`, a `stale` of a held box, whose copies end with the held hints. */
/** `every`: the flag's own throttle in place of the 30 minutes (a stale reminder's interval). */
export interface CapEvent { kind: CapKind; key: string; text: string; subject?: string; workspace?: string; standing?: string; main?: string; tag?: string; also?: string[]; mainOnly?: true; mainText?: string; held?: true; every?: number }
export interface CapDeps {
	/** The capacity folder (`<state dir>/capacity`). */
	dir: string;
	now(): number;
	log(event: string, facts: Record<string, string | number | boolean>): void;
	/** `capacity.budget` of config.json; none when unset. */
	budget(): number | undefined;
	/** `capacity.staleMinutes` and `capacity.staleUnattendedMinutes` of config.json; today's 120 and 30 without it. */
	stale?(): StaleMs;
	load(): { load1: number; cores: number };
	unattended(): boolean;
	/** The live mains and trains; undefined when the net cannot be read (nothing is written then). */
	mains(): Promise<MainFacts[] | undefined>;
	allies(): AllySeen[];
	/** Delivers an event; true when someone took it. */
	tell(e: CapEvent): Promise<boolean>;
	/** This device's own holds of teammates' boxes and the ones that ended within the hour (link/holds.json); none without Straw Link. */
	holds?(): { holds: Hold[]; ended: EndedHold[] };
}
/** The mark in `_sent.json` of a box's hold its mains were told of, kept until they are told it ended (so a restart repeats neither). */
const HOLD_MARK = "hold:", HOLD_MAIN = "holdmain:";
const holdMark = (h: Pick<HeldBy, "device" | "since">) => `${HOLD_MARK}${h.device}@${h.since}`;
const markHold = (k: string) => ((at) => ({ device: k.slice(HOLD_MARK.length, at), since: Number(k.slice(at + 1)) }))(k.lastIndexOf("@"));

const q = (name: string) => JSON.stringify(name);
/** A teammate device's main is named with its device. */
const on = (ally?: AllySeen) => (ally ? ` · device ${q(ally.label)} (${ally.short})` : "");
/** The event texts: terse, the main or device named, the flag, the numbers. */
/** `working`: the main's Herdr pane is working, so the escalation says to ask it nothing (boss 2026-11-26 「herdr state 還在 working 的 agent 不必被詢問」). */
export function capText(kind: CapKind, d: DeviceCap, now: number, row?: MainRow, ally?: AllySeen, since?: number, working?: boolean): string {
	switch (kind) {
		case "under": return `capacity under · main ${q(row!.name)} · ${row!.ready} ready (smallest ${row!.minReady} pt) · ${capLine(d, now)} · held ${Math.floor((underFor(d, now) ?? 0) / MIN)} min`;
		case "under-30m": return `capacity under-30m · main ${q(row!.name)} · still under 30 min after its notice at ${clock(since ?? now, now)} · ${row!.ready} ready (smallest ${row!.minReady} pt) · ${capLine(d, now)} · ${working ? "its pane is working now: ask it nothing" : "ask it to dispatch or say why"}`;
		case "stale": return `capacity stale · main ${q(row!.name)} · ${row!.woke ? `its snooze ended at ${clock(row!.woke.at, now)} (${q(row!.woke.why)}) · ` : ""}${todosText(row!)} · no move for ${row!.moved !== undefined ? Math.floor((now - row!.moved) / MIN) : d.unattended ? "30+" : "120+"} min · state of the device: ${capLine(d, now)}`;
		case "quota": return `capacity quota · main ${q(row!.name)}${on(ally)} · ${pauseText(row!.paused ?? {}, now)}${row!.paused?.detail ? ` · ${row!.paused.detail}` : ""}`;
		case "resumed": return `capacity quota resumed · main ${q(row!.name)}${on(ally)}`;
		case "silent": return `capacity device-silent · device ${q(ally!.label)} (${ally!.short}) · last board ${Math.floor(ally!.boardAgeMs / MIN)} min ago · ${ally!.online ? "online" : "offline"} · its last board had open work`;
		case "silent-2h": return `capacity device-silent-2h · device ${q(ally!.label)} (${ally!.short}) · still silent 2 h after the first notice at ${clock(since ?? now, now)} · last board ${Math.floor(ally!.boardAgeMs / MIN)} min ago · ${ally!.online ? "online" : "offline"} · needs the boss`;
		default: return kind; // the hold's events carry their own words (moments.ts)
	}
}

/** A stale main's unanswered todos, three by id and subject (docs/specs/2026-11-28-stale-snooze.md); a main of an older build lists none, and its count says it. */
function todosText(r: MainRow): string {
	const t = r.todos, n = r.unanswered ?? t?.length ?? 0;
	if (!t) return `${r.open} open todos`;
	return `${n} open todo${n === 1 ? "" : "s"} unanswered: ${t.slice(0, 3).map((x) => `#${x.id} ${q(x.subject.slice(0, 60))}`).join(", ")}${n > 3 ? `, +${n - 3} more` : ""}`;
}

export function createCapWatch(d: CapDeps) {
	// `untold`: the flags whose last try nobody took, logged once per entry while they are tried again each minute.
	// The hold is read back from a fresh device row, so a restart neither restarts the 10 minutes nor ends an `under-30m` episode.
	let underSince: number | undefined = readDevice(d.dir, d.now())?.under, active = new Set<string>(), untold = new Set<string>(), last: Map<string, MainRow> = new Map(), sent = readSent(d.dir);
	/** Since when each box this device holds has had room (`held-room`), by `<team>:<device>`; when each teammate device was last among the allies, and when this watch started (R-F001). */
	const roomSince = new Map<string, number>(), seenAt = new Map<string, number>(), started = d.now();
	/** Told, or held by the throttle: true. False when nobody took it, so the next look tries again. */
	const markOf = (e: CapEvent) => `${e.kind}:${e.key}${e.tag !== undefined ? `@${e.tag}` : ""}`;
	const send = async (e: CapEvent, now: number): Promise<boolean> => {
		const mark = markOf(e);
		if (now - (sent[mark] ?? -Infinity) < (e.every ?? THROTTLE_MS)) return d.log("capacity-held", { kind: e.kind, key: e.key }), true;
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
			// The first end seen of each snooze, by its identity (review F001; docs/specs/2026-11-28-stale-snooze.md).
			const caps = readCaps(d.dir), ends: SnoozeEnds = Object.fromEntries(Object.entries(sent).flatMap(([k, at]) => (k.startsWith(SNOOZE_END) ? [[k.slice(SNOOZE_END.length), at]] : [])));
			const { load1, cores } = d.load(), spans = d.stale?.() ?? STALE_DEFAULTS, dev = joinCaps({ mains: facts, caps, budget: d.budget(), load1, cores, unattended: d.unattended(), now, stale: spans, ends });
			for (const [id, at] of Object.entries(ends)) sent[SNOOZE_END + id] = at;
			const every = dev.unattended ? spans.unattendedMs : spans.attendedMs; // the stale reminder's interval, its repeat, and its throttle
			underSince = roomFor(dev) ? (underSince ?? now) : undefined;
			if (underSince !== undefined) dev.under = underSince;
			writeDevice(d.dir, dev);
			// A main whose Herdr pane is working is not asked (boss 2026-11-26): its own copy of `under` is not sent, and `under-30m` tells its tower and the standing main to ask it nothing.
			const working = new Set(facts.filter((m) => m.paneStatus === "working").map((m) => m.session));
			const standing = (subject?: string) => dev.mains.find((r) => r.standing && r.session !== subject)?.session;
			const allies = d.allies(), silent = allies.filter((a) => a.open && (!a.online || (a.timed && a.boardAgeMs > SILENT_MS))), silentKeys = new Set(silent.map((a) => a.key));
			// Device hold (docs/specs/2026-11-26-device-hold.md): this box's judge and its file first, so a session's next look reads it; the holds this device has, for the ally notices' holding main.
			const marks = Object.keys(sent).filter((k) => k.startsWith(HOLD_MARK)), prev = readHold(d.dir, now, true), ignored = readIgnored(d.dir, now), mine = d.holds?.() ?? { holds: [], ended: [] };
			const was = marks[0] ? markHold(marks[0]) : undefined, verdict = holdOf(allies, { unattended: d.unattended(), now, ignored, ...(was ? { was } : {}) });
			// After a restart the link holder gets its boards back from the relay only later: a holder absent from the allies keeps its hold for 5 minutes since it was last seen, so no false end is told (R-F001).
			for (const a of allies) if (a.device) seenAt.set(a.device, now);
			const unknown = !verdict.held && was !== undefined && prev?.device === was.device && prev.since === was.since && d.unattended() && !allies.some((a) => a.device === was.device) && now - (seenAt.get(was.device) ?? started) < DEVICE_FRESH_MS;
			const held = verdict.held ?? (unknown ? prev : undefined);
			const holding = mine.holds.map((h) => ((a) => ({ device: h.device, label: a?.label ?? shortOf(h.device), short: shortOf(h.device), main: facts.find((m) => m.session === h.session)?.name ?? h.session.slice(0, 8), since: h.since, ...(h.until !== undefined ? { until: h.until } : {}), honoured: a?.echo?.since === h.since, ...(a ? { boxBoardSecondsAgo: Math.round(a.boardAgeMs / 1000) } : {}) }))(allies.find((x) => x.device === h.device && x.team === h.team)));
			writeHold(d.dir, { v: 1, at: now, ...(held ? { held } : {}), ...(holding.length ? { holds: holding } : {}) });
			const holderOf = (a: AllySeen) => mine.holds.find((h) => h.device === a.device && h.team === a.team)?.session;
			const ally = (kind: CapKind, a: AllySeen, since?: number): CapEvent => ((text, main) => ({ kind, key: a.key, text, ...(standing() ? { standing: standing()! } : {}), ...(main && kind === "silent" ? { main, mainText: `${text}${HOLDER_CAP_HINT}` } : {}) }))(capText(kind, dev, now, undefined, a, since), holderOf(a));
			const of = (kind: CapKind, row: MainRow, since?: number): CapEvent => ({
				kind, key: row.session, text: capText(kind, dev, now, row, undefined, since, working.has(row.session)), subject: row.session, workspace: row.workspace, ...(standing(row.session) ? { standing: standing(row.session)! } : {}),
				...((kind === "under" || kind === "stale") && !working.has(row.session) ? { main: row.session } : {}),
			});
			// A teammate device's paused main (its board's capacity row) is told to this device's standing main and the head tower as a local one is, its key the device's and the entry id: not the team's, so a box in two
			// teams is told of once (T4 review F003; `key` is `<team>:<device>`, and an entry id is the device's own).
			const allyRow = (a: AllySeen, id: string, until?: number) => ({ session: `${a.key.slice(a.key.indexOf(":") + 1)}:${id}`, name: a.mains?.find((m) => m.id === id)?.name ?? id, workspace: "", points: 0, ready: 0, open: 0, paused: until !== undefined ? { until } : {} }) as MainRow;
			const allyOf = (kind: CapKind, a: AllySeen, row: MainRow): CapEvent => ((text, main) => ({ kind, key: row.session, text, ...(standing() ? { standing: standing()! } : {}), ...(main && kind === "quota" ? { main, mainText: `${text}${HOLDER_CAP_HINT}` } : {}) }))(capText(kind, dev, now, row, a), holderOf(a));
			const allyPaused = [...new Map(allies.flatMap((a) => (a.paused ?? []).map((p) => ({ a, row: allyRow(a, p.id, p.until) }))).map((x) => [x.row.session, x])).values()];
			// A held box raises no `under` for its own mains: its free room is the holder's, told there as `held-room` (D5).
			const under = !held && underFor(dev, now) !== undefined ? dev.mains.filter((r) => r.minReady !== undefined && dev.points + r.minReady <= dev.budget!) : [], underKeys = new Set(under.map((r) => r.session));
			const flagged: CapEvent[] = [
				...under.map((r) => of("under", r)),
				...dev.mains.filter((r) => r.stale && r.open > 0).map((r): CapEvent => ({ ...of("stale", r), ...(held ? { held: true as const } : {}), every })),
				...dev.mains.filter((r) => r.paused).map((r) => ({ ...of("quota", r), tag: String(r.paused!.until ?? "") })),
				...silent.map((a) => ally("silent", a)),
				...allyPaused.map(({ a, row }) => ({ ...allyOf("quota", a, row), tag: String(row.paused!.until ?? "") })),
				...heldRoom(mine.holds, allies, now, roomSince),
				// The box's boss ended a hold of this device's there: its main is told once (an ended entry lives an hour; the throttle covers half of it, and `active` the rest of one server's life).
				...mine.ended.filter((e) => e.reason === "ended-there" && now - e.at < THROTTLE_MS).map((e): CapEvent => ((a) => ({ kind: "hold-ended", key: `${e.team}:${e.device}@${e.since}`, text: holdEndedThereText(a?.label ?? shortOf(e.device), a?.short ?? shortOf(e.device)), main: e.session, mainOnly: true }))(allies.find((x) => x.device === e.device))),
			];
			const next = new Set<string>();
			/** A main told of its stale episode: when, and its move and open todos then, which are the episode (r2-F002). */
			const noted = (r: MainRow) => void ((sent[NOTICE + r.session] = now), (sent[NOTICE_MOVED + r.session] = r.basis ?? 0), (sent[NOTICE_TODOS + r.session] = r.todosKey ?? 0));
			for (const e of flagged) {
				const mark = markOf(e);
				if (e.kind !== "stale") { if (active.has(mark) || (await send(e, now))) next.add(mark); continue; }
				// A stale main: a new episode (no notice yet, or its move or its open todos changed since the last) is told as every flag is; the same episode again to the main alone, each interval after
				// the last notice, whatever looks in between saw it not stale. A snooze's end not told yet starts a new one at once, with its own tag (the throttle does not hold it back); once told, it routes nothing.
				const r = dev.mains.find((x) => x.session === e.key)!, s = r.session, last = sent[NOTICE + s], wake = r.woke && sent[WAKE + r.woke.id] === undefined ? WAKE + r.woke.id : undefined;
				const same = last !== undefined && sent[NOTICE_MOVED + s] === (r.basis ?? 0) && sent[NOTICE_TODOS + s] === (r.todosKey ?? 0);
				next.add(mark);
				if (!wake && ((last !== undefined && now - last < every) || (same && e.main === undefined))) continue;
				if (await send({ ...e, ...(wake ? { tag: wake } : same ? { mainOnly: true as const } : {}) }, now)) (noted(r), wake && (sent[wake] = now));
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
			// A box's hold is told once to its head tower, standing main, and coordinators, and its end once, with the reason; the marks say what they were told, so a restart repeats neither.
			// Ends first, so a new holder's notice follows the old one's end (R-F003); an end clears the marks and throttles of its own hold only, so a hold that comes back is told again (R-F001).
			const readers = { ...(standing() ? { standing: standing()! } : {}), also: facts.filter((m) => m.role === "main" && (m.duty === undefined || m.duty === "coordinator")).map((m) => m.session) };
			const tag = (h: Pick<HeldBy, "device" | "since">) => `${h.device}@${h.since}`, ofHold = (h: Pick<HeldBy, "device" | "since">) => [holdMark(h), `${HOLD_MAIN}${tag(h)}:`, `held:${tag(h)}`];
			for (const k of marks) {
				const h = markHold(k), gone = prev?.device === h.device && prev.since === h.since ? prev : allies.find((a) => a.device === h.device);
				if (held && holdMark(held) === k) continue;
				const who = gone ? holderName({ byName: "byName" in gone ? gone.byName : "its main", label: gone.label, short: gone.short }) : `device ${shortOf(h.device)}`;
				if (await send({ kind: "hold-ended", key: tag(h), text: holdEndedText(who, endOf(allies, h, now, ignored)), ...readers }, now)) for (const m of Object.keys(sent)) if (ofHold(h).some((p) => m.startsWith(p))) delete sent[m];
			}
			const told = () => { for (const m of Object.keys(sent)) if (m.startsWith(`hold-ended:${tag(held!)}`)) delete sent[m]; return true; };
			if (held && sent[holdMark(held)] === undefined && (await send({ kind: "held", key: tag(held), text: heldText(holderName(held), clock(held.since, now)), ...readers }, now)) && told()) for (const m of [holdMark(held), ...readers.also.map((x) => `${HOLD_MAIN}${tag(held)}:${x}`)]) sent[m] = now;
			// A coordinator that starts on the held box (opened here later, or one that missed it) is told once too.
			if (held && sent[holdMark(held)] !== undefined) for (const x of readers.also) if (sent[`${HOLD_MAIN}${tag(held)}:${x}`] === undefined && (await send({ kind: "held", key: `${tag(held)}:${x}`, text: heldText(holderName(held), clock(held.since, now)), main: x, mainText: heldText(holderName(held), clock(held.since, now)), mainOnly: true }, now))) sent[`${HOLD_MAIN}${tag(held)}:${x}`] = now;
			// A quota that cleared while its main still runs is told once: the main is back at work.
			const rows = new Map(dev.mains.map((r) => [r.session, r]));
			// An ally's main is back when its board still has it and its pause is gone.
			const allyMains = new Map<string, { a: AllySeen; row: MainRow }>(allies.flatMap((a) => (a.mains ?? []).map((m) => ((row) => [row.session, { a, row }] as const)(allyRow(a, m.id)))));
			for (const mark of active) {
				const kind = mark.slice(0, mark.indexOf(":")), session = mark.slice(mark.indexOf(":") + 1).split("@")[0]!, row = rows.get(session), theirs = allyMains.get(session);
				if (kind !== "quota" || flagged.some((e) => e.kind === "quota" && e.key === session)) continue;
				if (row && last.has(session)) await send(of("resumed", row), now);
				else if (theirs) await send(allyOf("resumed", theirs.a, theirs.row), now);
			}
			active = next;
			untold = new Set(flagged.map(markOf).filter((m) => untold.has(m)));
			last = rows;
			const spell = (k: string) => [FIRST, ESCALATED].find((p) => k.startsWith(p)), episode = (k: string) => [UFIRST, UESCALATED].find((p) => k.startsWith(p));
			// A snooze's marks last while a main's file still holds it; a main's notice while the main is live, or a day.
			const live = new Set(facts.map((m) => m.session)), snoozed = new Set(caps.flatMap((c) => (c.snoozes ?? []).map((s) => snoozeId(c.session, s)))), ofSnooze = (k: string) => [SNOOZE_END, WAKE].find((p) => k.startsWith(p)), notice = (k: string) => [NOTICE_MOVED, NOTICE_TODOS, NOTICE].find((p) => k.startsWith(p));
			sent = Object.fromEntries(Object.entries(sent).filter(([k, at]) => (k.startsWith(HOLD_MARK) || k.startsWith(HOLD_MAIN) ? true : ofSnooze(k) ? snoozed.has(k.slice(ofSnooze(k)!.length)) : notice(k) ? ((m) => live.has(m) || now - (sent[NOTICE + m] ?? 0) < 24 * 3600_000)(k.slice(notice(k)!.length)) : k.startsWith("episode:stale:") ? false : episode(k) ? underKeys.has(k.slice(episode(k)!.length)) : spell(k) ? silentKeys.has(k.slice(spell(k)!.length)) : now - at < (k.startsWith("stale:") ? Math.max(every, THROTTLE_MS) : THROTTLE_MS))));
			try { writeSent(d.dir, sent); } catch (error) { d.log("capacity-error", { text: (error as Error).message.slice(0, 200) }); }
			return dev;
		},
	};
}

/** `held-room` (the controller's side): a box this device holds, whose echo says the hold is honoured, with a point of room and load under 0.7 per core for 10 minutes, is told to the holding main alone. */
function heldRoom(holds: readonly Hold[], allies: readonly AllySeen[], now: number, since: Map<string, number>): CapEvent[] {
	const out: CapEvent[] = [], keys = new Set<string>();
	for (const h of holds) {
		const key = `${h.team}:${h.device}`, a = allies.find((x) => x.key === key), c = a?.cap;
		keys.add(key);
		if (!a?.online || a.echo?.since !== h.since || !c || c.budget === undefined || c.budget - c.points < 1 || c.load1 >= LOAD_SHARE * c.cores) { since.delete(key); continue; }
		since.set(key, since.get(key) ?? now);
		if (now - since.get(key)! >= UNDER_HOLD_MS) ((text) => out.push({ kind: "held-room", key, text, main: h.session, mainText: text, mainOnly: true }))(heldRoomText(a.label, a.short, c.points, c.budget, c.load1, c.cores));
	}
	for (const k of [...since.keys()]) if (!keys.has(k)) since.delete(k);
	return out;
}
