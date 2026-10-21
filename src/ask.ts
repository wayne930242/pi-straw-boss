import { open, stat } from "node:fs/promises";
import { commanding } from "./dashboard.ts";
import { type Json, parse } from "./items.ts";
import type { Net, Queued, Unit } from "./net.ts";
import type { Answerable, Dialog } from "./owners.ts";
import type { Monitor } from "./monitors.ts";

// What a waiting session waits on: the current branch's newest assistant message's tool call with no result yet, read from the end of
// its session file. The snapshot carries it so the alert and the session view can show an ask_user question (its context and options).
// A dialog the session's bridge relays (bridge.ts, dialogs.ts) joins it as `answer` when the page may answer it; nothing here sends anything.
// Two tools are read: pi-ask-user's `ask_user` (one question with a context) and @juicesharp/rpiv-ask-user-question's `ask_user_question` (one to four questions
// with a header, options with descriptions, and a multi-select flag; no context). Older session files hold the first, new ones the second.

const TAIL = 262_144, LIMIT = 16_777_216, CACHE = new Map<string, { sig: string; pending?: Pending; calls: OpenCall[]; secret: boolean }>();
export interface Option { title: string; description?: string }
/** `multiple`: it takes several choices; `freeform`: it takes the user's own words; `header`: the short tag ask_user_question gives a question. */
export interface Ask { question: string; header?: string; context?: string; options: Option[]; multiple: boolean; freeform: boolean }
/** What a waiting session waits on: `ask` for one question, `asks` for two to four (ask_user_question), else `why` there is nothing to show; `answer` when the page may answer it (never a secret: SB-F001). */
export interface Pending { callId: string; tool: string; ask?: Ask; asks?: Ask[]; why?: string; answer?: Answerable }
export const SEVERAL = "It waits on more than one dialog.";
interface Call { id: string; name: string; args: Json }
/** An open tool call of the newest assistant message: what a dialog that names its `toolCallId` is bound to. */
export interface OpenCall { id: string; name: string }

const clip = (v: unknown, n: number) => String(v ?? "").slice(0, n);
const TITLES = ["title", "label", "text", "value", "name", "option"];
/** pi-ask-user's coerceOption: a plain value, or an object with one of its title keys and an optional description. */
const option = (o: unknown): Option | undefined => {
	if (["string", "number", "boolean"].includes(typeof o)) return String(o).trim() ? { title: clip(String(o).trim(), 200) } : undefined;
	const r = (o && typeof o === "object" ? o : {}) as Json, title = TITLES.map((k) => r[k]).find((v) => typeof v === "string" && v.trim());
	return title ? { title: clip(title.trim(), 200), ...(typeof r.description === "string" && r.description.trim() ? { description: clip(r.description, 600) } : {}) } : undefined;
};

/**
 * The unanswered tool calls of the current branch's newest assistant message, none once a user message follows it. The branch is the path
 * from the file's last entry up through parentId (pi's own rule, as history.ts reads it), so a branch left behind never shows. The window is
 * the file's last 256 KB; when the path leaves it before reaching a decisive entry (one very long call), the window grows to `LIMIT`, and
 * past that the answer is "cut".
 */
