import { bool, cutBytes, cutChars, dec, enc, int, list, readBool, readInt, readList, readStr, str } from "./canon.ts";

// The message kinds of docs/specs/2026-10-25-straw-link.md (Message kinds): who may send each, whether it is ephemeral or goes to the
// whole team, and its plaintext as a canonical structure. Every text field is cut to its limit, on the way out and on the way in, and a
// plaintext never becomes a header.

export type Kind = "tower" | "presence" | "confirm-request" | "confirm-answer" | "dialog-open" | "dialog-answer" | "dialog-close" | "unit-status" | "notice";
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
	"confirm-request": { ephemeral: false, wholeTeam: false, sender: "any" },
	"confirm-answer": { ephemeral: false, wholeTeam: false, sender: "any" },
	"dialog-open": { ephemeral: false, wholeTeam: false, sender: "unattended" },
	"dialog-answer": { ephemeral: false, wholeTeam: false, sender: "attended" },
	"dialog-close": { ephemeral: false, wholeTeam: false, sender: "unattended" },
	"unit-status": { ephemeral: true, wholeTeam: false, sender: "unattended" },
	notice: { ephemeral: false, wholeTeam: false, sender: "unattended" },
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
} as const;
const short = (s: string) => cutBytes(s, LIMITS.short);

export interface TowerMessage { fromWorkspace: string; toWorkspace: string; replyExpected: boolean; text: string }
export interface TabState { label: string; state: string }
export interface WorkspaceState { label: string; tower: string; tabs: TabState[] }
export interface Presence { label: string; headSeq: number; headHash: Buffer; workspaces: WorkspaceState[] }
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
	"confirm-request": ConfirmRequest;
	"confirm-answer": ConfirmAnswer;
	"dialog-open": DialogOpen;
	"dialog-answer": DialogAnswer;
	"dialog-close": DialogClose;
	"unit-status": { units: UnitStatus[] };
	notice: Notice;
}

// `toWorkspace` is empty when absent: a workspace label is never empty.
const encoders: { [K in Kind]: (p: Plaintexts[K]) => Buffer } = {
	tower: (p) => enc(str(short(p.fromWorkspace)), str(short(p.toWorkspace)), bool(p.replyExpected), str(cutBytes(p.text, LIMITS.towerText))),
	presence: (p) => enc(str(short(p.label)), int(p.headSeq), p.headHash, list(p.workspaces.map((w) => enc(str(short(w.label)), str(short(w.tower)), list(w.tabs.map((t) => enc(str(short(t.label)), str(short(t.state))))))))),
	"confirm-request": (p) => enc(str(short(p.dialogId)), str(short(p.digest)), str(short(p.tool)), str(cutChars(p.args, LIMITS.toolArguments)), str(short(p.tower))),
	"confirm-answer": (p) => enc(str(short(p.dialogId)), str(short(p.digest)), bool(p.allow), str(short(p.answerId))),
	"dialog-open": (p) => enc(str(short(p.dialogId)), str(short(p.digest)), str(short(p.owner)), str(cutBytes(p.dialog, LIMITS.dialog))),
	"dialog-answer": (p) => enc(str(short(p.dialogId)), str(short(p.digest)), str(cutBytes(p.answer, LIMITS.dialog)), str(short(p.answerId))),
	"dialog-close": (p) => enc(str(short(p.dialogId)), str(short(p.by))),
	"unit-status": (p) => enc(list(p.units.map((u) => enc(str(short(u.unit)), str(short(u.state)), list(u.monitors.map((m) => str(short(m)))), str(cutBytes(u.report, LIMITS.report)))))),
	notice: (p) => enc(str(short(p.kind)), str(short(p.unit)), str(cutBytes(p.text, LIMITS.noticeText))),
};

// Decoding cuts again, so a sender that skipped its own limits is held to them. A structure that is malformed throws CanonError.
const s = (f: Buffer, max: number = LIMITS.short) => cutBytes(readStr(f), max);
const decoders: { [K in Kind]: (b: Buffer) => Plaintexts[K] } = {
	tower: (b) => {
		const [from, to, reply, text] = dec(b, 4) as [Buffer, Buffer, Buffer, Buffer];
		return { fromWorkspace: s(from), toWorkspace: s(to), replyExpected: readBool(reply), text: s(text, LIMITS.towerText) };
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
