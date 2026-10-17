import { stat } from "node:fs/promises";
import { type readers as makeReaders, PAGE, type Reader } from "./history.ts";
import { lastLine } from "./items.ts";
import type { Found, Ref } from "./net.ts";

// What a page watching one session or one workspace receives on the stream, and the paged API behind it. Everything is read
// through the registry (net.lookup): a key it does not know, or that has no file yet, never reaches the file system.

export interface Hub { lookup(key: string): Found | undefined; workspace(id: string): Ref[]; readers: ReturnType<typeof makeReaders> }
export type Send = (event: string, data: unknown) => void;
/** `refresh` runs after every net reading: it retries what could not attach yet and reports changes the file events missed. */
export interface Watch { refresh(): Promise<void>; stop(): void }

/** The history of one session: the newest page at once, then every change the reader reports; a state change when the key leaves the net. */
export function watchSession(hub: Hub, key: string, send: Send): Watch {
	let reader: Reader | undefined, file: string | undefined, unsub: (() => void) | undefined, signature: string | undefined, stopped = false, attaching = false;
	const meta = (f?: Found) => ({ key, state: f ? (f.live ? "live" : "recent") : "unknown", successor: f?.successor, base: f?.base, name: f?.name, role: f?.role });
	async function refresh() {
		if (stopped || attaching) return;
		const found = hub.lookup(key), sig = JSON.stringify(meta(found));
		if (!reader && found?.file) {
			attaching = true;
			try {
				file = found.file;
				reader = hub.readers.acquire(file);
				const queued: unknown[] = [];
				let ready = false;
				unsub = reader.subscribe((change) => (ready ? send("history", { key, ...change }) : queued.push({ key, ...change })));
				await reader.ready;
				const { items, before } = await reader.page();
				send("history", { ...meta(found), reset: true, items, before, header: reader.header(), unreadable: reader.unreadable() });
				ready = true;
				queued.forEach((change) => send("history", change));
				signature = sig;
			} finally {
				attaching = false;
			}
		} else if (sig !== signature) {
			// Unknown, not written yet, or changed state: say so, with no items (the page keeps what it has unless this is the first message).
			send("history", { ...meta(found), reset: signature === undefined, items: [] });
			signature = sig;
		}
	}
	return {
		refresh,
		stop() {
			stopped = true;
			unsub?.();
			if (file) hub.readers.release(file);
		},
	};
}

/** The last assistant line of every session of a workspace, resent for a session only when its file changed. */
export function watchWorkspace(hub: Hub, id: string, send: Send): Watch {
	const seen = new Map<string, string>();
	return {
		async refresh() {
			const out: Record<string, string> = {};
			const read = async (r: Ref & { file: string }) => {
				const s = await stat(r.file).catch(() => undefined), sig = s ? `${s.size}:${s.mtimeMs}` : "";
				if (seen.get(r.key) !== sig) out[r.key] = s ? await lastLine(r.file) : "";
				seen.set(r.key, sig);
			};
			await Promise.all(hub.workspace(id).flatMap((r) => (r.file ? [read(r as Ref & { file: string })] : [])));
			if (Object.keys(out).length) send("cards", out);
		},
		stop() {},
	};
}

/** GET /api/history/<key>?before=<entry id>&limit=<n> and GET /api/entry/<key>/<entry id>. */
export async function api(hub: Hub, [kind, key, id]: string[], query: URLSearchParams): Promise<{ status: number; body: unknown }> {
	const found = key ? hub.lookup(key) : undefined;
	if (!found?.file || !["history", "entry"].includes(kind ?? "")) return { status: 404, body: { error: "not found" } };
	const reader = hub.readers.acquire(found.file);
	try {
		if (kind === "history") return { status: 200, body: await reader.page(query.get("before") ?? undefined, Math.min(300, Math.max(1, Number(query.get("limit")) || PAGE))) };
		const item = id ? await reader.entry(id) : undefined;
		return item ? { status: 200, body: item } : { status: 404, body: { error: "not found" } };
	} finally {
		hub.readers.release(found.file);
	}
}
