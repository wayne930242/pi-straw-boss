import { h } from "./dom.ts";
import type { Tile } from "./layer.ts";
import type { Answer } from "./post.ts";

// The terminal tile: what a session's pane shows, drawn from the server's `mirror` frames (src/mirror.ts) on this tab's one stream. Rows are
// display only: each becomes spans of text nodes, SGR colours and attributes as classes or checked colour styles, never markup, and the
// mirror takes no input. A tile attaches the stream when it opens and again on a new stream's `hello`, detaches 5 s after the tab is hidden
// (attaching again when it shows) and when it closes. Fit width scales the font to the tile; otherwise rows keep their size and scroll sideways.

export interface Span { text: string; cls: string; fg?: string; bg?: string }
export interface Frame { key: string; seq?: number; rows?: number; cols?: number; whole?: boolean; set?: [number, string][]; hidden?: boolean; ended?: string }
export type Post = (action: "mirror" | "keys", body: Record<string, unknown>) => Promise<Answer>;
type Color = number | string | undefined; // a palette index (0–15), an rgb() colour, or the terminal's own
interface Style { fg?: Color; bg?: Color; b?: boolean; d?: boolean; i?: boolean; u?: boolean; v?: boolean; s?: boolean }
const CUBE = [0, 95, 135, 175, 215, 255], MAX_ROWS = 120, AWAY_MS = 5000, STALE_MS = 3000;
const byte = (n: number) => Number.isInteger(n) && n >= 0 && n <= 255;
/** A 256-colour index as a palette index or an rgb() colour; anything else is no colour. */
const indexed = (n: number): Color => (!byte(n) ? undefined : n < 16 ? n : n < 232 ? `rgb(${CUBE[Math.floor((n - 16) / 36)]},${CUBE[Math.floor((n - 16) / 6) % 6]},${CUBE[(n - 16) % 6]})` : `rgb(${8 + 10 * (n - 232)},${8 + 10 * (n - 232)},${8 + 10 * (n - 232)})`);
const rgb = ([r, g, b]: number[]): Color => ([r, g, b].every((n) => byte(n!)) ? `rgb(${r},${g},${b})` : undefined);

