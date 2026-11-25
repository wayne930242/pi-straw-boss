import { CanonError, bool, cutBytes, cutChars, dec, enc, int, list, readBool, readInt, readList, readStr, str } from "./canon.ts";

// The message kinds of docs/specs/2026-10-25-straw-link.md (Message kinds): who may send each, whether it is ephemeral or goes to the
// whole team, and its plaintext as a canonical structure. Every text field is cut to its limit, on the way out and on the way in, and a
// plaintext never becomes a header.

export type Kind = "tower" | "presence" | "board" | "confirm-request" | "confirm-answer" | "dialog-open" | "dialog-answer" | "dialog-close" | "unit-status" | "notice" | "caps" | "tower-reply" | "unit-stop" | "operate";
/** Which devices may send a kind: any member, only an attended one, or only an unattended one. */
export type Sender = "any" | "attended" | "unattended";
/** `live` is a third class of ephemeral kind (docs/specs/2026-11-07-link-operate.md §5.1): the relay never stores it, writes it only to the addressee's open streams, and sends it as a `live` event with no id. */
export interface KindRule { ephemeral: boolean; wholeTeam: boolean; sender: Sender; live: boolean }

/**
 * The rule of each kind. The ephemeral flag is fixed here, never chosen by the sender. `dialog-answer` is the one kind with a sender rule
 * the spec leaves implicit: a controller answers, and nobody answers at an unattended device, so it takes only attended senders.
 */
export const KINDS: Record<Kind, KindRule> = {
	tower: { ephemeral: false, wholeTeam: false, sender: "any", live: false },
	presence: { ephemeral: true, wholeTeam: true, sender: "any", live: false },
	board: { ephemeral: true, wholeTeam: true, sender: "any", live: false },
	"confirm-request": { ephemeral: false, wholeTeam: false, sender: "any", live: false },
	"confirm-answer": { ephemeral: false, wholeTeam: false, sender: "any", live: false },
	"dialog-open": { ephemeral: false, wholeTeam: false, sender: "unattended", live: false },
	"dialog-answer": { ephemeral: false, wholeTeam: false, sender: "attended", live: false },
	"dialog-close": { ephemeral: false, wholeTeam: false, sender: "unattended", live: false },
	"unit-status": { ephemeral: true, wholeTeam: false, sender: "unattended", live: false },
	notice: { ephemeral: false, wholeTeam: false, sender: "unattended", live: false },
	caps: { ephemeral: true, wholeTeam: true, sender: "any", live: false },
	"tower-reply": { ephemeral: false, wholeTeam: false, sender: "any", live: false },
	/** A controller's request that an unattended box stop one main (docs/specs/2026-11-07-link-remote-stop.md): queued, addressed to one box, from attended senders only. */
	"unit-stop": { ephemeral: false, wholeTeam: false, sender: "attended", live: false },
	/** A controller's live session with an unattended box (docs/specs/2026-11-07-link-operate.md §5): live, addressed to one device, either end sends it; the holder checks the type against the sender's `attended` flag. */
	operate: { ephemeral: true, wholeTeam: false, sender: "any", live: true },
};
export const kindOk = (kind: unknown): kind is Kind => typeof kind === "string" && Object.hasOwn(KINDS, kind);

/** The limits the spec names (`tower` text 192 KB, arguments 12 000 characters, a unit's report 4 KB, a notice 1 KB) and the ones it leaves open (marked). */
export const LIMITS = {
	towerText: 192 * 1024,
	toolArguments: 12_000,
	report: 4 * 1024,
	noticeText: 1024,
	/** Not in the spec: a dialog as the GUI hub shows it, and an answer to one. */
	dialog: 64 * 1024,
	/** Not in the spec: ids, labels, names, tool names, and states. */
	short: 256,
	/** Not in the spec: a presence names at most this many workspaces, and each at most this many tabs; the rest is cut when it is decoded. */
	presenceWorkspaces: 32,
	presenceTabs: 64,
	/** A board (spec, Work board): entries, characters of a label or name, of `now`, items per entry, characters of an item. */
	boardEntries: 24,
	boardLabel: 40,
	boardNow: 120,
	boardItems: 8,
	boardItem: 80,
	/** Not in the spec: a `caps` lists at most this many features; the rest is cut when it is decoded. */
	capsFeatures: 16,
	/** The spec's: a `unit-status` names at most this many mains, each by a name of at most `boardLabel` characters; a stop's reason is at most this many bytes. */
	mains: 20,
	stopReason: 200,
	/** A main's kind word in a `unit-status` entry (docs/specs/2026-11-09-agent-kinds.md §12): `coordinator`, `integrator`, `standing` or `train`; the longest is 11 bytes, so 16 leaves room for a word added later. */
	mainKind: 16,
	/** operate: a `frame`'s ciphertext (a part is at most 160 KB, so 200 KB leaves room), and the teams a session may name. */
	operateFrame: 200 * 1024,
	operateTeams: 8,
} as const;
const short = (s: string) => cutBytes(s, LIMITS.short);

