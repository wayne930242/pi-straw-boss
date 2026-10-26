import { CanonError, bool, cutBytes, cutChars, dec, enc, int, list, readBool, readInt, readList, readStr, str } from "./canon.ts";

// The message kinds of docs/specs/2026-10-25-straw-link.md (Message kinds): who may send each, whether it is ephemeral or goes to the
// whole team, and its plaintext as a canonical structure. Every text field is cut to its limit, on the way out and on the way in, and a
// plaintext never becomes a header.

export type Kind = "tower" | "presence" | "board" | "confirm-request" | "confirm-answer" | "dialog-open" | "dialog-answer" | "dialog-close" | "unit-status" | "notice" | "caps" | "tower-reply";
/** Which devices may send a kind: any member, only an attended one, or only an unattended one. */
export type Sender = "any" | "attended" | "unattended";
export interface KindRule { ephemeral: boolean; wholeTeam: boolean; sender: Sender }

/**
 * The rule of each kind. The ephemeral flag is fixed here, never chosen by the sender. `dialog-answer` is the one kind with a sender rule
 * the spec leaves implicit: a controller answers, and nobody answers at an unattended device, so it takes only attended senders.
 */
export const KINDS: Record<Kind, KindRule> = {
	tower: { ephemeral: false, wholeTeam: false, sender: "any" },
	presence: { ephemeral: true, wholeTeam: true, sender: "any" },
	board: { ephemeral: true, wholeTeam: true, sender: "any" },
	"confirm-request": { ephemeral: false, wholeTeam: false, sender: "any" },
	"confirm-answer": { ephemeral: false, wholeTeam: false, sender: "any" },
	"dialog-open": { ephemeral: false, wholeTeam: false, sender: "unattended" },
	"dialog-answer": { ephemeral: false, wholeTeam: false, sender: "attended" },
	"dialog-close": { ephemeral: false, wholeTeam: false, sender: "unattended" },
	"unit-status": { ephemeral: true, wholeTeam: false, sender: "unattended" },
	notice: { ephemeral: false, wholeTeam: false, sender: "unattended" },
	caps: { ephemeral: true, wholeTeam: true, sender: "any" },
	"tower-reply": { ephemeral: false, wholeTeam: false, sender: "any" },
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
} as const;
const short = (s: string) => cutBytes(s, LIMITS.short);

/** `awaitsReply` is the optional fifth field: an ask id, 16 random bytes in hex. Written only to a device whose `caps` list `tower.awaitsReply`. */
export interface TowerMessage { fromWorkspace: string; toWorkspace: string; replyExpected: boolean; text: string; awaitsReply?: string }
export interface Caps { features: string[] }
export interface TowerReply { inReplyTo: string; text: string }
/** An ask id as it travels. */
export const askIdOk = (id: string): boolean => /^[0-9a-f]{32}$/.test(id);
export interface TabState { label: string; state: string }
export interface WorkspaceState { label: string; tower: string; tabs: TabState[] }
export interface Presence { label: string; headSeq: number; headHash: Buffer; workspaces: WorkspaceState[] }
/** One main's work board entry as it crosses the wire: `id` is the first 8 bytes of sha256(device id ‖ session id), hex, so no local session id leaves the computer. */
export interface BoardWireEntry { id: string; workspace: string; tab: string; name: string; now: string; updated: number; items: { t: string; done: boolean }[] }
export interface Board { entries: BoardWireEntry[] }
export interface ConfirmRequest { dialogId: string; digest: string; tool: string; args: string; tower: string }
export interface ConfirmAnswer { dialogId: string; digest: string; allow: boolean; answerId: string }
export interface DialogOpen { dialogId: string; digest: string; owner: string; dialog: string }
export interface DialogAnswer { dialogId: string; digest: string; answer: string; answerId: string }
export interface DialogClose { dialogId: string; by: string }
export interface UnitStatus { unit: string; state: string; monitors: string[]; report: string }
export interface Notice { kind: string; unit: string; text: string }

export interface Plaintexts {
	tower: TowerMessage;
	presence: Presence;
	board: Board;
	"confirm-request": ConfirmRequest;
	"confirm-answer": ConfirmAnswer;
	"dialog-open": DialogOpen;
	"dialog-answer": DialogAnswer;
	"dialog-close": DialogClose;
	"unit-status": { units: UnitStatus[] };
	notice: Notice;
	caps: Caps;
	"tower-reply": TowerReply;
}

