import assert from "node:assert/strict";
import { test } from "node:test";
import { trackActivity } from "../src/activity.ts";
import type { Pane, Session, Workspace } from "../src/herdr.ts";
import { buildNet, type Net, type Unit } from "../src/net.ts";
import { sanitizeNet, type Rewrite } from "../src/server/operatesanitize.ts";
import { El, page, sessionGlobals } from "./fake-dom.ts";
import { overwriteGetLocale } from "../gui/paraglide/runtime.js";

// Todo #152 review kir-F001/F002: each hop a launched subagent's kind takes (the map, Link, the activity reader) and each plate that draws it (drawer, dossier, token, chat avatar, the three layer plates) has a test of its own, and a kind draws only on its position.

sessionGlobals();
overwriteGetLocale(() => "en");
Object.assign(globalThis, { HTMLButtonElement: El, requestAnimationFrame: (run: () => void) => run(), innerWidth: 1000, fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
Object.assign(document, { createComment: () => new El("#comment"), documentElement: new El("html"), createDocumentFragment: () => new El("#fragment"), createTextNode: (t: string) => String(t) });
Object.assign(El.prototype, { replaceWith(this: El, node: El) { this.before(node); this.remove(); } });
const icons = (el: El) => el.find((x) => x.tag === "use").map((u) => u.dataset.icon);

const ws: Workspace[] = [{ workspace_id: "wA", label: "Alpha", tokens: { tower: "t" } }];
const pane = (id: string, tokens: Record<string, string>): Pane => ({ pane_id: id, tab_id: "wA:t1", tokens });
const session = (id: string, p: string): Session => ({ id, name: id, status: "idle", herdrLocation: { status: "current", paneId: p, workspace: { id: "wA", label: "wA" }, tab: { id: "wA:t1", label: "t1" } } });
const rw: Rewrite = { key: (k) => k, base: (b) => b, tab: (_w, t) => t, bad() {} };

test("a launched subagent's kind crosses the map: the row's duty is the unit's duty", () => {
	const n = buildNet({ sessions: [session("m", "wA:p1"), session("t", "wA:p9")], panes: [pane("wA:p1", { sb_role: "main", sb_duty: "coordinator" }), pane("wA:p9", { sb_role: "tower" })], workspaces: ws, children: (p) => (p?.pane_id === "wA:p1" ? [{ text: "kid", mark: "working", id: "k1", duty: "scout" }] : []) as never });
	const subs = n.bases[0]!.tabs[0]!.units[0]!.subs;
	assert.deepEqual(subs.map((s) => [s.name, s.role, s.duty]), [["kid", "subagent", "scout"]]);
});

const netOf = (units: Unit[]): Net => ({ bases: [{ id: "wA", label: "A", mark: "idle", tower: null, tabs: [{ id: "t", label: "t", units }], outposts: [], outside: [] }] });
const u = (key: string, role: Unit["role"], over: Partial<Unit> = {}): Unit => ({ id: key, key, control: true, name: key, role, mark: "idle", subs: [], ...over });

test("Link keeps a subagent's worker kind and a main's coordinator kind and drops a word that is no kind", () => {
	const got = sanitizeNet(netOf([u("m", "main", { duty: "standing", subs: [u("s", "subagent", { duty: "scout" }), u("w", "subagent", { duty: "wizard" as never })] })]), rw);
	const m = got!.bases[0]!.tabs[0]!.units[0]!;
	assert.equal(m.duty, "standing");
	assert.deepEqual(m.subs.map((s) => s.duty), ["scout", undefined]);
});

test("the activity reader's duty event is for a main's coordinator kinds only: a subagent's kind appearing or changing raises none", () => {
	let at = 1000;
	const track = trackActivity(() => at);
	const of = (duty: string) => netOf([u("m", "main", { duty: "coordinator", subs: [u("s", "subagent", { duty: duty as never })] })]);
	track(of("scout"));
	at = 2000;
	assert.equal(track(of("reviewer")).events, undefined);
});

const { kindIcon, unitIcon } = await import("../gui/icons.ts");
const { COORDINATOR_DUTIES, WORKER_DUTIES } = await import("../src/duty.ts");
const { KIND_MARK, MARK } = await import("../src/herdr.ts");
const { netTokens } = await import("../src/order.ts");
const { render } = await import("../src/dashboard.ts");
const { World } = await import("./fakes.ts");

test("a kind draws only on its position: coordinator kinds on a main, worker kinds on a subagent, anything else keeps the position's icon", () => {
	for (const d of COORDINATOR_DUTIES) assert.deepEqual([unitIcon("main", d), unitIcon("subagent", d), unitIcon("member", d)], [d, "subagent", "member"], d);
	for (const d of WORKER_DUTIES) assert.deepEqual([unitIcon("subagent", d), unitIcon("main", d), unitIcon("member", d), unitIcon("train", d)], [d, "main", "member", "train"], d);
	assert.equal(kindIcon("member", "standing"), undefined);
});

test("the sidebar marks follow the position too: a main with a worker kind keeps the star, the dashboard drops a mismatched glyph", async () => {
	const world = new World();
	world.herdr.addPane("wA:p1", "wA:t1");
	const run = world.herdr.runFor("wA:p1"), place = { paneId: "wA:p1", tabId: "wA:t1", workspaceId: "wA" };
	assert.equal((await netTokens(run, place, "main", "M", Date.now(), undefined, { integrator: false, duty: "worker" as never })).own.sb_mark, MARK.main);
	await world.stopAll();
	const dash = (kind: string, duty: string) => render({ title: "A", mark: "idle", head: false, rows: [{ group: "net", depth: 0, mark: "idle", text: "X", kind, duty: duty as never }] }, 0, 100, (_t, s) => s).join("\n");
	assert.ok(dash("subagent", "scout").includes(KIND_MARK.scout));
	assert.ok(!dash("subagent", "standing").includes(KIND_MARK.standing));
	assert.ok(!dash("main", "scout").includes(KIND_MARK.scout));
});

const { fillToken, tokenEl } = await import("../gui/tokens.ts");

test("the token draws the unit's kind icon", () => {
	const el = tokenEl() as unknown as El;
	fillToken(el as never, { key: "k", name: "kid", role: "subagent", mark: "working", duty: "planner" }, "w1");
	assert.deepEqual(icons(el), ["planner"]);
});

test("the drawer's row draws the unit's kind icon", async () => {
	const { mountDrawer } = await import("../gui/drawer.ts");
	const drawer = mountDrawer();
	drawer.net(netOf([u("m", "main", { duty: "integrator", subs: [u("s", "subagent", { duty: "scout" })] })]));
	for (const on of page.on["sb-drawer"] ?? []) on({ target: document });
	const all = page.body.find((x) => x.tag === "use").map((x) => x.dataset.icon);
	assert.ok(all.includes("integrator") && all.includes("scout"), String(all));
});

test("the dossier draws the unit's kind icon", async () => {
	const { mountDossier } = await import("../gui/dossier.ts");
	const { subject } = await import("../gui/scene.ts");
	const unit = u("k", "subagent", { duty: "reviewer" });
	const sc = { route: { view: "session", ws: "wA", key: "k" }, net: { bases: [{ id: "wA", label: "wA", tabs: [], outside: [unit] }] }, cards: {}, info: { name: "k", role: "subagent", state: "live" } } as never;
	const host = new El("div");
	mountDossier(host as never, sc, { openTile() {}, fullScreen() {} })(subject(sc)!);
	assert.ok(icons(host).includes("reviewer"), String(icons(host)));
});

test("the chat avatar draws the speaker's kind icon", async () => {
	const { mountChat } = await import("../gui/chat.ts");
	const root = new El("div"), data = { older: async () => ({ items: [] }), latest: async () => ({ items: [] }), entry: async () => undefined };
	const chat = mountChat(root as never, data, { who: () => ({ key: "k", name: "kid", role: "subagent", mark: "idle" as const, duty: "scout" }), link: () => undefined });
	chat.apply({ key: "k", reset: true, items: [{ id: "a1", kind: "assistant", text: "hi" }] } as never);
	assert.ok(icons(root).includes("scout"), String(icons(root)));
});

test("the overlay's dialog, finished list and alert faces draw the unit's kind icon", async () => {
	const { mountPanels } = await import("../gui/layer.ts");
	page.body.replaceChildren();
	for (const id of ["dock", "work", "tiles", "tile-tabs", "alerts", "done", "done-pop", "done-list", "done-clear"]) {
		const el = new El(id === "alerts" || id === "done" || id === "done-clear" ? "button" : "div");
		el.id = id;
		page.body.append(el);
		if (id === "alerts") for (const [tag, cls, ident] of [["b", "", "alert-count"], ["span", "", "alert-text"], ["span", "faces", ""]] as const) Object.assign(el.appendChild(new El(tag)), { id: ident }).setAttribute("class", cls);
	}
	Object.assign(page.body.find((el) => el.id === "done-pop")[0]!, { matches: () => false, hidePopover() {}, getClientRects: () => [] });
	const net = netOf([u("k1", "subagent", { duty: "scout" }), u("k2", "subagent", { duty: "planner" })]);
	const layer = mountPanels({ label: (w: string) => w, net: () => net as never, recent: async () => [], stream: () => "s", showTerminal() {}, post: () => async () => ({ ok: true, status: 200, body: {} as never }), trust: async () => ({ ok: true, status: 200, body: {} as never }) } as never);
	const asking = { key: "k1", ws: "wA", name: "k1", role: "subagent", mark: "waiting", at: 1 }, finished = { key: "k2", ws: "wA", name: "k2", role: "subagent", mark: "done", at: 1 };
	layer.alerts([asking, finished] as never, new Map([[asking.key, asking], [finished.key, finished]]) as never);
	layer.stack.show(asking as never);
	const [dock, faces, done] = ["dock", "faces", "done-list"].map((id) => (id === "faces" ? page.body.find((x) => x.classes.has("faces"))[0]! : page.body.find((x) => x.id === id)[0]!));
	assert.ok(icons(dock!).includes("scout"), `dialog ${icons(dock!)}`);
	assert.ok(icons(faces!).includes("scout"), `faces ${icons(faces!)}`);
	assert.ok(icons(done!).includes("planner"), `done ${icons(done!)}`);
});
