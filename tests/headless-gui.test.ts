import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { callControl } from "../src/server/socket.ts";
import { towerPanel } from "../src/server/towerpanel.ts";
import { runRoute, type TowerPanel } from "../src/control.ts";
import { headRoutes } from "../src/headroutes.ts";
import { HEAD_KEY } from "../src/headkey.ts";
import { watchSession, type Hub } from "../src/watch.ts";
import type { RunDialog, TowerService } from "../src/net.ts";
import { readQueue } from "../src/server/towerstore.ts";
import { type Running, until } from "./server-world.ts";
import { type FakeKid, TowerWorld } from "./tower-world.ts";
import { El, sessionGlobals } from "./fake-dom.ts";

// The GUI and the entry under headless runs (docs/specs/2026-11-23-lite-b2-d-e-f.md §4.4 "The GUI", docs/specs/2026-11-23-f-entry.md §2.6 and §2.8): the run's text under way reaches the tower's stream as `live`;
// its dialogs reach this computer's page only and are answered there (`door: page`), never from a paired device; Open viewer asks for a viewer tab; the head's composer takes `@<workspace>`; the Terminal tab says
// where runs show; ally runs are chips with no pane; a viewer posts `door: viewer`; the head's viewer reads its card view again when another tower's card comes or goes. Red on 3d38d3b6: none of these existed.

sessionGlobals();
const { fillRunDialogs } = await import("../gui/rundialogs.ts");
const { headLine } = await import("../gui/headline.ts");
const { termHold } = await import("../gui/towerturns.ts");
const { m } = await import("../gui/paraglide/messages.js");

let world: TowerWorld;
beforeEach(() => {
	world = new TowerWorld();
	world.setFlag(true, undefined, true);
});
afterEach(() => world.close());

type Reply = Record<string, unknown> & { ok: boolean; error?: string };
const ask = (r: Running, cmd: Record<string, unknown>) => callControl(r.handle.endpoint, world.record()!.secret, cmd as { cmd: string }).then((x) => x.reply as Reply);
const started = async () => {
	const s = await world.start();
	await s.handle.ready;
	assert.equal((await ask(s, { cmd: "ensure-tower", workspace: "wA", view: false })).ok, true);
	return s;
};
const kid = async (n = 1): Promise<FakeKid> => {
	await until(() => world.kids.size >= n, `headless run ${n} to spawn`);
	return [...world.kids.values()][n - 1]!;
};
const claim = async (s: Running, k: FakeKid) => String((await ask(s, { cmd: "claim", runId: k.run, pane: "", pid: k.pid, nonce: k.nonce, liveBrief: true })).token);
const panel = () => towerPanel(() => world.expose, world.herdr.runFor("none"));

