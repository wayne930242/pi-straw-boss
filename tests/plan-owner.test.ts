import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cleanPlan } from "../src/board.ts";
import { deriveBoard } from "../src/boardauto.ts";
import { createBossPaths, type Post } from "../src/bosspaths.ts";
import { todosOf } from "../src/items.ts";
import type { Net, Unit } from "../src/net.ts";
import { ownerOf, todoRef } from "../src/planowner.ts";
import { sanitizeHistory, type Rewrite } from "../src/server/operatesanitize.ts";
import type { Kit } from "../src/state.ts";
import { El, sessionGlobals } from "./fake-dom.ts";

// A todo's owner on the net (src/planowner.ts; pi-todo-ledger 0.5.0 sets `owner` to the Herdr child's full name and `metadata.herdr.id` to its run id, the net's key of that subagent): the plan carries the id, the page links the owner
// to its session and its pane's focus and marks one that left, and `/boss send #<id>` (or a todo uid) writes to the todo's owner. A child as pi-intercom lists it (`subagent-chat-<id>`) and a name Herdr's row cut with `…` reach it too.
// The id is the identity, and only while the binding's name is still the owner (T1-F001); a name is a fallback under the todo's own main alone, exact, one unit, never the board's cut label (T1-F002).

sessionGlobals();
const { planView, io } = await import("../gui/plangraph.ts");
const { m } = await import("../gui/paraglide/messages.js");

const unit = (key: string, name: string, role: Unit["role"], extra: Partial<Unit> = {}): Unit => ({ id: key, key, control: true, name, role, mark: "working", subs: [], ...extra });
const LONG = "worker-reconcile-ledger-exports";
const NET = { bases: [
	{ id: "wA", label: "Alpha", mark: "idle", tower: null, outposts: [], outside: [], tabs: [{ id: "wA:t1", label: "work", units: [
		unit("m1", "api-main", "main", { subs: [unit("run-api-1", "worker-api", "subagent"), unit("run-old", "worker-web", "subagent", { ended: true, control: false }), unit("run-web-2", "worker-web", "subagent"), unit("run-long", LONG, "subagent"), unit("run-cap", "api-worker", "subagent", { alias: "API Worker 2" })] }),
		unit("b1", "api-member", "member"),
	] }] },
	{ id: "wB", label: "Beta", mark: "idle", tower: null, outposts: [], outside: [], tabs: [{ id: "wB:t1", label: "work", units: [unit("m3", "other-main", "main", { subs: [unit("run-x", "worker-api", "subagent"), unit("run-solo", "reviewer-x", "subagent")] })] }] },
] } as unknown as Net;

test("ownerOf: the Herdr child's run id first (gone when it left the net, not live when its pane is), then the full name under the main, then anywhere when only one; an owner nothing bears is text", () => {
	assert.deepEqual(ownerOf(NET, "m1", { agent: "run-api-1", owner: "someone-else" }), { key: "run-api-1", name: "worker-api", ws: "wA", live: true }, "the id wins over the name");
	assert.equal(ownerOf(NET, "m1", { agent: "run-gone", owner: "worker-api" }), "gone", "an id the net no longer has is a child that left");
	assert.equal((ownerOf(NET, "m1", { agent: "run-old" }) as { live: boolean }).live, false, "an ended child whose pane is gone");
	assert.equal((ownerOf(NET, "m1", { owner: "worker-api" }) as { key: string }).key, "run-api-1", "the main's own subagent, not another main's of the same name");
	assert.equal((ownerOf(NET, "m3", { owner: "worker-api" }) as { key: string }).key, "run-x");
	assert.equal(ownerOf(NET, "m1", { owner: "worker-web" }), "ambiguous", "an old run and its successor of one name: no guess, even for the live one");
	assert.equal(ownerOf(NET, "m1", { owner: "reviewer-x" }), undefined, "another main's only subagent of the name is not this todo's owner");
	assert.equal(ownerOf(NET, "m3", { owner: "worker-web" }), undefined, "nor across mains for a name that is there twice");
	assert.equal(ownerOf(NET, "m1", { owner: "worker-api" }, false), undefined, "the board's label is never a name to route by");
	assert.equal(ownerOf(NET, undefined, { owner: "worker-api" }), undefined, "no main, no scope");
	assert.equal(ownerOf(NET, "m1", { owner: "boss" }), undefined, "a person is text");
	assert.equal(ownerOf(NET, "m1", { owner: `${LONG.slice(0, 23)}…` }), undefined, "the row's cut name is never a key here");
	assert.deepEqual([todoRef("#63"), todoRef("t_abcdefgh23"), todoRef("63"), todoRef("t_ABC")], [{ id: 63 }, { uid: "t_abcdefgh23" }, undefined, undefined]);
});

