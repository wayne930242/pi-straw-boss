import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Item } from "../src/items.ts";
import type { Net, Unit } from "../src/net.ts";
import { contrast, declarations, mix, rulesOf } from "./css-rules.ts";
import { El } from "./fake-dom.ts";

// Storybook's chat page (docs/specs/2026-11-26-storybook-theme/spec.md §B11, the boss's pick A): a notice is stamped with its sender's animal where the view draws senders (Storybook), the comms bird where the net
// does not name the sender and in every other view; the corner picture is named only under its phase; the working bee moves by transform alone, slowly, and stops for calm, reduced motion, and forced colours.
const { mountChat } = await import("../gui/chat.ts");
const { senderIn } = await import("../gui/senders.ts");
const { repoint, useIcons } = await import("../gui/icons.ts");

const css = readFileSync(new URL("../gui/themes/storybook/storybook.css", import.meta.url), "utf8"), bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
const unit = (key: string, name: string, role: Unit["role"], more: Partial<Unit> = {}): Unit => ({ id: key, key, control: true, name, role, mark: "idle", subs: [], ...more });
const net = {
	head: { key: "head", name: "Straw Net", mark: "idle" },
	bases: [{
		id: "w1", label: "Harbor", mark: "idle", tabs: [{ label: "billing", units: [unit("a1", "billing-main", "main", { duty: "coordinator", subs: [unit("a1/lint", "lint-sweep", "subagent", { duty: "worker" }), unit("a1/doc", "docs-writer", "subagent")] })] }],
		outposts: [], outside: [unit("o1", "stray", "outside")], tower: { key: "t1", name: "harbor-tower", mark: "idle", control: true, subs: [unit("t1/s", "tower-helper", "subagent")] },
	}, { id: "w2", label: "Ops", mark: "idle", tabs: [{ label: "ops", units: [unit("a3", "ops-main", "main")] }], outposts: [], outside: [], tower: null }],
} as unknown as Net;

test("a sender is found by its key, else its name, anywhere in the net: the head, a tower, a main with its kind, a nested subagent, an outside unit; a name the net does not list is nobody", () => {
	assert.deepEqual(senderIn(net, "lint-sweep"), { role: "subagent", duty: "worker" });
	assert.deepEqual(senderIn(net, "docs-writer"), { role: "subagent" });
	assert.deepEqual(senderIn(net, "renamed", "a1"), { role: "main", duty: "coordinator" }, "the key wins over a stale name");
	assert.deepEqual(senderIn(net, "ops-main", "not-a-key"), { role: "main" }, "an id the net does not hold falls back to the name");
	assert.deepEqual(senderIn(net, "harbor-tower"), { role: "tower" });
	assert.deepEqual(senderIn(net, "tower-helper"), { role: "subagent" });
	assert.deepEqual(senderIn(net, "Straw Net"), { role: "crown" });
	assert.deepEqual(senderIn(net, "stray"), { role: "outside" });
	assert.equal(senderIn(net, "Laptop"), undefined);
	assert.equal(senderIn(undefined, "lint-sweep"), undefined);
	assert.equal(senderIn(net, ""), undefined);
});

function notice(from: string, listed?: () => Net | undefined) {
	const root = new El("div"), data = { older: async () => ({ items: [] }), latest: async () => ({ items: [] }), entry: async () => undefined };
	const chat = mountChat(root as unknown as HTMLElement, data, { who: () => ({ key: "a1", name: "billing-main", role: "main", mark: "idle" as const }), link: () => undefined, ...(listed ? { net: listed } : {}) });
	const it: Item = { id: "n1", kind: "notice", type: "subagent_result", from, text: "No findings." };
	chat.apply({ key: "a1", reset: true, items: [it] });
	return { root, use: root.find((el) => el.tag === "use")[0]! };
}

test("a notice carries its sender's icon beside the comms bird: Standard keeps the bird, a view that draws senders shows the sender, and an unknown sender keeps the bird", () => {
	let asked = 0;
	const known = notice("lint-sweep", () => (asked++, net));
	assert.equal(asked, 1, "the net is read when the notice is drawn");
	assert.equal(known.use.attrs.get("data-icon"), "comms");
	assert.equal(known.use.attrs.get("data-sender"), "worker", "a subagent's kind names its icon, as on the map");
	assert.equal(known.use.attrs.get("href"), "#i-comms", "Standard draws the bird: its look does not change");
	const main = notice("ops-main (a3)", () => net);
	assert.equal(main.use.attrs.get("data-sender"), "main", "an intercom sender's `name (id)` is read");
	const unknown = notice("Laptop", () => net), none = notice("lint-sweep");
	for (const n of [unknown, none]) assert.equal(n.use.attrs.get("data-sender"), undefined);
	useIcons("storybook", '<symbol id="storybook-comms"/><symbol id="storybook-worker"/><symbol id="storybook-main"/>', true);
	try {
		for (const n of [known, main, unknown, none]) repoint(n.root as unknown as ParentNode);
		assert.deepEqual([known, main, unknown, none].map((n) => n.use.attrs.get("href")), ["#storybook-worker", "#storybook-main", "#storybook-comms", "#storybook-comms"]);
		assert.equal(notice("lint-sweep", () => net).use.attrs.get("href"), "#storybook-worker", "drawn with the sender's icon at once");
		useIcons("raven", '<symbol id="raven-comms"/><symbol id="raven-worker"/>');
		repoint(known.root as unknown as ParentNode);
		assert.equal(known.use.attrs.get("href"), "#raven-comms", "a view that does not draw senders keeps the bird");
	} finally {
		useIcons("standard");
	}
});

