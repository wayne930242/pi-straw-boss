import { capDir as capOf } from "../capacity.ts";
import { addIgnored, readHold, writeHold } from "../hold.ts";
import type { AllySeen } from "../server/capwatch.ts";
import type { Done, Fail, MemberView, TeamView } from "./admin.ts";
import { endHolds, readHolds, setHold } from "./holds.ts";
import type { Notice } from "./kinds.ts";
import type { NetView } from "./routing.ts";

// A device hold's operations in the link holder (docs/specs/2026-11-26-device-hold.md, Tools and commands): the controller's hold and release (the boss's `/boss link hold | release`, an approved `link_request` hold,
// a main's own `link_request` release) and its list; the box's view of the hold it honours and its boss's end of it (`/boss link held [end]`), which is told to the controller as a `hold-ended` notice. The box decides
// whether a hold is honoured (hold.ts); nothing here grants anything on another device.

export interface HoldPort {
	teams(): TeamView[];
	caps(team: string, device: string): string[];
	now(): number;
	attended(): boolean;
	/** `<state dir>/link` and `<state dir>/board`. */
	linkDir: string;
	boardDir?: string;
	net(): Promise<NetView>;
	allies(): AllySeen[];
	notice(team: string, device: string, n: Notice): Promise<void>;
}
export const HOLD_FEATURE = "board.holds", MAX_HOURS = 168;
const no = (error: string): Fail => ({ ok: false, error });
const TOWER = /^sb-tower-/;