/**
 * `awaitsReply` is the optional fifth field: an ask id, 16 random bytes in hex. Written only to a device whose `caps` list `tower.awaitsReply`. `wait` is the optional sixth (docs/specs/2026-11-21-box-mac-waits.md §2.3), written only to
 * a device whose `caps` list `tower.wait`; with it the fifth field may be empty, which means no ask.
 */
export interface TowerMessage { fromWorkspace: string; toWorkspace: string; replyExpected: boolean; text: string; awaitsReply?: string; wait?: WaitWire }
/** The states a link wait moves through on the wire: the sender opens or cancels it, the receiver tells, takes, answers, or declines it, and either end lets it expire. `escalated` (D14, 0.81.7): an approval's delegate leaves it to the boss; written only to a device whose `caps` list `tower.approval`. */
export const WAIT_STATES = ["open", "told", "taken", "done", "declined", "cancelled", "expired", "escalated"] as const;
export type WaitWireState = (typeof WAIT_STATES)[number];
/**
 * A link wait as it travels: its id (16 random bytes in hex), its state, the owner the sender named (40 characters), what it waits on (one line, 200 bytes), and the sender main's handle (16 hex, or empty). `kind`, the optional sixth
 * part (D13, 0.81.3), is for the receiver's standing main: `question` (it carries an ask) or `notice` (it expects nothing back); written only to a device whose `caps` list `tower.standing`. `approval` (D14, 0.81.7): a card for the
 * sender's boss that the receiver's main decides as the boss's delegate; written only to a device whose `caps` list `tower.approval`. `re`, the optional seventh part (0.93.0), goes with a notice only: the id of the wait it is a note
 * on, one the receiver sent; written only to a device whose `caps` list `tower.note`.
 */
export interface WaitWire { id: string; state: WaitWireState; owner: string; what: string; handle: string; kind?: WaitWireKind; re?: string }
export const STANDING_KINDS = ["question", "notice"] as const;
export type StandingKind = (typeof STANDING_KINDS)[number];
export const WAIT_KINDS = [...STANDING_KINDS, "approval"] as const;
export type WaitWireKind = (typeof WAIT_KINDS)[number];
export interface Caps { features: string[] }
export interface TowerReply { inReplyTo: string; text: string }
/** An ask id as it travels. */
export const askIdOk = (id: string): boolean => /^[0-9a-f]{32}$/.test(id);
export interface TabState { label: string; state: string }
export interface WorkspaceState { label: string; tower: string; tabs: TabState[] }
export interface Presence { label: string; headSeq: number; headHash: Buffer; workspaces: WorkspaceState[] }
/** One main's work board entry as it crosses the wire: `id` is the first 8 bytes of sha256(device id ‖ session id), hex, so no local session id leaves the computer. */
export interface BoardWireEntry { id: string; workspace: string; tab: string; name: string; now: string; updated: number; items: { t: string; done: boolean }[] }
/**
 * A device's capacity row as it crosses the wire (docs/specs/2026-11-24-capacity.md): numbers and times only. Points, the budget, the smallest ready todo and the load are in hundredths; `paused` names the mains by
 * the entry ids the board already carries. Sent as the board's second field only when every teammate's `caps` list `board.capacity` (an older build refuses a board of two fields).
 */