// `toWorkspace` is empty when absent: a workspace label is never empty.
const encoders: { [K in Kind]: (p: Plaintexts[K]) => Buffer } = {
	tower: (p) => {
		const fields = [str(short(p.fromWorkspace)), str(short(p.toWorkspace)), bool(p.replyExpected), str(cutBytes(p.text, LIMITS.towerText))];
		if (p.awaitsReply !== undefined) {
			if (!askIdOk(p.awaitsReply)) throw new RangeError("an ask id is 32 lowercase hex digits");
			fields.push(str(p.awaitsReply));
		}
		return enc(...fields);
	},
	presence: (p) => enc(str(short(p.label)), int(p.headSeq), p.headHash, list(p.workspaces.map((w) => enc(str(short(w.label)), str(short(w.tower)), list(w.tabs.map((t) => enc(str(short(t.label)), str(short(t.state))))))))),
	board: (p) => enc(list(p.entries.slice(0, LIMITS.boardEntries).map((e) => enc(
		str(short(e.id)), str(cutChars(e.workspace, LIMITS.boardLabel)), str(cutChars(e.tab, LIMITS.boardLabel)), str(cutChars(e.name, LIMITS.boardLabel)), str(cutChars(e.now, LIMITS.boardNow)), int(e.updated),
		list(e.items.slice(0, LIMITS.boardItems).map((i) => enc(str(cutChars(i.t, LIMITS.boardItem)), bool(i.done)))),
	)))),
	"confirm-request": (p) => enc(str(short(p.dialogId)), str(short(p.digest)), str(short(p.tool)), str(cutChars(p.args, LIMITS.toolArguments)), str(short(p.tower))),
	"confirm-answer": (p) => enc(str(short(p.dialogId)), str(short(p.digest)), bool(p.allow), str(short(p.answerId))),
	"dialog-open": (p) => enc(str(short(p.dialogId)), str(short(p.digest)), str(short(p.owner)), str(cutBytes(p.dialog, LIMITS.dialog))),
	"dialog-answer": (p) => enc(str(short(p.dialogId)), str(short(p.digest)), str(cutBytes(p.answer, LIMITS.dialog)), str(short(p.answerId))),
	"dialog-close": (p) => enc(str(short(p.dialogId)), str(short(p.by))),
	"unit-status": (p) => enc(list(p.units.map((u) => enc(str(short(u.unit)), str(short(u.state)), list(u.monitors.map((m) => str(short(m)))), str(cutBytes(u.report, LIMITS.report)))))),
	notice: (p) => enc(str(short(p.kind)), str(short(p.unit)), str(cutBytes(p.text, LIMITS.noticeText))),
	caps: (p) => enc(list(p.features.slice(0, LIMITS.capsFeatures).map((f) => str(short(f))))),
	// Sending holds `inReplyTo` to an ask id; decoding only cuts it, since a malformed one just matches no ask and the reply is a plain tower.
	"tower-reply": (p) => {
		if (!askIdOk(p.inReplyTo)) throw new RangeError("an ask id is 32 lowercase hex digits");
		return enc(str(p.inReplyTo), str(cutBytes(p.text, LIMITS.towerText)));
	},
};

// Decoding cuts again, so a sender that skipped its own limits is held to them. A structure that is malformed throws CanonError.
const s = (f: Buffer, max: number = LIMITS.short) => cutBytes(readStr(f), max);
const decoders: { [K in Kind]: (b: Buffer) => Plaintexts[K] } = {
	tower: (b) => {
		const fields = dec(b);
		if (fields.length !== 4 && fields.length !== 5) throw new CanonError(`a tower has 4 or 5 fields, got ${fields.length}`);
		const [from, to, reply, text, asked] = fields as [Buffer, Buffer, Buffer, Buffer, Buffer | undefined];
		const out: TowerMessage = { fromWorkspace: s(from), toWorkspace: s(to), replyExpected: readBool(reply), text: s(text, LIMITS.towerText) };
		if (asked) {
			const id = readStr(asked);
			if (!askIdOk(id)) throw new CanonError("an ask id is 32 lowercase hex digits");
			out.awaitsReply = id;
		}
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
		const [entries] = dec(b, 1) as [Buffer];
		return { entries: readList(entries).slice(0, LIMITS.boardEntries).map((e) => {
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
		const [units] = dec(b, 1) as [Buffer];
		return { units: readList(units).map((u) => {
			const [unit, state, monitors, report] = dec(u, 4) as [Buffer, Buffer, Buffer, Buffer];
			return { unit: s(unit), state: s(state), monitors: readList(monitors).map((m) => s(m)), report: s(report, LIMITS.report) };
		}) };
	},
	notice: (b) => {
		const [kind, unit, text] = dec(b, 3) as [Buffer, Buffer, Buffer];
		return { kind: s(kind), unit: s(unit), text: s(text, LIMITS.noticeText) };
	},
	caps: (b) => {
		const [features] = dec(b, 1) as [Buffer];
		return { features: readList(features).slice(0, LIMITS.capsFeatures).map((f) => s(f)) };
	},
	"tower-reply": (b) => {
		const [inReplyTo, text] = dec(b, 2) as [Buffer, Buffer];
		return { inReplyTo: s(inReplyTo), text: s(text, LIMITS.towerText) };
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