export async function openCalls(file: string): Promise<Call[] | "cut"> {
	const fh = await open(file, "r");
	try {
		const { size } = await fh.stat();
		for (let span = TAIL; ; span *= 4) {
			const start = Math.max(0, size - span), buf = Buffer.alloc(size - start);
			await fh.read(buf, 0, buf.length, start);
			const found = walk(buf.toString("utf8").split("\n").slice(start ? 1 : 0), start > 0);
			if (found !== "cut" || span >= LIMIT) return found;
		}
	} finally {
		await fh.close();
	}
}
const LINK = /"id":"([^"]+)","parentId":(?:null|"([^"]*)")/;
function walk(lines: string[], partial: boolean): Call[] | "cut" {
	const entries = new Map<string, { parent?: string; m?: Json }>();
	let leaf: string | undefined;
	for (const line of lines) {
		const link = LINK.exec(line.slice(0, 300)) ?? LINK.exec(line.slice(-200));
		if (!link) continue;
		leaf = link[1]!;
		entries.set(leaf, { parent: link[2], m: line.includes('"message"') ? parse(line)?.message : undefined });
	}
	const answered = new Set<string>();
	for (let at = leaf, steps = 0; at && steps++ <= entries.size; at = entries.get(at)!.parent) { // a path longer than the file has a cycle: nothing decisive
		const e = entries.get(at);
		if (!e) return partial ? "cut" : [];
		const m = e.m;
		if (m?.role === "toolResult") answered.add(String(m.toolCallId));
		if (m?.role === "user") return [];
		if (m?.role === "assistant") return (Array.isArray(m.content) ? m.content : []).filter((b: Json) => b?.type === "toolCall" && !answered.has(String(b.id))).map((b: Json) => ({ id: String(b.id), name: String(b.name), args: b.arguments ?? {} }));
	}
	return partial && !leaf ? "cut" : [];
}

/** The question to show, or why there is none. Shown as plain text; the page never turns it into markup. */
export function askOf(a: Json): { ask: Ask } | { why: string } {
	if (Array.isArray(a.questions)) return { why: "It asks several questions at once." };
	if (typeof a.question !== "string" || !a.question.trim()) return { why: "Its question could not be read." };
	const options = (Array.isArray(a.options) ? a.options : []).map(option).filter((o: Option | undefined): o is Option => Boolean(o)).slice(0, 50);
	const context = typeof a.context === "string" && a.context.trim() ? clip(a.context.trim(), 8000) : undefined;
	return { ask: { question: clip(a.question, 2000), ...(context && { context }), options, multiple: a.allowMultiple === true, freeform: !options.length || a.allowFreeform !== false } };
}

/** ask_user_question's questions: one reads like an ask_user question, two to four come as a list; "Type something." is always offered, so its own words are always taken. */
export function questionsOf(a: Json): { ask: Ask } | { asks: Ask[] } | { why: string } {
	const asks: Ask[] = [];
	for (const q of (Array.isArray(a.questions) ? a.questions : []).slice(0, 4)) {
		if (typeof q?.question !== "string" || !q.question.trim()) return { why: "Its question could not be read." };
		const options = (Array.isArray(q.options) ? q.options : []).map(option).filter((o: Option | undefined): o is Option => Boolean(o)).slice(0, 50);
		asks.push({ question: clip(q.question, 2000), ...(typeof q.header === "string" && q.header.trim() ? { header: clip(q.header.trim(), 40) } : {}), options, multiple: q.multiSelect === true, freeform: true });
	}
	return asks.length === 1 ? { ask: asks[0]! } : asks.length ? { asks } : { why: "Its question could not be read." };
}

/** What a waiting session waits on, for the snapshot; cached while the file is unchanged. */
export const pendingOf = async (file: string) => (await pendingWith(file)).pending;
/** `pendingOf`, with every open call of the file (several when the newest assistant message made more than one call that is still unanswered). */
async function pendingWith(file: string): Promise<{ pending?: Pending; calls: OpenCall[] }> {
	const s = await stat(file).catch(() => undefined), sig = s ? `${s.size}:${s.mtimeMs}` : "", hit = CACHE.get(file);
	if (hit?.sig === sig) return hit;
	const found = s ? await openCalls(file).catch(() => null) : [], calls = !found || found === "cut" ? [] : found, [c] = calls;
	const shape = c?.name === "ask_user" ? askOf(c.args) : c?.name === "ask_user_question" ? questionsOf(c.args) : { why: c?.name === "secret_drop" ? "It waits for a secret." : "It waits on a dialog." };
	const pending = found === "cut" ? { callId: `cut:${sig}`, tool: "dialog", why: "Its call is too long to read here." } : c && { callId: c.id, tool: c.name, ...(calls.length > 1 ? { why: SEVERAL } : shape) };
	const entry = { sig, pending, calls: calls.map((x) => ({ id: x.id, name: x.name })), secret: !found || found === "cut" || calls.some((x) => x.name === "secret_drop") }; // a file it could not read through counts as a secret
	CACHE.set(file, entry);
	if (CACHE.size > 64) CACHE.delete(CACHE.keys().next().value!);
	return entry;
}
/** Whether one of the file's open calls is secret_drop (or the file could not be read through; a missing one, a new session, is not): the terminal mirror hides, and the key pad sends only Escape, while it is. */
export const waitsForSecret = async (file: string) => (await pendingOf(file), CACHE.get(file)?.secret !== false); // dropped from the cache meanwhile: hidden until the next look

/** The dialogs bridges relay, by unit key, and how they join what the file says (dialogs.ts); `docsOf`, the documents they list. */
export interface Relayed { dialogsOf(key: string): Dialog[] | undefined; merge(key: string, file: Pending | undefined, dialogs: Dialog[], readable: boolean, calls?: OpenCall[]): Pending; docsOf?(key: string): Pick<Unit, "docs" | "docsCut"> | undefined; queuedOf?(key: string): Queued[] | undefined; monitorsOf?(key: string): Monitor[] | undefined }

const unitsOf = (b: Net["bases"][number]) => [...(b.tower ? [b.tower, ...b.tower.subs] : []), ...[...b.tabs.flatMap((t) => t.units), ...b.outside].flatMap((u) => [u, ...u.subs])];
/** Adds what each waiting unit waits on, and the documents each unit shows, to a snapshot. A unit with a relayed dialog waits even before Herdr reports its pane blocked. */
export async function withPending(net: Net, fileOf: (key: string) => string | undefined, relayed?: Relayed): Promise<Net> {
	const jobs: Promise<unknown>[] = [];
	for (const b of net.bases)
		for (const u of unitsOf(b)) {
			const dialogs = relayed?.dialogsOf(u.key);
			Object.assign(u, relayed?.docsOf?.(u.key));
			const queued = relayed?.queuedOf?.(u.key);
			if (queued?.length) u.queued = queued;
			const monitors = relayed?.monitorsOf?.(u.key); if (monitors?.length) u.monitors = monitors;
			if (u.mark === "idle" && monitors?.some((x) => x.status === "running")) [u.mark, b.mark, (u as Unit).note] = ["commanding", b.mark === "waiting" ? b.mark : "working", "watching a monitor"]; // idle with a running monitor: it will wake
			if (dialogs?.length) [u.mark, b.mark] = ["waiting", "waiting"];
			if (dialogs?.length && u !== b.tower) (u as Unit).note = "waiting on a question";
			const file = u.mark === "waiting" ? fileOf(u.key) : undefined;
			const join = (p?: Pending, calls?: OpenCall[]) => (dialogs?.length ? relayed!.merge(u.key, p, dialogs, Boolean(file), calls) : p);
			if (file) jobs.push(pendingWith(file).then(({ pending, calls }) => (u.pending = join(pending, calls))));
			else if (dialogs?.length) u.pending = join();
		}
	// A unit that is idle while a subagent of it commands (by a monitor above) commands too.
	for (const b of net.bases) for (const u of unitsOf(b)) u.mark = commanding(u.mark, u.subs.map((c) => c.mark));
	await Promise.all(jobs);
	return net;
}
