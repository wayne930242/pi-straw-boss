import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { createDeploy, createDeploys } from "../src/deploy.ts";
import { createSpawn } from "../src/spawn.ts";
import { readRecord } from "../src/handover.ts";
import { requestFile, trustDir, writeAtomic } from "../src/trust/files.ts";
import { digestOf } from "../src/trust/found.ts";
import type { TrustRequest } from "../src/trust/types.ts";
import { TRUST_MAX_MS, waitPastTrust } from "../src/trust/wait.ts";
import { until, World } from "./fakes.ts";
import type { TrustRequest as Req } from "../src/trust/types.ts";

// The openings that wait for a new pi (src/trust/wait.ts, spawn.ts, deploy.ts): a pane with a trust question open does not use up the join wait, the deploy shows a `trust` step
// with the question, and ten minutes without an answer fail the opening and close what it created.

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const bundle = mkdtempSync(join(tmpdir(), "psb-trust-wait-"));
writeFileSync(join(bundle, "index.html"), "<title>Straw Net</title>");
const home = realpathSync(mkdtempSync(join(tmpdir(), "psb-trust-home-")));
mkdirSync(join(home, "beta"));
const realHome = process.env.HOME;
process.env.HOME = home;
process.on("exit", () => ((process.env.HOME = realHome), rmSync(bundle, { recursive: true, force: true }), rmSync(home, { recursive: true, force: true })));

function put(dir: string, pane: string, n = 1): TrustRequest {
	const found = [{ kind: "settings", path: ".pi/settings.json", items: ["package: npm:demo"], more: 0 }], cwd = "/work/demo";
	const r: TrustRequest = { version: 1, id: id(n), pid: process.pid, herdr: "/h.sock", pane, role: "member", cwd, at: 1, found, digest: digestOf(cwd, found) };
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	writeAtomic(dir, requestFile(r.id), r);
	return r;
}
const tmp = () => join(mkdtempSync(join(tmpdir(), "psb-trust-dir-")), "trust");

test("waitPastTrust: without a question it is waitFor; a question for the pane does not use the budget, and the budget goes on when it is gone", async () => {
	const dir = tmp();
	let slept = 0;
	const sleep = async (ms: number) => void (slept += ms);
	assert.equal(await waitPastTrust(sleep, () => false, 1000, 100, { dir, pane: "p1" }), undefined);
	assert.equal(slept, 1000, "the plain budget");
	slept = 0;
	const r = put(dir, "p1");
	let ticks = 0;
	const seen: (string | undefined)[] = [];
	const result = await waitPastTrust(async (ms) => {
		slept += ms;
		if (++ticks === 700) rmSync(join(dir, requestFile(r.id)));
	}, () => ticks >= 705 && "joined", 60_000, 100, { dir, pane: "p1", on: (q) => void seen.push(q?.id) });
	assert.equal(result, "joined");
	assert.ok(slept > 60_000, "more than the 60 s budget passed while the question was open");
	assert.deepEqual(seen, [r.id, undefined], "told when it came and when it went");
	const other = put(dir, "p2", 2);
	let n = 0;
	assert.equal(await waitPastTrust(async () => void n++, () => false, 1000, 100, { dir, pane: "p9" }), undefined, "a question for another pane changes nothing");
	assert.ok(other && n === 10);
});

test("waitPastTrust: ten minutes on a question fail with the folder in the message", async () => {
	const dir = tmp();
	put(dir, "p1");
	let slept = 0;
	await assert.rejects(waitPastTrust(async (ms) => void (slept += ms), () => false, 60_000, 500, { dir, pane: "p1" }), /No trust decision for \/work\/demo within 10 minutes/);
	assert.ok(slept >= TRUST_MAX_MS - 500 && slept <= TRUST_MAX_MS + 500);
});

test("deploy: the trust step appears only when a question does, between start and join, and the join runs again when it goes", () => {
	let t = 0;
	const d = createDeploy(["create", "start", "join"], () => t);
	d.go("create");
	d.go("start");
	d.go("join");
	t = 100;
	assert.deepEqual(d.view().steps.map((s) => s.id), ["create", "start", "join"]);
	assert.equal(d.view().trust, undefined);
	const ask = { id: id(1), digest: "a".repeat(64), folder: "/work/demo", found: [] };
	t = 1000;
	d.hold(ask);
	assert.deepEqual(d.view().steps.map((s) => [s.id, s.state]), [["create", "done"], ["start", "done"], ["trust", "active"], ["join", "pending"]]);
	assert.deepEqual(d.view().trust, ask);
	t = 5000;
	assert.equal(d.view().steps[2]!.ms, 4000);
	d.hold(undefined);
	assert.deepEqual(d.view().steps.map((s) => [s.id, s.state]), [["create", "done"], ["start", "done"], ["trust", "done"], ["join", "active"]]);
	assert.equal(d.view().trust, undefined);
	d.finish();
	assert.deepEqual(d.view().steps.map((s) => s.state), ["done", "done", "done", "done"]);
	const plain = createDeploy(["create", "start", "join"], () => t);
	plain.go("join");
	plain.finish();
	assert.ok(!plain.view().steps.some((s) => s.id === "trust"), "no trust step when none happened");
});