test("the corner picture: one per phase, named only under its phase's selector, at most 20 KB, drawn in the log's corner on a wide page and after the last message on a narrow one", () => {
	for (const phase of ["day", "night"]) {
		const named = [...bare.matchAll(new RegExp(`([^{}]*)\\{[^{}]*nook-${phase}\\.webp`, "g"))].map((m) => m[1]!.trim());
		assert.deepEqual(named, [`[data-view="storybook"][data-phase="${phase}"] .chat-root`], `nook-${phase}.webp is named once, under ${phase}`);
		assert.ok(readFileSync(new URL(`../gui/themes/storybook/nook-${phase}.webp`, import.meta.url)).length <= 20_000);
	}
	assert.equal([...bare.matchAll(/var\(--sb-nook\)/g)].length, 2, "two places draw it");
	assert.match(bare, /\[data-view="storybook"\] \.comms-in > \.chat-root \{ container: comms \/ inline-size;/);
	assert.match(bare, /@container comms \(min-width: 980px\) \{ \[data-view="storybook"\] \[data-slot="chat-corner"\] \{ display: block; position: absolute; inset: 0; transform: translateZ\(0\); background: var\(--sb-nook\) [^;]*no-repeat; \} \}/, "a wide page: fixed in the log's corner");
	assert.match(bare, /@container comms \(max-width: 979\.98px\) \{ \[data-view="storybook"\] \.chat-list::after \{[^}]*var\(--sb-nook\)/, "a narrow page: after the last message, never over the end sentinel");
	assert.match(bare, /\[data-view="storybook"\] \.chat-list \{ max-width: 800px;/, "the column leaves the corner to the picture");
	assert.match(bare, /@media \(forced-colors: active\) \{[^@]*\.chat-list::after[^@]*display: none;[^@]*\.chat-scroll \{ background: none; \}/, "forced colours draw no picture, holes, or tape");
});

test("the working bee: only while the unit works, transform alone, no cycle under 1.6 s, still under calm and reduced motion, gone under forced colours, and Standard's sweep stopped", () => {
	const rules = rulesOf(css);
	const still = rules.find((r) => r.selector === '[data-view="storybook"] .composer[data-activity="working"] > [data-slot="composer-edge"]::before');
	assert.ok(still && /mask: var\(--sb-bee\)/.test(still.body) && !/animation/.test(still.body), "a still bee, drawn as a mask");
	for (const r of rules) if (/\.composer(?!\[data-activity="working"\])[^,]*::(before|after)/.test(r.selector) && !r.selector.includes(".cmp-row")) assert.equal(r.body.trim(), "display: none;", `${r.selector}: no bee on a composer that is not working`);
	const moving = [...bare.matchAll(/([^{}]*)\{ animation: (sb-bee[^;]*); \}/g)];
	assert.ok(moving.length >= 2);
	for (const [, selector, value] of moving) {
		for (const part of selector!.split(",")) assert.match(part.trim(), /^html\[data-view="storybook"\](\[data-phase="night"\])?:not\(\[data-calm\]\) \.composer\[data-activity="working"\] > \[data-slot="composer-edge"\]::(before|after)$/);
		for (const s of value!.matchAll(/(\d*\.?\d+)s\b/g)) assert.ok(Number(s[1]) >= 1.6, `${value}: ${s[1]} s`);
		assert.ok(bare.indexOf(selector!) > bare.indexOf("@media (prefers-reduced-motion: no-preference) {"), "inside the motion block");
	}
	for (const name of ["sb-bee", "sb-bee-glow"]) {
		const body = new RegExp(`@keyframes ${name} \\{(.*?)\\}\\s*\\}`).exec(bare)?.[1] ?? "";
		const props = new Set([...body.matchAll(/\{([^{}]*)\}/g)].flatMap((m) => declarations(m[1]!).map(([p]) => p)));
		assert.ok(props.size && [...props].every((p) => p === "transform" || p === "opacity"), `${name}: ${[...props]}`);
	}
	assert.match(bare, /html\[data-view="storybook"\]:not\(\[data-calm\]\) \.comms-in \.composer\[data-activity="working"\] \.cmp-row::before \{ animation: none;/, "the ring's sweep is off where the bee flies");
	assert.match(bare, /@media \(forced-colors: active\) \{[^@]*\[data-slot="composer-edge"\]::before, \[data-view="storybook"\] \[data-slot="composer-edge"\]::after \{ display: none; \}/);
});

test("the page's text keeps 4.5 : 1 on the page, the boss's note, and a slip, and a sticker's label on its sticker, in both phases (the night's error sticker in --err-soft)", () => {
	const rules = rulesOf(css);
	for (const [phase, selector] of [["day", '[data-view="storybook"]'], ["night", '[data-view="storybook"][data-phase="night"]']] as const) {
		const c = Object.fromEntries(declarations(rules.find((r) => r.selector === selector)!.body).filter(([, v]) => /^#[0-9a-f]{6}$/i.test(v)).map(([p, v]) => [p.slice(2), v]));
		for (const ground of ["sb-page", "sb-you", "sb-slip"]) for (const text of ["text", "dim", "accent", "violet"]) assert.ok(contrast(c[text]!, c[ground]!) >= 4.5, `${phase}: --${text} on --${ground} ${contrast(c[text]!, c[ground]!).toFixed(2)}`);
		for (const state of ["ok", "working", phase === "night" ? "err-soft" : "err"]) {
			const sticker = mix(c[state]!, 0.13, c["sb-page"]!);
			assert.ok(contrast(c[state]!, sticker) >= 4.5 && contrast(c.dim!, sticker) >= 4.5, `${phase}: --${state} on its sticker ${contrast(c[state]!, sticker).toFixed(2)}`);
		}
	}
	assert.match(bare, /\[data-view="storybook"\]\[data-phase="night"\] \.act > summary\[data-mark="error"\] \{ --c: var\(--err-soft\); \}/);
});
