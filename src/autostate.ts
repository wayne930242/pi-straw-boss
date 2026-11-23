import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Auto mode's state files and the boss's words (docs/specs/2026-11-09-auto-mode.md, §1 and §2). Only the sb server writes them; every session reads `auto.json` (here, synchronously, because pi asks its trust
// question before `session_start`). Pure: no clock, no network.

export const AUTO_FILE = "auto.json", OWN_FILE = "auto-own.json";
export type Via = "pi" | "gui" | "phone" | "head";
/** Who asked, as the request reported it: a session, its pane, and its pid. Never trusted for anything but the record. */
export interface Requester { session?: string; pane?: string; pid?: number }
export interface By { via: Via; name: string; said?: string; requester?: Requester }
/** `auto.json`: the state every session reads. `hash` covers the other fields. */
export interface AutoState { v: 1; rev: number; on: boolean; since?: string; by: By; hash: string }
/** A staged `on` that waits for the boss's confirm (D9). */
export interface Pending { id: string; said: string; from: By; at: number; expires: number }
/** `auto-own.json`: what the server wrote last, so a write that is not its own is told. `prev` is the write before it (a crash between the two files leaves `auto.json` on it). */
export interface Own { v: 1; rev: number; hash: string; state: AutoState; prev?: { rev: number; hash: string }; pending?: Pending; used: { events: string[]; typed: string[] } }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");

/** The hash of every field but itself, in a fixed order. */
export const hashOf = (s: Omit<AutoState, "hash">): string => createHash("sha256").update(JSON.stringify([s.v, s.rev, s.on, s.since ?? null, s.by])).digest("hex");
export const seal = (s: Omit<AutoState, "hash">): AutoState => ({ ...s, hash: hashOf(s) });

function requesterOf(v: unknown): Requester | undefined {
	if (!isRecord(v)) return undefined;
	const out: Requester = { ...(text(v.session, 80) ? { session: text(v.session, 80) } : {}), ...(text(v.pane, 80) ? { pane: text(v.pane, 80) } : {}), ...(Number.isInteger(v.pid) && (v.pid as number) > 0 ? { pid: v.pid as number } : {}) };
	return Object.keys(out).length ? out : undefined;
}
/** A requester as a request reports it (`session`, `pane`, `pid` beside the command), cut to what the record keeps. */
export const requesterFrom = (request: Record<string, unknown>): Requester | undefined => requesterOf(isRecord(request.requester) ? request.requester : request);
export function byOf(v: unknown): By | undefined {
	if (!isRecord(v) || !["pi", "gui", "phone", "head"].includes(String(v.via))) return undefined;
	const requester = requesterOf(v.requester);
	return { via: v.via as Via, name: text(v.name, 80), ...(text(v.said, 200) ? { said: text(v.said, 200) } : {}), ...(requester ? { requester } : {}) };
}

/** A well-formed `auto.json` whose hash holds, or undefined. */
export function parseAuto(raw: string): AutoState | undefined {
	let j: unknown;
	try { j = JSON.parse(raw); } catch { return undefined; }
	if (!isRecord(j) || j.v !== 1 || !Number.isInteger(j.rev) || (j.rev as number) < 0 || typeof j.on !== "boolean" || typeof j.hash !== "string") return undefined;
	const by = byOf(j.by);
	if (!by || (j.since !== undefined && (typeof j.since !== "string" || Number.isNaN(Date.parse(j.since))))) return undefined;
	const state: AutoState = { v: 1, rev: j.rev as number, on: j.on, ...(j.since ? { since: j.since as string } : {}), by, hash: j.hash };
	return hashOf(state) === state.hash ? state : undefined;
}
function pendingOf(v: unknown): Pending | undefined {
	if (!isRecord(v) || typeof v.id !== "string" || !Number.isFinite(v.at) || !Number.isFinite(v.expires)) return undefined;
	const from = byOf(v.from);
	return from ? { id: v.id.slice(0, 64), said: text(v.said, 200), from, at: v.at as number, expires: v.expires as number } : undefined;
}
export function parseOwn(raw: string): Own | undefined {
	let j: unknown;
	try { j = JSON.parse(raw); } catch { return undefined; }
	if (!isRecord(j) || j.v !== 1 || !Number.isInteger(j.rev) || typeof j.hash !== "string" || !isRecord(j.used)) return undefined;
	const state = parseAuto(JSON.stringify(j.state));
	if (!state || state.rev !== j.rev || state.hash !== j.hash) return undefined;
	const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(-500) : []);
	const prev = isRecord(j.prev) && Number.isInteger(j.prev.rev) && typeof j.prev.hash === "string" ? { rev: j.prev.rev as number, hash: j.prev.hash } : undefined;
	const pending = pendingOf(j.pending);
	return { v: 1, rev: j.rev as number, hash: j.hash, state, ...(prev ? { prev } : {}), ...(pending ? { pending } : {}), used: { events: strings(j.used.events), typed: strings(j.used.typed) } };
}

