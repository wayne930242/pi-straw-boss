// The one fake DOM of the answer, session, and Zen paths (the answer panel, the trust panel, the chat, the composer, the session view, the overlay layer, and Zen's layer).
// Importing this module installs `document` (the `page` below), `localStorage`, `DOMParser`, `HTMLElement`, and the observers (Intersection, Resize, Mutation: they never fire) before the gui modules are loaded.
// Elements keep attributes, classes, data, children, value, disabled, handlers, geometry, and focus; `page` is the document's state a test sets.
// What a test needs beyond that (a matchMedia, a location, a fetch) it assigns itself; `sessionGlobals()` gives the session view's.

type Kid = El | string;
const dataName = (key: string) => `data-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
export class El {
	attrs = new Map<string, string>();
	kids: Kid[] = [];
	parent: El | undefined;
	/** A view over the `data-*` attributes, as the DOM's: `dataset.fooBar` is `data-foo-bar`, a set stringifies, a delete removes the attribute. */
	readonly dataset: Record<string, string | undefined> = new Proxy({} as Record<string, string | undefined>, {
		get: (_, key) => (typeof key === "string" ? this.attrs.get(dataName(key)) : undefined),
		set: (_, key, value) => (typeof key === "string" && this.attrs.set(dataName(key), String(value)), true),
		deleteProperty: (_, key) => (typeof key === "string" && this.attrs.delete(dataName(key)), true),
		has: (_, key) => typeof key === "string" && this.attrs.has(dataName(key)),
		ownKeys: () => [...this.attrs.keys()].filter((name) => name.startsWith("data-")).map((name) => name.slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())),
		getOwnPropertyDescriptor: (_, key) => (typeof key === "string" && this.attrs.has(dataName(key)) ? { value: this.attrs.get(dataName(key)), enumerable: true, configurable: true, writable: true } : undefined),
	});
	/** The inline style: properties set by name, and `setProperty` for a custom property (a plain assignment of `--x` does nothing in the DOM). */
	style: Record<string, string> & { setProperty(name: string, value: string): void } = Object.defineProperty({} as Record<string, string>, "setProperty", { value(this: Record<string, string>, name: string, value: string) { this[name] = value; } }) as never;
	handlers: Record<string, ((e: any) => void)[]> = {};
	onclick: (() => void) | null = null;
	oninput: (() => void) | null = null;
	hidden = false;
	title = "";
	value = "";
	selectionStart = 0;
	selectionEnd = 0;
	/** Geometry and scroll position, which a test sets; `scrollTo` only records the call (a smooth scroll arrives later, when the test moves `scrollTop` and sends the scroll event). */
	offsetTop = 0;
	offsetHeight = 0;
	clientHeight = 0;
	clientWidth = 0;
	scrollHeight = 0;
	scrollTop = 0;
	scrolls: { top?: number; behavior?: string }[] = [];
	private off = false;
	readonly tagName: string;
	constructor(tagName: string) {
		this.tagName = tagName;
	}
	/** The tag, as the chat tests read it. */
	get tag() {
		return this.tagName;
	}
	setAttribute(name: string, value: string) {
		this.attrs.set(name, String(value));
	}
	getAttribute(name: string) {
		return this.attrs.get(name) ?? null;
	}
	hasAttribute(name: string) {
		return this.attrs.has(name);
	}
	removeAttribute(name: string) {
		this.attrs.delete(name);
	}
	toggleAttribute(name: string, on?: boolean) {
		(on ?? !this.attrs.has(name)) ? this.attrs.set(name, "") : this.attrs.delete(name);
	}
	get id() {
		return this.getAttribute("id") ?? "";
	}
	set id(v: string) {
		this.setAttribute("id", v);
	}
	get className() {
		return this.getAttribute("class") ?? "";
	}
	set className(v: string) {
		this.setAttribute("class", v);
	}
	/** The classes, over the `class` attribute. */
	get classes() {
		return new Set(this.className.split(" ").filter(Boolean));
	}
	get classList() {
		const read = () => this.classes, write = (set: Set<string>) => this.setAttribute("class", [...set].join(" "));
		return {
			add: (...cs: string[]) => write(new Set([...read(), ...cs])),
			remove: (...cs: string[]) => { const set = read(); for (const c of cs) set.delete(c); write(set); },
			contains: (c: string) => read().has(c),
			toggle: (c: string, on?: boolean) => { const set = read(), want = on ?? !set.has(c); want ? set.add(c) : set.delete(c); write(set); return want; },
		};
	}
	addEventListener(type: string, on: (e: any) => void) {
		(this.handlers[type] ??= []).push(on);
	}
	private adopt(kids: Kid[]) {
		for (const kid of kids) if (kid instanceof El) (kid.remove(), (kid.parent = this));
	}
	append(...kids: Kid[]) {
		this.adopt(kids);
		this.kids.push(...kids);
	}
	appendChild<T extends El>(kid: T): T {
		this.append(kid);
		return kid;
	}
	/** As the DOM's: the node goes in front of `ref` (at the end when `ref` is null). */
	insertBefore<T extends El>(node: T, ref: El | null | undefined): T {
		node.remove();
		node.parent = this;
		const at = ref ? this.kids.indexOf(ref) : -1;
		this.kids.splice(at < 0 ? this.kids.length : at, 0, node);
		return node;
	}
	get nextElementSibling(): El | null {
		const kids = this.parent?.children ?? [];
		return kids[kids.indexOf(this) + 1] ?? null;
	}
	prepend(...kids: Kid[]) {
		this.adopt(kids);
		this.kids.unshift(...kids);
	}
	replaceChildren(...kids: Kid[]) {
		for (const kid of this.kids) if (kid instanceof El) (this.dropFocus(kid), (kid.parent = undefined));
		this.kids = [];
		this.append(...kids);
	}
	/** As the DOM's: inserts the nodes in front of this one, in its parent. */
	before(...nodes: Kid[]) {
		const parent = this.parent;
		if (!parent) return;
		for (const node of nodes) if (node instanceof El) node.remove();
		for (const node of nodes) if (node instanceof El) node.parent = parent;
		parent.kids.splice(parent.kids.indexOf(this), 0, ...nodes);
	}
	/** As the DOM's: this node leaves its parent and `next` takes its place. */
	replaceWith(next: El) {
		const parent = this.parent;
		if (!parent) return;
		next.remove();
		next.parent = parent;
		parent.kids.splice(parent.kids.indexOf(this), 1, next);
		this.dropFocus(this);
		this.parent = undefined;
	}
	/** A browser moves the focus to the body when the focused node leaves the document (here: when its subtree is cut loose from where it stood). */
	private dropFocus(gone: El) {
		if (page.focused && gone.contains(page.focused)) page.focused = undefined;
	}
	remove() {
		this.dropFocus(this);
		this.parent?.kids.splice(this.parent.kids.indexOf(this), 1);
		this.parent = undefined;
	}
	contains(other: unknown) {
		for (let at = other as El | undefined; at; at = at.parent) if (at === this) return true;
		return false;
	}
	get isConnected() {
		for (let at: El | undefined = this; at; at = at.parent) if (at === page.body) return true;
		return false;
	}
	focus() {
		page.focused = this;
		this.bubble("focusin");
	}
	blur() {
		if (page.focused === this) page.focused = undefined;
		this.bubble("focusout");
	}
	/** An event sent to this element's own listeners (a custom one, as the answer form's keys send). */
	dispatchEvent(event: { type: string }) {
		for (const on of this.handlers[event.type] ?? []) on(event);
		return true;
	}
	/** An event that rises from this element through its ancestors' listeners. */
	bubble(type: string, extra: object = {}) {
		for (let at: El | undefined = this; at; at = at.parent) for (const on of at.handlers[type] ?? []) on({ target: this, preventDefault() {}, ...extra });
	}
	/** A browser drops the focus from a control that becomes disabled (to the body). */
	get disabled() {
		return this.off;
	}
	set disabled(v: boolean) {
		this.off = v;
		if (v && page.focused === this) page.focused = undefined;
	}
	scrollIntoView() {}
	scrollTo(o: { top?: number; behavior?: string }) {
		this.scrolls.push(o);
	}
	getBoundingClientRect() {
		return { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 };
	}
	get children(): El[] {
		return this.kids.filter((kid): kid is El => kid instanceof El);
	}
	get firstElementChild(): El | null {
		return this.children[0] ?? null;
	}
	get lastElementChild(): El | undefined {
		return this.children.at(-1);
	}
	/** Whether the element matches a comma-separated list of compound selectors: `tag`, `.class`, `#id`, `[attr]`, `[attr="value"]`, and `:not(...)` of one. */
	matches(selector: string): boolean {
		return selector.split(",").some((part) => this.is(part.trim()));
	}
	private is(compound: string): boolean {
		const m = /^([a-z][\w-]*|\*)?((?:\.[\w-]+|#[\w-]+|\[[\w-]+(?:="[^"]*"|=[\w-]+)?\]|:not\([^()]*\))*)$/i.exec(compound);
		if (!m) throw new Error(`fake-dom: unsupported selector ${compound}`);
		if (m[1] && m[1] !== "*" && this.tagName !== m[1]) return false;
		return [...m[2]!.matchAll(/\.([\w-]+)|#([\w-]+)|\[([\w-]+)(?:="([^"]*)"|=([\w-]+))?\]|:not\(([^()]*)\)/g)].every(([, cls, id, attr, quoted, bare, not]) =>
			cls ? this.classes.has(cls) : id ? this.id === id : attr ? ((quoted ?? bare) === undefined ? this.attrs.has(attr) : this.getAttribute(attr) === (quoted ?? bare)) : !this.is(not!));
	}
	closest(selector: string): El | null {
		for (let at: El | undefined = this; at; at = at.parent) if (at.matches(selector)) return at;
		return null;
	}
	/** A descendant chain (`.a .b`, `:scope > .a .b` too: a child combinator is read as a descendant one) matches the elements under this one. */
	querySelectorAll(selector: string): El[] {
		const chains = selector.split(",").map((part) => part.replace(/:scope/g, " ").split(/[\s>]+/).filter(Boolean));
		return this.all((el) => chains.some((chain) => {
			if (!el.is(chain.at(-1)!)) return false;
			let want = chain.length - 2;
			for (let at = el.parent; want >= 0 && at && at !== this.parent; at = at.parent) if (at.is(chain[want]!)) want--;
			return want < 0;
		}));
	}
	querySelector(selector: string): El | null {
		return this.querySelectorAll(selector)[0] ?? null;
	}
	get textContent(): string {
		return this.kids.map((kid) => (typeof kid === "string" ? kid : kid.textContent)).join("");
	}
	set textContent(text: string) {
		this.replaceChildren(...(text ? [text] : []));
	}
	click() {
		if (this.disabled) return;
		this.onclick?.();
		this.bubble("click");
	}
	type(text: string) {
		[this.value, this.selectionStart, this.selectionEnd] = [text, text.length, text.length];
		this.oninput?.();
	}
	/** The descendants (not this one) that match. */
	all(match: (el: El) => boolean): El[] {
		return this.kids.flatMap((kid) => (kid instanceof El ? [...(match(kid) ? [kid] : []), ...kid.all(match)] : []));
	}
	/** This element and its descendants that match, in document order. */
	find(match: (el: El) => boolean): El[] {
		return [...(match(this) ? [this] : []), ...this.all(match)];
	}
	/** The element's text, attributes, and data, as one string: what a reader (or a screen reader) could find in it. */
	dump(): string {
		return [...this.attrs.values(), ...this.kids.map((kid) => (typeof kid === "string" ? kid : kid.dump()))].join(" ");
	}
}

export const page = {
	body: new El("body"),
	focused: undefined as El | undefined,
	hidden: false,
	focus: true,
	on: {} as Record<string, ((e: { target: unknown }) => void)[]>,
	get activeElement(): El {
		return page.focused ?? page.body;
	},
	set activeElement(el: El | undefined | null) {
		page.focused = el ?? undefined;
	},
	hasFocus: () => page.focus,
	addEventListener: (type: string, on: (e: { target: unknown }) => void) => void (page.on[type] ??= []).push(on),
	createElement: (tag: string) => new El(tag),
	createElementNS: (_ns: string, tag: string) => new El(tag),
	importNode: (el: El) => el,
	getElementById: (id: string) => page.body.find((el) => el.id === id)[0] ?? null,
	querySelector: (selector: string) => page.body.querySelector(selector),
	querySelectorAll: (selector: string) => page.body.querySelectorAll(selector),
};

/** html() parses a constant template: the fake answers each with a tree of the tags, classes, and attributes the template names, so the mounted views find their parts. */
const VOID = new Set(["br", "hr", "img", "input", "link", "meta"]);
class Parser {
	parseFromString(markup: string) {
		let root: El | undefined;
		const stack: El[] = [];
		for (const x of markup.matchAll(/<(\/?)([a-z0-9]+)\b((?:[^>"]|"[^"]*")*?)(\/?)>|([^<]+)/g)) {
			const [, close, tag, attrs, self, text] = x;
			if (text !== undefined) {
				stack.at(-1)?.append(text);
				continue;
			}
			if (close) {
				stack.pop();
				continue;
			}
			const el = new El(tag!);
			for (const a of attrs!.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) el.setAttribute(a[1]!, a[2] ?? "");
			if (el.className === "comms-head" || (el.className === "tower-notices" && stack.some((open) => open.className === "tower-notes"))) { // the session view's; a base card's notices (render.ts) are drawn
				const skipped = new El("skipped"), info = new El("button");
				info.setAttribute("class", "head-info");
				stack.at(-1)?.append(info);
				stack.push(skipped);
				continue;
			}
			(stack.at(-1) ?? { append: (e: El) => (root = e) }).append(el);
			if (!self && !VOID.has(tag!)) stack.push(el);
		}
		return { documentElement: root, body: { firstElementChild: root } };
	}
}
class Watcher {
	observe() {}
	unobserve() {}
	disconnect() {}
}
const store = new Map<string, string>();
Object.assign(globalThis, {
	document: page, DOMParser: Parser, HTMLElement: El, IntersectionObserver: Watcher, ResizeObserver: Watcher, MutationObserver: Watcher,
	localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
});
export const stored = store;

/** What the session view and the dossier read besides the document: a window with no media match, a location, and CSS support. The caller owns `setTimeout`. */
export const sessionGlobals = () => void Object.assign(globalThis, { matchMedia: () => ({ matches: false }), CSS: { supports: () => true, escape: (s: string) => s }, window: {}, location: { hash: "", href: "http://x/", origin: "http://x" } });
