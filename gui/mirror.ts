import { h, replay } from "./dom.ts";
import type { Tile } from "./layer.ts";
import { m } from "./paraglide/messages.js";
import type { Answer } from "./post.ts";

// The terminal tile: what a session's pane shows, drawn from the server's `mirror` frames (src/mirror.ts) on this tab's one stream. Rows are
// display only: each becomes spans of text nodes, SGR colours and attributes as classes or checked colour styles, never markup, and the
// mirror takes no input. A tile attaches the stream when it opens and again on a new stream's `hello`, detaches 5 s after the tab is hidden
// (attaching again when it shows) and when it closes. Fit width scales the font to the tile and goes to the bottom; otherwise rows keep their size and scroll sideways.
// The keyboard: a pane is not a text field, so a phone's soft keyboard never opens on a tap into it. The tile has a hidden text box (the sink) and a
// Keyboard button that focuses it (a second tap, or the tile closing, blurs it); on a desktop a click into the mirror focuses it too.

export interface Span { text: string; cls: string; fg?: string; bg?: string }
const SENTINEL = "\u200b";
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
interface Term { key: string; box: HTMLElement; scroll: HTMLElement; state: HTMLElement; fit: HTMLButtonElement; kb: HTMLButtonElement; typing: HTMLElement; sink: HTMLTextAreaElement; post: Post; cols: number; seen: number; away?: ReturnType<typeof setTimeout>; parked: boolean; first: boolean; ended: boolean; tile?: Tile; queue: Promise<unknown>; pad?: Pad }
/** The key pad under a mirror (keypad.ts): its element, and `update` when what the pad may do changes. */
export interface Pad { el: HTMLElement; update(): void; type?(e: KeyboardEvent): boolean; key?(key: string): void; text?(typed: string): void; paste?(pasted: string): void }
/** The terminal tiles of this page: `stream()` is the newest `hello` as it came (JSON); `pad` puts the key pad under a mirror. */
export function mountTerminals({ tiles, post, stream, pad }: { tiles: { open(tile: Tile, focus?: boolean): void }; post(key: string): Post; stream(): string; pad?(t: { name: string; state(): TermState; post: Post; stream(): string; blip(): void }): Pad }) {
	const open = new Map<string, Term>();
	let tick: ReturnType<typeof setInterval> | undefined;
	const id = () => { try { return String(JSON.parse(stream()).stream ?? ""); } catch { return ""; } };
	const say = (t: Term, text: string, tone = "") => (t.pad?.update(), (t.state.textContent !== text || t.state.dataset.tone !== tone) && ((t.state.dataset.tone = tone), (t.state.textContent = text))); // a status that stays is not announced again
	// One request at a time per tile, so an off sent right after an on reaches the server after it.
	// A refused or failed attach ends the tile's mirror, so opening the terminal again tries again.
	const refused = (t: Term, why: string) => ((t.ended = true), say(t, m.retry_terminal({ why }), "error"));
	const attach = (t: Term, on: boolean, s = id()) => s && void (t.queue = t.queue.then(() => t.post("mirror", { stream: s, on }).then((r) => on && !r.ok && refused(t, r.body.reason ?? m.refused({ status: r.status })), () => on && refused(t, m.unreachable()))));
	// The widest of the pane's columns and its longest row: rows drawn before the pane narrowed stay wider until they are redrawn.
	const fit = (t: Term, n = Math.max(t.cols, ...[...t.box.children].map((r) => r.textContent?.length ?? 0))) => (t.box.style.fontSize = t.fit.getAttribute("aria-pressed") === "true" && n ? `${Math.max(6, Math.floor((t.scroll.clientWidth - 20) / (n * 0.6)))}px` : "");
	const stale = (t: Term) => Date.now() - t.seen > STALE_MS;
	// A frame comes at least once a second; a mirror without one for 3 s dims. The check runs only while a tile is open and the tab shows.
	const watch = () => (clearInterval(tick), (tick = open.size && !document.hidden ? setInterval(() => open.forEach((t) => (t.box.classList.toggle("stale", stale(t)), t.pad?.update())), 1000) : undefined));
	document.addEventListener("visibilitychange", () => (watch(), open.forEach((t) => {
		clearTimeout(t.away);
		if (document.hidden) t.away = setTimeout(() => ((t.parked = true), attach(t, false), say(t, m.paused_hidden())), AWAY_MS);
		else if (t.parked) void ((t.parked = false), attach(t, true));
	})));
	const make = (key: string, name: string): Tile => {
		const t: Term = { key, box: h("div", { class: "term", role: "group", "aria-label": m.terminal_of({ name }) }), scroll: h("div", { class: "term-scroll", tabindex: "0" }), state: h("p", { class: "term-state", role: "status" }, m.connecting()), fit: h("button", { type: "button", class: "cmp-link", "aria-pressed": "false" }, m.fit_width()), kb: h("button", { type: "button", class: "cmp-link term-kb", "aria-pressed": "false" }, m.keyboard()), typing: h("span", { class: "term-typing", hidden: "" }, m.typing_direct()), sink: h("textarea", { class: "term-sink", rows: "1", "aria-label": m.typing_hint(), inputmode: "text", enterkeyhint: "enter", autocomplete: "off", autocapitalize: "off", autocorrect: "off", spellcheck: "false" }) as HTMLTextAreaElement, post: post(key), cols: 0, seen: 0, parked: false, first: true, ended: false, queue: Promise.resolve() };
		// The font changes size, so the rows move: the view goes to the bottom, where pi's editor is, once the new size is laid out.
		t.fit.onclick = () => (t.fit.setAttribute("aria-pressed", String(t.fit.getAttribute("aria-pressed") !== "true")), fit(t), requestAnimationFrame(() => (t.scroll.scrollTop = t.scroll.scrollHeight)));
		t.scroll.append(t.box);
		// The keyboard goes to the pane while the sink has the focus: a click into the mirror on a desktop (not a drag that selects text to copy), or
		// the Keyboard button on any screen (a phone's soft keyboard opens for it). Keys and chords go from its keydown, characters from its input (so
		// an input method and dead keys work), a paste from its paste. A soft keyboard sends no key for Backspace or Enter on some phones (keydown
		// is "Unidentified", keyCode 229) but a beforeinput that names it, so that is read too, once: a keydown the pad took never reaches beforeinput.
		// A composition goes as one write when it ends. The mirror lights up as it takes the keyboard and flashes with each key.
		{
			const { sink } = t, rest = () => ((sink.value = SENTINEL), sink.setSelectionRange?.(1, 1)), typedIn = () => sink.value.replaceAll(SENTINEL, "");
			// An open box holds one zero-width character kept before the caret, so Backspace on an empty box still deletes something and a phone's
			// keyboard (Gboard sends nothing for Backspace on an empty input) fires its deleteContentBackward; the sentinel is never typed.
			const flush = () => ((typed) => (on ? rest() : (sink.value = ""), typed && t.pad?.text?.(typed)))(typedIn());
			let on = false;
			if (globalThis.matchMedia?.("(pointer: fine)").matches) {
				t.scroll.title = m.typing_hint();
				t.scroll.addEventListener("click", () => getSelection()?.isCollapsed !== false && sink.focus({ preventScroll: true }));
			}
			t.kb.addEventListener("mousedown", (e) => e.preventDefault()); // the button does not take the focus from the sink, so a second tap sees it open and closes it
			t.kb.addEventListener("click", () => (on ? sink.blur() : sink.focus({ preventScroll: true })));
			sink.addEventListener("keydown", (e) => t.pad?.type?.(e) && e.preventDefault());
			sink.addEventListener("beforeinput", (e) => {
				const { inputType, isComposing } = e as InputEvent, key = inputType === "deleteContentBackward" && !typedIn() ? "backspace" : inputType === "insertLineBreak" || inputType === "insertParagraph" ? "enter" : undefined;
				if (isComposing || !key) return;
				e.preventDefault();
				flush();
				t.pad?.key?.(key);
			});
			sink.addEventListener("input", (e) => !(e as InputEvent).isComposing && flush());
			sink.addEventListener("compositionend", flush);
			sink.addEventListener("paste", (e) => (e.preventDefault(), t.pad?.paste?.(e.clipboardData?.getData("text/plain") ?? "")));
			sink.addEventListener("focus", () => {
				const at = t.scroll.getBoundingClientRect(); // an input method's candidates show by the mirror's bottom-left corner
				Object.assign(sink.style, { left: `${at.left + 12}px`, top: `${Math.min(at.bottom, innerHeight) - 28}px` });
				on = true;
				rest();
				t.kb.setAttribute("aria-pressed", "true");
				t.typing.hidden = false;
				t.scroll.classList.add("typing", "engage");
			});
			sink.addEventListener("blur", () => ((on = false), t.kb.setAttribute("aria-pressed", "false"), (t.typing.hidden = true), t.scroll.classList.remove("typing", "engage", "blip"), flush()));
			t.scroll.addEventListener("animationend", (e) => t.scroll.classList.remove(e.animationName === "term-engage" ? "engage" : "blip"));
		}
		new ResizeObserver(() => fit(t)).observe(t.scroll);
		open.set(key, t);
		attach(t, true);
		watch();
		const state = (): TermState => (t.parked || t.ended || stale(t) ? "off" : t.box.classList.contains("hidden") ? "hidden" : "live");
		t.pad = pad?.({ name, state, post: t.post, stream: id, blip: () => replay(t.scroll, "blip") });
		return (t.tile = { id: `term:${key}`, title: m.terminal_title({ name }), icon: "i-comms", body: () => h("div", { class: "term-tile" }, h("div", { class: "term-bar" }, t.state, t.typing, t.kb, t.fit), t.scroll, t.sink, t.pad?.el), closed: () => (clearTimeout(t.away), t.sink.blur(), attach(t, false), open.delete(key), watch()) });
	};
	return {
		/** Opens (or brings forward) the tile of a session's terminal, the user's own act, so it takes focus; a mirror that ended tries again. */
		open(key: string, name: string) {
			const t = open.get(key);
			if (t?.ended) void ((t.ended = false), say(t, m.connecting()), attach(t, true));
			tiles.open(t?.tile ?? make(key, name), true);
		},
		/** Shows a session's terminal inside `host` (the session view's terminal mode) until the returned function takes it away. */
		embed(key: string, name: string, host: HTMLElement): () => void {
			const t = open.get(key);
			if (t?.ended) void ((t.ended = false), say(t, m.connecting()), attach(t, true));
			const tile = t?.tile ?? make(key, name);
			host.replaceChildren(tile.body());
			return () => (tile.closed?.(), host.replaceChildren());
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
			if (f.ended) return refused(t, m.mirror_ended({ why: f.ended }));
			[t.seen, t.ended] = [Date.now(), false];
			t.box.classList.remove("stale");
			if (f.hidden) return applyFrame(t.box, { key: t.key, rows: 0 }), say(t, m.mirror_hidden());
			applyFrame(t.box, f);
			if (f.whole || (f.cols && f.cols !== t.cols)) void ((t.cols = f.cols || t.cols), fit(t));
			say(t, m.mirror_live({ cols: t.cols, rows: t.box.children.length }), "ok");
			if (t.first && f.whole) void ((t.first = false), requestAnimationFrame(() => (t.scroll.scrollTop = t.scroll.scrollHeight)));
		},
	};
}