export interface WireCap { at: number; points: number; budget?: number; load1: number; cores: number; ready: number; minReady?: number; open: number; paused: { id: string; until?: number }[] }
export interface Board { entries: BoardWireEntry[]; capacity?: WireCap }
export interface ConfirmRequest { dialogId: string; digest: string; tool: string; args: string; tower: string }
export interface ConfirmAnswer { dialogId: string; digest: string; allow: boolean; answerId: string }
export interface DialogOpen { dialogId: string; digest: string; owner: string; dialog: string }
export interface DialogAnswer { dialogId: string; digest: string; answer: string; answerId: string }
export interface DialogClose { dialogId: string; by: string }
/** One main of a box a controller may stop: `handle` is the first 8 bytes of sha256(box device id ‖ main session id), hex, so no session id leaves the box. `by` is the dispatcher's device id. */
export interface MainStatus {
	handle: string; unit: string; name: string; state: string; by: string; stopping: boolean;
	/** The optional seventh field of the entry: the main's kind word (`coordinator`, `integrator`, `standing`, or `train`), written only to a controller whose `caps` list `unit-status.kind`; the reader draws only the words it knows. Absent when the box knows none. */
	kind?: string;
}
/** `mode` is read as sent: a value the box does not take is refused there, not at decoding. */
export interface UnitStop { stopId: string; handle: string; mode: string; reason: string }
/** A main's handle as it travels. */
export const handleOk = (handle: string): boolean => /^[0-9a-f]{16}$/.test(handle);
/** A stop's reason is one line: line breaks, C0 and C1 controls (NEL, the 8-bit CSI), U+2028/2029, bidi overrides and isolates, and invisible or zero-width characters become spaces, and it is cut to its limit. */
const LINE_BREAKERS = /[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u2028-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\u{e0000}-\u{e0fff}]/gu;
export const oneLine = (text: string, max: number = LIMITS.stopReason) => cutBytes(text.replace(LINE_BREAKERS, " "), max);
/** A wait's fields cut as they travel: the owner to 40 characters, what it waits on to one line of 200 bytes. */
export const waitOwner = (text: string) => cutChars(oneLine(text, LIMITS.short).trim(), 40);
export const waitWhat = (text: string) => oneLine(text, LIMITS.stopReason).trim();
const encodeWait = (w: WaitWire): Buffer => {
	if (!askIdOk(w.id)) throw new RangeError("a wait id is 32 lowercase hex digits");
	if (!(WAIT_STATES as readonly string[]).includes(w.state)) throw new RangeError("a wait's state is one of open, told, taken, done, declined, cancelled, expired, escalated");
	if (w.handle !== "" && !handleOk(w.handle)) throw new RangeError("a main's handle is 16 lowercase hex digits");
	if (w.kind !== undefined && !(WAIT_KINDS as readonly string[]).includes(w.kind)) throw new RangeError("a wait's kind is question, notice, or approval");
	if (w.re !== undefined && w.kind !== "notice") throw new RangeError("re goes with a notice");
	if (w.re !== undefined && !askIdOk(w.re)) throw new RangeError("a wait id is 32 lowercase hex digits");
	return enc(str(w.id), str(w.state), str(waitOwner(w.owner)), str(waitWhat(w.what)), str(w.handle), ...(w.kind !== undefined ? [str(w.kind)] : []), ...(w.re !== undefined ? [str(w.re)] : []));
};
const decodeWait = (b: Buffer): WaitWire => {
	const parts = dec(b).map((f) => readStr(f)), [id, state, owner, what, handle, kind, re] = parts as [string, string, string, string, string, string | undefined, string | undefined];
	if (parts.length < 5 || parts.length > 7) throw new CanonError(`a wait has 5, 6, or 7 parts, got ${parts.length}`);
	if (re !== undefined && (kind !== "notice" || !askIdOk(re))) throw new CanonError("a wait's seventh part is the id of the wait a notice is about");
	if (kind !== undefined && !(WAIT_KINDS as readonly string[]).includes(kind)) throw new CanonError(`a wait's kind is not ${JSON.stringify(kind.slice(0, 20))}`);
	if (!askIdOk(id)) throw new CanonError("a wait id is 32 lowercase hex digits");
	if (!(WAIT_STATES as readonly string[]).includes(state)) throw new CanonError(`a wait's state is not ${JSON.stringify(state.slice(0, 20))}`);
	if (handle !== "" && !handleOk(handle)) throw new CanonError("a main's handle is 16 lowercase hex digits");
	return { id, state: state as WaitWireState, owner: waitOwner(owner), what: waitWhat(what), handle, ...(kind !== undefined ? { kind: kind as WaitWireKind } : {}), ...(re !== undefined ? { re } : {}) };
};
export interface UnitStatus { unit: string; state: string; monitors: string[]; report: string }
/** `ref` is the optional fourth field (docs/specs/2026-11-21-box-mac-waits.md §4, C4): the ask id the notice is about, written only to a device whose `caps` list `notice.ref`. */
export interface Notice { kind: string; unit: string; text: string; ref?: string }

