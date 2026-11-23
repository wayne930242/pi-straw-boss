import assert from "node:assert/strict";
import { test } from "node:test";
import type { Item } from "../src/items.ts";
import type { HeadUnit } from "../src/nethead.ts";
import type { Net, RunDialog, TowerService, Unit } from "../src/net.ts";
import { alertsOf } from "../gui/alerts.ts";
import type { Chat, HistoryEvent } from "../gui/chat.ts";
import type { Answer } from "../gui/post.ts";
import { El, page } from "./fake-dom.ts";

// Zen's run cards (docs/specs/2026-11-24-zen-f.md §2, §8.3): a dialog a headless run waits on is a blocking card on this computer's page only. It queues like every card (the cue's words are the only change), Enter takes it with the focus on its
// primary control and, for an approval, the confirm bar's 400 ms dwell; each method answers through Standard's route and body; one that ends while queued leaves unseen, one that ends on the screen stays with its words; a `boss_wait_ask` dialog
// is its wait card; a paired device's page draws none. Red on 84f77b3e: Zen had no run cards (`runs` did not exist).
const { mountZen, real } = await import("../gui/zen.ts");
const { m } = await import("../gui/paraglide/messages.js");

const service = (o: Partial<TowerService> = {}): TowerService => ({ state: "running", queued: 0, notices: [], parked: [], allyRuns: [], headless: true, ...o });
const head = (): HeadUnit => ({ key: "sb-head", name: "head tower", mark: "idle", state: "running", service: service(), asks: [] });
const unit = (key: string, o: Partial<Unit> = {}): Unit => ({ id: key, key, control: true, name: key, role: "main", mark: "idle", subs: [], ...o });
/** Harbor's tower runs `r7`, live unless `ended`; a wait W3 of Harbor's tower is open when `wait`. */
const net = (o: { ended?: boolean; wait?: boolean; units?: Unit[] } = {}): Net => ({
	bases: [{ id: "wA", label: "Harbor", mark: "idle", tower: { name: "tower", mark: "working", key: "tA", control: true, subs: [], service: service({ ...(o.ended ? {} : { run: { id: "r7", kind: "local", startedAt: "" } }), ...(o.wait ? { memory: { rev: 1, standing: 0, decisions: 0, waits: 1, proposals: [], bossWaits: [{ id: "W3", text: "Pick a release date", at: new Date(Date.now() - 60_000).toISOString() }] } } : {}) }) }, tabs: [{ id: "t1", label: "t", units: o.units ?? [] }], outposts: [], outside: [] }],
	trust: [], head: head(),
}) as Net;
const dialog = (o: Partial<RunDialog> = {}): RunDialog => ({ key: "r7:sb-req1", workspace: "wA", method: "confirm", title: "Invite merlin-box to waydosoft", message: "action   invite\nteam     waydosoft", approval: true, run: "local", label: "Harbor", at: 1_000_000, ...o });

