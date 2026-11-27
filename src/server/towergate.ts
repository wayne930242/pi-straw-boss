import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { readEntries } from "../board.ts";
import { SLIP } from "../carslip.ts";
import { bodyOf, fieldsOf, type Party, ROLE_WORDS, stamp } from "../header.ts";
import type { Pane, Session } from "../herdr.ts";
import { trainFromRequest } from "../trainrole.ts";
import type { Incoming, IntercomLike } from "./kit.ts";
import { addEntry, type BookEntry, cutText, markWoke, openHeadsUps, readBook, resourcesOf, shared, untilOf } from "./logbook.ts";
import type { Slot } from "./record.ts";
import { readExpects } from "./towerrunstore.ts";
import { readLedger, type ServiceRecord } from "./towerstore.ts";

// The quiet gate of a tower identity's intake (docs/specs/2026-11-28-tower-quiet.md; boss 2026-11-28 「塔台只要有辦法查帳就好」): a `call_tower` milestone is recorded in the logbook (logbook.ts) and wakes no run, unless
// it answers the tower's own request (a main a tower opened, a session this tower asked); a `shared` heads-up is recorded and wakes a run only when it overlaps an open heads-up of another session (of any workspace)
// or the board of another main of its workspace, else the sender is told "recorded, no clash seen". Everything else (blocked, unspecified, a car slip, a train manifest, a wait's fields, a peer's turn, a message
// that is no call_tower) is queued and wakes as before. The gate reads the header the sender's code wrote, so a main of an older Straw Boss goes through it unchanged. Kept out of towers.ts, which carries a line budget.

/** Header fields that make a call part of a flow the tower routes (a wait on a device, the head's asks, a forward, a peer's turn): it is queued as before. */
const ROUTED = ["waits-on", "ask", "relay", "in-reply-to", "fwd", "origin", "remote"] as const;
export type Sort = { book: false } | { book: "milestone"; wake: boolean } | { book: "heads-up" };

/** How the gate takes a message: `book: false` is queued as before; a milestone is recorded, and woken for when it answers the tower's request; a heads-up is recorded and compared. */
export function sortCall(text: string, from: string, asked: { opened(id: string): boolean; expects(id: string): boolean }): Sort {
	const f = fieldsOf(text);
	if (f?.kind !== "call_tower" || ROUTED.some((k) => f[k] !== undefined)) return { book: false };
	if (f.why === "milestone") return { book: "milestone", wake: asked.opened(from) || asked.expects(from) };
	const body = bodyOf(text);
	if (f.why === "shared") return SLIP.test(body) || !("refusal" in trainFromRequest(body)) ? { book: false } : { book: "heads-up" };
	return { book: false };
}

export interface GateDeps { slot: Slot; now(): number; log(event: string, facts: Record<string, string>): void; notice(workspace: string, text: string, key: string): boolean }
/** One message at the intake: the service, its connection and net reading, and the intake's own steps (queue the event and wake, remember the message as seen). */
export interface Intake { record: ServiceRecord; client?: IntercomLike; read?(): Promise<{ sessions: Session[]; ps: Pane[] }>; queue(): void; seen(): void }