// The opening through the page's API, with a fake Herdr whose new pane waits on a trust question until the test answers it.
let world = new World();
afterEach(async () => {
	await world.stopAll();
	world = new World();
});
async function gui() {
	const viewer = world.agent({ id: "viewer-a", pane: "wA:p1", tab: "wA:t1", deps: { bundle, openUrl: async () => {}, call: async () => ({}) } });
	await viewer.start();
	await viewer.command("gui");
	const r = readRecord(world.stateDir)!;
	const post = (path: string, body: Record<string, unknown>) => new Promise<{ status: number; body: Record<string, unknown> }>((done, fail) => {
		const req = request({ host: "127.0.0.1", port: r.port, path: `/${r.token}/api/${path}`, method: "POST", agent: false, headers: { host: `127.0.0.1:${r.port}`, origin: `http://127.0.0.1:${r.port}`, "content-type": "application/json", "x-sb-csrf": r.csrf! } }, (res) => {
			let text = "";
			res.on("data", (c) => (text += c)).on("end", () => done({ status: res.statusCode!, body: JSON.parse(text) }));
		});
		req.on("error", fail).end(JSON.stringify(body));
	});
	return { post, dir: trustDir(world.stateDir) };
}

test("a page's opening whose pi waits on a trust question holds at the trust step past the 60 s join wait, then joins once it is answered", async () => {
	const { post, dir } = await gui();
	let held: { start(): Promise<unknown> } | undefined;
	world.herdr.onAgentStart = (pane) => {
		put(dir, pane.pane_id);
		held = world.agent({ id: `opened-${pane.pane_id}`, name: "member", pane: pane.pane_id, env: { STRAW_BOSS_ROLE: "member" } });
	};
	const opening = post("open/base", { dir: join(home, "beta"), label: "", deploy: "deploy-trust-1" });
	const progress = async () => (await post("open/progress", { id: "deploy-trust-1" })).body as { steps: { id: string; state: string }[]; trust?: { id: string; folder: string } };
	await until(async () => ((await progress()).steps.some((s) => s.id === "trust" && s.state === "active")) || undefined, "the trust step is active", 5000).catch(() => {});
	await new Promise((r) => setTimeout(r, 600)); // many times the 60 s join wait at the tests' sleep
	const view = await progress();
	assert.deepEqual(view.steps.map((s) => [s.id, s.state]), [["create", "done"], ["start", "done"], ["trust", "active"], ["join", "pending"]]);
	assert.equal(view.trust?.folder, "/work/demo");
	rmSync(join(dir, requestFile(id(1))));
	await held!.start();
	const answer = await opening;
	assert.equal(answer.status, 200, JSON.stringify(answer.body));
	assert.deepEqual((await progress()).steps.map((s) => [s.id, s.state]), [["create", "done"], ["start", "done"], ["trust", "done"], ["join", "done"]]);
});

test("a question nobody answers in ten minutes fails the opening at the trust step and closes what it created", async () => {
	const { post, dir } = await gui();
	world.herdr.onAgentStart = (pane) => void put(dir, pane.pane_id);
	const answer = await post("open/base", { dir: join(home, "beta"), label: "", deploy: "deploy-trust-2" });
	assert.equal(answer.status, 502);
	assert.match(String(answer.body.reason), /No trust decision for \/work\/demo within 10 minutes/);
	assert.equal(answer.body.step, "trust");
	assert.equal(world.herdr.commands("workspace", "close").length, 1, "the workspace the opening created is closed");
});

test("the opening that waits on a pane is known from before pi starts, since its trust question can be there before `agent start` returns", async () => {
	const deploys = createDeploys(), dir = tmp();
	let seen: string | undefined = "never asked";
	world.herdr.onAgentStart = (pane) => {
		seen = deploys.openingOf(pane.pane_id);
		world.agent({ id: `opened-${pane.pane_id}`, name: "member", pane: pane.pane_id, env: { STRAW_BOSS_ROLE: "member" } }).start();
	};
	const spawn = createSpawn({ run: world.herdr.runFor("wA:p1"), sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 2))), live: async () => true, home, deploys, trustDir: dir });
	const answer = await spawn(["open", "base"], { dir: join(home, "beta"), label: "", deploy: "deploy-early-1" });
	assert.equal(answer.status, 200, JSON.stringify(answer.body));
	assert.equal(seen, "deploy-early-1");
	assert.equal(deploys.openingOf((answer.body as { pane: string }).pane), undefined, "an opening that is over names no pane");
});

// The tower's opening of a main (opener.ts) waits the same way: a trust question holds it past its 60 s, and ten minutes of it fail the opening and close the tab.
async function tower() {
	const t = world.tower("tower-wA", "wA:t7", "wA:p7");
	await t.start();
	await world.agent({ id: "sender-1", name: "docs-main", pane: "wA:p1", tab: "wA:t1" }).start();
	return t;
}
test("a main a tower opens waits past 60 s while its pi asks for trust, and the request is handed over once it joins", async () => {
	const dir = trustDir(world.stateDir);
	let main: { start(): Promise<unknown> } | undefined;
	world.herdr.onAgentStart = (pane) => {
		put(dir, pane.pane_id);
		main = world.agent({ id: `opened-${pane.pane_id}`, name: `main · ${pane.workspace_id}`, pane: pane.pane_id, env: { STRAW_BOSS_ROLE: "main" } });
	};
	const t = await tower();
	const opening = t.tool("boss_open_main", { request: "Fix the thing", sender: "docs-main" });
	await new Promise((r) => setTimeout(r, 600));
	rmSync(join(dir, requestFile(id(1))));
	await main!.start();
	const result = await opening;
	assert.match(result.content.map((c) => (c.type === "text" ? c.text : "")).join(""), /Opened tab/);
});
test("a main a tower opens fails after ten minutes of an unanswered trust question, and its tab is closed", async () => {
	const dir = trustDir(world.stateDir);
	world.herdr.onAgentStart = (pane) => void put(dir, pane.pane_id);
	const t = await tower();
	await assert.rejects(t.tool("boss_open_main", { request: "Fix the thing", sender: "docs-main" }), /No trust decision for \/work\/demo within 10 minutes/);
	assert.equal(world.herdr.commands("tab", "close").length, 1, "the tab it created is closed");
});