function rig(o: { remote?: boolean; start?: { key: string; ws: string } } = {}) {
	let t = 1_000_000;
	const timers: { at: number; fn: () => void }[] = [];
	const calls = { sound: [] as string[], posts: [] as { path: string; body: Record<string, unknown> }[], composers: [] as { key: string; box: El }[] };
	let status = 200;
	globalThis.fetch = (async (url: string, init: { body: string }) => (calls.posts.push({ path: String(url).replace(/^api\//, ""), body: JSON.parse(init.body) as Record<string, unknown> }), new Response(JSON.stringify(status < 400 ? { ok: true } : { reason: "That dialog is not waiting any more" }), { status }))) as never;
	const mounts = {
		...real,
		composer: ((root: El, key: string) => { const box = new El("textarea"); root.replaceChildren(box); calls.composers.push({ key, box }); return { box, update() {} }; }) as never,
		chat: async () => () => ({ apply() {}, reveal() {}, box() {} }) as unknown as Chat,
	};
	const items: Item[] = [{ id: "x", kind: "assistant", text: "The box has to join the team first." } as Item];
	const deps = {
		data: () => ({ older: async () => ({ items: [] }), latest: async () => ({ items: [] }), entry: async () => undefined }),
		recent: async () => items, post: () => async () => ({ ok: true, status: 200, body: { accepted: true } }),
		label: (ws: string) => (ws === "wA" ? "Harbor" : ws), online: () => true, remote: o.remote ?? false, remind() {}, sound: (s: string) => void calls.sound.push(s), leave() {},
		terminals: async () => ({}), watch() {}, start: () => o.start,
		fs: { doc: { addEventListener() {}, documentElement: {} }, standalone: () => false, touch: () => false, seen: { getItem: () => "1", setItem() {} }, later: () => () => {} },
		still: () => false, random: () => 0, now: () => t,
		later: (fn: () => void, ms: number) => { const e = { at: t + ms, fn }; timers.push(e); return () => void (timers.includes(e) && timers.splice(timers.indexOf(e), 1)); },
	};
	const root = new El("section");
	page.body.replaceChildren(root);
	[page.focused, page.hidden, page.focus] = [undefined, false, true];
	const z = mountZen(root as unknown as HTMLElement, deps as never, mounts as never);
	const settle = () => new Promise((done) => setImmediate(done));
	const advance = async (ms: number) => {
		t += ms;
		for (;;) {
			const due = timers.filter((e) => e.at <= t).sort((a, b) => a.at - b.at)[0];
			if (!due) break;
			timers.splice(timers.indexOf(due), 1);
			due.fn();
		}
		await settle();
	};
	const by = (cls: string) => root.all((el) => el.classes.has(cls));
	const cue = () => by("zen-head-cue-btn").map((b) => b.textContent).join("");
	return {
		z, root, calls, by, settle, advance, cue, now: () => t,
		refuse: () => (status = 409),
		feed: (n: Net) => z.net(alertsOf(n, t), n),
		start: async (n: Net = net()) => (z.net(alertsOf(n, t), n), z.show(), await settle()),
		button: (text: string) => root.all((el) => el.tagName === "button" && el.textContent === text)[0],
		/** The page without the cue's words, its button's state, and its own `data-away`: what must not change when a card queues. */
		still: () => JSON.stringify(snap(root)),
		esc: () => z.escape({ preventDefault() {} }),
	};
}
/** The tree, with the cue's line taken out (its words and its away mark are the one thing a queued card changes), and the folded hint, which names Enter for the card instead of the head (Z-D19, the cue's own words). */
const snap = (el: El): unknown => (el.classes.has("zen-head-cue") || el.classes.has("zen-head-hint") ? "cue" : [el.tagName, [...el.attrs].filter(([k]) => k !== "data-away").sort(), el.kids.map((k) => (k instanceof El ? snap(k) : String(k)))]);

test("a run dialog that arrives on the circle, the companion, or the head's history changes nothing on the page but the cue's words, plays no sound, and moves no focus", async () => {
	for (const where of ["circle", "companion", "history"] as const) {
		const r = rig(where === "companion" ? { start: { key: "a", ws: "wA" } } : {});
		await r.start(net({ units: [unit("a")] }));
		if (where === "history") (r.z.key("history"), r.z.key("history"), await r.settle());
		const before = r.still(), focus = page.focused;
		for (const n of [1, 2, 5]) {
			r.z.runs(Array.from({ length: n }, (_, i) => dialog({ key: `r7:d${i}`, at: 1_000_000 + i })));
			await r.settle();
			assert.equal(r.still(), before, `${where}: ${n} queued: nothing but the cue changed`);
			assert.equal(r.cue(), n === 1 ? m.zen_cue_one({ n }) : m.zen_cue_many({ n }), `${where}: the cue counts them`);
		}
		assert.deepEqual(r.calls.sound, [], `${where}: no sound`);
		assert.equal(page.focused, focus, `${where}: the focus did not move`);
		assert.equal(r.by("zen-card").length, 0, `${where}: no card took the screen by itself`);
	}
});

test("Enter takes the run card: the bowl, who asks and what, the focus on Allow; an approval's dwell: an Enter within 400 ms, a held one, or one that began before it presses nothing", async () => {
	const r = rig();
	await r.start();
	r.z.runs([dialog()]);
	await r.settle();
	r.z.key("talk");
	await r.settle();
	assert.deepEqual(r.calls.sound, ["bowl"]);
	const text = r.root.textContent;
	for (const words of [m.zen_run_approval_title({ name: "Harbor" }), m.zen_run_who({ name: "Harbor" }), "Invite merlin-box to waydosoft", "team     waydosoft", "The box has to join the team first."]) assert.ok(text.includes(words), words);
	const allow = r.button(m.zen_run_allow())!;
	assert.equal(page.focused, allow, "Allow has the focus (ZF-8)");
	let stopped = 0;
	const enter = (extra: object) => allow.bubble("keydown", { key: "Enter", repeat: false, timeStamp: Infinity, preventDefault() {}, stopPropagation: () => void stopped++, ...extra });
	enter({});
	assert.equal(stopped, 1, "within 400 ms of the card: swallowed");
	await r.advance(500);
	enter({ repeat: true });
	assert.equal(stopped, 2, "a held Enter: swallowed");
	enter({ timeStamp: -1 });
	assert.equal(stopped, 3, "one that began before the card: swallowed");
	enter({});
	assert.equal(stopped, 3, "a fresh Enter after the dwell goes through");
	assert.equal(r.calls.posts.length, 0, "nothing was answered by the keys swallowed");
});

test("each method answers through Standard's route and body: Allow, a select's option and Send, an input's text and Send, a head run's dialog to head/dialog, and Esc is Cancel", async () => {
	const cases: [RunDialog, (r: ReturnType<typeof rig>) => void, string, Record<string, unknown>][] = [
		[dialog(), (r) => r.button(m.zen_run_allow())!.click(), "tower/wA/dialog", { key: "r7:sb-req1", confirmed: true }],
		[dialog({ approval: undefined, key: "r7:c1" }), (r) => r.button(m.run_dialog_no())!.click(), "tower/wA/dialog", { key: "r7:c1", confirmed: false }],
		[dialog({ method: "select", key: "r7:s1", approval: undefined, options: ["main", "release/0.85"] }), (r) => (r.by("zen-run-opt")[1]!.click(), r.button(m.run_dialog_send())!.click()), "tower/wA/dialog", { key: "r7:s1", value: "release/0.85" }],
		[dialog({ method: "input", key: "r7:i1", approval: undefined }), (r) => { const f = r.by("zen-run-input")[0]!; f.value = "0.85.0"; f.bubble("input"); r.button(m.run_dialog_send())!.click(); }, "tower/wA/dialog", { key: "r7:i1", value: "0.85.0" }],
		[dialog({ run: "head", key: "r9:c1", approval: undefined }), (r) => r.button(m.run_dialog_yes())!.click(), "head/dialog", { key: "r9:c1", confirmed: true }],
		[dialog({ key: "r7:c2", approval: undefined }), (r) => r.esc(), "tower/wA/dialog", { key: "r7:c2", cancelled: true }],
	];
	for (const [d, act, path, body] of cases) {
		const r = rig();
		await r.start();
		r.z.runs([d]);
		await r.settle();
		r.z.key("talk");
		await r.advance(500);
		act(r);
		await r.settle();
		await r.settle();
		assert.deepEqual(r.calls.posts, [{ path, body }], `${d.method} ${d.run}`);
		assert.ok(r.calls.sound.includes("knock"), "accepted: the knock");
	}
});

test("a run card that ends while queued leaves unseen; on the screen it stays with its words and Back to the breath, and only answered elsewhere knocks", async () => {
	const q = rig();
	await q.start();
	q.z.runs([dialog()]);
	await q.settle();
	q.z.runs([]);
	await q.settle();
	assert.equal(q.cue(), "", "the cue dropped it");
	assert.deepEqual(q.calls.sound, [], "no bowl, no knock");
	for (const [why, n, words, knock] of [["elsewhere", net(), m.zen_elsewhere(), true], ["ended", net({ ended: true }), m.zen_run_ended(), false], ["expired", net(), m.zen_run_expired(), false]] as const) {
		const r = rig();
		await r.start();
		r.z.runs([dialog({ at: why === "expired" ? 1_000_000 - 10 * 60_000 : 1_000_000 })]);
		await r.settle();
		r.z.key("talk");
		await r.settle();
		r.feed(n);
		r.z.runs([]);
		await r.settle();
		assert.ok(r.root.textContent.includes(words), `${why}: ${words}`);
		assert.ok(r.button(m.zen_rest()), `${why}: Back to the breath`);
		assert.equal(r.button(m.zen_run_allow())!.disabled, true, `${why}: no answer left`);
		assert.equal(r.calls.sound.includes("knock"), knock, `${why}: knock only for answered elsewhere`);
	}
});

test("ZF-3: a dialog boss_wait_ask draws is no card of its own: its wait card is the one, taken first as blocking", async () => {
	const r = rig();
	await r.start(net({ wait: true, units: [unit("a", { mark: "waiting", since: 2_000_000_000_000, pending: { callId: "c", tool: "robot_hand", answer: { dialog: "d", digest: "0".repeat(64), select: { title: "x", choices: [{ label: "y" }] } } } })] }));
	assert.equal(r.cue(), m.zen_cue_many({ n: 2 }), "a unit's dialog and the wait");
	r.z.runs([dialog({ key: "r7:s1", method: "select", approval: undefined, options: ["W3"], wait: { workspace: "wA", id: "W3" } })]);
	await r.settle();
	assert.equal(r.cue(), m.zen_cue_many({ n: 2 }), "no third card for the dialog");
	r.z.key("talk");
	await r.settle();
	assert.ok(r.root.textContent.includes("Pick a release date"), "the asked wait ranks blocking and, older, comes first");
});

test("a paired device's page draws no run card and its cue never counts one", async () => {
	const r = rig({ remote: true });
	await r.start();
	r.z.runs([dialog(), dialog({ key: "r7:x" })]);
	await r.settle();
	assert.equal(r.cue(), "");
	r.z.key("talk");
	await r.settle();
	assert.equal(r.by("zen-card").length, 0);
});

test("ZF-5 (§4): a parked notice, a notice, and another tower's run change nothing on any Zen screen: no card, no cue, no other tower's name, no digit but the cue's", async () => {
	for (const where of ["circle", "companion", "history"] as const) {
		const r = rig(where === "companion" ? { start: { key: "a", ws: "wA" } } : {});
		const base = net({ units: [unit("a")] });
		await r.start(base);
		if (where === "history") (r.z.key("history"), r.z.key("history"), await r.settle());
		const before = r.still();
		const busy = structuredClone(base);
		busy.bases.push({ id: "wB", label: "Orchard", mark: "working", tower: { name: "tower", mark: "working", key: "tB", control: true, subs: [], service: service({ run: { id: "r8", kind: "local", startedAt: "" }, parked: [{ id: "p1", kind: "boss", first: "deploy at 3" }], notices: [{ id: "n1", level: "info", kind: "run", text: "↳ Orchard run", at: 1 }] }) }, tabs: [], outposts: [], outside: [] } as never);
		busy.bases[0]!.tower!.service!.parked = [{ id: "p2", kind: "boss", first: "later" }];
		r.feed(busy);
		await r.settle();
		assert.equal(r.still(), before, `${where}: unchanged`);
		assert.equal(r.cue(), "", `${where}: no cue`);
		assert.ok(!r.root.textContent.includes("Orchard"), `${where}: no other tower's name`);
		r.z.runs([dialog(), dialog({ key: "r7:b" })]);
		await r.settle();
		assert.deepEqual(r.root.textContent.match(/\d/g)?.join("") ?? "", (r.cue().match(/\d/g) ?? []).join(""), `${where}: the cue's is the only digit`);
	}
});