export function createHoldOps(p: HoldPort) {
	/** The box `query` names (an id, short id, or label) in one of this computer's teams: the first team that has it. */
	function box(query: string): { team: TeamView; member: MemberView } | Fail {
		const q = query.trim(), id = q.toLowerCase();
		const hits = p.teams().flatMap((team) => team.members.filter((m) => !m.self && (m.id === id || m.short === id || m.label === q)).map((member) => ({ team, member })));
		const ids = new Set(hits.map((h) => h.member.id));
		if (ids.size !== 1) return no(ids.size ? `"${q}" fits ${ids.size} devices: ${[...new Map(hits.map((h) => [h.member.id, h.member])).values()].map((m) => `${m.label} (${m.short})`).join(", ")}; name one by its short id` : `No device "${q}" in this computer's teams`);
		return hits[0]!;
	}
	/** Whether a hold of `device` for `session` may be set, with the words the boss approves; nothing is set. */
	function check(session: string, device: string, hours?: string): Done<{ team: string; device: string; label: string; short: string; until?: number; lines: string[] }> {
		if (!p.attended()) return no("An unattended device holds no other device");
		if (TOWER.test(session)) return no("A tower holds no box; one of its mains does");
		const found = box(device);
		if ("ok" in found) return found;
		const { team, member } = found;
		if (member.attended) return no(`Only an unattended box is held: ${member.label} (${member.short}) is attended`);
		const old = team.members.filter((m) => !m.self && !p.caps(team.team, m.id).includes(HOLD_FEATURE));
		if (old.length) return no(`Every device of team ${team.name} needs a pi-straw-boss that lists ${HOLD_FEATURE} in its caps before a hold is set (an older build would drop the boards); these do not yet: ${old.map((m) => `${m.label} (${m.short})`).join(", ")}`);
		const h = hours === undefined || hours === "" ? undefined : Number(hours);
		if (h !== undefined && !(Number.isFinite(h) && h > 0 && h <= MAX_HOURS)) return no(`hours is a number over 0, at most ${MAX_HOURS}`);
		const until = h === undefined ? undefined : p.now() + Math.round(h * 3600_000);
		return {
			ok: true, team: team.team, device: member.id, label: member.label, short: member.short, ...(until !== undefined ? { until } : {}),
			lines: [`Box: ${member.label} (${member.short}) of team ${team.name}`, `Until: ${until !== undefined ? new Date(until).toISOString() : "it lasts while the holding main runs; it lapses 30 minutes after this computer goes silent"}`, "The box tells its own mains to start no new work, gives its free room to the holding main, and opens worker slips from this device only, if its policy trusts this device at dispatch."],
		};
	}
	/** The session `main` names (an id, an id prefix of 8 or more, or a name) among the live ones, else `session`. */
	async function mainOf(session: string, main?: string): Promise<{ id: string; name: string } | Fail> {
		const sessions = (await p.net()).sessions, q = (main ?? "").trim();
		const hits = q ? sessions.filter((x) => x.id === q || (q.length >= 8 && x.id.startsWith(q)) || x.name === q) : sessions.filter((x) => x.id === session);
		if (hits.length !== 1) return no(q ? (hits.length ? `"${q}" fits ${hits.length} sessions; name one by its id` : `No live session "${q}" on this computer`) : "The session that asked is not live on this computer");
		if (TOWER.test(hits[0]!.id)) return no("A tower holds no box; one of its mains does");
		return { id: hits[0]!.id, name: hits[0]!.name ?? hits[0]!.id.slice(0, 8) };
	}
	return {
		check,
		/** Sets the hold (one per box: it replaces this computer's earlier hold of it). */
		async set(session: string, device: string, o: { main?: string; hours?: string } = {}): Promise<Done<{ text: string }>> {
			const c = check(session, device, o.hours);
			if (!c.ok) return c;
			const m = await mainOf(session, o.main);
			if ("ok" in m) return m;
			try { setHold(p.linkDir, p.now(), { team: c.team, device: c.device, session: m.id, since: p.now(), ...(c.until !== undefined ? { until: c.until } : {}) }); } catch (error) { return no((error as Error).message); }
			return { ok: true, text: `${m.name} now holds ${c.label} (${c.short}). Its next board (within about 20 seconds) carries the hold; the box honours it if its policy trusts this computer at dispatch, and its board echoes it then (/boss link holds shows whether).` };
		},
		/** Whether `session` holds `device` (a main's own release needs no approval: it only narrows what it holds, D4). */
		owns: (session: string, device: string) => ((b) => !("ok" in b) && readHolds(p.linkDir, p.now()).holds.some((h) => h.device === b.member.id && h.session === session))(box(device)),
		release(device: string, session?: string): Done<{ text: string }> {
			const found = box(device);
			if ("ok" in found) return found;
			const gone = endHolds(p.linkDir, p.now(), (h) => h.device === found.member.id && (session === undefined || h.session === session), "released");
			return gone.length ? { ok: true, text: `Released ${found.member.label} (${found.member.short}): the next board carries no hold, and the box tells its mains to take their own work again.` } : no(`${found.member.label} (${found.member.short}) is not held ${session ? "by this session" : "from this computer"}`);
		},
		/** This computer's holds, with whether the box's board echoes each (`honoured`) and how old that board is. */
		async list() {
			const now = p.now(), sessions = (await p.net().catch(() => ({ sessions: [] as NetView["sessions"] }))).sessions, allies = p.allies(), file = readHolds(p.linkDir, now);
			return {
				holds: file.holds.map((h) => {
					const a = allies.find((x) => x.device === h.device && x.team === h.team), m = p.teams().flatMap((t) => t.members).find((x) => x.id === h.device);
					return { team: h.team, device: h.device, label: m?.label ?? h.device.slice(0, 6), short: h.device.slice(0, 6), main: sessions.find((x) => x.id === h.session)?.name ?? h.session.slice(0, 8), session: h.session, since: h.since, ...(h.until !== undefined ? { until: h.until } : {}), honoured: a?.echo?.since === h.since, ...(a ? { boxBoardSecondsAgo: Math.round(a.boardAgeMs / 1000) } : {}) };
				}),
				ended: file.ended.map((e) => ({ device: e.device, short: e.device.slice(0, 6), at: e.at, reason: e.reason })),
			};
		},
		/** The hold this box honours (the capacity watch's file). */
		held: () => ((h) => (h ? { held: h } : {}))(p.boardDir ? readHold(capOf(p.boardDir), p.now()) : undefined),
		/** The box's boss ends the hold here: it is not honoured again (the ignored mark), the file drops it at once, and the controller is told with a `hold-ended` notice. */
		async endHeld(): Promise<Done<{ text: string }>> {
			const dir = p.boardDir && capOf(p.boardDir), now = p.now(), h = dir ? readHold(dir, now) : undefined;
			if (!dir || !h) return no("No teammate holds this box now");
			addIgnored(dir, now, { device: h.device, since: h.since });
			writeHold(dir, { v: 1, at: now });
			const told = await p.notice(h.team, h.device, { kind: "hold-ended", unit: "", text: `The boss of this box ended the hold of main ${h.byName} here.` }).then(() => true, () => false);
			return { ok: true, text: `Ended the hold of ${h.label} (${h.short}) here: this box takes its own work again, and its mains hear so within a minute. ${told ? "That device is told." : "Telling that device failed; its next board is refused here all the same."}` };
		},
	};
}
export type HoldOps = ReturnType<typeof createHoldOps>;