const read = (dir: string, name: string): string | undefined => { try { return readFileSync(join(dir, name), "utf8"); } catch { return undefined; } };
/** What a session sees of auto mode: `unreadable` when the file is there and does not parse or hold its hash (the last good state stays), `missing` when there is none (off). */
export type Seen = { kind: "ok"; state: AutoState } | { kind: "missing" } | { kind: "unreadable" };
export function readAuto(dir: string): Seen {
	const raw = read(dir, AUTO_FILE);
	if (raw === undefined) return { kind: "missing" };
	const state = parseAuto(raw);
	return state ? { kind: "ok", state } : { kind: "unreadable" };
}
export const readOwn = (dir: string): Own | undefined => { const raw = read(dir, OWN_FILE); return raw === undefined ? undefined : parseOwn(raw); };
/** Whether a state is the server's own write: it is the own record's, or the write before it (AM2-F008). */
export const isOwn = (state: AutoState, own: Own | undefined): boolean => Boolean(own && ((state.rev === own.rev && state.hash === own.hash) || (own.prev && state.rev === own.prev.rev && state.hash === own.prev.hash)));

/** The trust question's reading (AM-F010, AM2-F009), before any session starts: auto mode is on only when `auto.json` says so and is the server's own write. Anything else asks as usual. */
export function autoOnForTrust(dir: string): { on: boolean; foreign: boolean } {
	const seen = readAuto(dir);
	if (seen.kind === "missing") return { on: false, foreign: false };
	if (seen.kind === "unreadable") return { on: false, foreign: true };
	const own = readOwn(dir);
	if (!isOwn(seen.state, own)) return { on: false, foreign: seen.state.on };
	// A file on the write before the own record is a crash between the two writes: the own record is the newer truth.
	return { on: (own!.rev === seen.state.rev ? seen.state : own!.state).on, foreign: false };
}

// --- the boss's words (§2) ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export const ON_WORDS = ["我要睡了", "準備休息", "睡前最後一輪", "進入自動模式", "auto mode on"];
export const OFF_WORDS = ["我起床了", "我醒了", "結束自動模式", "auto mode off"];
/** 早安 counts only as the whole line or its start. */
const GREETING = "早安";
const NEGATIONS = ["不要", "先不", "還沒", "不是", "別", "don't", "dont", "not"];
const QUESTION_ENDS = ["嗎", "呢", "?", "？"];
export const LINE_MAX = 2000, SAID_MAX = 200, NEAR = 6;
const fold = (line: string) => line.slice(0, LINE_MAX).toLowerCase().replace(/\s+/g, "");
/** Where a phrase stands in the folded line (every place), as [start, end). */
function spots(folded: string, phrase: string, startOnly = false): [number, number][] {
	const key = phrase.toLowerCase().replace(/\s+/g, ""), out: [number, number][] = [];
	for (let i = folded.indexOf(key); i >= 0; i = folded.indexOf(key, i + 1)) {
		if (startOnly && i !== 0) break;
		out.push([i, i + key.length]);
	}
	return out;
}
/**
 * The boss's words matched against one direction's list. Returns what to keep as `said` (the line, 200 characters), or undefined when the line does not match: it holds both lists, a negation stands within six
 * characters either side of the phrase, or it ends as a question. The match ignores case and spacing and reads the whole line (to 2,000 characters).
 */