/** The outer layer of `operate` (spec §5.2): `session` is 16 random bytes, and the body depends on `type`. The version (1) is on the wire only; any other is refused. */
export type OperateType = "open" | "accept" | "refuse" | "frame" | "close";
export type OperateMessage = { session: Buffer } & (
	| { type: "open"; eph: Buffer; caps: string[]; want: "team" | "box" }
	| { type: "accept"; eph: Buffer; openHash: Buffer; scope: { teams: Buffer[]; box: boolean }; limits: { mirrors: number; watches: number; budget: number } }
	| { type: "refuse"; reason: string }
	| { type: "frame"; ctr: number; ct: Buffer }
	| { type: "close"; reason: string }
);
export const OPERATE_VERSION = 1;
/** Which outer types each end sends: a controller (attended) opens; a box (unattended) accepts or refuses; both send frames and close. The spec's table lists `frame` for either end; its "open, req and close" for the controller names `req`, an inner message, so `frame` stands for it. */
const OPERATE_FROM: Record<"attended" | "unattended", readonly OperateType[]> = { attended: ["open", "frame", "close"], unattended: ["accept", "refuse", "frame", "close"] };
export const operateDirectionOk = (type: OperateType, attended: boolean): boolean => OPERATE_FROM[attended ? "attended" : "unattended"].includes(type);

export interface Plaintexts {
	tower: TowerMessage;
	presence: Presence;
	board: Board;
	"confirm-request": ConfirmRequest;
	"confirm-answer": ConfirmAnswer;
	"dialog-open": DialogOpen;
	"dialog-answer": DialogAnswer;
	"dialog-close": DialogClose;
	/** `mains` is the optional second field, written only to a controller whose `caps` list `unit-status.mains`; each entry's `kind` only to one whose `caps` list `unit-status.kind` too. */
	"unit-status": { units: UnitStatus[]; mains?: MainStatus[] };
	notice: Notice;
	caps: Caps;
	"tower-reply": TowerReply;
	"unit-stop": UnitStop;
	operate: OperateMessage;
}

const sessionOk = (b: Buffer) => b.length === 16;
const exactBytes = (b: Buffer, n: number, what: string): Buffer => {
	if (b.length !== n) throw new RangeError(`${what} is ${n} bytes`);
	return b;
};
/** The canonical bytes of an `operate` body: `accept` carries sha256 of the `open` body, so a box's signature covers the operator's key. */
export function operateBody(m: OperateMessage): Buffer {
	switch (m.type) {
		case "open": return enc(exactBytes(m.eph, 32, "an ephemeral key"), list(m.caps.slice(0, LIMITS.capsFeatures).map((c) => str(short(c)))), str(m.want));
		case "accept": return enc(exactBytes(m.eph, 32, "an ephemeral key"), exactBytes(m.openHash, 32, "an open hash"), enc(list(m.scope.teams.slice(0, LIMITS.operateTeams).map((t) => exactBytes(t, 16, "a team id"))), bool(m.scope.box)), enc(int(m.limits.mirrors), int(m.limits.watches), int(m.limits.budget)));
		case "refuse": return enc(str(short(m.reason)));
		case "frame":
			if (!Number.isSafeInteger(m.ctr) || m.ctr < 1) throw new RangeError("a frame counter starts at 1");
			if (m.ct.length < 16 || m.ct.length > LIMITS.operateFrame) throw new RangeError("a frame's ciphertext holds a tag and at most 200 KB");
			return enc(int(m.ctr), m.ct);
		case "close": return enc(str(short(m.reason)));
	}
}

