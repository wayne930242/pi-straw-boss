import { stat } from "node:fs/promises";
import { fileOfEntry, pageThrough } from "./headhistory.ts";
import { type readers as makeReaders, PAGE, type Reader } from "./history.ts";
import { lastLine } from "./items.ts";
import type { Found, Ref, RunDialog } from "./net.ts";

// What a page watching one session or one workspace receives on the stream, and the paged API behind it. Everything is read
// through the registry (net.lookup): a key it does not know, or that has no file yet, never reaches the file system.

/** The finished runs an operate session reaches (docs/specs/2026-11-07-link-operate.md §9, server/operateledger.ts), narrowed to its scope: a key `t<id>` is looked up here and nowhere else, so out of scope it is not found (the ledger holds the path, a request never does) and `GET api/transcripts` is answered from it. Only the box's operate hub has one. */
export interface Transcripts { has(key: string): boolean; lookup(key: string): Found | undefined; list(query: URLSearchParams): Promise<{ status: number; body: unknown }> }
/** A tower's or the head's headless runs (docs/specs/2026-11-23-lite-b2-d-e-f.md §4.4, The GUI): the text the live run writes now, and the dialogs its runs wait on. */
export interface RunSide { live(): string; dialogs(): RunDialog[] }
export interface Hub { lookup(key: string): Found | undefined; workspace(id: string): Ref[]; readers: ReturnType<typeof makeReaders>; transcripts?: Transcripts; /** The runs behind a tower's or the head's key, under headless runs. */ run?(key: string): RunSide | undefined }
const foundOf = (hub: Pick<Hub, "lookup" | "transcripts">, key: string): Found | undefined => (hub.transcripts && /^t[0-9a-f]{16}$/.test(key) ? hub.transcripts.lookup(key) : hub.lookup(key));
export type Send = (event: string, data: unknown) => void;
/** `refresh` runs after every net reading: it retries what could not attach yet and reports changes the file events missed. */
export interface Watch { refresh(): Promise<void>; stop(): void }

/**
 * The history of one session: the newest page at once, then every change the reader reports; a state change when the key leaves the net.
 * A key whose file changes re-attaches (the page resets); a first page that fails releases the reader, and the next refresh tries again.
 */
export function watchSession(hub: Hub, key: string, send: Send, { local = false }: { local?: boolean } = {}): Watch {
	let reader: Reader | undefined, file: string | undefined, unsub: (() => void) | undefined, signature: string | undefined, stopped = false, attaching = false;
	// A tower's headless run: what it writes now (`live`, every page) and the dialogs it waits on (`dialogs`, this computer's own page only: a paired device never gets an approval card), each sent when it changed.
	let liveWas = "", dialogsWas = "[]";
	const runSide = () => {
		const side = hub.run?.(key);
		if (!side) return;
		const live = side.live(), dialogs = local ? JSON.stringify(side.dialogs()) : "[]";
		if (live !== liveWas) (liveWas = live), send("history", { key, items: [], live });
		if (dialogs !== dialogsWas) (dialogsWas = dialogs), send("history", { key, items: [], dialogs: JSON.parse(dialogs) as RunDialog[] });
	};
	const meta = (f?: Found) => ({ key, state: f ? (f.live ? "live" : "recent") : "unknown", successor: f?.successor, base: f?.base, name: f?.name, role: f?.role });
	const detach = () => (unsub?.(), file && hub.readers.release(file), (reader = file = unsub = undefined));
	async function refresh() {
		if (stopped || attaching) return;
		runSide();
		const found = foundOf(hub, key), sig = JSON.stringify(meta(found));
		if (reader && found?.file && found.file !== file) detach();
		if (!reader && found?.file) {
			attaching = true;
			try {
				file = found.file;
				reader = hub.readers.acquire(file);
				const queued: unknown[] = [];
				let ready = false;
				unsub = reader.subscribe((change) => (ready ? send("history", { key, ...change }) : queued.push({ key, ...change })));
				const { items, before } = await pageThrough(hub, found, undefined, PAGE, reader);
				if (stopped || file !== found.file) return;
				send("history", { ...meta(found), reset: true, items, before, header: reader.header(), unreadable: reader.unreadable(), todos: await reader.todos() });
				ready = true;
				queued.forEach((change) => send("history", change));
				signature = sig;
			} catch {
				detach();
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
			detach();
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

/**
 * GET /api/image/<key>/<entry id>/<n>: the entry's n-th image (png, jpeg, gif, or webp; items.ts drops other types), as its bytes, so the
 * page shows it with <img> instead of carrying base64 in the history.
 */
export async function image(hub: Hub, [key, id, n]: string[]): Promise<{ type: string; bytes: Buffer } | undefined> {
	const found = key ? foundOf(hub, key) : undefined, i = Number(n), file = found?.file && id ? await fileOfEntry(hub, found, id) : undefined;
	if (!file || !id || !Number.isInteger(i) || i < 0) return undefined;
	const reader = hub.readers.acquire(file);
	try {
		const pic = (await reader.entry(id))?.pics?.[i], hit = pic && /^data:(image\/(?:png|jpeg|jpg|gif|webp));base64,(.*)$/s.exec(pic);
		return hit ? { type: hit[1]!, bytes: Buffer.from(hit[2]!, "base64") } : undefined;
	} finally {
		hub.readers.release(file);
	}
}

/** GET /api/history/<key>?before=<entry id>&limit=<n>, GET /api/entry/<key>/<entry id>, and (an operate hub only) GET /api/transcripts?before=<cursor>&limit=<n>. */
export async function api(hub: Hub, [kind, key, id]: string[], query: URLSearchParams): Promise<{ status: number; body: unknown }> {
	if (kind === "transcripts" && key === undefined) return hub.transcripts ? hub.transcripts.list(query) : { status: 404, body: { error: "not found" } };
	const found = key ? foundOf(hub, key) : undefined;
	if (!found?.file || !["history", "entry"].includes(kind ?? "")) return { status: 404, body: { error: "not found" } };
	if (kind === "history") return { status: 200, body: await pageThrough(hub, found, query.get("before") ?? undefined, Math.min(300, Math.max(1, Number(query.get("limit")) || PAGE))) };
	const file = id ? await fileOfEntry(hub, found, id) : undefined, reader = file && hub.readers.acquire(file);
	try {
		const item = id && reader ? await reader.entry(id) : undefined;
		return item ? { status: 200, body: item } : { status: 404, body: { error: "not found" } };
	} finally {
		if (file) hub.readers.release(file);
	}
}
