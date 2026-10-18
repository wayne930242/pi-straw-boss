import type { HerdrCall, Pane } from "./herdr.ts";
import type { Found } from "./net.ts";

// The terminal mirror: what a session's pane shows, for the page's terminal tile. Herdr gives no change signal, so one reader per mirrored
// pane polls `pane.read` (visible, ansi) and sends only the rows that changed, on the streams of the pages that have the tile open: every
// 250 ms while the screen changed in the last 2 s, else every second, with every row again on attach, after a size change, and every 10 s.
// A stream asks for a session's mirror with POST …/mirror {stream, on}; the reads are shared by every stream on that session and stop when
// the last one leaves, when the unit leaves the registry or its pane runs something else, or after 10 failed reads in a row (`ended`).
// While the session file's open call is secret_drop no row is read, and the streams hear `hidden` instead. Rows are display data only:
// nothing here reads them for meaning, and the sanitizer keeps SGR (colours and attributes) and drops every other escape and control.

export const FAST_MS = 250, SLOW_MS = 1000, CALM_MS = 2000, WHOLE_MS = 10_000, SIZE_MS = 2000, FAILS = 10, MAX_ROWS = 120, MAX_ROW = 4096, PER_STREAM = 2, PANES = 6, FRESH_MS = 3000;
export type Send = (event: string, data: unknown) => void;
export type TimerId = ReturnType<typeof setTimeout> | number;
export interface Timer { now(): number; set(run: () => void, ms: number): TimerId; clear(id: TimerId | undefined): void }
export interface MirrorDeps { call?: HerdrCall; lookup(key: string): Found | undefined; secret(file: string): Promise<boolean>; canonical(file?: string): string | undefined; timer?: Timer }
interface Viewer { send: Send; at: number; whole: boolean }
interface Reader { key: string; pane: string; file: string; viewers: Map<string, Viewer>; rows: string[]; cols: number; seq: number; changed: number; whole: number; sized: number; fails: number; hidden: boolean; timer?: TimerId; gone: boolean }

