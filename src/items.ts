import { type FileHandle, open } from "node:fs/promises";
import { basename } from "node:path";
import { type Graph, graphOf, isGraph } from "./duty.ts";
import { cleanLabel } from "./eventmarks.ts";
import { MAX_SB_BYTES, tooDeep } from "./train/spec.ts";

// Session entries as displayable items: what the chat shows for each kind of entry, with previews capped so a page stays small.
// `full` lifts the caps for the one-entry fetch (thinking text, whole tool result, images).

const PREVIEW = 2048, FULL = 1 << 20, TEXT = 100_000, LAST_BYTES = 65_536;
export const FULL_LIMIT = FULL;

export interface Tool { id: string; name: string; summary: string; args?: string; cut?: true }
/** One task of a session's todo list, as pi-todo-ledger (its `todo/v1` entries) or @juicesharp/rpiv-todo (its snapshot entries and todo results) keeps it; deleted ones are left out. */
export interface Todo { id: number; subject: string; status: "pending" | "in_progress" | "completed"; activeForm?: string; /** A train's step (`metadata.sb`), bounded: see `stepInfo`. */ sb?: StepInfo; /** The plan's graph: the todo's own `graph` (pi-todo-ledger 0.4.0, a name of `GRAPHS` exactly), else a legacy `metadata.graph` through `graphOf`, when the todo names one. */ graph?: Graph; /** Who works on it (rpiv-todo's `owner`), the ids it waits on, and its capacity points (`metadata.points`, else the ledger's own `points`, 0 to 10; capacity.ts). */ owner?: string; blockedBy?: number[]; points?: number; /** A deferred todo (prompts/planning.md "Defer"): who it waits on (`metadata.waitsOn`, cut to 64) and until when (`metadata.until`, a date `Date.parse` reads, as ISO). */ waitsOn?: string; until?: string; /** The ledger's `uid` (`t_` and ten base32 characters), and the Herdr child that works on it (pi-todo-ledger 0.5.0 `metadata.herdr.id`, the net's key of that subagent), kept only while `metadata.herdr.name` is the todo's `owner`: an update of the owner alone leaves the old binding behind (T1-F001). */ uid?: string; agent?: string; anchor?: string; evidence?: { command: string; result: "pass" | "fail"; sha?: string; at: string } }
/** What the page keeps of a step's `metadata.sb` (docs/specs/2026-11-07-train-workers.md §11.1): its kind and name, whose it is, the check's type, what it holds and needs, and how it ended; never a command, a path, or evidence text. */
export interface StepInfo {
	kind: string; name?: string; project?: string; app?: string; train?: string; round?: number; check?: string;
	holds?: { lane?: string; target?: string }; load?: { max?: number; perCore?: number; weight?: number }; lock?: string; outcome?: "passed" | "failed" | "void"; why?: "superseded" | "skipped";
}
const STATUSES = new Set(["pending", "in_progress", "completed"]), UID = /^t_[a-z2-7]{10}$/, AGENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const obj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const cut = (v: unknown, n: number) => (typeof v === "string" && v ? v.slice(0, n) : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
/** The members of `from` named in `keys` that `read` accepts, or nothing when none is. */
function pick<T>(from: unknown, keys: string[], read: (v: unknown) => T | undefined): Record<string, T> | undefined {
	const out: Record<string, T> = {};
	if (obj(from)) for (const key of keys) { const v = read(from[key]); if (v !== undefined) out[key] = v; }
	return Object.keys(out).length ? out : undefined;
}
/** The page's view of `metadata.sb`: known keys only, strings cut to their caps, and nothing at all for a value over 8 KB, nested over 32 levels, or without a kind in words. */
export function stepInfo(metadata: unknown): StepInfo | undefined {
	const sb = obj(metadata) ? metadata.sb : undefined;
	if (!obj(sb) || tooDeep(sb)) return undefined;
	let bytes: number;
	try { bytes = Buffer.byteLength(JSON.stringify(sb)); } catch { return undefined; }
	const kind = cut(sb.kind, 32);
	if (bytes > MAX_SB_BYTES || !kind) return undefined;
	const spec = obj(sb.spec) ? sb.spec : {}, check = obj(spec.check) ? spec.check : {}, result = obj(sb.result) ? sb.result : {};
	const info: StepInfo = { kind }, put = <K extends keyof StepInfo>(key: K, value: StepInfo[K] | undefined) => void (value !== undefined && (info[key] = value));
	put("name", cut(sb.name, 64)); put("project", cut(sb.project, 64)); put("app", cut(sb.app, 64)); put("train", cut(sb.train, 16)); put("round", num(sb.round)); put("check", cut(check.type, 16));
	put("holds", pick(spec.holds, ["lane", "target"], (v) => cut(v, 64))); put("load", pick(spec.load, ["max", "perCore", "weight"], num)); put("lock", cut(spec.lock, 32));
	if (["passed", "failed", "void"].includes(result.outcome as string)) put("outcome", result.outcome as StepInfo["outcome"]);
	if (["superseded", "skipped"].includes(result.why as string)) put("why", result.why as StepInfo["why"]);
	return info;
}
/** Capacity points: a number from 0 to 10, else none. */
const pointsOf = (v: unknown) => (typeof v === "number" && v >= 0 && v <= 10 ? v : undefined);
/** The open tasks of a todo snapshot (`{ tasks, nextId }`), checked field by field; anything else is no list. */
export function todosOf(snapshot: unknown): Todo[] | undefined {
	const s = snapshot as { tasks?: unknown; nextId?: unknown } | undefined;
	if (!s || !Array.isArray(s.tasks) || typeof s.nextId !== "number") return undefined;
	return s.tasks.slice(0, 200).flatMap((t: Json) => {
		if (!(typeof t?.id === "number" && typeof t.subject === "string" && STATUSES.has(t.status))) return [];
		const sb = stepInfo(t.metadata), graph = isGraph(t.graph) ? t.graph : obj(t.metadata) ? graphOf(t.metadata.graph) : undefined, points = pointsOf(obj(t.metadata) ? t.metadata.points : undefined) ?? pointsOf(t.points);
		const e = Array.isArray(t.evidence) ? t.evidence.at(-1) : undefined;
		const evidence = e && typeof e.command === "string" && (e.result === "pass" || e.result === "fail") && typeof e.at === "string" && Number.isFinite(Date.parse(e.at)) ? { command: e.command.slice(0, 500), result: e.result, at: e.at, ...(typeof e.sha === "string" && { sha: e.sha.slice(0, 7) }) } : undefined;
		const md = obj(t.metadata) ? t.metadata : {}, herdr = obj(md.herdr) ? md.herdr : {}, owner = typeof t.owner === "string" ? t.owner.trim() : "", agent = owner && typeof herdr.name === "string" && herdr.name.trim() === owner && typeof herdr.id === "string" && AGENT.test(herdr.id) ? herdr.id : undefined, waitsOn = typeof md.waitsOn === "string" ? md.waitsOn.trim().slice(0, 64) : "", until = typeof md.until === "string" && md.until.length <= 64 && Number.isFinite(Date.parse(md.until)) ? new Date(Date.parse(md.until)).toISOString() : undefined;
		return [{ ...(typeof t.anchor === "string" && t.anchor && { anchor: t.anchor.slice(0, 500) }), ...(evidence && { evidence }), id: t.id, subject: t.subject.slice(0, 300), status: t.status, ...(typeof t.activeForm === "string" && { activeForm: t.activeForm.slice(0, 120) }), ...(sb && { sb }), ...(graph && { graph }), ...(owner && { owner: owner.slice(0, 64) }), ...(typeof t.uid === "string" && UID.test(t.uid) && { uid: t.uid }), ...(agent && { agent }), ...(Array.isArray(t.blockedBy) && { blockedBy: t.blockedBy.filter(Number.isSafeInteger).slice(0, 50) }), ...(points !== undefined && { points }), ...(waitsOn && { waitsOn }), ...(until && { until }) }];
	});
}
export interface Item {
	id: string; kind: "user" | "assistant" | "result" | "bash" | "notice" | "divider" | "meta"; at?: string; text?: string; more?: boolean; images?: number; pics?: string[];
	thought?: number; thoughtText?: string; tools?: Tool[]; model?: string; stop?: string; error?: string; ctx?: number;
	callId?: string; name?: string; isError?: boolean; bytes?: number; command?: string; exit?: number; type?: string; from?: string; link?: string; tokens?: number; /** A `straw-tower` message: what the sb server sent it as (`details.kind`: boss, intercom, notice, timer, link), or `steer`. */ event?: string; /** A chapter divider's reason code: first, new, size, or unreadable. */ code?: string;
}
export interface Json { [key: string]: any } // eslint-disable-line @typescript-eslint/no-explicit-any -- session entries are untrusted JSON, read defensively

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);
const first = (v: unknown, n = 160) => clip(String(v ?? "").split("\n")[0] ?? "", n);
const blocks = (c: unknown): Json[] => (Array.isArray(c) ? c : []);
const textOf = (c: unknown) => (typeof c === "string" ? c : blocks(c).filter((b) => b?.type === "text").map((b) => String(b.text)).join("\n"));
export const parse = (s: string): Json | undefined => {
	try {
		return JSON.parse(s);
	} catch {
		return undefined;
	}
};
const pics = (c: unknown) => blocks(c).filter((b) => b?.type === "image" && /^image\/(png|jpe?g|gif|webp)$/.test(b.mimeType)).map((b) => `data:${b.mimeType};base64,${b.data}`);
const idOf = (file: string) => basename(file, ".jsonl").split("_").pop()!;