/** One SGR's parameters applied to a style. Unknown codes and malformed colours change nothing. */
export function sgr(st: Style, params: string): Style {
	const next: Style = { ...st }, parts = params.split(";");
	for (let i = 0; i < parts.length; i++) {
		const sub = parts[i]!.split(":").map((x) => (x === "" ? 0 : Number(x))), code = sub[0]!;
		if (code === 38 || code === 48 || code === 58) {
			// Extended colours: 38;5;n and 38;2;r;g;b, or with colons (38:5:n, 38:2::r:g:b). 58 (underline colour) is read and dropped.
			const mode = sub.length > 1 ? sub[1] : Number(parts[i + 1]), args = sub.length > 1 ? sub.slice(2) : parts.slice(i + 2, i + (mode === 5 ? 3 : 5)).map(Number);
			if (sub.length === 1) i += mode === 5 ? 2 : mode === 2 ? 4 : 1;
			const c = mode === 5 ? indexed(args[0]!) : mode === 2 ? rgb(args.slice(-3)) : undefined;
			if (c !== undefined && code !== 58) next[code === 38 ? "fg" : "bg"] = c;
		} else if (code === 0) for (const k of Object.keys(next)) delete next[k as keyof Style];
		else if (code === 1 || code === 2) next[code === 1 ? "b" : "d"] = true;
		else if (code === 22) next.b = next.d = false;
		else if (code === 3 || code === 23) next.i = code === 3;
		else if (code === 4 || code === 21 || code === 24) next.u = code !== 24 && sub[1] !== 0;
		else if (code === 7 || code === 27) next.v = code === 7;
		else if (code === 9 || code === 29) next.s = code === 9;
		else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) next.fg = code - (code < 90 ? 30 : 82);
		else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) next.bg = code - (code < 100 ? 40 : 92);
		else if (code === 39 || code === 49) delete next[code === 39 ? "fg" : "bg"];
	}
	return next;
}
/** A row as spans: text between SGRs with the style in force. Any other escape or control is dropped, so nothing malformed shows. */
export function rowSpans(row: string): Span[] {
	const out: Span[] = [];
	let st: Style = {}, at = 0;
	const push = (raw: string) => {
		const text = raw.replace(/\x1b(\[[0-?]*[ -/]*[@-~]?)?|[\u0000-\u001f\u007f-\u009f]/g, "");
		if (!text) return;
		// Inverse swaps the colours, the terminal's own included (classes cz and kz).
		const [fg, bg] = st.v ? [st.bg ?? "z", st.fg ?? "z"] : [st.fg, st.bg];
		const cls = [typeof fg === "number" || fg === "z" ? `c${fg}` : "", typeof bg === "number" || bg === "z" ? `k${bg}` : "", ...(["b", "d", "i", "u", "s"] as const).filter((k) => st[k]).map((k) => `t${k}`)].filter(Boolean).join(" ");
		out.push({ text, cls, ...(typeof fg === "string" && fg !== "z" && { fg }), ...(typeof bg === "string" && bg !== "z" && { bg }) });
	};
	for (const m of row.matchAll(/\x1b\[([0-9;:]{0,64})m/g)) {
		push(row.slice(at, m.index));
		st = sgr(st, m[1]!);
		at = m.index + m[0].length;
	}
	push(row.slice(at));
	return out;
}
/** A frame into the rows of `box`: the row count first, then each row it sets, built from text nodes. */
export function applyFrame(box: HTMLElement, f: Frame) {
	const n = Math.min(Math.max(0, Number(f.rows) || 0), MAX_ROWS);
	while (box.children.length < n) box.append(h("div", { class: "tr" }));
	while (box.children.length > n) box.lastElementChild!.remove();
	for (const [i, row] of Array.isArray(f.set) ? f.set : []) {
		if (!Number.isInteger(i) || i < 0 || i >= n || typeof row !== "string") continue;
		box.children[i]!.replaceChildren(...rowSpans(row).map((s) => {
			if (!s.cls && !s.fg && !s.bg) return s.text;
			const span = h("span", s.cls ? { class: s.cls } : null, s.text);
			if (s.fg) span.style.color = s.fg;
			if (s.bg) span.style.backgroundColor = s.bg;
			return span;
		}));
	}
}

/** `state` is what the pad may do: send keys (`live`), only Escape (`hidden`, a secret), or nothing (`off`: stale, ended, parked, connecting). */
export type TermState = "live" | "hidden" | "off";
interface Term { key: string; box: HTMLElement; scroll: HTMLElement; state: HTMLElement; fit: HTMLButtonElement; post: Post; cols: number; seen: number; away?: ReturnType<typeof setTimeout>; parked: boolean; first: boolean; ended: boolean; tile?: Tile; queue: Promise<unknown> }
/** The terminal tiles of this page: `stream()` is the newest `hello` as it came (JSON); `pad` puts the key pad under a mirror. */
export function mountTerminals({ tiles, post, stream, pad }: { tiles: { open(tile: Tile, focus?: boolean): void }; post(key: string): Post; stream(): string; pad?(t: { key: string; state(): TermState; post: Post }): HTMLElement }) {
	const open = new Map<string, Term>();
	let tick: ReturnType<typeof setInterval> | undefined;
	const id = () => { try { return String(JSON.parse(stream()).stream ?? ""); } catch { return ""; } };
	const say = (t: Term, text: string, tone = "") => (t.state.textContent !== text || t.state.dataset.tone !== tone) && ((t.state.dataset.tone = tone), (t.state.textContent = text)); // a status that stays is not announced again
	// One request at a time per tile, so an off sent right after an on reaches the server after it.
	const attach = (t: Term, on: boolean, s = id()) => s && void (t.queue = t.queue.then(() => t.post("mirror", { stream: s, on }).then((r) => on && !r.ok && say(t, r.body.reason ?? `Refused (${r.status}).`, "error"), () => on && say(t, "The server could not be reached.", "error"))));
	const fit = (t: Term) => (t.box.style.fontSize = t.fit.getAttribute("aria-pressed") === "true" && t.cols ? `${Math.max(6, Math.floor((t.scroll.clientWidth - 20) / (t.cols * 0.6)))}px` : "");
	const stale = (t: Term) => Date.now() - t.seen > STALE_MS;
	// A frame comes at least once a second; a mirror without one for 3 s dims. The check runs only while a tile is open and the tab shows.
	const watch = () => (clearInterval(tick), (tick = open.size && !document.hidden ? setInterval(() => open.forEach((t) => t.box.classList.toggle("stale", stale(t))), 1000) : undefined));
	document.addEventListener("visibilitychange", () => (watch(), open.forEach((t) => {
		clearTimeout(t.away);
		if (document.hidden) t.away = setTimeout(() => ((t.parked = true), attach(t, false), say(t, "Paused while this tab is hidden.")), AWAY_MS);
		else if (t.parked) void ((t.parked = false), attach(t, true));
	})));
	const make = (key: string, name: string): Tile => {
		const t: Term = { key, box: h("div", { class: "term", role: "group", "aria-label": `Terminal of ${name}, read only` }), scroll: h("div", { class: "term-scroll", tabindex: "0" }), state: h("p", { class: "term-state", role: "status" }, "Connecting…"), fit: h("button", { type: "button", class: "cmp-link", "aria-pressed": "false" }, "Fit width"), post: post(key), cols: 0, seen: 0, parked: false, first: true, ended: false, queue: Promise.resolve() };
		t.fit.onclick = () => (t.fit.setAttribute("aria-pressed", String(t.fit.getAttribute("aria-pressed") !== "true")), fit(t));
		t.scroll.append(t.box);
		new ResizeObserver(() => fit(t)).observe(t.scroll);
		open.set(key, t);
		attach(t, true);
		watch();
		const state = (): TermState => (t.parked || t.ended || stale(t) ? "off" : t.box.classList.contains("hidden") ? "hidden" : "live");
		return (t.tile = { id: `term:${key}`, title: `Terminal · ${name}`, icon: "i-comms", body: () => h("div", { class: "term-tile" }, h("div", { class: "term-bar" }, t.state, t.fit), t.scroll, pad?.({ key, state, post: t.post })), closed: () => (clearTimeout(t.away), attach(t, false), open.delete(key), watch()) });
	};
	return {
		/** Opens (or brings forward) the tile of a session's terminal, the user's own act, so it takes focus; a mirror that ended tries again. */
		open(key: string, name: string) {
			const t = open.get(key);
			if (t?.ended) void ((t.ended = false), say(t, "Connecting…"), attach(t, true));
			tiles.open(t?.tile ?? make(key, name), true);
		},
		/** A new stream said hello: every open tile attaches to it. */
		hello: () => open.forEach((t) => !t.parked && !t.ended && attach(t, true)),
		/** One `mirror` event from the stream. */
		frame(raw: string) {
			let f: Frame;
			try { f = JSON.parse(raw) as Frame; } catch { return; }
			const t = open.get(f.key);
			if (!t) return;
			t.box.classList.toggle("hidden", Boolean(f.hidden || f.ended));
			if (f.ended) return (t.ended = true), say(t, `The mirror ended: ${f.ended} Open the terminal again to retry.`, "error");
			[t.seen, t.ended] = [Date.now(), false];
			t.box.classList.remove("stale");
			if (f.hidden) return applyFrame(t.box, { key: t.key, rows: 0 }), say(t, "Hidden while it waits for a secret; type it in the terminal.");
			applyFrame(t.box, f);
			if (f.cols && f.cols !== t.cols) void ((t.cols = f.cols), fit(t));
			say(t, `Live · ${t.cols}×${t.box.children.length}`, "ok");
			if (t.first && f.whole) void ((t.first = false), requestAnimationFrame(() => (t.scroll.scrollTop = t.scroll.scrollHeight)));
		},
	};
}