test("the todo's herdr binding: todosOf reads metadata.herdr.id as the agent only while its name is the owner; the plan carries the agent, the reader checks it, and an operate box's agent is a rewritten key", () => {
	const list = todosOf({ nextId: 4, tasks: [
		{ id: 1, uid: "t_abcdefgh23", subject: "api", status: "in_progress", owner: "worker-api", metadata: { herdr: { name: "worker-api", id: "run-api-1", pane: "w1:p9" } } },
		{ id: 2, subject: "web", status: "pending", metadata: { herdr: { name: "worker-web", id: "../etc" } } },
		{ id: 3, subject: "bad uid", uid: "T_X", status: "pending" },
		{ id: 4, subject: "moved", status: "pending", owner: "API Worker 2", metadata: { herdr: { name: "worker-api", id: "run-api-1" } } },
		{ id: 5, subject: "unassigned", status: "pending", metadata: { herdr: { name: "worker-api", id: "run-api-1" } } },
	] })!;
	assert.deepEqual([list[0]!.agent, list[0]!.uid, list[0]!.owner], ["run-api-1", "t_abcdefgh23", "worker-api"]);
	assert.deepEqual([list[1]!.agent, list[1]!.owner, list[2]!.uid], [undefined, undefined, undefined], "an id that is no key is dropped, and the binding's name is no owner of its own");
	assert.deepEqual([list[3]!.owner, list[3]!.agent], ["API Worker 2", undefined], "an owner updated alone leaves the old run's binding behind: it is not kept");
	assert.deepEqual([list[4]!.owner, list[4]!.agent], [undefined, undefined], "an owner taken off: no owner, no binding");
	const plan = deriveBoard({ name: "n", todos: list })!.plan!;
	assert.equal(plan.nodes[0]!.agent, "run-api-1");
	assert.ok(!JSON.stringify(plan).includes("w1:p9"), "no pane id goes on the board");
	assert.equal(cleanPlan({ nodes: [{ id: 1, t: "x", status: "pending", agent: "a b/../c" }] })!.nodes[0]!.agent, undefined);
	const rw: Rewrite = { key: (k) => `K:${k}`, base: (k) => k, tab: (_w, k) => k, bad: () => {} };
	const out = sanitizeHistory({ key: "k", items: [], reset: true, todos: [{ id: 1, subject: "x", status: "pending", owner: "worker-api", agent: "run-api-1" }, { id: 2, subject: "y", status: "pending", agent: "../x" }] }, rw) as { todos: { agent?: string }[] };
	assert.deepEqual(out.todos.map((t) => t.agent), ["K:run-api-1", undefined], "the box's key is rewritten as every unit key is");
});

test("the page: an owner on the net links to its session and has Focus (sessions/<key>/focus); one that left, or whose pane is gone, is marked gone; a person is text", async () => {
	const posts: string[] = [];
	io.post = async (path) => (posts.push(path), { ok: true, status: 200, body: {} });
	const v = planView({ nodes: [
		{ id: 1, t: "api", status: "in_progress", owner: "worker-api", agent: "run-api-1" },
		{ id: 2, t: "db", status: "pending", owner: "worker-db", agent: "run-db-9" },
		{ id: 3, t: "old", status: "pending", owner: "worker-web", agent: "run-old" },
		{ id: 4, t: "sign", status: "pending", owner: "boss" },
	] }, Date.now(), { net: NET, main: "m1" }) as unknown as El;
	const at = (id: number) => v.querySelector(`.plan-node[data-id="${id}"]`)!;
	const link = at(1).querySelector("a.plan-owner")!;
	assert.equal(link.textContent, "worker-api");
	assert.equal(link.getAttribute("href"), "w/wA/s/run-api-1");
	assert.equal(link.dataset.route, link.getAttribute("href"));
	(at(1).querySelector(".plan-focus") as El).click();
	await new Promise((done) => setImmediate(done));
	assert.deepEqual(posts, ["sessions/run-api-1/focus"]);
	for (const id of [2, 3]) {
		assert.equal(at(id).querySelector("a.plan-owner"), null);
		assert.equal(at(id).querySelector(".plan-owner")!.hasAttribute("data-gone"), true);
		assert.match(at(id).querySelector(".plan-owner")!.textContent, new RegExp(m.plan_gone().replace(/[()]/g, "\\$&")));
	}
	assert.deepEqual([at(4).querySelector(".plan-owner")!.textContent, at(4).querySelector(".plan-focus")], ["boss", null]);
});

