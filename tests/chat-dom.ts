// The few DOM calls the chat makes, as a fake document: importing this module installs it before gui/chat.ts is loaded.

export class El {
	tag: string;
	attrs = new Map<string, string>();
	kids: (El | string)[] = [];
	dataset: Record<string, string> = {};
	listeners = new Map<string, unknown>();
	classes = new Set<string>();
	classList = { add: (c: string) => void this.classes.add(c), remove: (c: string) => void this.classes.delete(c), contains: (c: string) => this.classes.has(c), toggle: (c: string) => (this.classes.has(c) ? !this.classes.delete(c) : !!this.classes.add(c)) };
	hidden = false;
	parent: El | undefined;
	scrollTop = 0;
	scrollHeight = 0;
	clientHeight = 0;
	constructor(tag: string) {
		this.tag = tag;
	}
	setAttribute(name: string, value: string) {
		this.attrs.set(name, value);
		if (name === "class") this.classes = new Set(value.split(" "));
	}
	removeAttribute(name: string) {
		this.attrs.delete(name);
	}
	focus() {}
	private adopt(kids: (El | string)[]) {
		for (const kid of kids) if (typeof kid !== "string") (kid.remove(), (kid.parent = this));
	}
	append(...kids: (El | string)[]) {
		this.adopt(kids);
		this.kids.push(...kids);
	}
	prepend(...kids: (El | string)[]) {
		this.adopt(kids);
		this.kids.unshift(...kids);
	}
	replaceChildren(...kids: (El | string)[]) {
		for (const old of this.kids) if (typeof old !== "string") old.parent = undefined;
		this.adopt(kids);
		this.kids = [...kids];
	}
	get isConnected() {
		return this.parent !== undefined;
	}
	/** As the DOM's: inserts the nodes in front of this one, in its parent. */
	before(...nodes: (El | string)[]) {
		const parent = this.parent;
		if (!parent) return;
		for (const node of nodes) if (typeof node !== "string") node.remove();
		for (const node of nodes) if (typeof node !== "string") node.parent = parent;
		parent.kids.splice(parent.kids.indexOf(this), 0, ...nodes);
	}
	addEventListener(type: string, run: unknown) {
		this.listeners.set(type, run);
	}
	remove() {
		if (this.parent) this.parent.kids = this.parent.kids.filter((k) => k !== this);
		this.parent = undefined;
	}
	querySelector(selector: string) {
		return this.find((el) => (selector.startsWith(".") ? el.classes.has(selector.slice(1)) : el.tag === selector))[0] ?? null;
	}
	get textContent(): string {
		return this.kids.map((k) => (typeof k === "string" ? k : k.textContent)).join("");
	}
	set textContent(value: string) {
		this.kids = [value];
	}
	find(pred: (el: El) => boolean): El[] {
		return [this, ...this.kids.flatMap((k) => (typeof k === "string" ? [] : k.find(pred)))].filter(pred);
	}
}
/** html() parses a constant template; the fake answers each with a bare element that has a <use>. */
class Parser {
	parseFromString() {
		const root = new El("span");
		root.append(new El("use"));
		return { body: { firstElementChild: root } };
	}
}
class Watcher {
	observe() {}
	disconnect() {}
}
Object.assign(globalThis, {
	document: { createElement: (tag: string) => new El(tag), importNode: (el: El) => el },
	DOMParser: Parser, HTMLElement: El, IntersectionObserver: Watcher, ResizeObserver: Watcher,
});
