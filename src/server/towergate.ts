import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { readEntries } from "../board.ts";
import { carriesSlip } from "../carslip.ts";
import { bodyOf, fieldsOf, type Party, ROLE_WORDS, stamp } from "../header.ts";
import type { Pane, Session } from "../herdr.ts";
import { startOf } from "../startof.ts";
import { trainFromRequest } from "../trainrole.ts";
import type { Incoming, IntercomLike } from "./kit.ts";
import { addEntry, allEntries, type BookEntry, cutText, fenced, openHeadsUps, resourcesOf, shared, untilOf } from "./logbook.ts";
import type { Slot } from "./record.ts";
import { type LockDeps, lockDirOf, takeLock, type Taken } from "./trainlock.ts";
import { baseId, hashOf } from "./towerseen.ts";
import { readExpects } from "./towerrunstore.ts";
import { readLedger, type ServiceRecord } from "./towerstore.ts";

// The quiet gate of a tower identity's intake (docs/specs/2026-11-28-tower-quiet.md; boss 2026-11-28 「塔台只要有辦法查帳就好」): a `call_tower` milestone is recorded in the logbook (logbook.ts) and wakes no run, unless
// it answers the tower's own request (a main a tower opened, a session this tower asked); a `shared` heads-up is recorded and wakes a run only when it overlaps an open heads-up of another session (of any workspace
// and slot) or the board of another main of the sender's workspace, else the sender is told "recorded, no clash seen". A session this tower waits on reaches it whatever its why (quiet-F003). Everything else
// (blocked, unspecified, a car slip or a train manifest under any why, a wait's fields, a peer's turn, a handover notice, a message that is no call_tower) is queued and wakes as before; a manifest that does not
// read is refused with a resend (quiet-F006). The gate classifies and records a call before the intake remembers or receipts it (quiet-F002). It reads the header the sender's code wrote, so a main of an older
// Straw Boss goes through it unchanged (its handover notice, which has no `handed-to`, by its words: quiet-F007). A heads-up is compared with every slot's open heads-ups and written in one step under the
// logbook lock, after the net reads (quiet-F010); a retry under `~r<n>` is the call its base id names, for the same tower and sender, when its words are the same (quiet-F011). Kept out of towers.ts, which
// carries a line budget.

/** Header fields that make a call part of a flow the tower routes (a wait on a device, the head's asks, a forward, a peer's turn, a handover notice): it is queued as before. */
const ROUTED = ["waits-on", "ask", "relay", "in-reply-to", "fwd", "origin", "remote", "handed-to"] as const;
/**
 * A train manifest, the integrator's request to open a train (integrator.md, "one `train:` block"): a `train:` line that opens a block (nothing after it but a `{`), or a `train:` line beside a `project:` or
 * `code:` key. A `train:` line with words after it and no such key is a train's own heads-up (`train: 2026-11-28-a deploying ws01`), not a manifest.
 */
const TRAIN_LINE = /^[ \t>*-]*["']?train["']?[ \t]*:/im, TRAIN_BLOCK = /^[ \t>*-]*["']?train["']?[ \t]*:[ \t]*(?:\{.*)?$/im, MANIFEST_KEY = /^[ \t>*-]*["']?(?:project|code)["']?[ \t]*[:=]/im;
const isManifest = (body: string) => TRAIN_BLOCK.test(body) || (TRAIN_LINE.test(body) && MANIFEST_KEY.test(body));
/**
 * The handover notice of a Straw Boss before `handed-to` (closemain.ts `handedNotice`, the same words since 0.99.0, which box 2 runs): a plain milestone to the code that reads only its header. Its words name the
 * session that steps down, which must be the sender's own.
 */
const HANDED = /^\s*Straw Boss: main .{1,200}? \(session (\S+)\) handed over to its successor in tab \S+ \(session \S+\), which took the handoff\. /;
const handedBefore = (body: string, from: string) => HANDED.exec(body)?.[1] === from;
export type Sort = { book: false } | { book: "milestone" | "heads-up"; wake: boolean } | { book: "reject"; why: string };