/** What a question tool asks, in one line: the questions' headers when each has one (short enough for a phone), else the first question. */
const asked = (qs: Json[], heads = qs.map((q) => (typeof q?.header === "string" ? first(q.header.trim()).trim() : ""))) => (qs.length && heads.every(Boolean) ? first(heads.join(" · ")) : first(qs[0]?.question) + (qs.length > 1 ? ` (+${qs.length - 1} more)` : ""));

function toolLine(name: string, a: Json): string {
	switch (name) {
		case "bash": return first(a.command);
		case "read": case "edit": case "write": return first(a.path ?? a.file_path);
		case "subagent": case "subagent_resume": return [a.name, a.agent].filter(Boolean).join(" · ");
		case "intercom": return [a.action, a.to, first(a.message, 80)].filter(Boolean).join(" ");
		// A model may give `questions` as a JSON string; one that is not JSON shows as written.
		case "ask_user": case "ask_user_question": { const qs = typeof a.questions === "string" ? (parse(a.questions) ?? a.questions) : a.questions; return Array.isArray(qs) ? asked(qs) : qs && typeof qs === "object" ? asked([qs]) : qs !== undefined && typeof a.questions === "string" ? first(a.questions) : asked([a]); }
		case "show_doc": return first([a.paths].flat().join(", "));
		case "boss_duty": return [a.duty, first(a.reason, 120)].filter(Boolean).join(" · ");
		case "todo": return [a.action, first(a.subject ?? a.id, 80)].filter(Boolean).join(" ");
		case "MonitorCreate": return first(a.description ?? a.command);
		// Another tool shows its first plain argument by name; one with only structured arguments shows their names, never "[object Object]".
		default: { const plain = Object.entries(a).find(([, v]) => ["string", "number", "boolean"].includes(typeof v)); return `(${first(plain ? `${plain[0]}: ${plain[1]}` : Object.keys(a).join(", "), 100)})`; }
	}
}

