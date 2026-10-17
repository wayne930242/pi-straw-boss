import { type FSWatcher, watch } from "node:fs";
import { type FileHandle, open, stat } from "node:fs/promises";
import { FULL_LIMIT, type Item, type Json, parse, toItem } from "./items.ts";

// The session reader: a pi session file in, pages of displayable items out, plus a live tail. Only an index stays in memory
// (type, id, parent, role, offset, length per entry); item content is read from the file by offset for the page being sent.
//
// Index: 1 MB chunks, yielding to the event loop between them. Per line only its first bytes (type, id, parentId, role come first
// in most entries) and its last bytes (custom entries end with id, parentId, timestamp) are kept and matched, so a 58 MB file costs
// tens of milliseconds. A line neither matches is read and parsed once. The leaf is the last entry in file order (pi's own load
// rule) and the view is the path from the leaf up through parentId, oldest first. A rewritten file (smaller, new inode, new header)
// is re-indexed from scratch; a new entry whose parent is not the current leaf is a branch move. Both reset the page.
// All index work and every read run one at a time, in order (`serial`): the first index ends before any append starts, and a page or
// entry is never read while the index is being rebuilt under it.

const CHUNK = 1 << 20, HEAD = 512, TAIL = 400, BIG = 16_384;
export const PAGE = 150;
const HIDDEN = new Set(["session", "custom", "label", "usage", "context_edit"]);

export interface Change { reset: boolean; items: Item[]; before?: string }
export interface Reader {
	ready: Promise<void>;
	header(): { id?: string; cwd?: string } | undefined;
	unreadable(): number;
	page(before?: string, limit?: number): Promise<{ items: Item[]; before?: string }>;
	entry(id: string): Promise<Item | undefined>;
	subscribe(fn: (change: Change) => void): () => void;
	start(): void;
	stop(): void;
}
interface Ent { type: string; role?: string; id: string; parent: string | null; off: number; len: number }

