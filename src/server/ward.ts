import { closeSync, openSync, readSync, statSync } from "node:fs";
import { type HerdrRun, type Pane, panes } from "../herdr.ts";
import { subagents } from "../netdata.ts";
import { sessionHeader } from "../revive.ts";
import { armedLoop } from "./capops.ts";
import type { Reply } from "./socket.ts";

// `sb ward <pane>` and `sb_ward` (docs/how-it-works.md#ward-a-plain-pane): a main hands the sb server a worker that runs in a plain pane (no subagent row, so no completion of its own), and the server wakes the main only when the worker
// really ended: finished (it reported to the main over intercom or call_peer, or its last turn ended and nothing of its runs, for two looks 60 s apart), blocked (Herdr shows the pane blocked, or the worker waits on a dialog), or dead
// (the pane is gone, or pi left it). A worker that is idle while its own monitor, loop, or subagent runs is not finished. The ward is one of the server's watches (watches.ts): its key is `ward:<pane>`, it is kept in `watches.json`, its
// line goes out on the same tower identity as boss_watch's lines, and the main's boss_watch listener takes it. The ward is read only: it never closes the pane, sends it keys, or signals a process.

export const WARD = "ward:";
/** How long a ward waits after a look that found nothing to tell, and how long a quiet worker must stay quiet to be finished (two looks this far apart). */
export const WARD_LOOK_MS = 20_000, QUIET_MS = 60_000;
/** A session file's tail read for its last message, and the most read from the ward's start for reports. */
const TAIL = 256 * 1024, SPAN = 8 * 1024 * 1024;
/** The tools whose open call is a question to a person: the worker waits on a dialog. */
const DIALOGS = new Set(["ask_user_question", "ask_user", "secret_drop", "robot_hand", "call_tower"]);
const ITEM = /^[A-Za-z0-9][A-Za-z0-9._:#/-]{0,63}$/;

/** What a ward watches: the pane, the session file pi held there at the ward's start, the worker's session id, where that file ended then, and the main the worker reports to. */
/** `terminal`: Herdr's terminal id of the pane at the start, which stays with the terminal when Herdr moves the pane, while a pane id may be given to another pane. */
export interface WardRec { pane: string; file: string; worker: string; offset: number; terminal?: string; item?: string; main: { id: string; names: string[] } }
export type WardState = "finished" | "blocked" | "dead" | "unchanged";
/** The worker's turn as its session file says: `ended` (the last message is the assistant's and called no tool), `dialog` (it waits on a question tool), `working`, or `unknown` (no message yet, or the file cannot be read). */
export type Turn = "ended" | "dialog" | "working" | "unknown";
/** One look: the pane in Herdr's list, the turn, whether a report to the main came after the ward's start, and what still runs for the worker. */
export interface WardLook { pane?: Pick<Pane, "agent" | "agent_status" | "agent_session">; turn: Turn; reported?: string; runs: string[] }
/** What a ward already told, carried from look to look (watches.ts keeps it as the watch's `since`): when the worker was first seen quiet, and whether its blocked spell was told. */
export interface WardTold { quiet?: number; blocked?: boolean }

/** The verdict of one look. A blocked spell is told once; quiet is finished only when it held for QUIET_MS. */
export function judgeWard(rec: WardRec, look: WardLook, told: WardTold, at: number): { state: WardState; why: string; told: WardTold } {
	if (!look.pane) return { state: "dead", why: "its pane is gone", told };
	if (look.pane.agent !== "pi") return { state: "dead", why: "pi left the pane", told };
	const file = look.pane.agent_session?.value;
	if (file !== undefined && file !== rec.file) return { state: "dead", why: "the pane now runs another session", told };
	// Whose pi it is cannot be told while Herdr names no session file: nothing is judged finished or blocked on a pane that may be another worker's (ward-review F006).
	if (file === undefined) return { state: "unchanged", why: "Herdr names no session file of its pane now", told };
	if (look.reported) return { state: "finished", why: `it reported to you (${look.reported})`, told };
	if (look.pane.agent_status === "blocked" || look.turn === "dialog") {
		const why = look.turn === "dialog" ? "it waits on a dialog" : "Herdr shows its pane blocked";
		return told.blocked ? { state: "unchanged", why, told: { blocked: true } } : { state: "blocked", why, told: { blocked: true } };
	}
	const quiet = look.turn === "ended" && look.pane.agent_status !== "working" && !look.runs.length;
	if (!quiet) return { state: "unchanged", why: look.runs.length ? `${look.runs.join(", ")}` : "it works", told: {} };
	if (told.quiet === undefined) return { state: "unchanged", why: "its turn ended; looking again before calling it finished", told: { quiet: at } };
	if (at - told.quiet < QUIET_MS) return { state: "unchanged", why: "its turn ended; looking again before calling it finished", told: { quiet: told.quiet } };
	return { state: "finished", why: "its last turn ended and nothing of it has run for a minute", told: { quiet: told.quiet } };
}

type Json = Record<string, any>;
const blocksOf = (m: Json): Json[] => (Array.isArray(m?.content) ? m.content.filter((b: unknown) => b && typeof b === "object") : []);

/** The worker's turn, and its first report to the main written at or after `offset`, from its session file. */
export function readSession(file: string, offset: number, main: WardRec["main"]): { turn: Turn; reported?: string } {
	let fd: number | undefined;
	try {
		const size = statSync(file).size, from = Math.max(0, Math.min(offset, size - TAIL), size - SPAN), buffer = Buffer.alloc(size - from);
		fd = openSync(file, "r");
		readSync(fd, buffer, 0, buffer.length, from);
		const lines = buffer.toString("utf8").split("\n");
		let at = from, turn: Turn = "unknown", reported: string | undefined;
		const calls = new Map<string, string>();
		for (const [i, line] of lines.entries()) {
			const start = at;
			at += Buffer.byteLength(line) + 1;
			if (i === 0 && from > 0) continue; // a line cut by the read's start
			let d: Json;
			try { d = JSON.parse(line); } catch { continue; }
			if (d?.type !== "message" || !d.message) continue;
			const m = d.message as Json;
			if (m.role === "assistant") {
				const tools = blocksOf(m).filter((b) => b.type === "toolCall");
				turn = m.stopReason === "toolUse" || tools.length ? (tools.some((b) => DIALOGS.has(String(b.name))) ? "dialog" : "working") : "ended";
				if (start >= offset) for (const b of tools) {
					const a: Json = b.arguments ?? {}, name = String(b.name);
					// Only a recipient the result proves (ward-review F001): intercom resolves a full session id before any name or id prefix, so only the main's full id is the main; call_peer's result names the session it sent to.
					if (name === "intercom" && (a.action === "send" || a.action === "ask") && typeof a.to === "string" && a.to.trim() === main.id) calls.set(String(b.id), `intercom ${a.action}`);
					if (name === "call_peer") calls.set(String(b.id), "call_peer");
				}
			} else if (m.role === "toolResult") {
				turn = "working";
				const call = calls.get(String(m.toolCallId)), det: Json = m.details ?? {};
				const took = call === "call_peer" ? det.id === main.id && det.status === "sent" : det.delivered === true;
				if (call && took && !m.isError && start >= offset) reported ??= call;
			} else if (m.role === "user") turn = "working";
		}
		return { turn, ...(reported ? { reported } : {}) };
	} catch {
		return { turn: "unknown" };
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

export interface WardDeps {
	run: HerdrRun;
	now(): number;
	/** The panes a monitor runs in now (the dialog hub's relayed monitors). */
	monitorPanes(): ReadonlySet<string>;
	/** pi-loop-monitor's folder (`~/.pi/loops`): a worker's active loop still runs. */
	loopsDir: string;
}
/** `workspace` and `here`: the main's workspace and pane as the server reads them, never as a request says (ward-review F003). */
export interface WardAsk { pane: string; session: string; workspace: string; item?: string; names?: string[]; here?: string }

const stampOf = (t: WardTold) => Buffer.from(JSON.stringify(t)).toString("base64url");
const toldOf = (since: string | undefined): WardTold => {
	try {
		const t = JSON.parse(Buffer.from(since ?? "", "base64url").toString("utf8")) as WardTold;
		return { ...(typeof t?.quiet === "number" ? { quiet: t.quiet } : {}), ...(t?.blocked === true ? { blocked: true } : {}) };
	} catch {
		return {};
	}
};
const NEXT: Record<Exclude<WardState, "unchanged">, string> = {
	finished: "Read its report or its session; close its pane with cli.mjs pane close when nothing more is wanted of it.",
	blocked: "Look at its pane: it needs an answer before it goes on.",
	dead: "Read its session file (FILE); resume it as a tracked subagent (subagent_resume) if the work is not done.",
};
/** The line a main gets for a ward. */
export const wardLine = (rec: WardRec, state: WardState, why: string) => `ward ${rec.pane}${rec.item ? ` (${rec.item})` : ""}: ${state}: ${why}.${state === "unchanged" ? "" : ` ${NEXT[state].replace("FILE", rec.file)}`}`;

export function createWardRead(d: WardDeps) {
	/** One look at the worker, with what still runs for it: a monitor in its pane, an active loop of its session, a running subagent of its pane. */
	const look = async (rec: WardRec): Promise<WardLook> => {
		// The worker is the pi pane that holds its session file, wherever Herdr moved it; else its terminal, which a move keeps; else its pane id, unless that id now names another terminal (ward-review F006).
		const all = await panes(d.run), other = (p: Pane) => Boolean(rec.terminal && p.terminal_id && p.terminal_id !== rec.terminal);
		const pane = all.find((p) => p.agent === "pi" && p.agent_session?.value === rec.file) ?? (rec.terminal ? all.find((p) => p.terminal_id === rec.terminal) : undefined) ?? all.find((p) => p.pane_id === rec.pane && !other(p));
		if (!pane) return { turn: "unknown", runs: [] };
		const runs: string[] = [];
		if (d.monitorPanes().has(pane.pane_id)) runs.push("a monitor of it runs");
		if (armedLoop(d.loopsDir, rec.worker, d.now())) runs.push("a loop of it is active");
		const kids = subagents(pane, all, d.now()).filter((r) => !r.ended).length;
		if (kids) runs.push(`${kids} subagent${kids > 1 ? "s" : ""} of it run${kids > 1 ? "" : "s"}`);
		return { pane, ...readSession(rec.file, rec.offset, rec.main), runs };
	};
	return {
		/** One look and its verdict, as watch-read answers: `since` carries what was told. A Herdr list that does not answer is no verdict. */
		async read(q: { since?: string; deadline?: number; ward: WardRec }): Promise<Reply> {
			const at = d.now(), was = toldOf(q.since);
			if (q.deadline !== undefined && at >= q.deadline) return { ok: true, state: "expired", since: stampOf(was), ward: `ward ${q.ward.pane}: expired; the ward ended` };
			let seen: WardLook;
			try { seen = await look(q.ward); } catch (error) { return { ok: false, error: `Herdr's pane list did not answer: ${(error as Error).message}` }; }
			const v = judgeWard(q.ward, seen, was, at);
			return { ok: true, state: v.state, since: stampOf(v.told), now: at, unit: { pane: q.ward.pane, state: v.state, why: v.why, ...(q.ward.item ? { item: q.ward.item } : {}) }, ward: wardLine(q.ward, v.state, v.why) };
		},
		/** The record of a new ward: the pane runs pi with a session file, it is not the caller's own pane or session, and the item (if any) is a plain key. */
		async resolve(a: WardAsk): Promise<WardRec | string> {
			if (a.item !== undefined && !ITEM.test(a.item)) return "item is a plain key of 1 to 64 letters, digits, and . _ : # / - (MP-123)";
			if (a.here && a.pane === a.here) return `${a.pane} is your own pane`;
			const pane = (await panes(d.run)).find((p) => p.pane_id === a.pane);
			if (!pane) return `no pane ${a.pane} in Herdr's list`;
			if (pane.workspace_id !== a.workspace) return `${a.pane} is not in your workspace; a main wards only a pane of its own workspace`;
			const file = pane.agent === "pi" ? pane.agent_session?.value : undefined;
			if (!file) return `${a.pane} runs no pi session Herdr can name, so there is nothing to ward`;
			const worker = sessionHeader(file)?.id;
			if (!worker) return `the session file of ${a.pane} has no pi header: ${file}`;
			if (worker === a.session) return `${a.pane} runs your own session`;
			let offset = 0;
			try { offset = statSync(file).size; } catch { return `the session file of ${a.pane} cannot be read: ${file}`; }
			return { pane: a.pane, file, worker, offset, ...(pane.terminal_id ? { terminal: pane.terminal_id } : {}), ...(a.item ? { item: a.item } : {}), main: { id: a.session, names: (a.names ?? []).filter((n) => typeof n === "string" && n.trim()).map((n) => n.trim()).slice(0, 4) } };
		},
	};
}
export type WardRead = ReturnType<typeof createWardRead>;
/** A stored ward as read back from `watches.json`; undefined for anything else. */
export function wardOf(v: unknown): WardRec | undefined {
	const r = v as Partial<WardRec> | undefined;
	if (!r || typeof r.pane !== "string" || typeof r.file !== "string" || typeof r.worker !== "string" || typeof r.offset !== "number" || typeof r.main?.id !== "string" || !Array.isArray(r.main.names)) return undefined;
	return { pane: r.pane, file: r.file, worker: r.worker, offset: r.offset, ...(typeof r.terminal === "string" ? { terminal: r.terminal } : {}), ...(typeof r.item === "string" ? { item: r.item } : {}), main: { id: r.main.id, names: r.main.names.filter((n): n is string => typeof n === "string") } };
}
