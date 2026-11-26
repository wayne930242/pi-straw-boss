import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { basename } from "node:path";
import type { Pane, Session } from "./herdr.ts";
import { readRecords } from "./roles.ts";
import { v1Of } from "./todoledger.ts";

// call_peer's targets as sb finds them at the call (callpeer.ts; the boss, 2026-11-26: 「agent 在同一個 sb net 找彼此，應該都可以有語法糖包好吧？intercom 直接呼叫通常是備用的」). The reads here are the ones the
// targets need beyond the net reading: the last writer on the session's own branch, the handover marks of the role records, and a main's todo list from its session file. No pi imports.

/** The session that wrote to this one last: the newest pi-intercom message on the branch whose sender is another session. */
export function lastWriter(entries: readonly unknown[], me: string): { id: string; name?: string } | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i] as { type?: unknown; customType?: unknown; details?: { from?: { id?: unknown; name?: unknown } } } | null;
		if (e?.type !== "custom_message" || e.customType !== "intercom_message") continue;
		const from = e.details?.from;
		if (typeof from?.id === "string" && from.id && from.id !== me) return { id: from.id, ...(typeof from.name === "string" && from.name ? { name: from.name } : {}) };
	}
	return undefined;
}

/** A pi session file's session id: pi names it `<timestamp>_<id>.jsonl`, and pi-intercom's id is pi's. */
export const fileId = (file: string) => basename(file, ".jsonl").split("_").pop()!;

/** Each main that handed over (roles.ts `handedOver`, written once its successor took the handoff), by session id: the successor's id. */
export function handovers(stateDir: string): Map<string, string> {
	return new Map(readRecords(stateDir).flatMap(({ record }) => (record.role === "main" && record.handedOver ? [[fileId(record.file), record.handedOver.to] as const] : [])));
}
/** `id`, or the main its work went to by one handover after another; never `me` (a successor asking after the main it took over from gets that main). */
export function successorOf(id: string, handed: ReadonlyMap<string, string>, me: string): string {
	for (let at = id, seen = new Set([id]); ;) {
		const next = handed.get(at);
		if (next === undefined || next === me || seen.has(next)) return at;
		seen.add((at = next));
	}
}

/** An item key as the todo tool names one: a task's uid (`t_` and ten base32 characters), or `<session8>#<id>`. */
export function itemKey(of: string): { uid: string } | { session: string; id: number } | undefined {
	if (/^t_[a-z2-7]{10}$/.test(of)) return { uid: of };
	const m = /^([A-Za-z0-9._-]{1,64})#([1-9]\d{0,8})$/.exec(of);
	return m ? { session: m[1]!, id: Number(m[2]) } : undefined;
}

const MARK = Buffer.from('"customType":"todo/v1"'), CHUNK = 1 << 20, MAX = 64 << 20;
/** The newest `todo/v1` snapshot of a session file, read from its end (at most 64 MB of it); undefined when there is none or the file cannot be read. */
export function todoSnapshot(file: string): { tasks: { id: number; uid?: string }[] } | undefined {
	let fd: number | undefined;
	try {
		fd = openSync(file, "r");
		const size = fstatSync(fd).size;
		for (let span = Math.min(size, CHUNK); ; span = Math.min(size, span * 4)) {
			const buf = Buffer.alloc(span);
			readSync(fd, buf, 0, span, size - span);
			for (let at = buf.lastIndexOf(MARK); at >= 0; at = at > 0 ? buf.lastIndexOf(MARK, at - 1) : -1) {
				const start = buf.lastIndexOf(10, at) + 1, end = buf.indexOf(10, at);
				if (start === 0 && span < size) break; // the line begins before the window: read more
				try {
					const data = v1Of(JSON.parse(buf.subarray(start, end < 0 ? span : end).toString("utf8")));
					if (data) return data as { tasks: { id: number; uid?: string }[] };
				} catch { /* a torn or other line: look further back */ }
			}
			if (span >= size || span >= MAX) return undefined;
		}
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/** A live main as the selector sees it. */
export interface MainSeen { id: string; name: string; tab: { id: string; label: string }; file?: string }
export const mainsOf = (sessions: readonly Session[], ps: readonly Pane[]): MainSeen[] =>
	sessions.flatMap((s) => {
		const loc = s.herdrLocation, pane = ps.find((p) => p.pane_id === loc?.paneId);
		return pane?.tokens?.sb_role === "main" && loc?.tab ? [{ id: s.id, name: s.name ?? s.id, tab: { id: loc.tab.id, label: loc.tab.label }, ...(pane.agent_session?.value ? { file: pane.agent_session.value } : {}) }] : [];
	});
/** The live mains `of` names: by an item key the one that holds the item (a session prefix after its handovers), else by exact name, tab id, or tab label. */
export function selectMains(of: string, mains: readonly MainSeen[], handed: ReadonlyMap<string, string>, me: string, snapshot = todoSnapshot): MainSeen[] {
	const key = itemKey(of);
	if (key && "uid" in key) return mains.filter((m) => m.file && snapshot(m.file)?.tasks.some((t) => t.uid === key.uid));
	if (key) {
		const live = mains.filter((m) => m.id.startsWith(key.session));
		if (live.length) return live;
		const now = new Set([...handed.keys()].filter((id) => id.startsWith(key.session)).map((id) => successorOf(id, handed, me)));
		return mains.filter((m) => now.has(m.id));
	}
	return mains.filter((m) => m.name === of || m.tab.id === of || m.tab.label === of);
}
/** Up to five candidates for a refusal: name, tab, and the first 8 of the id. */
export const candidates = (mains: readonly MainSeen[]) => mains.slice(0, 5).map((m) => `${m.name} (tab ${m.tab.label}, ${m.id.slice(0, 8)})`).join("; ") || "none";
