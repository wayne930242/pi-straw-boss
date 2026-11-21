import { type FileHandle, open } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bossTurn } from "../eventmarks.ts";
import { type Json, parse, toItem } from "../items.ts";
import { type BossPointer, resumable, type Resume, type ResumeEnv } from "./bossconv.ts";
import type { Slot } from "./record.ts";
import { ensureDir, HEAD_KEY, towerDir, writeDurable } from "./towerstore.ts";

// The head tower's one conversation (docs/specs/2026-11-04-head-tower.md, Runs): every run resumes the pi session `boss-session.json` names, with no age limit. A session that grows past `HEAD_CHAPTER_MAX`, the boss's
// `/new`, or a failed check starts a new **chapter**: a new session file whose brief opens with why and with the last lines between the boss and the head. `chapters.json` lists the files, oldest first, for the history.

export const HEAD_CHAPTER_MAX = 8 * 1024 * 1024;
/** At most this many chapters are listed; an older one is dropped from the list, not deleted. */
const KEEP = 50;
/** The recap of the last conversation: this many lines, and this many characters together. */
const RECAP_LINES = 8, RECAP_CHARS = 2000, TAIL_BYTES = 262_144;

export interface Chapter { n: number; file: string; from: string; to?: string; why: string }

const chaptersFile = (slot: Slot) => join(towerDir(slot, HEAD_KEY), "chapters.json");
export function readChapters(slot: Slot): Chapter[] {
	try {
		const list = JSON.parse(readFileSync(chaptersFile(slot), "utf8")) as Chapter[];
		return Array.isArray(list) ? list.filter((c) => Number.isInteger(c?.n) && typeof c.file === "string" && typeof c.from === "string" && typeof c.why === "string") : [];
	} catch {
		return [];
	}
}
/** A chapter begins with this file (an old one ends): once, however often the file is reported. */
export function appendChapter(slot: Slot, now: number, file: string, why: string): Chapter {
	const list = readChapters(slot), last = list.at(-1);
	if (last?.file === file) return last;
	const at = new Date(now).toISOString(), chapter: Chapter = { n: (last?.n ?? 0) + 1, file, from: at, why };
	if (last && !last.to) last.to = at;
	ensureDir(towerDir(slot, HEAD_KEY));
	writeDurable(chaptersFile(slot), [...list, chapter].slice(-KEEP));
	return chapter;
}

/** What the next head run does with its conversation: resume the session, or begin chapter `n` for `why`. */
export type HeadResume = { resumed: true; file: string; n: number } | { resumed: false; n: number; why: string };
/** The head's checks: a boss conversation's, without the age limit and with the chapter size. A pointer the boss marked `/new` begins a chapter for that reason. */
export function headResume(slot: Slot, pointer: BossPointer | undefined, e: Omit<ResumeEnv, "days" | "max">): HeadResume {
	const n = (readChapters(slot).at(-1)?.n ?? 0) + 1;
	if (!pointer) return { resumed: false, n: 1, why: "the first conversation" };
	const got: Resume = pointer.fresh ? { ok: false, why: "the boss asked for a new conversation" } : resumable(pointer, { ...e, days: null, max: HEAD_CHAPTER_MAX });
	return got.ok ? { resumed: true, file: got.file, n: n - 1 } : { resumed: false, n, why: got.why.replace(/^the last session grew/, "the last one grew") };
}

/**
 * The last lines between the boss and the head in a session file, read from its tail: the boss's messages (the events the server marked as his) and the head's replies (the final text of each assistant message), the last eight
 * of them within 2,000 characters, oldest first. A file that cannot be read has none.
 */
export async function recapOf(file: string): Promise<string[]> {
	let fh: FileHandle | undefined;
	try {
		fh = await open(file, "r");
		const { size } = await fh.stat(), start = Math.max(0, size - TAIL_BYTES), buf = Buffer.alloc(size - start);
		await fh.read(buf, 0, buf.length, start);
		const out: string[] = [];
		for (const raw of buf.toString("utf8").split("\n").slice(start ? 1 : 0)) {
			const entry: Json | undefined = raw.includes('"custom_message"') || raw.includes('"assistant"') ? parse(raw) : undefined;
			const item = entry && toItem(entry, raw.length);
			if (!item?.text) continue;
			const boss = item.kind === "notice" && item.type === "straw-tower" && item.event === "boss";
			const text = (boss ? (bossTurn(item.text)?.body ?? item.text) : item.text).replace(/\s+/g, " ").trim();
			if (boss && text) out.push(`boss: ${text}`);
			else if (item.kind === "assistant" && text) out.push(`head: ${text}`);
		}
		const lines = out.slice(-RECAP_LINES).map((l) => (l.length > 400 ? `${l.slice(0, 399)}…` : l));
		while (lines.length > 1 && lines.join("\n").length > RECAP_CHARS) lines.shift();
		return lines.map((l) => (l.length > RECAP_CHARS ? `${l.slice(0, RECAP_CHARS - 1)}…` : l));
	} catch {
		return [];
	} finally {
		await fh?.close();
	}
}