/** How the gate takes a message: `book: false` is queued as before; a milestone or heads-up is recorded, and `wake` says it answers the tower's request; `reject` is a manifest refused for a resend. */
export function sortCall(text: string, from: string, asked: { opened(id: string): boolean; expects(id: string): boolean }): Sort {
	const f = fieldsOf(text);
	if (f?.kind !== "call_tower" || ROUTED.some((k) => f[k] !== undefined) || (f.why !== "milestone" && f.why !== "shared")) return { book: false };
	const body = bodyOf(text), train = trainFromRequest(body);
	// A train manifest is the tower's to open, whatever its why label: recognised first, then read; one that does not read is refused, never a heads-up, nor a car slip for the slips sb appended to it.
	if (isManifest(body)) return "refusal" in train ? { book: "reject", why: train.refusal } : { book: false };
	// A car slip as the integrator reads one, the fields of a manifest without its `train:` line, or an older Straw Boss's handover notice: the tower's, as before.
	if (carriesSlip(body) || !("refusal" in train) || handedBefore(body, from)) return { book: false };
	// The answer of a session this tower asked (expects.json) is the tower's, whatever its why.
	if (asked.expects(from)) return { book: f.why === "milestone" ? "milestone" : "heads-up", wake: true };
	return f.why === "milestone" ? { book: "milestone", wake: asked.opened(from) } : { book: "heads-up", wake: false };
}

/** `sleep` waits between looks at a busy logbook lock; `lock` is the lock's own deps (trainlock.ts), for a test. */
export interface GateDeps { slot: Slot; now(): number; log(event: string, facts: Record<string, string>): void; notice(workspace: string, text: string, key: string): boolean; sleep?(ms: number): Promise<void>; lock?: LockDeps }
/** One message at the intake: the service, its connection and net reading, and the intake's own steps (queue the event and wake, remember the message as seen). */
export interface Intake { record: ServiceRecord; client?: IntercomLike; read?(): Promise<{ sessions: Session[]; ps: Pane[] }>; queue(): void; seen(): void }
type Clash = { short: string; notice: string };
/** What a recorded call does: wake a run (why, and the clash it saw) or nothing. */
type Verdict = { wake: false } | { wake: true; why: string; clash?: Clash };