test("the tower panel: a run's text under way is `live`, its dialogs are listed for the page and answered there with a key of that workspace only, and the composer's words carry door page", async () => {
	const s = await started();
	const p = panel();
	assert.equal((await p.event("wA", "hello from the page", "page")).ok, true);
	assert.equal(readQueue(world.slot, "wA").find((e) => e.text === "hello from the page")?.door, "page", "this computer's page is a door");
	const k = await kid();
	await claim(s, k);
	k.say({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Looking at the" } });
	k.say({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: " ledger\u001b[3G now" } });
	await until(() => p.liveText!("wA") === "Looking at the ledger now", "the live text");
	k.say({ type: "message_end" });
	await until(() => p.liveText!("wA") === "", "the live text to clear at the message's end");
	k.say({ type: "extension_ui_request", id: "c1", method: "confirm", title: "Allow it?", message: "an extension asks" });
	await until(() => p.dialogs!("wA").length === 1, "the dialog for the page");
	const d = p.dialogs!("wA")[0]!;
	assert.deepEqual({ ...d, key: undefined }, { key: undefined, workspace: "wA", method: "confirm", title: "Allow it?", message: "an extension asks" });
	assert.deepEqual(p.dialogs!("wB"), [], "another tower's page lists none of it");
	assert.match(String((await p.answer!("wB", d.key, { confirmed: true })).error), /not waiting/, "a key is answered from its own tower's page only");
	assert.equal((await p.answer!("wA", d.key, { confirmed: true })).ok, true);
	assert.deepEqual(k.written.at(-1), { type: "extension_ui_response", id: "c1", confirmed: true });
	const view = p.view("wA")!;
	assert.equal(view.headless, true);
	assert.equal(view.viewer, undefined, "no viewer pane runs");
	assert.equal(p.live("wA"), false, "no terminal without a viewer");
});

test("Open viewer makes one viewer tab and the page then has a terminal; the head page's @<workspace> is the boss's words at that tower with door page; with the switch off each is refused and the page names no door", async () => {
	await started();
	const p = panel();
	assert.equal((await p.viewer!("wA")).ok, true);
	assert.equal(world.herdr.commands("tab", "create").length, 1, "one viewer tab");
	await until(() => p.view("wA")?.viewer === true, "the service to name its viewer");
	assert.equal(p.live("wA"), true, "the Terminal tab mirrors the viewer");
	const sent = await p.direct!("Beta", "check the deploy", "page");
	assert.equal(sent.ok, true, JSON.stringify(sent));
	assert.equal(sent.label, "Beta");
	assert.equal(readQueue(world.slot, "wB").find((e) => e.text === "check the deploy")?.door, "page");
	world.setFlag(true);
	assert.match(String((await p.viewer!("wA")).error), /towerRuns\.headless/);
	assert.match(String((await p.direct!("Beta", "x")).error), /towerRuns\.headless/);
	assert.equal((await p.event("wA", "switch off", "page")).ok, true);
	assert.equal(readQueue(world.slot, "wA").find((e) => e.text === "switch off")?.door, undefined, "with the switch off the page names no door, as in 0.84.0");
	assert.deepEqual(p.dialogs!("wA"), []);
	assert.equal(p.liveText!("wA"), "");
});

test("the routes: a run's dialog and the viewer tab are this computer's page's only; the head's composer sends `to` as a field, and a paired device may use it", async () => {
	const calls: unknown[][] = [];
	const fake = { has: () => true, live: () => false, event: async (...a: unknown[]) => (calls.push(["event", ...a]), { ok: true }), act: async () => ({ ok: true }), answer: async (...a: unknown[]) => (calls.push(["answer", ...a]), { ok: true }), viewer: async (ws: string) => (calls.push(["viewer", ws]), { ok: true }), direct: async (...a: unknown[]) => (calls.push(["direct", ...a]), { ok: true, label: "Beta" }) } as unknown as TowerPanel;
	for (const action of ["dialog", "viewer"] as const) {
		const far = await runRoute(fake, "wA", action, { key: "r:1", confirmed: true }, true);
		assert.equal(far.status, 403, action);
		assert.equal((far.body as { error: string }).error, "local_only");
	}
	assert.equal(calls.length, 0, "nothing reached the tower from a paired device");
	assert.equal((await runRoute(fake, "wA", "dialog", { key: "r:1", confirmed: true }, false)).status, 200);
	assert.equal((await runRoute(fake, "wA", "viewer", {}, false)).status, 200);
	assert.equal((await runRoute(fake, "wA", "dialog", {}, false)).status, 400, "a dialog is named");
	assert.deepEqual(calls, [["answer", "wA", "r:1", { confirmed: true }], ["viewer", "wA"]]);
	calls.length = 0;
	const text = (v: unknown) => String(v);
	assert.equal((await headRoutes(fake, ["sessions", "sb-head", "input"], { text: "check the deploy", to: "Beta" }, text))!.status, 200);
	assert.equal((await headRoutes(fake, ["sessions", "sb-head", "input"], { text: "from the phone", to: "Beta" }, text, true))!.status, 200);
	assert.equal((await headRoutes(fake, ["sessions", "sb-head", "input"], { text: "plain line" }, text))!.status, 200);
	assert.equal((await headRoutes(fake, ["head", "dialog"], { key: "r:1", confirmed: false }, text, true))!.status, 403, "the head page's dialogs are this computer's too");
	assert.deepEqual(calls, [["direct", "Beta", "check the deploy", "page"], ["direct", "Beta", "from the phone", undefined], ["event", HEAD_KEY, "plain line", "page"]]);
	// The page reads `@`: the server never does.
	assert.deepEqual(headLine("@Beta check the deploy"), { text: "check the deploy", to: "Beta" });
	assert.deepEqual(headLine("@@Beta is a name"), { text: "@Beta is a name" });
	assert.deepEqual(headLine("look at @Beta"), { text: "look at @Beta" });
	assert.deepEqual(headLine("@Beta"), { text: "@Beta" }, "an address with no words is a plain line");
	assert.deepEqual(headLine("@Beta first\nsecond"), { text: "first\nsecond", to: "Beta" });
	assert.deepEqual(headLine("hi\n@Beta x"), { text: "hi\n@Beta x" }, "only the first line is read for it");
});

test("the stream: a tower's key carries `live` to every page and the dialogs to this computer's own page only; a change is sent once", async () => {
	let live = "", dialogs: RunDialog[] = [];
	const hub = { lookup: () => undefined, workspace: () => [], readers: {} as never, run: (key: string) => (key === "sb-tower-wa" ? { live: () => live, dialogs: () => dialogs } : undefined) } as unknown as Hub;
	const local: [string, Record<string, unknown>][] = [], far: [string, Record<string, unknown>][] = [];
	const mine = watchSession(hub, "sb-tower-wa", (event, data) => local.push([event, data as Record<string, unknown>]), { local: true });
	const theirs = watchSession(hub, "sb-tower-wa", (event, data) => far.push([event, data as Record<string, unknown>]));
	live = "writing";
	dialogs = [{ key: "r:1", workspace: "wA", method: "confirm", title: "Link request from the tower run of Alpha", approval: true }];
	await mine.refresh();
	await theirs.refresh();
	await mine.refresh();
	assert.deepEqual(local.filter(([e, d]) => e === "history" && (d.live !== undefined || d.dialogs !== undefined)).map(([, d]) => (d.live !== undefined ? { live: d.live } : { dialogs: d.dialogs })), [{ live: "writing" }, { dialogs }]);
	assert.deepEqual(far.filter(([e, d]) => e === "history" && (d.live !== undefined || d.dialogs !== undefined)).map(([, d]) => d.live), ["writing"], "a paired device gets the text, never a dialog");
	mine.stop();
	theirs.stop();
});

test("the page: the Terminal tab says runs are headless until a viewer runs; the dialogs draw with their buttons and post to their tower's route", async () => {
	const svc = (over: Partial<TowerService>): TowerService => ({ state: "standing", queued: 0, allyRuns: [], notices: [], parked: [], ...over });
	assert.equal(termHold(svc({ headless: true })), m.tower_term_headless());
	assert.match(termHold(svc({ headless: true }), { locale: "zh-TW" })!, /通訊/);
	assert.equal(termHold(svc({ headless: true, viewer: true, run: { id: "r", kind: "local", startedAt: "" } })), undefined, "a viewer is mirrored");
	assert.equal(termHold(svc({ headless: true, run: { id: "r", kind: "local", startedAt: "" } })), m.tower_term_headless(), "a live run has no terminal either");
	assert.equal(termHold(svc({})), m.tower_term_standing(), "switch off: as before");
	const box = new El("div") as unknown as HTMLElement, posts: [string, Record<string, unknown>][] = [];
	const send = async (path: string, body: Record<string, unknown>) => (posts.push([path, body]), { ok: true, status: 200, body: {} });
	fillRunDialogs(box, "wA", [{ key: "r:1", workspace: "wA", method: "confirm", title: "Link request from the tower run of Alpha", message: "Add device Bob", approval: true }, { key: "r:2", workspace: "wA", method: "select", title: "Which?", options: ["red", "blue"] }], send);
	assert.equal(box.hidden, false);
	const buttons = (box as unknown as El).querySelectorAll("button");
	assert.deepEqual(buttons.map((b) => b.textContent), [m.run_dialog_yes(), m.run_dialog_no(), "red", "blue", m.run_dialog_cancel()]);
	assert.ok((box as unknown as El).querySelector("[data-approval]"), "an approval is marked as one");
	buttons[0]!.click();
	buttons[3]!.click();
	await new Promise((r) => setTimeout(r, 0));
	assert.deepEqual(posts, [["tower/wA/dialog", { key: "r:1", confirmed: true }], ["tower/wA/dialog", { key: "r:2", value: "blue" }]]);
	fillRunDialogs(box, HEAD_KEY, [{ key: "r:3", workspace: "wB", method: "confirm", title: "x" }], send);
	(box as unknown as El).querySelectorAll("button")[1]!.click();
	await new Promise((r) => setTimeout(r, 0));
	assert.deepEqual(posts.at(-1), ["head/dialog", { key: "r:3", confirmed: false }]);
	fillRunDialogs(box, "wA", [], send);
	assert.equal(box.hidden, true);
});

test("a headless ally run is a chip of its tower with no pane: nothing is split, marked, or listed as a pane row", async () => {
	const s = await started();
	world.ally.add("m1", "a".repeat(26), "hello from afar");
	world.expose?.allyWaiting("sb-tower-wa");
	const k = await kid();
	const token = await claim(s, k);
	assert.ok(token);
	const view = panel().view("wA")!;
	assert.deepEqual(view.allyRuns.map((a) => a.id), [k.run], "the ally run is its tower's chip");
	assert.deepEqual(world.herdr.commands("pane", "split"), []);
	assert.equal(world.herdr.commands("pane", "report").filter((c) => c.join(" ").includes("ally")).length, 0, "no pane row marked for it");
});

test("a viewer's words carry door viewer, kept on the event; the head's viewer is told the other towers' open cards so its card view reads them again", async () => {
	const s = await started();
	assert.equal((await ask(s, { cmd: "tower-event", workspace: "wA", text: "from the viewer", present: true, door: "viewer" })).ok, true);
	assert.equal(readQueue(world.slot, "wA").find((e) => e.text === "from the viewer")?.door, "viewer");
	const k = await kid();
	const token = await claim(s, k);
	const event = (await ask(s, { cmd: "run-poll", token, idle: true })).event as { door?: string };
	assert.equal(event.door, "viewer", "the run reads where the boss wrote it");
	const head = await world.expose!.head.ensure();
	const card = { op: "add", kind: "wait", for: "boss", type: "action", happened: "The release needs a date.", do: "Pick a release date.", after: "The main tags it.", command: "git tag", from: "self" };
	const recorded = await ask(s, { cmd: "run-tool", token, tool: "tower_memory", args: card });
	assert.equal(recorded.ok, true, JSON.stringify(recorded));
	const polled = await ask(s, { cmd: "prompt-poll", workspace: head.workspace, pid: 4242 });
	assert.equal(polled.ok, true, JSON.stringify(polled));
	assert.ok(Array.isArray(polled.elsewhere) && (polled.elsewhere as string[]).some((x) => x.startsWith("wA:")), JSON.stringify(polled.elsewhere));
	const own = await ask(s, { cmd: "prompt-poll", workspace: "wA", pid: 4243 });
	assert.equal(own.elsewhere, undefined, "a workspace's viewer is told nothing of the others");
});
