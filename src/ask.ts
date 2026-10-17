import { open, stat } from "node:fs/promises";
import { type Json, parse } from "./items.ts";
import type { Net } from "./net.ts";

// What a waiting session waits on, for display only: its newest assistant message's one tool call with no result yet, read from the end of
// its session file. The snapshot carries it so the alert and the session view can show an ask_user question (its context and options);
// the user answers it in the terminal. Nothing here sends anything: answering from the browser is deferred (see the spec, "Pending dialogs").

const TAIL = 262_144, CACHE = new Map<string, { sig: string; pending?: Pending }>();
export interface Option { title: string; description?: string }
/** `multiple`: it takes several choices; `freeform`: it takes the user's own words. */
export interface Ask { question: string; context?: string; options: Option[]; multiple: boolean; freeform: boolean }
/** What a waiting session waits on: the question when it is one ask_user question, else `why` there is nothing to show. */
export interface Pending { callId: string; tool: string; ask?: Ask; why?: string }
interface Call { id: string; name: string; args: Json }

const clip = (v: unknown, n: number) => String(v ?? "").slice(0, n);
const TITLES = ["title", "label", "text", "value", "name", "option"];
/** pi-ask-user's coerceOption: a plain value, or an object with one of its title keys and an optional description. */
const option = (o: unknown): Option | undefined => {
	if (["string", "number", "boolean"].includes(typeof o)) return String(o).trim() ? { title: clip(String(o).trim(), 200) } : undefined;
	const r = (o && typeof o === "object" ? o : {}) as Json, title = TITLES.map((k) => r[k]).find((v) => typeof v === "string" && v.trim());
	return title ? { title: clip(title.trim(), 200), ...(typeof r.description === "string" && r.description.trim() ? { description: clip(r.description, 600) } : {}) } : undefined;
};

/** The unanswered tool calls of the newest assistant message, read from the file's last 256 KB; none once a user message follows it. */
export async function openCalls(file: string): Promise<Call[]> {
	const fh = await open(file, "r");
	try {
		const { size } = await fh.stat(), start = Math.max(0, size - TAIL), buf = Buffer.alloc(size - start);
		await fh.read(buf, 0, buf.length, start);
		const answered = new Set<string>();
		for (const line of buf.toString("utf8").split("\n").slice(start ? 1 : 0).reverse()) {
			const m = line.includes('"message"') ? parse(line)?.message : undefined;
			if (m?.role === "toolResult") answered.add(String(m.toolCallId));
			if (m?.role === "user") return [];
			if (m?.role === "assistant") return (Array.isArray(m.content) ? m.content : []).filter((b: Json) => b?.type === "toolCall" && !answered.has(String(b.id))).map((b: Json) => ({ id: String(b.id), name: String(b.name), args: b.arguments ?? {} }));
		}
		return [];
	} finally {
		await fh.close();
	}
}

/** The question to show, or why there is none. Shown as plain text; the page never turns it into markup. */
export function askOf(a: Json): { ask: Ask } | { why: string } {
	if (Array.isArray(a.questions)) return { why: "It asks several questions at once." };
	if (typeof a.question !== "string" || !a.question.trim()) return { why: "Its question could not be read." };
	const options = (Array.isArray(a.options) ? a.options : []).map(option).filter((o: Option | undefined): o is Option => Boolean(o)).slice(0, 50);
	const context = typeof a.context === "string" && a.context.trim() ? clip(a.context.trim(), 8000) : undefined;
	return { ask: { question: clip(a.question, 2000), ...(context && { context }), options, multiple: a.allowMultiple === true, freeform: !options.length || a.allowFreeform !== false } };
}

/** What a waiting session waits on, for the snapshot; cached while the file is unchanged. */
export async function pendingOf(file: string): Promise<Pending | undefined> {
	const s = await stat(file).catch(() => undefined), sig = s ? `${s.size}:${s.mtimeMs}` : "", hit = CACHE.get(file);
	if (hit?.sig === sig) return hit.pending;
	const calls = s ? await openCalls(file).catch(() => []) : [], [c] = calls;
	const shape = c?.name === "ask_user" ? askOf(c.args) : { why: c?.name === "secret_drop" ? "It waits for a secret." : "It waits on a dialog." };
	const pending = c && { callId: c.id, tool: c.name, ...(calls.length > 1 ? { why: "It waits on more than one dialog." } : shape) };
	CACHE.set(file, { sig, pending });
	if (CACHE.size > 64) CACHE.delete(CACHE.keys().next().value!);
	return pending;
}

/** Adds what each waiting unit waits on to a snapshot. */
export async function withPending(net: Net, fileOf: (key: string) => string | undefined): Promise<Net> {
	const all = net.bases.flatMap((b) => [...(b.tower ? [b.tower] : []), ...[...b.tabs.flatMap((t) => t.units), ...b.outside].flatMap((u) => [u, ...u.subs])]);
	const jobs: Promise<unknown>[] = [];
	for (const u of all) {
		const file = u.mark === "waiting" ? fileOf(u.key) : undefined;
		if (file) jobs.push(pendingOf(file).then((pending) => pending && (u.pending = pending)));
	}
	await Promise.all(jobs);
	return net;
}
