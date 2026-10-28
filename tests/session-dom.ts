import { El } from "./chat-dom.ts";

// The fake document the session view and the dossier mount into (gui/session.ts, gui/dossier.ts): chat-dom's elements, with html() answering each
// template by a tree of the classes it names. Importing this module installs it.

Object.assign(document, { addEventListener() {}, activeElement: null, body: {} });
Object.assign(globalThis, { matchMedia: () => ({ matches: false }), CSS: { supports: () => true }, window: {}, location: { hash: "", href: "http://x/", origin: "http://x" }, setTimeout: () => 0 });
/** html() answers each template with a tree of the classes the template names, so the mounted views find their parts. */
class Parser {
	parseFromString(markup: string) {
		let root: El | undefined;
		const stack: El[] = [];
		for (const x of markup.matchAll(/<(\/?)([a-z0-9]+)\b([^>]*?)(\/?)>/g)) {
			const [, close, tag, attrs, self] = x;
			if (close) {
				stack.pop();
				continue;
			}
			const el = new El(tag!), cls = /class="([^"]+)"/.exec(attrs!)?.[1];
			if (cls) el.setAttribute("class", cls);
			if (/^(comms-head|tower-notices)$/.test(cls ?? "")) {
				const skipped = new El("skipped"), info = new El("button");
				info.setAttribute("class", "head-info");
				stack.at(-1)?.append(info);
				stack.push(skipped);
				continue;
			}
			(stack.at(-1) ?? { append: (e: El) => (root = e) }).append(el);
			if (!self) stack.push(el);
		}
		return { body: { firstElementChild: root } };
	}
}
Object.assign(globalThis, { DOMParser: Parser });
Object.defineProperty(El.prototype, "children", { get(this: El) { return this.kids.filter((k) => typeof k !== "string"); } });
Object.defineProperty(El.prototype, "lastElementChild", { get(this: El) { return this.kids.at(-1); } });
Object.defineProperty(El.prototype, "firstElementChild", { get(this: El) { return this.kids[0]; } });
Object.assign(El.prototype, { value: "", toggleAttribute(this: El, name: string, on?: boolean) { on === false ? this.attrs.delete(name) : this.attrs.set(name, ""); }, getAttribute(this: El, name: string) { return this.attrs.get(name) ?? null; }, querySelectorAll(this: El, selector: string) { const [parent, tag] = selector.split(" "); return tag ? this.find((el) => el.classes.has(parent!.slice(1)))[0]?.find((el) => el.tag === tag) ?? [] : this.find((el) => el.classes.has(selector.slice(1))); } });
Object.assign(El.prototype, {
	contains(this: El, el: unknown) {
		return el === this || this.kids.some((k) => typeof k !== "string" && (k as El & { contains(e: unknown): boolean }).contains(el));
	},
});
/** A map card's parts are found by the last class or tag of selectors such as ":scope > .card .age". */
const plainQuery = El.prototype.querySelector;
El.prototype.querySelector = function (this: El, selector: string) {
	return plainQuery.call(this, selector.trim().split(/\s+/).at(-1)!);
};
Object.assign(El.prototype, { closest: () => null }); // a card in no base