const maybe = (n: number | undefined) => list(n === undefined ? [] : [int(n)]);
const readMaybe = (f: Buffer) => { const [n] = readList(f); return n ? readInt(n) : undefined; };
function encodeCap(c: WireCap): Buffer {
	return enc(int(c.at), int(c.points), maybe(c.budget), int(c.load1), int(c.cores), int(c.ready), maybe(c.minReady), int(c.open), list(c.paused.slice(0, LIMITS.boardEntries).map((p) => enc(str(short(p.id)), maybe(p.until)))));
}
function decodeCap(b: Buffer): WireCap {
	const [at, points, budget, load1, cores, ready, minReady, open, paused] = dec(b, 9) as Buffer[];
	const opt = (key: string, n: number | undefined) => (n === undefined ? {} : { [key]: n });
	return { at: readInt(at!), points: readInt(points!), ...opt("budget", readMaybe(budget!)), load1: readInt(load1!), cores: readInt(cores!), ready: readInt(ready!), ...opt("minReady", readMaybe(minReady!)), open: readInt(open!),
		paused: readList(paused!).slice(0, LIMITS.boardEntries).map((p) => { const [id, until] = dec(p, 2) as [Buffer, Buffer]; return { id: s(id), ...opt("until", readMaybe(until)) }; }) };
}

// `toWorkspace` is empty when absent: a workspace label is never empty.
const encoders: { [K in Kind]: (p: Plaintexts[K]) => Buffer } = {
	tower: (p) => {
		const fields = [str(short(p.fromWorkspace)), str(short(p.toWorkspace)), bool(p.replyExpected), str(cutBytes(p.text, LIMITS.towerText))];
		if (p.awaitsReply !== undefined) {
			if (!askIdOk(p.awaitsReply)) throw new RangeError("an ask id is 32 lowercase hex digits");
			fields.push(str(p.awaitsReply));
		} else if (p.wait !== undefined) fields.push(str(""));
		if (p.wait !== undefined) fields.push(encodeWait(p.wait));
		return enc(...fields);
	},
	presence: (p) => enc(str(short(p.label)), int(p.headSeq), p.headHash, list(p.workspaces.map((w) => enc(str(short(w.label)), str(short(w.tower)), list(w.tabs.map((t) => enc(str(short(t.label)), str(short(t.state))))))))),
	board: (p) => enc(list(p.entries.slice(0, LIMITS.boardEntries).map((e) => enc(
		str(short(e.id)), str(cutChars(e.workspace, LIMITS.boardLabel)), str(cutChars(e.tab, LIMITS.boardLabel)), str(cutChars(e.name, LIMITS.boardLabel)), str(cutChars(e.now, LIMITS.boardNow)), int(e.updated),
		list(e.items.slice(0, LIMITS.boardItems).map((i) => enc(str(cutChars(i.t, LIMITS.boardItem)), bool(i.done)))),
	))), ...(p.capacity ? [encodeCap(p.capacity)] : [])),
	"confirm-request": (p) => enc(str(short(p.dialogId)), str(short(p.digest)), str(short(p.tool)), str(cutChars(p.args, LIMITS.toolArguments)), str(short(p.tower))),
	"confirm-answer": (p) => enc(str(short(p.dialogId)), str(short(p.digest)), bool(p.allow), str(short(p.answerId))),
	"dialog-open": (p) => enc(str(short(p.dialogId)), str(short(p.digest)), str(short(p.owner)), str(cutBytes(p.dialog, LIMITS.dialog))),
	"dialog-answer": (p) => enc(str(short(p.dialogId)), str(short(p.digest)), str(cutBytes(p.answer, LIMITS.dialog)), str(short(p.answerId))),
	"dialog-close": (p) => enc(str(short(p.dialogId)), str(short(p.by))),
	"unit-status": (p) => {
		const units = list(p.units.map((u) => enc(str(short(u.unit)), str(short(u.state)), list(u.monitors.map((m) => str(short(m)))), str(cutBytes(u.report, LIMITS.report)))));
		if (p.mains === undefined) return enc(units);
		return enc(units, list(p.mains.slice(0, LIMITS.mains).map((m) => enc(str(short(m.handle)), str(short(m.unit)), str(cutChars(m.name, LIMITS.boardLabel)), str(short(m.state)), str(short(m.by)), bool(m.stopping), ...(m.kind !== undefined ? [str(cutBytes(m.kind, LIMITS.mainKind))] : [])))));
	},
	notice: (p) => {
		if (p.ref !== undefined && !askIdOk(p.ref)) throw new RangeError("a notice's ref is an ask id, 32 lowercase hex digits");
		return enc(str(short(p.kind)), str(short(p.unit)), str(cutBytes(p.text, LIMITS.noticeText)), ...(p.ref !== undefined ? [str(p.ref)] : []));
	},
	caps: (p) => enc(list(p.features.slice(0, LIMITS.capsFeatures).map((f) => str(short(f))))),
	// Sending holds `inReplyTo` to an ask id; decoding only cuts it, since a malformed one just matches no ask and the reply is a plain tower.
	"tower-reply": (p) => {
		if (!askIdOk(p.inReplyTo)) throw new RangeError("an ask id is 32 lowercase hex digits");
		return enc(str(p.inReplyTo), str(cutBytes(p.text, LIMITS.towerText)));
	},
	"unit-stop": (p) => {
		if (!askIdOk(p.stopId)) throw new RangeError("a stop id is 32 lowercase hex digits");
		if (!handleOk(p.handle)) throw new RangeError("a main's handle is 16 lowercase hex digits");
		return enc(str(p.stopId), str(p.handle), str(short(p.mode)), str(oneLine(p.reason)));
	},
	operate: (p) => {
		if (!sessionOk(p.session)) throw new RangeError("a session id is 16 bytes");
		return enc(int(OPERATE_VERSION), p.session, str(p.type), operateBody(p));
	},
};

