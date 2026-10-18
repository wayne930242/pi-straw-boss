import { type FileHandle, open } from "node:fs/promises";
import { basename } from "node:path";

// Session entries as displayable items: what the chat shows for each kind of entry, with previews capped so a page stays small.
// `full` lifts the caps for the one-entry fetch (thinking text, whole tool result, images).

const PREVIEW = 2048, FULL = 1 << 20, TEXT = 100_000, LAST_BYTES = 65_536;
export const FULL_LIMIT = FULL;

export interface Tool { id: string; name: string; summary: string; args?: string; cut?: true }
export interface Item {
	id: string; kind: "user" | "assistant" | "result" | "bash" | "notice" | "divider" | "meta"; at?: string; text?: string; more?: boolean; images?: number; pics?: string[];
	thought?: number; thoughtText?: string; tools?: Tool[]; model?: string; stop?: string; error?: string; ctx?: number;
	callId?: string; name?: string; isError?: boolean; bytes?: number; command?: string; exit?: number; type?: string; from?: string; link?: string; tokens?: number;
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
			return { ...base, kind: "notice", type: d.customType, text: clip(textOf(d.content), full ? FULL : 600), from: d.details?.from?.name ?? d.details?.name, link: typeof sessionFile === "string" ? idOf(sessionFile) : undefined };
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

