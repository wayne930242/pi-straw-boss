import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { TowerPanel } from "../src/control.ts";
import { startGui, type Gui } from "../src/gui.ts";
import { buildNet, type Found, type TowerView } from "../src/net.ts";

// The tower unit of a tower the sb server runs (docs/specs/2026-10-26-sb-backend.md, GUI): the net snapshot carries the service, its queue as the unit's queued rows, and a run's session file as
// its comms; the composer's Send is a boss event; the notices have their buttons; and with no run live there is no terminal (409 standing).

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "psb-tower-gui-")));
mkdirSync(join(scratch, "bundle"));
writeFileSync(join(scratch, "bundle", "index.html"), "<!doctype html><html><head><title>Straw Net</title></head><body></body></html>");
const running: Gui[] = [];
after(async () => {
	await Promise.all(running.map((g) => g.stop()));
	rmSync(scratch, { recursive: true, force: true });
});

const SESSIONS = join(scratch, "sessions");
mkdirSync(SESSIONS);
const FILE = join(SESSIONS, "2026_sb-tower-wa.jsonl");
writeFileSync(FILE, "");
const view = (over: Partial<TowerView> = {}): TowerView => ({ state: "standing", queued: 0, allyRuns: [], notices: [], parked: [], queue: [], ...over });
const net = (services?: (ws: string) => TowerView | undefined, pane = { pane_id: "wA:p1", tab_id: "wA:t1", workspace_id: "wA", agent: undefined as string | undefined, agent_session: undefined as { value: string } | undefined }) => buildNet({
	sessions: [{ id: "sb-tower-wa", name: "tower · Alpha", herdrLocation: { status: "ok", paneId: "wA:p1", workspace: { id: "wA", label: "Alpha" }, tab: { id: "wA:t1", label: "T" } } }],
	panes: [pane], workspaces: [{ workspace_id: "wA", label: "Alpha", tokens: { tower: "sb-tower-wa" } }], children: () => [], sessionDir: SESSIONS, ...(services ? { services } : {}),
});

test("a standing tower is a unit the composer can write to: its service, its queue as queued rows, no file while it never ran; a live run shows as working with its session file", () => {
	const standing = net(() => view({ queued: 2, queue: [{ text: "intercom · docs-main: please look", as: "followUp" }, { text: "boss: ship it", as: "followUp" }] })).bases[0]!.tower!;
	assert.equal(standing.control, true);
	assert.equal(standing.service?.state, "standing");
	assert.equal(standing.service?.queued, 2);
	assert.deepEqual(standing.queued?.map((q) => q.text), ["intercom · docs-main: please look", "boss: ship it"]);
	assert.ok(!("queue" in standing.service!) && !("file" in standing.service!), "the queue and the file are the unit's, not the service's");
	assert.equal(standing.mark, "idle");
	const live = net(() => view({ state: "running", run: { id: "r1", kind: "local", startedAt: "2026-10-27T10:00:00Z" }, file: FILE })).bases[0]!.tower!;
	assert.equal(live.mark, "working", "an idle identity with a live run is working");
	assert.equal(live.service?.run?.id, "r1");
});

test("without the service a tower is what it was: a control only while a pi runs in its pane", () => {
	const none = net().bases[0]!.tower!;
	assert.equal(none.control, false);
	assert.equal(none.service, undefined);
	const resident = net(undefined, { pane_id: "wA:p1", tab_id: "wA:t1", workspace_id: "wA", agent: "pi", agent_session: { value: FILE } }).bases[0]!.tower!;
	assert.equal(resident.control, true);
});

async function setup(over: Partial<TowerPanel> & { runLive?: boolean } = {}) {
	const events: [string, string][] = [], acts: [string, string, string | undefined][] = [], calls: string[] = [];
	const tower: TowerPanel = {
		has: (ws) => ws === "wA", live: () => over.runLive ?? false,
		event: over.event ?? (async (ws, text) => (events.push([ws, text]), { ok: true })),
		act: over.act ?? (async (ws, what, id) => (acts.push([ws, what, id]), { ok: true })),
		...(over.memory ? { memory: over.memory } : {}),
	};
	const lookup = (key: string): Found | undefined => (key === "ally-r1" ? { key, base: "wA", name: "Laptop", role: "ally", file: FILE, live: true } : key === "sb-tower-wa" ? { key, base: "wA", name: "tower", role: "tower", ...(over.runLive ? { file: FILE, pane: "wA:p1" } : {}), live: true } : key === "main-1" ? { key, base: "wA", name: "docs", role: "main", file: FILE, pane: "wA:p2", live: true } : undefined);
	const call = async (method: string) => (calls.push(method), method === "pane.get" ? { pane: { pane_id: "wA:p2", agent: "pi", agent_session: { value: FILE } } } : {});
	const gui = await startGui({ read: async () => ({ bases: [] }), net: { lookup, workspace: () => [] }, call, tower, dir: join(scratch, "bundle"), pollMs: 50 });
	running.push(gui);
	return { gui, events, acts, calls };
}
function send(gui: Gui, path: string, body: unknown) {
	const data = JSON.stringify(body);
	return new Promise<{ status: number; body: { accepted?: boolean; woke?: boolean; error?: string; reason?: string } }>((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port: gui.port, path: `/${gui.token}/api/${path}`, method: "POST", agent: false, headers: { host: `127.0.0.1:${gui.port}`, origin: `http://127.0.0.1:${gui.port}`, "sec-fetch-site": "same-origin", "content-type": "application/json", "x-sb-csrf": gui.csrf, "content-length": String(Buffer.byteLength(data)) } }, (res) => {
			let text = "";
			res.on("data", (c) => (text += c)).on("end", () => resolve({ status: res.statusCode!, body: /^application\/json/.test(String(res.headers["content-type"])) ? JSON.parse(text) : {} }));
		});
		req.on("error", reject).end(data);
	});
}