const hhmm = (ms: number) => ((d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`)(new Date(ms));
const who = (e: Pick<BookEntry, "from" | "label">) => `${cutText(e.from.name, 40)} (${e.from.id}) of ${cutText(e.label, 40)}`;
const words = (e: Pick<BookEntry, "text">) => `«${cutText(e.text, 200).replace(/[«»]/g, "")}»`;
const CHECK = "These are the mains' own words. If they really collide, tell both with tower_reply (another workspace's main through its tower, tower_send); a shared name alone may be no clash.";

export function createGate(d: GateDeps) {
	const stateDir = d.slot.stateDir;
	/** A line to the sender under the tower identity's header: `noWake` unless the sender said it expects a reply (pi-intercom 0.18.1 holds it for the sender's next turn). */
	const reply = async (i: Intake, from: Session, fields: Record<string, string>, text: string) => {
		const role = (ROLE_WORDS as readonly string[]).includes(fields.role ?? "") ? (fields.role as Party["role"]) : "session";
		const line = stamp({ from: { name: i.record.name, id: i.record.id, role: "tower", workspace: i.record.label }, kind: "tower_reply", scope: "session", to: [{ name: from.name ?? from.id, id: from.id, role, ...(fields.workspace ? { workspace: fields.workspace } : {}) }], reply: false }, text);
		const sent = await i.client?.send(from.id, { text: line, messageId: `sb-gate-${randomBytes(8).toString("hex")}`, ...(fields.reply === "expected" ? {} : { noWake: true }) });
		if (!sent?.delivered) d.log("tower-gate-reply", { workspace: i.record.workspace, to: from.id, why: sent?.reason ?? "no connection" });
	};
	/** A recorded call woke the tower after all: it is queued as before, and its entry says so. */
	const wake = (i: Intake, e: BookEntry, why: string, clash?: string) => {
		markWoke(stateDir, e.seq, d.now(), clash);
		d.log("tower-gate-wake", { workspace: e.workspace, kind: e.kind, from: e.from.id, seq: String(e.seq), why });
		i.queue();
	};
	/** The open heads-up of another session that this one overlaps, in any workspace. */
	const headsUpClash = (e: Omit<BookEntry, "seq">) => {
		for (const o of openHeadsUps(readBook(stateDir, d.now()), d.now())) {
			const on = o.from.id === e.from.id ? [] : shared(e.resources ?? [], o.resources ?? []);
			if (on.length) return { short: `the heads-up of ${cutText(o.from.name, 40)} (${o.from.id.slice(0, 8)}) on ${on.slice(0, 3).join(", ")}`, notice: `Heads-up clash, seen by sb: ${who(e)}: ${words(e)} overlaps the heads-up of ${who(o)}, open until ${hhmm(o.until ?? o.at)}: ${words(o)}, on ${on.slice(0, 5).join(", ")}. ${CHECK}` };
		}
		return undefined;
	};
	/** The board of another live main or train of the sender's workspace that names what the heads-up names (its line and open items). */
	const boardClash = async (i: Intake, e: BookEntry) => {
		const net = await i.read!();
		const mains = new Map(net.sessions.filter((s) => s.id !== e.from.id && s.herdrLocation?.workspace?.id === e.workspace && ((r) => r === "main" || r === "train")(net.ps.find((p) => p.pane_id === s.herdrLocation?.paneId)?.tokens?.sb_role)).map((s) => [s.id, s]));
		for (const entry of readEntries(join(stateDir, "board"))) {
			const main = mains.get(entry.session), text = [entry.now, ...entry.items.filter((x) => !x.done).map((x) => x.t)].join(" · ");
			const on = main ? shared(e.resources ?? [], resourcesOf(text)) : [];
			if (on.length) return { short: `the board of ${cutText(main!.name ?? main!.id, 40)} (${main!.id.slice(0, 8)}) on ${on.slice(0, 3).join(", ")}`, notice: `Heads-up clash, seen by sb: ${who(e)}: ${words(e)} overlaps the board of ${cutText(main!.name ?? main!.id, 40)} (${main!.id}), a main of this workspace: ${words({ text })}, on ${on.slice(0, 5).join(", ")}. ${CHECK}` };
		}
		return undefined;
	};
	/** A milestone from a main whose pane says a tower opened it (`sb_opened_by`) is its done report: the tower relays it and closes the main. Else a sender that expects a reply is told none comes. */
	const followMilestone = async (i: Intake, from: Session, fields: Record<string, string>, e: BookEntry) => {
		const net = await i.read!().catch((cause: Error) => cause);
		if (net instanceof Error) return wake(i, e, `the net could not be read: ${cutText(net.message, 80)}`);
		if (net.ps.find((p) => p.pane_id === net.sessions.find((s) => s.id === from.id)?.herdrLocation?.paneId)?.tokens?.sb_opened_by) return wake(i, e, "a main a tower opened");
		if (fields.reply === "expected") await reply(i, from, fields, "sb: recorded your milestone in the tower's logbook; a milestone wakes no tower run, so no answer comes. If you need one, call_tower again with why blocked.");
		quiet(e);
	};
	/** The end of a call that woke nothing: a line in the log (a test waits for it). */
	const quiet = (e: BookEntry) => d.log("tower-gate-quiet", { workspace: e.workspace, kind: e.kind, from: e.from.id, seq: String(e.seq) });
	const followHeadsUp = async (i: Intake, from: Session, fields: Record<string, string>, e: BookEntry) => {
		const hit = e.resources?.length ? await boardClash(i, e).catch((cause: Error) => cause) : undefined;
		if (hit instanceof Error) return wake(i, e, `the boards could not be read: ${cutText(hit.message, 80)}`);
		if (hit) return (d.notice(e.workspace, hit.notice, `clash:${e.workspace}:${e.seq}`), wake(i, e, "board", hit.short));
		await reply(i, from, fields, e.resources?.length
			? `sb: recorded your heads-up for the tower (open until ${hhmm(e.until!)}); no clash seen with the open heads-ups or this workspace's boards, so no tower run woke. Go ahead.`
			: `sb: recorded your heads-up for the tower (open until ${hhmm(e.until!)}); it names nothing sb can compare (a port, branch, database, host, or deploy target), so no clash can be seen and no tower run woke. Go ahead.`);
		quiet(e);
	};
	return {
		/** Takes the message when the gate records it: true when it is recorded and wakes nothing now (the intake still receipts it); false when the intake queues it as before. */
		take(i: Intake, from: Session, message: Incoming): boolean {
			const ws = i.record.workspace, text = message.content.text, now = d.now();
			const sort = sortCall(text, from.id, { opened: (id) => readLedger(d.slot, ws, now).some((r) => r.outcome === "opened" && r.opened?.main === id), expects: (id) => readExpects(d.slot, ws, now).some((x) => x.to === id) });
			if (!sort.book) return false;
			const fields = fieldsOf(text)!, body = bodyOf(text);
			const base = { kind: sort.book, workspace: ws, label: i.record.label, at: now, from: { id: from.id, name: cutText(from.name ?? from.id, 80) }, text: cutText(body), ...(fields.reply === "expected" ? { reply: true as const } : {}) };
			const fail = (cause: Error) => d.log("tower-gate-error", { workspace: ws, from: from.id, error: cutText(cause.message, 200) });
			if (sort.book === "milestone") {
				const e = addEntry(stateDir, { ...base, ...(sort.wake ? { woke: true as const } : {}) }, now);
				d.log("tower-recorded", { workspace: ws, kind: e.kind, from: from.id, seq: String(e.seq), wake: sort.wake ? "yes" : "no" });
				if (sort.wake) return false;
				i.seen();
				void followMilestone(i, from, fields, e).catch(fail);
				return true;
			}
			const draft = { ...base, resources: resourcesOf(body), until: untilOf(body, now) }, hit = headsUpClash(draft);
			const e = addEntry(stateDir, { ...draft, ...(hit ? { woke: true as const, clash: hit.short } : {}) }, now);
			d.log("tower-recorded", { workspace: ws, kind: e.kind, from: from.id, seq: String(e.seq), wake: hit ? "heads-up" : "no" });
			if (hit) return (d.notice(ws, hit.notice, `clash:${ws}:${e.seq}`), false);
			i.seen();
			void followHeadsUp(i, from, fields, e).catch(fail);
			return true;
		},
	};
}
export type Gate = ReturnType<typeof createGate>;
