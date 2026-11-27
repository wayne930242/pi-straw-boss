import { COORDINATOR_DUTIES, GRAPHS, WORKER_DUTIES } from "../duty.ts";
import { sanitize as mirrorRow } from "../mirror.ts";
import type { Base, Net, Outpost, Tab, TowerService, Unit } from "../net.ts";
import { type TrainId, trainFromToken } from "../trainrole.ts";
import { UNIT_ROLES } from "./operateroles.ts";

// What the controller lets through from an operate box (docs/specs/2026-11-07-link-operate.md §6.4): the box is treated as hostile, so everything it sends is rebuilt field by field from a schema before any page sees it.
// Known fields only (anything else is dropped, never passed on); every string is plain text (controls, bidi overrides and invisible characters become spaces, or go) with a length of its own; marks, roles and states come from their enums;
// a unit key is refused when it names a path segment `..` or `.`, holds a backslash or a control, or is over 200 characters, and what is refused takes its subtree with it; images are `image/png|jpeg|gif|webp` under 1 MB with the
// bytes the type says; `then` in an answer's reply is limited to `terminal` and `run`, never `pane`; a reply's status is a number from 200 to 599 and its body under 1 MB. Documents never cross: a card keeps its names and its `cap` is empty.
// Every id the page uses is rewritten: a unit key to `x<16 hex of sha256(box ‖ box key)>` (the same for the same unit in every session of that box, so a unit two sessions show is one unit), a base id and a tab id the same, each with its own tag (a tab's also with its workspace). The team is in none of the hashes (§11.3), so one box shows one key for a unit in every team's session. No box key reaches a URL, and no id from the box is one the page can point at a local unit.

/** What the sanitizer needs from its host: the rewrite of the ids of one (box, team), and a place to say that a field was refused. */
export interface Rewrite {
	key(raw: string): string;
	base(raw: string): string;
	tab(ws: string, raw: string): string;
	/** Told once for each thing dropped: a short word (`key`, `shape`, `image`), never content. */
	bad(why: string): void;
}

export const MAX_REPLY_BYTES = 1024 * 1024, MAX_IMAGE_BYTES = 1024 * 1024;
const MARKS = ["working", "waiting", "idle", "done", "error", "unknown", "commanding"] as const;
const TOWER_STATES = ["standing", "waking", "running", "closing", "held"] as const;

// C0 and C1 controls, soft hyphen and other invisibles, line and paragraph separators, bidi overrides and isolates, zero-width characters and variation selectors, tag characters (the set kinds.ts cleans a stop reason with).
const INVISIBLE_CLASS = "\\u0000-\\u001f\\u007f-\\u009f\\u00ad\\u034f\\u061c\\u115f\\u1160\\u17b4\\u17b5\\u180b-\\u180f\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u206f\\u3164\\ufe00-\\ufe0f\\ufeff\\uffa0\\u{e0000}-\\u{e0fff}";
const INVISIBLE = new RegExp(`[${INVISIBLE_CLASS}]`, "gu"), HAS_INVISIBLE = new RegExp(`[${INVISIBLE_CLASS}]`, "u");
/** The same without tab (\\u0009) and line feed (\\u000a), which a multi-line text keeps. */
const INVISIBLE_KEEP_BREAKS = new RegExp(`[${INVISIBLE_CLASS.replace("\\u0000-\\u001f", "\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f")}]`, "gu");