// Decoding cuts again, so a sender that skipped its own limits is held to them. A structure that is malformed throws CanonError.
const s = (f: Buffer, max: number = LIMITS.short) => cutBytes(readStr(f), max);
const decoders: { [K in Kind]: (b: Buffer) => Plaintexts[K] } = {
	tower: (b) => {
		const fields = dec(b);
		if (fields.length < 4 || fields.length > 6) throw new CanonError(`a tower has 4, 5, or 6 fields, got ${fields.length}`);
		const [from, to, reply, text, asked, wait] = fields as [Buffer, Buffer, Buffer, Buffer, Buffer | undefined, Buffer | undefined];
		const out: TowerMessage = { fromWorkspace: s(from), toWorkspace: s(to), replyExpected: readBool(reply), text: s(text, LIMITS.towerText) };
		if (asked) {
			const id = readStr(asked);
			// An empty fifth field is no ask, and only beside a sixth: a five-field tower always carries one.
			if (!(id === "" && wait) && !askIdOk(id)) throw new CanonError("an ask id is 32 lowercase hex digits");
			if (id) out.awaitsReply = id;
		}
		if (wait) out.wait = decodeWait(wait);
		return out;
	},
	presence: (b) => {
		const [label, seq, hash, spaces] = dec(b, 4) as [Buffer, Buffer, Buffer, Buffer];
		if (hash.length !== 32) throw new RangeError("a roster hash is 32 bytes");
		return {
			label: s(label), headSeq: readInt(seq), headHash: hash,
			workspaces: readList(spaces).slice(0, LIMITS.presenceWorkspaces).map((w) => {
				const [wl, tower, tabs] = dec(w, 3) as [Buffer, Buffer, Buffer];
				return { label: s(wl), tower: s(tower), tabs: readList(tabs).slice(0, LIMITS.presenceTabs).map((t) => { const [tl, st] = dec(t, 2) as [Buffer, Buffer]; return { label: s(tl), state: s(st) }; }) };
			}),
		};
	},
	board: (b) => {
		const fields = dec(b);
		if (fields.length !== 1 && fields.length !== 2) throw new CanonError(`a board has 1 or 2 fields, got ${fields.length}`);
		const [entries, cap] = fields as [Buffer, Buffer | undefined];
		return { ...(cap ? { capacity: decodeCap(cap) } : {}), entries: readList(entries).slice(0, LIMITS.boardEntries).map((e) => {
			const [id, workspace, tab, name, now, updated, items] = dec(e, 7) as [Buffer, Buffer, Buffer, Buffer, Buffer, Buffer, Buffer];
			return {
				id: s(id), workspace: cutChars(readStr(workspace), LIMITS.boardLabel), tab: cutChars(readStr(tab), LIMITS.boardLabel), name: cutChars(readStr(name), LIMITS.boardLabel), now: cutChars(readStr(now), LIMITS.boardNow), updated: readInt(updated),
				items: readList(items).slice(0, LIMITS.boardItems).map((i) => { const [t, done] = dec(i, 2) as [Buffer, Buffer]; return { t: cutChars(readStr(t), LIMITS.boardItem), done: readBool(done) }; }),
			};
		}) };
	},
	"confirm-request": (b) => {
		const [id, digest, tool, args, tower] = dec(b, 5) as [Buffer, Buffer, Buffer, Buffer, Buffer];
		return { dialogId: s(id), digest: s(digest), tool: s(tool), args: cutChars(readStr(args), LIMITS.toolArguments), tower: s(tower) };
	},
	"confirm-answer": (b) => {
		const [id, digest, allow, answerId] = dec(b, 4) as [Buffer, Buffer, Buffer, Buffer];
		return { dialogId: s(id), digest: s(digest), allow: readBool(allow), answerId: s(answerId) };
	},
	"dialog-open": (b) => {
		const [id, digest, owner, dialog] = dec(b, 4) as [Buffer, Buffer, Buffer, Buffer];
		return { dialogId: s(id), digest: s(digest), owner: s(owner), dialog: s(dialog, LIMITS.dialog) };
	},
	"dialog-answer": (b) => {
		const [id, digest, answer, answerId] = dec(b, 4) as [Buffer, Buffer, Buffer, Buffer];
		return { dialogId: s(id), digest: s(digest), answer: s(answer, LIMITS.dialog), answerId: s(answerId) };
	},
	"dialog-close": (b) => {
		const [id, by] = dec(b, 2) as [Buffer, Buffer];
		return { dialogId: s(id), by: s(by) };
	},
	"unit-status": (b) => {
		const fields = dec(b);
		if (fields.length !== 1 && fields.length !== 2) throw new CanonError(`a unit-status has 1 or 2 fields, got ${fields.length}`);
		const [units, mains] = fields as [Buffer, Buffer | undefined];
		const out: Plaintexts["unit-status"] = { units: readList(units).map((u) => {
			const [unit, state, monitors, report] = dec(u, 4) as [Buffer, Buffer, Buffer, Buffer];
			return { unit: s(unit), state: s(state), monitors: readList(monitors).map((m) => s(m)), report: s(report, LIMITS.report) };
		}) };
		if (mains) {
			out.mains = readList(mains).slice(0, LIMITS.mains).map((m) => {
				const fields = dec(m);
				if (fields.length !== 6 && fields.length !== 7) throw new CanonError(`a main has 6 or 7 fields, got ${fields.length}`);
				const [handle, unit, name, state, by, stopping, kind] = fields as [Buffer, Buffer, Buffer, Buffer, Buffer, Buffer, Buffer | undefined];
				return { handle: s(handle), unit: s(unit), name: cutChars(readStr(name), LIMITS.boardLabel), state: s(state), by: s(by), stopping: readBool(stopping), ...(kind ? { kind: s(kind, LIMITS.mainKind) } : {}) };
			});
		}
		return out;
	},
	notice: (b) => {
		const fields = dec(b);
		if (fields.length !== 3 && fields.length !== 4) throw new CanonError(`a notice has 3 or 4 fields, got ${fields.length}`);
		const [kind, unit, text, ref] = fields as [Buffer, Buffer, Buffer, Buffer | undefined];
		const out: Notice = { kind: s(kind), unit: s(unit), text: s(text, LIMITS.noticeText) };
		if (ref) {
			const id = readStr(ref);
			if (!askIdOk(id)) throw new CanonError("a notice's ref is an ask id, 32 lowercase hex digits");
			out.ref = id;
		}
		return out;
	},
	caps: (b) => {
		const [features] = dec(b, 1) as [Buffer];
		return { features: readList(features).slice(0, LIMITS.capsFeatures).map((f) => s(f)) };
	},
	"tower-reply": (b) => {
		const [inReplyTo, text] = dec(b, 2) as [Buffer, Buffer];
		return { inReplyTo: s(inReplyTo), text: s(text, LIMITS.towerText) };
	},
	"unit-stop": (b) => {
		const [stopId, handle, mode, reason] = dec(b, 4) as [Buffer, Buffer, Buffer, Buffer];
		const id = readStr(stopId), h = readStr(handle);
		if (!askIdOk(id)) throw new CanonError("a stop id is 32 lowercase hex digits");
		if (!handleOk(h)) throw new CanonError("a main's handle is 16 lowercase hex digits");
		return { stopId: id, handle: h, mode: s(mode), reason: oneLine(readStr(reason)) };
	},
	operate: (b) => {
		const [v, session, type, body] = dec(b, 4) as [Buffer, Buffer, Buffer, Buffer];
		if (readInt(v) !== OPERATE_VERSION) throw new CanonError("an operate message is version 1");
		if (!sessionOk(session)) throw new CanonError("a session id is 16 bytes");
		const base = { session };
		switch (readStr(type)) {
			case "open": {
				const [eph, caps, want] = dec(body, 3) as [Buffer, Buffer, Buffer], w = readStr(want);
				if (eph.length !== 32) throw new CanonError("an ephemeral key is 32 bytes");
				if (w !== "team" && w !== "box") throw new CanonError("want is team or box");
				return { ...base, type: "open", eph, caps: readList(caps).slice(0, LIMITS.capsFeatures).map((c) => s(c)), want: w };
			}
			case "accept": {
				const [eph, openHash, scope, limits] = dec(body, 4) as [Buffer, Buffer, Buffer, Buffer];
				if (eph.length !== 32 || openHash.length !== 32) throw new CanonError("a key and a hash are 32 bytes");
				const [teams, box] = dec(scope, 2) as [Buffer, Buffer], [mirrors, watches, budget] = dec(limits, 3) as [Buffer, Buffer, Buffer];
				const ids = readList(teams).slice(0, LIMITS.operateTeams);
				if (ids.some((t) => t.length !== 16)) throw new CanonError("a team id is 16 bytes");
				return { ...base, type: "accept", eph, openHash, scope: { teams: ids, box: readBool(box) }, limits: { mirrors: readInt(mirrors), watches: readInt(watches), budget: readInt(budget) } };
			}
			case "refuse": return { ...base, type: "refuse", reason: s((dec(body, 1) as [Buffer])[0]) };
			case "frame": {
				const [ctr, ct] = dec(body, 2) as [Buffer, Buffer], n = readInt(ctr);
				if (n < 1) throw new CanonError("a frame counter starts at 1");
				if (ct.length < 16 || ct.length > LIMITS.operateFrame) throw new CanonError("a frame's ciphertext holds a tag and at most 200 KB");
				return { ...base, type: "frame", ctr: n, ct };
			}
			case "close": return { ...base, type: "close", reason: s((dec(body, 1) as [Buffer])[0]) };
			default: throw new CanonError("an operate type this build does not know");
		}
	},
};

export const encodePlaintext = <K extends Kind>(kind: K, plain: Plaintexts[K]): Buffer => (encoders[kind] as (p: Plaintexts[K]) => Buffer)(plain);
/** The plaintext of `kind`, or null when its bytes are not that kind's structure. */
export function decodePlaintext<K extends Kind>(kind: K, bytes: Buffer): Plaintexts[K] | null {
	try {
		return (decoders[kind] as (b: Buffer) => Plaintexts[K])(bytes);
	} catch {
		return null;
	}
}