export function matchBoss(line: string, direction: "on" | "off"): string | undefined {
	const folded = fold(line);
	if (!folded) return undefined;
	const hit = (words: string[], greeting: boolean) => [...words.flatMap((w) => spots(folded, w)), ...(greeting ? spots(folded, GREETING, true) : [])];
	const mine = hit(direction === "on" ? ON_WORDS : OFF_WORDS, direction === "off"), other = hit(direction === "on" ? OFF_WORDS : ON_WORDS, direction === "on");
	if (!mine.length || other.length) return undefined;
	// 早安 in an on-line is not a list word, but it is one of the off list: a line that says both is refused.
	if (QUESTION_ENDS.includes(folded.at(-1)!)) return undefined;
	for (const [from, to] of mine) {
		const around = [folded.slice(Math.max(0, from - NEAR), from), folded.slice(to, to + NEAR)];
		if (around.some((side) => NEGATIONS.some((n) => side.includes(n)))) return undefined;
	}
	return text(line, SAID_MAX);
}

// --- what a reader shows -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** The time of day a state began, for the boss's eyes (`23:10`). */
export const clock = (iso: string | undefined): string => { const d = iso ? new Date(iso) : undefined; return d && !Number.isNaN(d.getTime()) ? `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` : "?"; };
/** The summary of the last return list (`auto-report.json`, written by the server when auto mode ends): what a waking boss, or the head, reads in `board_read` (section towers). */
export interface ReportSummary { since: string; until: string; off: string; parked: number; towers: number; cancels: number; decided: number; stillWaiting: number }
export const REPORT_FILE = "auto-report.json";
export function reportSummary(dir: string): ReportSummary | undefined {
	try {
		const r = JSON.parse(readFileSync(join(dir, REPORT_FILE), "utf8")) as { v?: number; since?: string; until?: string; off?: string; parked?: { workspace?: string }[]; lines?: { count?: number; kind?: string }[]; decided?: unknown[]; stillWaiting?: unknown[] };
		if (r.v !== 1 || typeof r.since !== "string" || typeof r.until !== "string" || !Array.isArray(r.parked) || !Array.isArray(r.lines)) return undefined;
		return { since: r.since, until: r.until, off: String(r.off ?? ""), parked: r.parked.length, towers: new Set(r.parked.map((p) => p.workspace)).size, cancels: r.lines.filter((l) => l.kind !== "re-asked").reduce((n, l) => n + (l.count ?? 1), 0), decided: r.decided?.length ?? 0, stillWaiting: r.stillWaiting?.length ?? 0 };
	} catch {
		return undefined;
	}
}
/** `board_read` (section towers), `/boss status` and `/boss auto` read it from the files: the state, and a staged request that is still alive. */
export function autoSummary(dir: string, now = Date.now()): { on: boolean; since?: string; by?: string; pending?: { said: string; expiresInS: number }; report?: ReportSummary } {
	const seen = readAuto(dir), own = readOwn(dir);
	const state = seen.kind === "ok" && isOwn(seen.state, own) ? seen.state : undefined, pending = own?.pending && own.pending.expires > now ? own.pending : undefined;
	return { on: Boolean(state?.on), ...(state?.on && state.since ? { since: state.since } : {}), ...(state?.on ? { by: `${state.by.via}: ${state.by.name}` } : {}), ...(pending ? { pending: { said: pending.said, expiresInS: Math.round((pending.expires - now) / 1000) } } : {}), ...((r) => (r ? { report: r } : {}))(reportSummary(dir)) };
}