/** Plain text: on one line every control becomes a space; with `multi` line breaks (`\n`) and tabs stay and `\r` goes. Cut to `max` characters. */
export function plain(text: string, max: number, multi = false): string {
	const clean = multi ? text.replace(/\r\n?/g, "\n").replace(INVISIBLE_KEEP_BREAKS, "") : text.replace(INVISIBLE, " ");
	return clean.length <= max ? clean : [...clean].slice(0, max).join("");
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const own = (o: Record<string, unknown>, k: string) => Object.hasOwn(o, k);

/** A parser: the value rebuilt, or undefined when it is not one of the shape. */
type P<T> = (v: unknown, rw: Rewrite) => T | undefined;
const str = (max: number, multi = false): P<string> => (v) => (typeof v === "string" ? plain(v, max, multi) : undefined);
const int = (min: number, max: number): P<number> => (v) => (typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max ? v : undefined);
const num: P<number> = (v) => (typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 1e15 ? v : undefined);
const bool: P<boolean> = (v) => (typeof v === "boolean" ? v : undefined);
const yes: P<true> = (v) => (v === true ? true : undefined);
const lit = <T extends string>(...values: readonly T[]): P<T> => (v) => (values.includes(v as T) ? (v as T) : undefined);
const hex = (n: number): P<string> => (v) => (typeof v === "string" && new RegExp(`^[0-9a-f]{${n}}$`).test(v) ? v : undefined);
/** A list: an item that does not parse is left out; not a list is no list. */
const list = <T>(item: P<T>, max: number): P<T[]> => (v, rw) => (Array.isArray(v) ? v.slice(0, max).flatMap((x) => { const r = item(x, rw); return r === undefined ? [] : [r]; }) : undefined);
/** An object of known fields: a required field that does not parse refuses the object; an optional one is left out. */
const shape = <T>(required: Record<string, P<unknown>>, optional: Record<string, P<unknown>> = {}): P<T> => (v, rw) => {
	if (!isObj(v)) return undefined;
	const out: Record<string, unknown> = {};
	for (const [k, p] of Object.entries(required)) {
		const r = own(v, k) ? p(v[k], rw) : undefined;
		if (r === undefined) return undefined;
		out[k] = r;
	}
	for (const [k, p] of Object.entries(optional)) if (own(v, k)) { const r = p(v[k], rw); if (r !== undefined) out[k] = r; }
	return out as T;
};

/** A key the box names a unit by, as the page will know it; refused for what could walk a path or break a line. */
export function keyOk(raw: unknown): raw is string {
	if (typeof raw !== "string" || !raw || raw.length > 200 || HAS_INVISIBLE.test(raw) || raw.includes("\\")) return false;
	return !raw.split("/").some((part) => part === ".." || part === ".");
}
const key: P<string> = (v, rw) => (keyOk(v) ? rw.key(v) : (rw.bad("key"), undefined));
/** A workspace or tab id of the box: plain, and rewritten; it names a workspace in a request only through the controller's table. */
const idOk = (raw: unknown): raw is string => keyOk(raw);
const ws: P<string> = (v, rw) => (idOk(v) ? rw.base(v) : (rw.bad("key"), undefined));

const mark = lit(...MARKS);
const queued = shape<{ text: string; as: "steer" | "followUp" | "start"; why?: "off" | "refused" | "full" | "offline" | "unproven" }>({ text: str(16_384, true), as: lit("steer", "followUp", "start") }, { why: lit("off", "refused", "full", "offline", "unproven") });
const monitor = shape({ id: str(64), what: str(160), status: lit("running", "done", "error", "stale", "stopped"), lines: int(0, 1e9), at: num }, { exit: num, last: str(160), ended: num, load: shape<{ max: number; now: number }>({ max: num, now: num }) });
const todoSum = shape({ done: int(0, 1e6), total: int(0, 1e6) }, { now: str(160), graph: lit(...GRAPHS) });
const ticks = list(shape({ at: num, mark }), 24);
const lately = { since: num, ticks, todo: todoSum };
const option = shape({ title: str(200) }, { description: str(600), preview: yes });
const ask = shape({ question: str(4000, true), options: list(option, 50), multiple: bool, freeform: bool }, { header: str(200), context: str(8000, true) });
const choice = shape({ label: str(300) }, { note: str(600), localOnly: yes, hereOnly: yes, next: lit("terminal", "pane"), tagged: yes });
const selectShape = shape<{ title: string; choices: unknown[]; copy?: string; confirm?: true }>({ title: str(600, true), choices: list(choice, 20) }, { copy: str(4000, true), confirm: yes });
/** The text Copy command puts on this computer's clipboard comes from the box: it is offered only when it is the whole title the page shows, on one line (the button shows no text of its own, and a title box scrolls), so what is copied is what was read (a box cannot show `ls` and copy a script). */
const select: P<unknown> = (v, rw) => {
	const r = selectShape(v, rw);
	if (r?.copy === undefined || (!/[\r\n\t]/.test(r.copy) && r.title === r.copy)) return r;
	rw.bad("copy");
	const { copy: _copy, ...rest } = r;
	return rest;
};
const question = shape({ question: str(4000, true), multiple: bool, options: list(option, 50) }, { header: str(200) });
const answerable = shape({ dialog: str(64), digest: hex(64) }, { select, questions: list(question, 8), twin: yes, cancel: yes });
const pending = shape({ callId: str(200), tool: str(200) }, { ask, asks: list(ask, 4), why: str(600), answer: answerable });
/** A shelf's cards keep their names; `cap` is what opens a document, and nothing crosses (decision 12). */
const doc = shape<{ display: string; kind: "html" | "text" | "blocks"; reason: string; revision: number; onScreen: boolean; cap: string }>({ display: str(1024), kind: lit("html", "text", "blocks"), reason: str(2048, true), revision: int(1, 1e9), onScreen: bool });
const shelf = { docs: (v: unknown, rw: Rewrite) => { const r = list(doc, 64)(v, rw); return r?.map((d) => ({ ...d, cap: "" })); }, docsCut: yes };

/** A wait card's address (wait-cards spec, Security): `http:` or `https:` with no userinfo, on one line and at most 300 characters; anything else is no address, and the card shows without one. */
const waitUrl: P<string> = (v) => {
	if (typeof v !== "string" || v.length > 300 || /\s/u.test(v) || HAS_INVISIBLE.test(v)) return undefined;
	try {
		const u = new URL(v);
		return (u.protocol === "http:" || u.protocol === "https:") && !u.username && !u.password ? v : undefined;
	} catch {
		return undefined;
	}
};
/** A command the boss runs themselves: at most 300 characters in at most 4 lines; shown as text with a copy button and never run. */
const waitCommand: P<string> = (v, rw) => { const r = str(300, true)(v, rw); return r !== undefined && r.split("\n").length <= 4 ? r : undefined; };
const waitOption = shape({ label: str(24), then: str(120) });
const waitFrom = shape({ name: str(200), role: str(40) }, { workspace: str(200), tab: str(200), gone: yes, key });
const waitCard = shape({ type: lit("action", "choice", "secret"), lang: lit("zh-TW", "en"), happened: str(160), do: str(160) }, { url: waitUrl, command: waitCommand, after: str(160), options: list(waitOption, 4), secret: shape({ name: str(60) }), from: waitFrom });
const waitPress = shape({ act: lit("done", "choose", "secret", "decline", "restate"), at: str(64) }, { option: int(0, 3), reason: str(600, true), main: shape({ status: lit("delivered", "queued", "gone", "failed"), at: str(64) }), secretAsked: str(64) });
/** A wait for the boss as the net shows it (net.ts `BossWait`): the card, the press, and the end of a resolved one cross like any other field, so a box's resolved wait is not shown open and a card is not shown as a wait written before cards. */
const bossWait = shape({ id: str(64), text: str(2000, true), at: str(64) }, { answered: str(64), state: lit("resolved"), outcome: str(200), ended: str(64), card: waitCard, press: waitPress, cut: yes });

const memory = shape({ rev: int(0, 1e9), standing: int(0, 1e6), decisions: int(0, 1e6), waits: int(0, 1e6), bossWaits: list(bossWait, 50), proposals: list(shape({ id: str(64), op: lit("add", "retire"), kind: lit("standing", "decision"), text: str(2000, true) }, { target: str(64), cites: str(200) }), 50) }, { problem: str(600, true) });
const conversation = shape({ since: str(64), resumed: bool, turns: int(0, 1e9), idle: bool, idleMs: num, capAt: num }, { why: str(200), idleAt: num, closing: yes });
const service: P<TowerService> = shape(
	{ state: lit(...TOWER_STATES), queued: int(0, 1e6), allyRuns: list(shape({ id: str(64), device: str(64), label: str(80), startedAt: str(64) }, { key }), 50), notices: list(shape({ id: str(64), level: lit("info", "warning", "error"), kind: str(64), text: str(1000, true), at: num }, { detail: str(1000, true) }), 50), parked: list(shape({ id: str(64), kind: str(64), first: str(64) }, { from: str(80) }), 50) },
	{ memory, run: shape({ id: str(64), kind: lit("local", "ally"), startedAt: str(64) }), conversation, bossIn: shape({ id: str(64), since: str(64) }), localRuns: list(shape({ id: str(64), kind: lit("conversation", "event"), startedAt: str(64) }, { resumed: bool, why: str(200), endedAt: str(64), outcome: str(200), note: str(600, true), key }), 50), lastRun: shape({ endedAt: str(64), outcome: str(200) }), crashes: int(0, 1e6) },
);

/** A train's project and code (`sb_train`): the pair must read back as a token, so nothing path-like or free text passes. */
const trainId: P<TrainId> = (v) => (isObj(v) && typeof v.project === "string" && typeof v.code === "string" ? trainFromToken(`${v.project}/${v.code}`) : undefined);
const unit: P<Unit> = (v, rw) => depth(v, rw, 0);
function depth(v: unknown, rw: Rewrite, level: number): Unit | undefined {
	const head = shape<Omit<Unit, "subs">>({ id: key, key, control: bool, name: str(200), role: lit("main", "member", "train", "subagent", "outside"), mark }, { train: trainId, duty: lit(...COORDINATOR_DUTIES, ...WORKER_DUTIES), note: str(300), pending, ended: yes, queued: list(queued, 50), monitors: list(monitor, 8), ...lately, ...shelf })(v, rw);
	if (!head) return undefined;
	const raw = (v as Record<string, unknown>).subs;
	return { ...head, id: head.key, subs: level >= 2 || !Array.isArray(raw) ? [] : raw.slice(0, 64).flatMap((s) => { const r = depth(s, rw, level + 1); return r ? [r] : []; }) } as Unit;
}
const tab = (ws_: string): P<Tab> => (v, rw) => {
	if (!isObj(v) || !idOk(v.id)) return undefined;
	const units = list(unit, 64)(v.units, rw), label = str(200)(v.label, rw);
	return units && label !== undefined ? { id: rw.tab(ws_, v.id), label, units } : undefined;
};
const outpost = shape<Outpost>({ id: ws, label: str(200), mark }, { ...lately });
const towerOf: P<NonNullable<Base["tower"]>> = (v, rw) => {
	const head = shape<Omit<NonNullable<Base["tower"]>, "subs">>({ name: str(200), mark, key, control: bool }, { service, pending, queued: list(queued, 50), monitors: list(monitor, 8), ...lately, ...shelf })(v, rw);
	if (!head || !isObj(v)) return undefined;
	return { ...head, subs: list(unit, 64)(v.subs, rw) ?? [] } as NonNullable<Base["tower"]>;
};

/** One base of the box's net, ids rewritten. A base whose id is refused is dropped; a tower that does not parse is none. */
function base(v: unknown, rw: Rewrite): Base | undefined {
	if (!isObj(v)) return (rw.bad("shape"), undefined);
	const id = ws(v.id, rw), label = str(200)(v.label, rw), m = mark(v.mark, rw);
	if (id === undefined || label === undefined || m === undefined) return undefined;
	const tower = v.tower === null || v.tower === undefined ? null : (towerOf(v.tower, rw) ?? null);
	return { id, label, mark: m, tower, tabs: list(tab(String(v.id)), 64)(v.tabs, rw) ?? [], outposts: list(outpost, 32)(v.outposts, rw) ?? [], outside: list(unit, 64)(v.outside, rw) ?? [] };
}
const event = shape<NonNullable<Net["events"]>[number]>({ at: num, ws, name: str(200), mark, kind: lit("joined", "mark", "left", "duty") }, { key, from: lit(...COORDINATOR_DUTIES), to: lit(...COORDINATOR_DUTIES) });

/** A snapshot from a box: its bases and events, or undefined when it is not a net. Nothing else of it (`link`, `stashed`, `trust`, `head`) is kept. */
export function sanitizeNet(raw: unknown, rw: Rewrite): Net | undefined {
	if (!isObj(raw) || !Array.isArray(raw.bases)) return (rw.bad("shape"), undefined);
	const bases = raw.bases.slice(0, 64).flatMap((b) => { const r = base(b, rw); return r ? [r] : []; });
	const events = Array.isArray(raw.events) ? list(event, 80)(raw.events, rw) : undefined;
	return { bases, ...(events?.length ? { events } : {}) };
}

// --- what a watch and a mirror send back ---------------------------------------------------------------------------------------------------------------------------------------------

const MAGIC: Record<string, (b: Buffer) => boolean> = {
	"image/png": (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
	"image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
	"image/gif": (b) => b.subarray(0, 4).toString("latin1") === "GIF8",
	"image/webp": (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP",
};
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
/** An image as `{type, base64}`: one of four types, base64, at most 1 MB decoded, and the type's own first bytes. */
export function sanitizeImage(raw: unknown): { type: string; bytes: Buffer } | undefined {
	if (!isObj(raw) || typeof raw.type !== "string" || typeof raw.base64 !== "string" || !own(MAGIC, raw.type) || raw.base64.length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4 || !BASE64.test(raw.base64)) return undefined;
	const bytes = Buffer.from(raw.base64, "base64");
	return bytes.length > 0 && bytes.length <= MAX_IMAGE_BYTES && MAGIC[raw.type]!(bytes) ? { type: raw.type, bytes } : undefined;
}
/** A picture of an entry as a data URL: the same four types (`jpg` too, as the reader names it), under 1 MB. */
const pic: P<string> = (v) => {
	const hit = typeof v === "string" && v.length <= Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 40 ? /^data:image\/(png|jpeg|jpg|gif|webp);base64,([A-Za-z0-9+/]*={0,2})$/.exec(v) : null;
	if (!hit) return undefined;
	const bytes = Buffer.from(hit[2]!, "base64");
	return bytes.length > 0 && bytes.length <= MAX_IMAGE_BYTES && MAGIC[`image/${hit[1] === "jpg" ? "jpeg" : hit[1]}`]!(bytes) ? (v as string) : undefined;
};
const tool = shape({ id: str(200), name: str(200), summary: str(2000, true) }, { args: str(1 << 20, true), cut: yes });
const item = shape({ id: str(200), kind: lit("user", "assistant", "result", "bash", "notice", "divider", "meta") }, {
	at: str(64), text: str(1 << 20, true), more: bool, images: int(0, 1000), pics: list(pic, 16), thought: int(-1, 1e9), thoughtText: str(1 << 20, true), tools: list(tool, 100), model: str(200), stop: str(40), error: str(4000, true), ctx: num,
	callId: str(200), name: str(200), isError: bool, bytes: num, command: str(400, true), exit: num, type: str(64), from: str(80), link: str(200), tokens: num, event: str(20), code: str(20),
});
/** A date as ISO, from a string `Date.parse` reads: no other text passes as a todo's `until`. */
const iso: P<string> = (v) => (typeof v === "string" && v.length <= 64 && Number.isFinite(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : undefined);
// A todo keeps its plan fields (gui/plangraph.ts draws the box's plan from them; a box on an older build sends some or none, and the page draws the checklist): who works on it and its Herdr child (a unit key, rewritten as every key is), the ids it waits on, the plan's graph, its defer.
const todo = shape({ id: int(0, 1e9), subject: str(300), status: lit("pending", "in_progress", "completed") }, { activeForm: str(120), owner: str(64), agent: (v, rw) => (keyOk(v) ? rw.key(v) : undefined), blockedBy: list(int(0, 1e9), 50), graph: lit(...GRAPHS), waitsOn: str(64), until: iso });
const itemList = list(item, 300);

/** A history event for a unit's watch: a page of items (a reset, with the unit's state) or a change; `key` is the page's own key for it. */
export function sanitizeHistory(raw: unknown, rw: Rewrite): unknown {
	return shape({ key, items: itemList, reset: bool }, { state: lit("live", "recent", "unknown"), successor: key, base: ws, name: str(200), role: str(40), before: str(200), header: shape({}, { id: str(200), cwd: str(1024) }), unreadable: int(0, 1e9), todos: (v, r) => (v === null ? (null as unknown as undefined) : list(todo, 200)(v, r)) })(raw, rw);
}
/** The last line of each session of a workspace, by unit key. */
export function sanitizeCards(raw: unknown, rw: Rewrite): Record<string, string> | undefined {
	if (!isObj(raw)) return undefined;
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(raw).slice(0, 200)) {
		const text = typeof v === "string" ? plain(v, 240, true) : undefined;
		if (text !== undefined && keyOk(k)) out[rw.key(k)] = text;
		else rw.bad("key");
	}
	return out;
}
/** A terminal frame: rows of SGR text (mirror.ts `sanitize` again), at most 120 of them, or `hidden`, or `ended` with its reason. */
export function sanitizeMirror(raw: unknown, rw: Rewrite): Record<string, unknown> | undefined {
	if (!isObj(raw) || !keyOk(raw.key)) return (rw.bad("key"), undefined);
	const k = rw.key(raw.key);
	if (typeof raw.ended === "string") return { key: k, ended: plain(raw.ended, 200) };
	if (raw.hidden === true) return { key: k, hidden: true };
	const seq = int(0, 2 ** 40)(raw.seq, rw), rows = int(0, 120)(raw.rows, rw), cols = int(0, 1000)(raw.cols, rw);
	if (seq === undefined || rows === undefined || cols === undefined || !Array.isArray(raw.set) || raw.set.length > 120) return (rw.bad("shape"), undefined);
	const set: [number, string][] = [];
	for (const pair of raw.set) {
		if (!Array.isArray(pair) || pair.length !== 2 || !Number.isInteger(pair[0]) || pair[0] < 0 || pair[0] >= 120 || typeof pair[1] !== "string") return (rw.bad("shape"), undefined);
		set.push([pair[0], mirrorRow(pair[1].slice(0, 20_000))]);
	}
	return { key: k, seq, rows, cols, ...(raw.whole === true ? { whole: true } : {}), set };
}

// --- what a request's answer is ------------------------------------------------------------------------------------------------------------------------------------------------------

/** Where a request goes, which decides the shape its answer may have. */
export type ReplyKind = "history" | "entry" | "image" | "input" | "keys" | "answer" | "dequeue" | "commands" | "upload" | "mirror" | "plain" | "memory" | "transcripts";
const errorBody = shape<{ error: string; reason: string }>({ error: str(64), reason: str(2000, true) }, { why: str(40), confirm: str(64), key: str(64), label: str(64) });
const then = (v: unknown) => {
	if (!isObj(v)) return undefined;
	// Never `pane` (decision 8): such a pane would run a shell, and nothing of it opens from here.
	return v.terminal === true ? { terminal: true as const, ...(v.run === true ? { run: true as const } : {}) } : undefined;
};
/** A finished run of the box's ledger (§9): its `id` becomes the page's key for the run's transcript (`t<id>` on the box), so the page reads it through `api/history` like any unit. */
const finishedRun: P<unknown> = (v, rw) => {
	const base = shape<{ id: string; name: string; role: string; workspace: string; first: number; last: number; size: number; dispatcher?: string }>({ id: hex(16), name: str(200), role: lit(...UNIT_ROLES), workspace: str(200), first: num, last: num, size: int(0, 1e12) }, { dispatcher: str(100) })(v, rw);
	if (!base) return undefined;
	const { id, ...rest } = base;
	return { key: rw.key(`t${id}`), ...rest };
};
/** The cursor of the next page of finished runs: the box's is `<last>:<its ledger id>`, and the id is a key like the rows' (the box's own id is never passed on): the page gets `<last>:<key of the last row>` and gives it back as it is. */
const cursor: P<string> = (v, rw) => {
	const m = typeof v === "string" ? /^(\d{1,16}):([0-9a-f]{16})$/.exec(v) : null;
	return m ? `${m[1]}:${rw.key(`t${m[2]}`)}` : undefined;
};
const bodyOf: Record<ReplyKind, P<unknown>> = {
	transcripts: shape({ rows: list(finishedRun, 50) }, { before: cursor }),
	history: shape({ items: itemList }, { before: str(200) }),
	entry: item,
	image: () => undefined, // an image never takes this path (sanitizeImage)
	input: shape({ accepted: bool }, { woke: bool, answered: (v) => (v === false ? false : typeof v === "string" ? plain(v, 64) : undefined) }),
	keys: shape({ accepted: bool }),
	answer: (v, rw) => {
		const base = shape<{ outcome: string; reason?: string; by?: string }>({ outcome: str(64) }, { reason: str(600, true), by: str(64) })(v, rw);
		if (!base) return undefined;
		const given = isObj(v) ? v.then : undefined, kept = then(given);
		if (given !== undefined && !kept) rw.bad("then");
		return { ...base, ...(kept ? { then: kept } : {}) };
	},
	dequeue: (v, rw) => shape({ text: str(1 << 16, true) })(v, rw) ?? shape({ empty: yes })(v, rw),
	commands: shape({ commands: (v, rw) => (v === null ? (null as unknown as undefined) : list(shape({ name: str(100), source: lit("extension", "prompt", "skill") }, { description: str(500) }), 200)(v, rw)) }),
	upload: shape({ path: str(1024) }),
	mirror: shape({ attached: bool }),
	plain: shape({}, { closed: int(0, 1e6), closing: bool, left: bool, fresh: bool, dismissed: int(0, 1e6) }),
	memory: (v) => generic(v, 0),
};
/** A bounded JSON value for the one reply whose shape the controller does not know (the tower's memory panel): depth, sizes and key names are held, and nothing else is. */
function generic(v: unknown, level: number): unknown {
	if (v === null || typeof v === "boolean") return v;
	if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
	if (typeof v === "string") return plain(v, 4000, true);
	if (level >= 5) return undefined;
	if (Array.isArray(v)) return v.slice(0, 200).map((x) => generic(x, level + 1)).filter((x) => x !== undefined);
	if (!isObj(v)) return undefined;
	const out: Record<string, unknown> = {};
	for (const [k, x] of Object.entries(v).slice(0, 64)) {
		const r = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(k) ? generic(x, level + 1) : undefined;
		if (r !== undefined) out[k] = r;
	}
	return out;
}

export type Sanitized = { ok: true; status: number; body: unknown } | { ok: false; why: string };
/**
 * A request's answer from the box. The status is 200 to 599 and the whole body under 1 MB (checked on what arrived, before any of it is read); an image keeps its bytes for the caller to serve, not a data URL. A refusal (`>= 400`) has the
 * error shape, whatever the route. An answer that does not fit its shape is not passed on: the page gets a 502 from the host instead.
 */
export function sanitizeReply(kind: ReplyKind, status: unknown, body: unknown, rw: Rewrite): Sanitized {
	if (typeof status !== "number" || !Number.isInteger(status) || status < 200 || status > 599) return { ok: false, why: "status" };
	let size = 0;
	try {
		size = Buffer.byteLength(JSON.stringify(body) ?? "");
	} catch {
		return { ok: false, why: "shape" };
	}
	if (size > MAX_REPLY_BYTES) return { ok: false, why: "size" };
	if (status >= 400) {
		const e = errorBody(body, rw);
		return e ? { ok: true, status, body: e } : { ok: false, why: "shape" };
	}
	if (kind === "image") {
		const pic_ = sanitizeImage(body);
		return pic_ ? { ok: true, status, body: pic_ } : { ok: false, why: "image" };
	}
	const out = bodyOf[kind](body, rw);
	return out === undefined ? { ok: false, why: "shape" } : { ok: true, status, body: out };
}
