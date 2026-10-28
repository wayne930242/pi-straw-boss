import assert from "node:assert/strict";
import { test } from "node:test";
import { El } from "./chat-dom.ts";

// An ended session shows no live activity where the GUI mounts it: the comms' live line (gui/session.ts calls liveNote) and the dossier's mark and state (gui/dossier.ts).

const { m } = await import("../gui/paraglide/messages.js");
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

const unit = (extra: object) => ({ key: "k", name: "billing-old", role: "session", mark: "working" as const, note: "tool:edit", subs: [], control: false, ...extra });
const scene = (u: object, state?: string) => ({ route: { view: "session", ws: "w1", key: "k" }, net: { bases: [{ id: "w1", label: "w1", tabs: [], outside: [u] }] }, cards: {}, info: { name: "billing-old", role: "session", state } }) as never;

test("the comms' live line is empty under an ended session and shows the tool under a live one", async () => {
	const { mountSession } = await import("../gui/session.ts");
	const { subject } = await import("../gui/scene.ts");
	const lines: string[] = [];
	for (const [u, state] of [[unit({ ended: true }), "recent"], [unit({ control: true }), "live"]] as const) {
		const sc = scene(u, state), view = new El("div");
		const data = { older: async () => ({ items: [] }), latest: async () => ({ items: [] }), entry: async () => undefined, post: async () => ({ ok: true }) };
		const session = mountSession(sc, { view: view as never, data: () => data as never, openTile() {}, embedTerminal: async () => () => {}, online: () => true, fullScreen() {}, opened() {} });
		session.open("k");
		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));
		session.draw(subject(sc)!);
		lines.push(view.find((el) => el.classes.has("live-line") || el.dataset.mark !== undefined).map((el) => el.textContent).join("|"));
	}
	assert.ok(!lines[0]!.includes(m.using({ tool: "edit" })), `ended: ${lines[0]}`);
	assert.ok(lines[1]!.includes(m.using({ tool: "edit" })), `live: ${lines[1]}`);
});

test("the dossier of a session that is not live draws no working mark and no tool", async () => {
	const { mountDossier } = await import("../gui/dossier.ts");
	const { subject } = await import("../gui/scene.ts");
	const out: { mark?: string; state: string }[] = [];
	for (const [u, state] of [[unit({ ended: true }), "recent"], [unit({ control: true }), "live"]] as const) {
		const sc = scene(u, state), host = new El("div");
		mountDossier(host as never, sc, { openTile() {}, fullScreen() {} })(subject(sc)!);
		const root = host.kids[0] as El;
		out.push({ mark: root.dataset.mark, state: root.find((el) => el.classes.has("state"))[0]?.textContent ?? "" });
	}
	assert.notEqual(out[0]!.mark, "working");
	assert.ok(!out[0]!.state.includes(m.using({ tool: "edit" })), out[0]!.state);
	assert.equal(out[1]!.mark, "working");
	assert.ok(out[1]!.state.includes(m.using({ tool: "edit" })), out[1]!.state);
});