/** A tool call: its line, and its arguments up to `cap` (`cut` when longer; the one-entry fetch carries them whole). */
const tool = (b: Json, cap: number, args = JSON.stringify(b.arguments ?? {}, null, 1)): Tool => ({ id: b.id, name: b.name, summary: toolLine(b.name, b.arguments ?? {}), args: clip(args, cap), ...(args.length > cap ? { cut: true as const } : {}) });
/** One session entry as an item, or undefined for kinds the chat does not show. `full` lifts the preview caps (thinking text, whole tool result). */
export function toItem(d: Json, len: number, full = false): Item | undefined {
	const base = { id: String(d.id), at: d.timestamp as string | undefined };
	const m: Json = d.message ?? {}, limit = full ? FULL : PREVIEW;
	const preview = (s: string, kind: "result" | "bash") => ({ text: clip(s, limit), more: s.length > limit, ...(kind === "result" ? { bytes: len } : {}) });
	switch (d.type === "message" ? m.role : d.type) {
		case "user": return { ...base, kind: "user", text: clip(textOf(m.content), TEXT), images: blocks(m.content).filter((b) => b?.type === "image").length, ...(full ? { pics: pics(m.content) } : {}) };
		case "assistant": {
			const thinking = blocks(m.content).filter((b) => b?.type === "thinking");
			const thought = thinking.reduce((n, b) => n + String(b.thinking ?? "").length, 0);
			const tools = blocks(m.content).filter((b) => b?.type === "toolCall").map((b): Tool => tool(b, full ? FULL : 1500));
			const stop = ["error", "aborted", "length"].includes(m.stopReason) ? m.stopReason : undefined;
			return { ...base, kind: "assistant", text: clip(textOf(m.content), TEXT), thought: thought || (thinking.length ? -1 : undefined), ...(full ? { thoughtText: thinking.map((b) => b.thinking).join("\n\n") } : {}), tools, model: m.model, stop, error: m.errorMessage, ctx: m.usage?.totalTokens };
		}
		case "toolResult": return { ...base, kind: "result", callId: m.toolCallId, name: m.toolName, isError: Boolean(m.isError), images: blocks(m.content).filter((b) => b?.type === "image").length, ...(full ? { pics: pics(m.content) } : {}), ...preview(textOf(m.content), "result") };
		case "bashExecution": return { ...base, kind: "bash", command: first(m.command, 400), exit: m.exitCode, ...preview(String(m.output ?? ""), "bash") };
		case "custom_message": {
			if (!d.display) return undefined;
			const sessionFile = d.details?.sessionFile;
			const named = d.details?.from?.name ?? d.details?.name;
			// The sender of a tower run's event or a link message is a device label or a session name another party chose: cleaned as the server's own sender line is, and cut.
			const from = typeof named === "string" ? ((d.customType === "straw-tower" || d.customType === "straw-link" ? cleanLabel(named) : clip(named, 80)) || undefined) : undefined;
			const event = d.customType === "straw-tower" ? (d.details?.steer === true ? "steer" : d.details?.kind) : undefined;
			return { ...base, kind: "notice", type: d.customType, text: clip(textOf(d.content), full ? FULL : 600), from, link: typeof sessionFile === "string" ? idOf(sessionFile) : undefined, ...(typeof event === "string" ? { event: clip(event, 20) } : {}) };
		}
		case "compaction": return { ...base, kind: "divider", type: "compaction", tokens: d.tokensBefore, text: clip(String(d.summary ?? ""), full ? FULL : 600) };
		case "branch_summary": return { ...base, kind: "divider", type: "branch", text: clip(String(d.summary ?? ""), full ? FULL : 600) };
		case "model_change": return { ...base, kind: "meta", text: `model ${d.provider}/${d.modelId}` };
		case "thinking_level_change": return { ...base, kind: "meta", text: `thinking ${d.thinkingLevel}` };
		case "session_info": return { ...base, kind: "meta", text: `session named ${d.name}` };
		default: return undefined;
	}
}

/** The last assistant text of a session file, from its last 64 KB: what a workspace card shows. */
export async function lastLine(file: string): Promise<string> {
	let fh: FileHandle | undefined;
	try {
		fh = await open(file, "r");
		const { size } = await fh.stat(), start = Math.max(0, size - LAST_BYTES), buf = Buffer.alloc(size - start);
		await fh.read(buf, 0, buf.length, start);
		for (const line of buf.toString("utf8").split("\n").slice(start ? 1 : 0).reverse()) {
			const text = textOf((line.includes('"role":"assistant"') ? parse(line) : undefined)?.message?.content).trim().split("\n").filter(Boolean).at(-1);
			if (text) return clip(text, 240);
		}
	} catch {} // an unreadable or missing file simply has no last line
	finally {
		await fh?.close();
	}
	return "";
}