export function openReader(file: string, pollMs = 1000): Reader {
	let ents: Ent[] = [], byId = new Map<string, number>(), path: number[] = [], bad = 0, size = 0, ino = -1, headText = "", head: Json | undefined;
	let cur = { start: 0, len: 0, head: Buffer.alloc(0), tail: Buffer.alloc(0) };
	const listeners = new Set<(c: Change) => void>();
	let watcher: FSWatcher | undefined, timer: ReturnType<typeof setInterval> | undefined, chain: Promise<unknown> = Promise.resolve(), queued = false;
	const serial = <T>(task: () => Promise<T>): Promise<T> => {
		const run = chain.then(task);
		chain = run.catch(() => {});
		return run;
	};

	const grab = async (fh: FileHandle, off: number, len: number) => {
		const buf = Buffer.allocUnsafe(len);
		return buf.subarray(0, (await fh.read(buf, 0, len, off)).bytesRead);
	};
	/** A finished line: its entry, from the bytes at either end, else from the whole line read once. */
	async function line(fh: FileHandle, start: number, len: number, h: string, t: string) {
		const a = h.match(/^\{"type":"(\w+)","id":"([^"]+)","parentId":(null|"[^"]*")/) ?? t.match(/^()[^]*"id":"([^"]+)","parentId":(null|"[^"]*"),"timestamp":"[^"]*"\}$/) ?? undefined;
		let type = a?.[1] || h.match(/^\{"type":"(\w+)"/)?.[1], id = a?.[2], parent = a?.[3];
		if (type === "session") return void (headText ||= h);
		if (!a || !type) {
			const d = parse((await grab(fh, start, len)).toString("utf8"));
			if (!d?.id) return void bad++;
			[type, id, parent] = [d.type, d.id, d.parentId === null ? "null" : `"${d.parentId}"`];
		}
		const role = type === "message" ? h.match(/"message":\{"role":"(\w+)"/)?.[1] : undefined;
		byId.set(id!, ents.push({ type: type!, role, id: id!, parent: parent === "null" ? null : parent!.slice(1, -1), off: start, len }) - 1);
	}
	/** Feeds file bytes starting at `at`; a line cut by the end of the data stays in `cur` until its newline arrives. */
	async function feed(fh: FileHandle, chunk: Buffer, at: number) {
		for (let i = 0; i < chunk.length; ) {
			const nl = chunk.indexOf(10, i), seg = chunk.subarray(i, nl < 0 ? chunk.length : nl);
			if (cur.head.length < HEAD) cur.head = Buffer.concat([cur.head, seg.subarray(0, HEAD - cur.head.length)]);
			cur.tail = seg.length >= TAIL ? Buffer.from(seg.subarray(-TAIL)) : Buffer.concat([cur.tail, seg]).subarray(-TAIL);
			cur.len += seg.length;
			if (nl < 0) break;
			if (cur.len) await line(fh, cur.start, cur.len, cur.head.toString("latin1"), cur.tail.toString("latin1"));
			cur = { start: at + nl + 1, len: 0, head: Buffer.alloc(0), tail: Buffer.alloc(0) };
			i = nl + 1;
		}
	}
	const pathTo = (leaf: number) => {
		const out: number[] = [];
		for (let i: number | undefined = leaf; i !== undefined && out.length <= ents.length; i = ents[i]!.parent === null ? undefined : byId.get(ents[i]!.parent!)) out.push(i);
		return out.reverse();
	};
	async function scan(fh: FileHandle, to: number) {
		for (let at = size; at < to; at += CHUNK) {
			await feed(fh, await grab(fh, at, Math.min(CHUNK, to - at)), at);
			await new Promise((resolve) => setImmediate(resolve));
		}
		size = to;
	}
	/** The items of the entries at these indexes, in order; hidden kinds are skipped without reading. */
	async function load(idx: number[], max = Infinity) {
		const items: Item[] = [];
		if (!idx.length) return items;
		const fh = await open(file, "r");
		try {
			for (const i of idx.toReversed()) {
				const e = ents[i]!;
				if (items.length >= max) break;
				if (HIDDEN.has(e.type) || e.role === "system") continue;
				const big = e.role === "toolResult" && e.len > BIG * 2;
				const text = (await grab(fh, e.off, big ? BIG : e.len)).toString("utf8");
				const d = big ? { type: "message", id: e.id, message: { role: "toolResult", toolCallId: text.match(/"toolCallId":"([^"]+)"/)?.[1], toolName: text.match(/"toolName":"([^"]+)"/)?.[1], content: [{ type: "text", text: parse(`"${(text.match(/"text":"((?:[^"\\]|\\.)*)/)?.[1] ?? "").replace(/\\(?:u[0-9a-fA-F]{0,3})?$/, "")}"`) ?? "" }], isError: (await grab(fh, e.off + e.len - 300, 300)).toString("utf8").includes('"isError":true') } } : parse(text);
				const item = d && toItem(d, e.len);
				if (item) items.unshift(item);
			}
		} finally {
			await fh.close();
		}
		return items;
	}
	async function page(before?: string, limit = PAGE) {
		const end = before === undefined ? path.length : path.findIndex((i) => ents[i]!.id === before);
		const idx = path.slice(0, Math.max(0, end)), items = await load(idx, limit);
		const oldest = items[0] && path.findIndex((i) => ents[i]!.id === items[0]!.id);
		return { items, before: oldest && oldest > 0 ? items[0]!.id : undefined };
	}
	async function reindex() {
		[ents, byId, path, bad, size, headText] = [[], new Map(), [], 0, 0, ""];
		cur = { start: 0, len: 0, head: Buffer.alloc(0), tail: Buffer.alloc(0) };
		const fh = await open(file, "r");
		try {
			const s = await fh.stat();
			ino = s.ino;
			await scan(fh, s.size);
			head = headText ? parse((await grab(fh, 0, Math.min(s.size, 4096))).toString("utf8").split("\n")[0]!) : undefined;
		} finally {
			await fh.close();
		}
		path = ents.length ? pathTo(ents.length - 1) : [];
	}
	const emit = (change: Change) => listeners.forEach((fn) => fn(change));
	/** New bytes were appended: new entries extend the path, or move the branch (a new parent) and reset the page. */
	async function append(to: number) {
		const n = ents.length, fh = await open(file, "r");
		try {
			await scan(fh, to);
		} finally {
			await fh.close();
		}
		const added = ents.slice(n), leaf = path.at(-1), from = path.length;
		if (!added.length) return;
		if (added.every((e, k) => e.parent === (k ? added[k - 1]!.id : leaf === undefined ? null : ents[leaf]!.id))) {
			path.push(...added.map((_, k) => n + k));
			return emit({ reset: false, items: await load(path.slice(from)) });
		}
		path = pathTo(ents.length - 1);
		emit({ reset: true, ...(await page()) });
	}
	const headChanged = async () => {
		const fh = await open(file, "r");
		try {
			return headText !== "" && (await grab(fh, 0, headText.length)).toString("latin1") !== headText;
		} finally {
			await fh.close();
		}
	};
	/** One look at the file: a rewrite re-indexes, new bytes are appended. Reads look first, so they never use an index of a replaced file. */
	async function look() {
		try {
			const s = await stat(file).catch(() => undefined);
			if (!s) return; // a new session has no file until its first message: keep waiting for it
			if (s.ino !== ino || s.size < size || (s.size > size && (await headChanged()))) {
				await reindex();
				emit({ reset: true, ...(await page()) });
			} else if (s.size > size) await append(s.size);
		} catch {} // a read that fails (the file vanished mid-read) is retried by the next poll
	}
	/** A look queued behind the work already running; changes that arrive meanwhile queue one more. */
	function refresh() {
		if (queued) return;
		queued = true;
		void serial(() => ((queued = false), look()));
	}
	const ready: Promise<void> = serial(reindex).catch(() => undefined);
	return {
		ready,
		header: () => head && { id: head.id, cwd: head.cwd },
		unreadable: () => bad,
		page: (before, limit) => serial(async () => (await look(), page(before, limit))),
		entry: (id) => serial(async () => {
			await look();
			const i = byId.get(id), e = i === undefined ? undefined : ents[i];
			if (!e) return undefined;
			const fh = await open(file, "r");
			try {
				const d = parse((await grab(fh, e.off, Math.min(e.len, 2 * FULL_LIMIT))).toString("utf8"));
				return d && toItem(d, e.len, true);
			} finally {
				await fh.close();
			}
		}),
		subscribe: (fn) => (listeners.add(fn), () => void listeners.delete(fn)),
		start() {
			if (timer) return;
			timer = setInterval(() => void refresh(), pollMs).unref();
			try {
				watcher = watch(file, refresh);
				watcher.unref().on("error", () => {});
			} catch {} // no file yet: the poll finds it
			refresh();
		},
		stop() {
			clearInterval(timer);
			timer = undefined;
			watcher?.close();
			watcher = undefined;
		},
	};
}

/** Readers for the files pages watch: one per file while watched, the last eight kept (index only, not watching) afterwards. */
export function readers(keep = 8, make = openReader) {
	const all = new Map<string, { reader: Reader; users: number }>();
	return {
		acquire(file: string): Reader {
			const held = all.get(file) ?? { reader: make(file), users: 0 };
			held.users++;
			all.delete(file);
			all.set(file, held);
			held.reader.start();
			return held.reader;
		},
		release(file: string) {
			const held = all.get(file);
			if (!held || --held.users > 0) return;
			held.reader.stop();
			for (const [name, other] of all) if (all.size > keep && !other.users) all.delete(name);
		},
	};
}