const hhmm = (ms: number) => ((d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`)(new Date(ms));
/** The sender of an entry, its name fenced as the sender's own. */
const who = (e: Pick<BookEntry, "from" | "label">) => `${fenced(e.from.name, 40)} (${e.from.id}) of ${cutText(e.label, 40)}`;
const words = (text: string) => fenced(text, 200);
const CHECK = "These are the mains' own words. If they really collide, tell both with tower_reply (another workspace's main through its tower, tower_send); a shared name alone may be no clash.";
/**
 * The logbook lock (quiet-F010): `<state dir>/locks/logbook.lock` (trainlock.ts), one for every slot of the computer, since each slot's sb server is its own process and a heads-up is compared with every slot's
 * book. This process takes it, compares, writes its own slot's book, and lets go in one synchronous step: no await while it holds it, and nothing hands it to another process. A lock that stays busy for
 * `LOCK_WAIT_MS` (a holder stalled under load) is no reason to drop the call: it is recorded and wakes the tower, the safe way to be wrong.
 */
const LOCK_NAME = "logbook", LOCK_POLL_MS = 25, LOCK_WAIT_MS = 3000;

export function createGate(d: GateDeps) {
	/** The calls being classified, by receiving tower, sender, and base message id, with the fingerprint of their text: a retry with the same text that comes meanwhile waits for the same end (quiet-F011). */
	const inflight = new Map<string, { hash: string; job: Promise<boolean> }>();
	const sleep = d.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
	let own: string | undefined;
	/** The logbook lock, or why it could not be had. */
	const lock = async (): Promise<{ release(): void } | { busy: string }> => {
		const until = d.now() + LOCK_WAIT_MS;
		for (;;) {
			let taken: Taken;
			try {
				own ??= (d.lock?.startOf ?? startOf)(process.pid);
				taken = takeLock(lockDirOf(d.slot.stateDir), LOCK_NAME, { train: LOCK_NAME, step: 0, ...(own ? { started: own } : {}) }, d.lock);
			} catch (cause) {
				return { busy: `the logbook lock could not be taken: ${cutText((cause as Error).message, 80)}` };
			}
			if (taken.ok) return taken;
			if (d.now() >= until) return { busy: `the logbook lock stayed ${taken.why}${taken.holder ? ` by pid ${taken.holder.pid}` : ""} for ${LOCK_WAIT_MS / 1000} s` };
			await sleep(LOCK_POLL_MS);
		}
	};
	/** A line to the sender under the tower identity's header: `noWake` unless the sender said it expects a reply (pi-intercom 0.18.1 holds it for the sender's next turn), or `wake` says it must act. */
	const reply = async (i: Intake, from: Session, fields: Record<string, string>, text: string, wake = fields.reply === "expected") => {
		const role = (ROLE_WORDS as readonly string[]).includes(fields.role ?? "") ? (fields.role as Party["role"]) : "session";
		const line = stamp({ from: { name: i.record.name, id: i.record.id, role: "tower", workspace: i.record.label }, kind: "tower_reply", scope: "session", to: [{ name: from.name ?? from.id, id: from.id, role, ...(fields.workspace ? { workspace: fields.workspace } : {}) }], reply: false }, text);
		const sent = await i.client?.send(from.id, { text: line, messageId: `sb-gate-${randomBytes(8).toString("hex")}`, ...(wake ? {} : { noWake: true }) });
		if (!sent?.delivered) d.log("tower-gate-reply", { workspace: i.record.workspace, to: from.id, why: sent?.reason ?? "no connection" });
	};
	/** The open heads-up of another session that this one overlaps, in any workspace of any slot. */
	const headsUpClash = (e: Omit<BookEntry, "seq">): Clash | undefined => {
		for (const o of openHeadsUps(allEntries(d.slot.stateDir, d.now()), d.now())) {
			const on = o.from.id === e.from.id ? [] : shared(e.resources ?? [], o.resources ?? []);
			if (on.length) return { short: `the heads-up of ${fenced(o.from.name, 40)} (${o.from.id.slice(0, 8)}) on ${fenced(on.slice(0, 3).join(", "), 60)}`, notice: `Heads-up clash, seen by sb: ${who(e)}: ${words(e.text)} overlaps the heads-up of ${who(o)}, open until ${hhmm(o.until ?? o.at)}: ${words(o.text)}, on ${fenced(on.slice(0, 5).join(", "), 120)}. ${CHECK}` };
		}
		return undefined;
	};
	/** The board of another live main or train of the sender's workspace (where the net places the sender, quiet-F004; the tower's when it places it nowhere) that names what the heads-up names. */
	const boardClash = (net: { sessions: Session[]; ps: Pane[] }, e: Omit<BookEntry, "seq">): Clash | undefined => {
		const ws = net.sessions.find((s) => s.id === e.from.id)?.herdrLocation?.workspace?.id ?? e.workspace;
		const mains = new Map(net.sessions.filter((s) => s.id !== e.from.id && s.herdrLocation?.workspace?.id === ws && ((r) => r === "main" || r === "train")(net.ps.find((p) => p.pane_id === s.herdrLocation?.paneId)?.tokens?.sb_role)).map((s) => [s.id, s]));
		for (const entry of readEntries(join(d.slot.stateDir, "board"))) {
			const main = mains.get(entry.session), text = [entry.now, ...entry.items.filter((x) => !x.done).map((x) => x.t)].join(" · ");
			const on = main ? shared(e.resources ?? [], resourcesOf(text)) : [];
			if (on.length) return { short: `the board of ${fenced(main!.name ?? main!.id, 40)} (${main!.id.slice(0, 8)}) on ${fenced(on.slice(0, 3).join(", "), 60)}`, notice: `Heads-up clash, seen by sb: ${who(e)}: ${words(e.text)} overlaps the board of ${fenced(main!.name ?? main!.id, 40)} (${main!.id}), a main of the sender's workspace: ${words(text)}, on ${fenced(on.slice(0, 5).join(", "), 120)}. ${CHECK}` };
		}
		return undefined;
	};
	const netOf = (i: Intake) => (i.read ? i.read() : Promise.reject(new Error("no net reader"))).catch((cause: Error) => cause);
	/** Whether the call wakes a run, by what the net and the boards say; the open heads-ups are compared later, with the write (quiet-F010). A net that cannot be read wakes it: the safe way to be wrong. */
	const classify = async (i: Intake, from: Session, sort: Extract<Sort, { wake: boolean }>, e: Omit<BookEntry, "seq">): Promise<Verdict> => {
		if (sort.book === "milestone") {
			if (sort.wake) return { wake: true, why: "it answers the tower's request" };
			// A milestone from a main whose pane says a tower opened it (`sb_opened_by`) is its done report: the tower relays it and closes the main.
			const net = await netOf(i);
			if (net instanceof Error) return { wake: true, why: `the net could not be read: ${cutText(net.message, 80)}` };
			return net.ps.find((p) => p.pane_id === net.sessions.find((s) => s.id === from.id)?.herdrLocation?.paneId)?.tokens?.sb_opened_by ? { wake: true, why: "a main a tower opened" } : { wake: false };
		}
		if (sort.wake) return { wake: true, why: "a session this tower asked" };
		if (!e.resources?.length) return { wake: false };
		const net = await netOf(i);
		if (net instanceof Error) return { wake: true, why: `the boards could not be read: ${cutText(net.message, 80)}` };
		const board = boardClash(net, e);
		return board ? { wake: true, why: "board", clash: board } : { wake: false };
	};
	/** The sender's line after a call that woke nothing: a heads-up is answered; a milestone only when its sender expects a reply. */
	const answer = (i: Intake, from: Session, fields: Record<string, string>, e: BookEntry) =>
		e.kind === "milestone"
			? fields.reply === "expected" ? reply(i, from, fields, "sb: recorded your milestone in the tower's logbook; a milestone wakes no tower run, so no answer comes. If you need one, call_tower again with why blocked.") : Promise.resolve()
			: reply(i, from, fields, e.resources?.length
				? `sb: recorded your heads-up for the tower (open until ${hhmm(e.until!)}); no clash seen with the open heads-ups or your workspace's boards, so no tower run woke. Go ahead.`
				: `sb: recorded your heads-up for the tower (open until ${hhmm(e.until!)}); it names nothing sb can compare (a port, branch, database, host, or deploy target), so no clash can be seen and no tower run woke. Go ahead.`);
	/**
	 * One call, classified, recorded, then queued or seen; the line to the sender goes last, so a lost one costs a line, not the call. True when the intake receipts it; false for a message whose base id this tower
	 * recorded from its sender with other words (not a retry: dropped, as the intake's dedupe drops one, towerseen.ts).
	 */
	const settle = async (i: Intake, from: Session, message: Incoming, sort: Exclude<Sort, { book: false }>, hash: string): Promise<boolean> => {
		const ws = i.record.workspace, text = message.content.text, now = d.now(), fields = fieldsOf(text)!, body = bodyOf(text);
		const fail = (cause: Error) => d.log("tower-gate-error", { workspace: ws, from: from.id, error: cutText(cause.message, 200) });
		if (sort.book === "reject") {
			i.seen();
			d.log("tower-gate-refused", { workspace: ws, from: from.id, why: cutText(sort.why, 200) });
			void reply(i, from, fields, `sb: your message reads as a train manifest, and it is refused: ${cutText(sort.why, 200)}. Nothing was recorded or opened: fix it and send it again with call_tower (why shared).`, true).catch(fail);
			return true;
		}
		const base = { kind: sort.book, workspace: ws, label: i.record.label, at: now, from: { id: from.id, name: cutText(from.name ?? from.id, 80) }, text: cutText(body), msg: baseId(message.id), hash, ...(fields.reply === "expected" ? { reply: true as const } : {}) };
		const draft = sort.book === "heads-up" ? { ...base, resources: resourcesOf(body), until: untilOf(body, now) } : base;
		const read = await classify(i, from, sort, draft), held = sort.book === "heads-up" ? await lock() : undefined;
		let verdict: Verdict, e: BookEntry;
		try {
			// One step, with nothing awaited: the open heads-ups of every slot as they are now, then the write, so two heads-ups whose reads overlapped still see each other (quiet-F010).
			const hit = sort.book === "heads-up" ? headsUpClash(draft) : undefined;
			verdict = hit ? { wake: true, why: "heads-up", clash: hit } : !read.wake && held && "busy" in held ? { wake: true, why: held.busy } : read;
			// A retry finds the entry its first try wrote (this tower, its sender, its base id): that try's verdict stands, so an entry never says quiet for an event a run got, or the reverse.
			e = addEntry(d.slot.dir, { ...draft, ...(verdict.wake ? { woke: true as const, ...(verdict.clash ? { clash: verdict.clash.short } : {}) } : {}) }, now);
		} finally {
			if (held && "release" in held) held.release();
		}
		if (e.hash !== undefined && e.hash !== hash) {
			d.log("tower-dropped", { workspace: ws, from: from.id, why: "the same message id with other content" });
			return false;
		}
		const why = verdict.wake ? verdict.why : "recorded so before";
		d.log("tower-recorded", { workspace: ws, kind: e.kind, from: from.id, seq: String(e.seq), wake: e.woke ? why : "no" });
		if (e.woke) {
			if (verdict.wake && verdict.clash) d.notice(ws, verdict.clash.notice, `clash:${ws}:${e.seq}`);
			d.log("tower-gate-wake", { workspace: ws, kind: e.kind, from: from.id, seq: String(e.seq), why });
			i.queue();
			return true;
		}
		i.seen();
		d.log("tower-gate-quiet", { workspace: ws, kind: e.kind, from: from.id, seq: String(e.seq) }); // a test waits for it
		void answer(i, from, fields, e).catch(fail);
		return true;
	};
	return {
		/**
		 * False when the intake queues the message as before; else the gate's work on it, which ends once the call is recorded and queued or seen, true when the intake receipts it then: a retry of a call in flight
		 * (its base id) shares that call's end when its text is the same, and is dropped, unreceipted, when it is not.
		 */
		take(i: Intake, from: Session, message: Incoming): false | Promise<boolean> {
			const ws = i.record.workspace, now = d.now();
			const sort = sortCall(message.content.text, from.id, { opened: (id) => readLedger(d.slot, ws, now).some((r) => r.outcome === "opened" && r.opened?.main === id), expects: (id) => readExpects(d.slot, ws, now).some((x) => x.to === id) });
			if (!sort.book) return false;
			const hash = hashOf(message.content.text), key = `${i.record.id}\n${from.id}\n${baseId(message.id)}`, running = inflight.get(key);
			if (running?.hash === hash) return running.job;
			if (running) {
				d.log("tower-dropped", { workspace: ws, from: from.id, why: "the same message id with other content" });
				return Promise.resolve(false);
			}
			const job = settle(i, from, message, sort, hash).finally(() => inflight.delete(key));
			inflight.set(key, { hash, job });
			return job;
		},
	};
}
export type Gate = ReturnType<typeof createGate>;