// CSI (kept only as SGR: final m, no intermediates, digits and separators), OSC/DCS/SOS/PM/APC up to BEL or ST, any other escape, C0 and C1.
const ESCAPES = /\x1b(?:\[([0-?]*)([ -/]*)([@-~]|(?=\x1b)|$)|[\]PX^_][^]*?(?:\x07|\x1b\\|$)|[ -/]*[0-~]?)|[\u0000-\u001f\u007f-\u009f]/g;
/** One row as the page may draw it: SGR only, at most 4 KB, never ending inside an escape. */
export function sanitize(row: string): string {
	const kept = row.replace(ESCAPES, (all, params?: string, inter?: string, final?: string) => (final === "m" && !inter && /^[0-9;:]{0,64}$/.test(params!) ? all : ""));
	if (Buffer.byteLength(kept) <= MAX_ROW) return kept;
	return Buffer.from(kept).subarray(0, MAX_ROW).toString("utf8").replace(/\ufffd$/, "").replace(/\x1b(\[[0-9;:]*)?$/, "");
}
const timers: Timer = { now: Date.now, set: (run, ms) => setTimeout(run, ms).unref(), clear: (id) => clearTimeout(id) };
const no = (status: number, error: string, reason: string) => ({ status, body: { error, reason } });

export function createMirrors({ call, lookup, secret, canonical, timer = timers }: MirrorDeps) {
	const streams = new Map<string, { send: Send; keys: Set<string> }>(), readers = new Map<string, Reader>(), started = new Map<string, number>();
	const frame = (r: Reader, set: [number, string][], whole?: true) => ({ key: r.key, seq: r.seq, rows: r.rows.length, cols: r.cols, ...(whole && { whole }), set });
	const end = (r: Reader, reason: string) => {
		if (r.gone) return;
		r.gone = true;
		timer.clear(r.timer);
		readers.delete(r.key);
		r.viewers.forEach((v, id) => void (streams.get(id)?.keys.delete(r.key), v.send("mirror", { key: r.key, ended: reason })));
		r.viewers.clear(); // a read still on its way delivers to nobody
	};
	const detach = (id: string, key: string) => {
		const r = readers.get(key);
		streams.get(id)?.keys.delete(key);
		if (!r?.viewers.delete(id) || r.viewers.size) return;
		timer.clear(r.timer); // the last viewer left: no more reads
		r.gone = true;
		readers.delete(key);
	};
	/** What each viewer gets after a read: every row when it needs them, the changed ones, or an empty frame once a second so it knows it is current. */
	const deliver = (r: Reader, changed: number[]) => {
		const now = timer.now(), all = now - r.whole >= WHOLE_MS;
		if (all) r.whole = now;
		for (const v of r.viewers.values()) {
			if (r.hidden) v.whole = true;
			const whole = !r.hidden && (v.whole || all), set = whole ? r.rows.map((row, i): [number, string] => [i, row]) : changed.map((i): [number, string] => [i, r.rows[i]!]);
			if (r.hidden ? now - v.at < SLOW_MS : !whole && !set.length && now - v.at < SLOW_MS) continue;
			v.send("mirror", r.hidden ? { key: r.key, hidden: true } : frame(r, set, whole || undefined));
			[v.at, v.whole] = [now, r.hidden];
		}
	};
	async function read(r: Reader) {
		const found = lookup(r.key);
		if (!found?.live || found.pane !== r.pane || found.file !== r.file) return end(r, "The session is no longer live in this pane.");
		const hidden = await secret(r.file);
		if (r.gone) return; // detached meanwhile: no Herdr call for nobody
		if ((r.hidden = hidden)) return (r.rows = []), deliver(r, []); // a secret is typed into that screen: nothing is read
		if (timer.now() - r.sized >= SIZE_MS) {
			const [{ pane }, { layout }] = (await Promise.all([call!("pane.get", { pane_id: r.pane }), call!("pane.layout", { pane_id: r.pane })])) as [{ pane: Pane }, { layout: { panes: { pane_id: string; rect: { width: number } }[] } }];
			if (pane.agent !== "pi" || canonical(pane.agent_session?.value) !== r.file) return end(r, "The pane runs something else now.");
			const cols = layout.panes.find((p) => p.pane_id === r.pane)?.rect.width ?? r.cols;
			if (cols !== r.cols) [r.cols, r.whole] = [cols, 0];
			r.sized = timer.now();
		}
		if (r.gone) return;
		const { read } = (await call!("pane.read", { pane_id: r.pane, source: "visible", format: "ansi", strip_ansi: false })) as { read: { text: string } };
		const rows = String(read.text).split("\n").slice(-MAX_ROWS).map(sanitize), changed = rows.flatMap((row, i) => (row !== r.rows[i] ? [i] : []));
		if (rows.length !== r.rows.length) r.whole = 0; // a size change sends every row
		if (changed.length) [r.seq, r.changed] = [r.seq + 1, timer.now()];
		r.rows = rows;
		deliver(r, changed);
	}
	const loop = async (r: Reader) => {
		started.set(r.key, timer.now());
		try {
			await read(r);
			r.fails = 0;
		} catch {
			if (++r.fails >= FAILS) end(r, "The pane could not be read.");
		}
		if (!r.gone) r.timer = timer.set(() => void loop(r), timer.now() - r.changed < CALM_MS ? FAST_MS : SLOW_MS);
	};
	return {
		/** A page's stream connected (`hello`), and may now attach mirrors. */
		open: (id: string, send: Send) => void streams.set(id, { send, keys: new Set() }),
		/** The stream closed: everything it held is detached. */
		close(id: string) {
			for (const key of streams.get(id)?.keys ?? []) detach(id, key);
			streams.delete(id);
		},
		/** POST …/sessions/<key>/mirror {stream, on}: attach this stream to the session's mirror, or detach it. */
		toggle(key: string, { stream, on }: Record<string, unknown>) {
			const s = typeof stream === "string" ? streams.get(stream) : undefined;
			if (!s || typeof on !== "boolean") return no(400, "bad_request", "Name this page's stream and whether to show the terminal; reload the page if it reconnected.");
			if (!on) return detach(stream as string, key), { status: 200, body: { attached: false } };
			const found = lookup(key);
			if (!found?.live || !found.pane || !found.file) return no(409, "not_live", "This session is no longer live in a pane.");
			if (!call) return no(503, "unavailable", "This server cannot reach Herdr.");
			if (!s.keys.has(key) && s.keys.size >= PER_STREAM) return no(429, "too_many", `A page shows at most ${PER_STREAM} terminals; close one first.`);
			const kept = readers.get(key), had = kept?.pane === found.pane && kept.file === found.file ? kept : (kept && end(kept, "The session moved to another pane."), undefined);
			if (!had && readers.size >= PANES) return no(429, "too_many", `This server mirrors at most ${PANES} terminals at once; close one first.`);
			const r: Reader = had ?? { key, pane: found.pane, file: found.file, viewers: new Map(), rows: [], cols: 0, seq: 0, changed: timer.now(), whole: 0, sized: 0, fails: 0, hidden: false, gone: false };
			readers.set(key, r).get(key)!.viewers.set(stream as string, { send: s.send, at: 0, whole: true });
			s.keys.add(key);
			if (!had) r.timer = timer.set(() => void loop(r), Math.max(0, (started.get(key) ?? -FAST_MS) + FAST_MS - timer.now())); // one loop per reader; on and off again keeps 4 reads a second
			else if (r.seq || r.hidden) deliver(r, []); // a page joining a running mirror gets every row at once
			return { status: 200, body: { attached: true } };
		},
		/** Whether this stream holds the session's mirror and was sent a frame in the last 3 s (the key pad's precondition). */
		fresh: (id: string, key: string) => { const v = readers.get(key)?.viewers.get(id); return Boolean(v && v.at && timer.now() - v.at <= FRESH_MS); },
		/** The keys of the mirrors being read now. */
		active: () => [...readers.keys()],
		stop() {
			readers.forEach((r) => void (timer.clear(r.timer), (r.gone = true)));
			[readers, streams, started].forEach((m) => m.clear());
		},
	};
}