function world(tasks: unknown[]) {
	const dir = mkdtempSync(join(tmpdir(), "sb-owner-"));
	const told: { text: string; level?: string }[] = [], posted: { path: string; json: Record<string, unknown> }[] = [];
	const post: Post = async (_r, path, json) => (posted.push({ path, json }), { status: 200, body: {} });
	const branch = [{ type: "custom", customType: "rpiv-todo-state", data: { nextId: 9, tasks } }];
	const kit = { cfg: { env: { LANG: "en" } }, s: { ui: undefined, branch: () => branch }, guiDir: dir, me: () => "m1", tell: (text: string, level?: string) => void told.push({ text, level }) } as unknown as Kit;
	const paths = createBossPaths(kit, { host: { ensure: async () => ({ record: { port: 1, token: "t", pid: 1, version: "0.108.0" } as never }), sessions: async () => [] }, closeSelf: () => undefined, here: (fn) => fn(), post, read: async () => NET });
	return { paths, told, posted, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("/boss send #<id> or a todo uid writes to that todo's owner: the run id first, then the full name; no such todo, no owner, an owner not on the net, and one that left are refused", async () => {
	const w = world([
		{ id: 3, uid: "t_abcdefgh23", subject: "api", status: "in_progress", owner: "worker-api", metadata: { herdr: { id: "run-api-1", name: "worker-api" } } },
		{ id: 4, subject: "web", status: "pending", owner: "worker-web" },
		{ id: 5, subject: "left", status: "pending", owner: "worker-db", metadata: { herdr: { id: "run-db-9", name: "worker-db" } } },
		{ id: 6, subject: "nobody", status: "pending" },
		{ id: 7, subject: "person", status: "pending", owner: "boss" },
	]);
	await w.paths.send("#3", false, "status?");
	await w.paths.send("t_abcdefgh23", true, "then this");
	assert.deepEqual(w.posted.map((p) => [p.path, p.json.as]), [["sessions/run-api-1/input", "send"], ["sessions/run-api-1/input", "followUp"]]);
	assert.deepEqual(w.told.map((t) => t.text), ["Sent to worker-api", "Sent to worker-api as a follow-up"]);
	for (const [q, re] of [["#99", /has no #99/], ["#4", /More than one subagent under this main is named "worker-web"/], ["#5", /"worker-db", has left the net/], ["#6", /#6 names no owner/], ["#7", /"boss", is not a subagent of this main/]] as const) {
		await w.paths.send(q, false, "x");
		assert.match(w.told.at(-1)!.text, re);
		assert.equal(w.told.at(-1)!.level, "error");
	}
	assert.equal(w.posted.length, 2, "nothing more was sent");
	w.done();
});

test("/boss send names a subagent as Herdr shows it: its full name, the row's cut name with …, or pi-intercom's subagent-chat-<id>", async () => {
	const w = world([]);
	await w.paths.send(LONG, false, "a");
	await w.paths.send(`${LONG.slice(0, 23)}…`, false, "b");
	await w.paths.send("subagent-chat-run-api-1", false, "c");
	assert.deepEqual(w.posted.map((p) => p.path), ["sessions/run-long/input", "sessions/run-long/input", "sessions/run-api-1/input"]);
	await w.paths.send("worker…", false, "d");
	assert.match(w.told.at(-1)!.text, /more than one/, "a cut name that begins two names picks neither");
	w.done();
});

test("a subagent whose row shows its script's file name answers to its full launch name (spaces, capitals): the page's owner, ownerOf, and /boss send", async () => {
	assert.equal((ownerOf(NET, "m1", { owner: "API Worker 2" }) as { key: string }).key, "run-cap");
	const v = planView({ nodes: [{ id: 1, t: "x", status: "pending", owner: "API Worker 2" }] }, Date.now(), { net: NET, main: "m1", byName: true }) as unknown as El; // the session page: the todo's own, exact owner
	assert.equal(v.querySelector("a.plan-owner")!.getAttribute("href"), "w/wA/s/run-cap");
	const w = world([{ id: 8, subject: "cap", status: "pending", owner: "API Worker 2" }]);
	await w.paths.send("API Worker 2", false, "a");
	await w.paths.send("#8", false, "b");
	await w.paths.send("api-worker", false, "c");
	assert.deepEqual(w.posted.map((p) => p.path), ["sessions/run-cap/input", "sessions/run-cap/input", "sessions/run-cap/input"]);
	w.done();
});

test("T1-F001: a todo launched with one worker and then given to another by owner alone goes to the new owner, never the old run, on the page and by /boss send; one taken off goes to nobody", async () => {
	const tasks = [
		{ id: 9, subject: "moved", status: "pending", owner: "API Worker 2", metadata: { herdr: { name: "worker-api", id: "run-api-1" } } },
		{ id: 10, subject: "taken off", status: "pending", metadata: { herdr: { name: "worker-api", id: "run-api-1" } } },
	];
	const list = todosOf({ nextId: 11, tasks })!, posts: string[] = [];
	io.post = async (path) => (posts.push(path), { ok: true, status: 200, body: {} });
	const { drawTodos } = await import("../gui/bars.ts");
	const view = new El("div"), d = new El("details"), summary = new El("summary"), ol = new El("ol");
	d.className = "todos";
	summary.append(new El("b"), new El("span"));
	d.append(summary, ol);
	view.append(d);
	drawTodos(view as never, list, { net: NET, main: "m1" });
	const links = d.querySelectorAll("a.plan-owner").map((a) => a.getAttribute("href"));
	assert.deepEqual(links, ["w/wA/s/run-cap"], "the new owner by its name under the main; nothing opens the old run");
	(d.querySelector(".plan-focus") as El).click();
	await new Promise((done) => setImmediate(done));
	assert.deepEqual(posts, ["sessions/run-cap/focus"]);
	const w = world(tasks);
	await w.paths.send("#9", false, "x");
	await w.paths.send("#10", false, "y");
	assert.deepEqual(w.posted.map((p) => p.path), ["sessions/run-cap/input"]);
	assert.match(w.told.at(-1)!.text, /#10 names no owner/);
	w.done();
});

test("T1-F002: a name never routes across mains or devices, nor from the board's cut label: a box's todo finds no local worker, and two workers that share the board's prefix get no link", () => {
	const box = { id: "xbox", label: "Box", box: { device: "d" }, mark: "idle", tower: null, outposts: [], outside: [], tabs: [{ id: "xbox:t", label: "work", units: [unit("xm1", "box-main", "main", { subs: [unit("xr1", "review", "subagent")] }), unit("xm2", "box-other", "main")] }] };
	const local = { id: "wL", label: "Local", mark: "idle", tower: null, outposts: [], outside: [], tabs: [{ id: "wL:t", label: "work", units: [unit("lm", "local-main", "main", { subs: [unit("lr", "review", "subagent"), unit("lx1", `${LONG}-a`, "subagent"), unit("lx2", `${LONG}-b`, "subagent")] })] }] };
	const net = { bases: [box, local] } as unknown as Net;
	assert.equal((ownerOf(net, "xm1", { owner: "review" }) as { key: string }).key, "xr1", "the box main's own review");
	assert.equal(ownerOf(net, "xm2", { owner: "review" }), undefined, "a box main with none does not reach this computer's review");
	assert.equal(ownerOf(net, "lm", { owner: "review" }) !== undefined && (ownerOf(net, "lm", { owner: "review" }) as { key: string }).key, "lr");
	const board = planView({ nodes: [{ id: 1, t: "x", status: "pending", owner: `${LONG}-a`.slice(0, 40) }] }, Date.now(), { net, main: "lm" }) as unknown as El;
	assert.equal(board.querySelector("a.plan-owner"), null, "a board label is text");
	const page = planView({ nodes: [{ id: 1, t: "x", status: "pending", owner: LONG }] }, Date.now(), { net, main: "lm", byName: true }) as unknown as El;
	assert.equal(page.querySelector("a.plan-owner"), null, "an exact name no unit bears: text, though two names begin with it");
});
