import assert from "node:assert/strict";
import { test } from "node:test";
import { El } from "./chat-dom.ts";

// An ended session shows no live activity where the GUI mounts it: the comms' live line (gui/session.ts calls liveNote) the dossier's mark and state (gui/dossier.ts), and the map's unit card (gui/render.ts).

import "./session-dom.ts";
const { m } = await import("../gui/paraglide/messages.js");

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

test("the map card of a unit that is not live draws no working mark and no tool, and one that is live draws both", async () => {
	const { fillUnit, unitEl } = await import("../gui/render.ts");
	const drawn: { mark: string | undefined; note: string; label: string | null }[] = [];
	for (const extra of [{ ended: true }, { control: true }]) {
		const el = unitEl() as unknown as El;
		fillUnit(el as never, unit(extra) as never);
		drawn.push({ mark: el.dataset.mark, note: el.find((x) => x.classes.has("note"))[0]!.textContent, label: el.find((x) => x.classes.has("hit"))[0]!.attrs.get("aria-label") ?? null });
	}
	assert.notEqual(drawn[0]!.mark, "working");
	assert.ok(!drawn[0]!.note.includes(m.using({ tool: "edit" })), drawn[0]!.note);
	assert.ok(!drawn[0]!.label?.includes(m.using({ tool: "edit" })), String(drawn[0]!.label));
	assert.equal(drawn[1]!.mark, "working");
	assert.ok(drawn[1]!.note.includes(m.using({ tool: "edit" })), drawn[1]!.note);
	assert.ok(drawn[1]!.label?.includes(m.using({ tool: "edit" })), String(drawn[1]!.label));
});