test("Send on a tower unit posts a boss event and types nothing, whether a run is live or not; a main's Send still types", async () => {
	for (const runLive of [false, true]) {
		const s = await setup({ runLive });
		const done = await send(s.gui, "sessions/sb-tower-wa/input", { text: "check the deploy", as: "send" });
		assert.equal(done.status, 200);
		assert.equal(done.body.woke, true);
		assert.deepEqual(s.events, [["wA", "check the deploy"]]);
		assert.deepEqual(s.calls, [], "nothing reached Herdr");
	}
	const s = await setup();
	assert.equal((await send(s.gui, "sessions/main-1/input", { text: "hello", as: "send" })).status, 200);
	assert.deepEqual(s.events, []);
	assert.ok(s.calls.includes("agent.prompt"));
	assert.equal((await send(s.gui, "sessions/sb-tower-wa/input", { text: "  ", as: "send" })).status, 400);
	const refused = await setup({ event: async () => ({ ok: false, error: "no tower" }) });
	const no = await send(refused.gui, "sessions/sb-tower-wa/input", { text: "x", as: "send" });
	assert.equal(no.status, 409);
	assert.equal(no.body.reason, "no tower");
});

test("keys, mirror, and focus of a standing tower are 409 standing; a live run's terminal is its pane's; the queue rows are not pi's queue to take back", async () => {
	const standing = await setup();
	for (const [action, body] of [["keys", { key: "esc", stream: "s1" }], ["mirror", { stream: "s1", on: true }], ["focus", {}]] as const) {
		const r = await send(standing.gui, `sessions/sb-tower-wa/${action}`, body);
		assert.equal(r.status, 409, action);
		assert.equal(r.body.error, "standing", action);
	}
	assert.deepEqual(standing.calls, []);
	assert.equal((await send(standing.gui, "sessions/sb-tower-wa/dequeue", { take: "a".repeat(16) })).body.error, "server_queue");
	const live = await setup({ runLive: true });
	assert.notEqual((await send(live.gui, "sessions/sb-tower-wa/focus", {})).body.error, "standing");
});

test("the notices' buttons: Retry, Deliver again, and Drop reach the service; a parked event needs its id; an unknown tower is 404", async () => {
	const s = await setup();
	assert.equal((await send(s.gui, "tower/wA/retry", {})).status, 200);
	assert.equal((await send(s.gui, "tower/wA/deliver", { id: "e1" })).status, 200);
	assert.equal((await send(s.gui, "tower/wA/drop", { id: "e2" })).status, 200);
	assert.deepEqual(s.acts, [["wA", "retry", undefined], ["wA", "deliver", "e1"], ["wA", "drop", "e2"]]);
	assert.equal((await send(s.gui, "tower/wA/deliver", {})).status, 400);
	assert.equal((await send(s.gui, "tower/wZ/retry", {})).status, 404);
	assert.equal((await send(s.gui, "tower/wA/explode", {})).status, 404);
	const failing = await setup({ act: async () => ({ ok: false, error: "No such parked event" }) });
	const r = await send(failing.gui, "tower/wA/drop", { id: "gone" });
	assert.equal(r.status, 409);
	assert.equal(r.body.reason, "No such parked event");
});

test("an ally run's comms take nothing: no input, keys, or focus (no pane backs the unit), an unknown ally key is no session, and the service's tower route does not take it for its tower", async () => {
	const s = await setup();
	for (const [action, body] of [["input", { text: "hello", as: "send" }], ["keys", { key: "esc", stream: "s1" }], ["focus", {}], ["dequeue", { take: "a".repeat(16) }]] as const) {
		const r = await send(s.gui, `sessions/ally-r1/${action}`, body);
		assert.equal(r.status, 409, action);
		assert.equal(r.body.error, "not_live", action);
	}
	assert.equal((await send(s.gui, "sessions/ally-zz/input", { text: "hello", as: "send" })).status, 404);
	assert.deepEqual(s.events, [], "no boss event was made of it");
	assert.deepEqual(s.calls, [], "nothing reached Herdr");
});

test("the memory panel's route: its request reaches the service with the workspace and the body, whatever status it answers; an unknown tower, or a service without the panel, is 404", async () => {
	const seen: [string, Record<string, unknown>][] = [];
	const s = await setup({ memory: (ws, json) => (seen.push([ws, json]), json.op === "read" ? { status: 200, body: { rev: 1, entries: [], notices: [] } } : { status: 409, body: { error: "rev", reason: "moved" } }) });
	const read = await send(s.gui, "tower/wA/memory", { op: "read" });
	assert.deepEqual([read.status, (read.body as { rev?: number }).rev], [200, 1]);
	const stale = await send(s.gui, "tower/wA/memory", { op: "add", kind: "standing", text: "x", rev: 0 });
	assert.deepEqual([stale.status, stale.body.error], [409, "rev"]);
	assert.deepEqual(seen, [["wA", { op: "read" }], ["wA", { op: "add", kind: "standing", text: "x", rev: 0 }]]);
	assert.equal((await send(s.gui, "tower/wZ/memory", { op: "read" })).status, 404);
	const bare = await setup();
	assert.equal((await send(bare.gui, "tower/wA/memory", { op: "read" })).status, 404);
});
