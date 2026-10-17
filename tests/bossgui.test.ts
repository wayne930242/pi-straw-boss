import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { readRecord } from "../src/gui.ts";
import type { Net } from "../src/net.ts";
import { type Agent, settle, until, World } from "./fakes.ts";

let world = new World();
const scratch = mkdtempSync(join(tmpdir(), "psb-bossgui-test-"));
const bundle = join(scratch, "bundle");
mkdirSync(bundle);
writeFileSync(join(bundle, "index.html"), "<title>Straw Net</title>");
afterEach(async () => {
	await world.stopAll();
	world = new World();
});
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));

const opened: string[] = [];
const deps = { bundle, openUrl: async (url: string) => void opened.push(url) };
const urlOf = (a: Agent) => a.notices.map((n) => /Straw net GUI: (\S+)/.exec(n.text)?.[1]).filter(Boolean).at(-1)!;
/** The first snapshot of the live stream at a GUI URL. */
const snapshot = (url: string) =>
	new Promise<Net>((resolve, reject) => {
		const req = get(`${url}events`, (res) => {
			res.setEncoding("utf8");
			let buffer = "";
			res.on("data", (chunk: string) => {
				buffer += chunk;
				const line = buffer.split("\n").find((l) => l.startsWith("data: "));
				if (line && buffer.includes("\n\n")) (req.destroy(), resolve(JSON.parse(line.slice(6)) as Net));
			});
		});
		req.on("error", reject);
	});
const status = (url: string) =>
	new Promise<number>((resolve, reject) => {
		get(url, (res) => (res.resume(), resolve(res.statusCode!))).on("error", reject);
	});

async function net() {
	world.autoTowers();
	const main = world.agent({ id: "main-1", name: "api-main", pane: "wA:p1", tab: "wA:t1" });
	const other = world.agent({ id: "main-b", name: "ops-main", pane: "wB:p1", tab: "wB:t1" });
	await Promise.all([main.start(), other.start()]);
	await Promise.all([main.join(), other.join()]);
	return { main, other };
}

test("any session can open the GUI: it shows the whole net, joins nothing, takes no role, and opens the browser", async () => {
	await net();
	const viewer = world.agent({ id: "viewer", name: "just looking", pane: "wA:p2", tab: "wA:t2", deps });
	await viewer.start();
	await viewer.command("gui");
	const url = urlOf(viewer);
	assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/$/);
	assert.deepEqual(opened.slice(-1), [url]);
	const seen = await snapshot(url);
	assert.deepEqual(seen.bases.map((b) => [b.label, b.tabs.flatMap((t) => t.units.map((u) => u.name))]), [["Alpha", ["api-main"]], ["Beta", ["ops-main"]]], "both workspaces, joined sessions only");
	assert.ok(!JSON.stringify(seen).includes("just looking"), "the viewer is not in the net");
	assert.deepEqual(viewer.tokens, {}, "no role token");
	assert.deepEqual(viewer.entries, [], "nothing written to the session");
	assert.deepEqual(world.broker.registrations.filter((r) => r.id === "viewer").map((r) => [r.namespace.split("/").slice(0, 2).join("/"), r.ownerEligible]), [["straw-boss/view", false]]);
	assert.deepEqual([...viewer.tools.keys()], ["boss_join"], "still outside the net");
});

test("running it again reuses the server and the URL and reopens the browser; stop closes it; a restart keeps the URL an open page has", async () => {
	const viewer = world.agent({ id: "viewer", pane: "wA:p1", tab: "wA:t1", deps });
	await viewer.start();
	await viewer.command("gui");
	const url = urlOf(viewer);
	const before = opened.length;
	await viewer.command("gui");
	assert.equal(urlOf(viewer), url);
	assert.equal(opened.length, before + 1);
	await snapshot(url);
	await viewer.command("gui stop");
	await viewer.command("gui");
	await snapshot(url);
	assert.equal(world.broker.registrations.filter((r) => r.id === "viewer").length, 1, "one viewer channel for the session, however often the server restarts");
	assert.equal(await status(url), 200);
	await viewer.command("gui stop");
	assert.ok(viewer.notices.some((n) => /GUI stopped/.test(n.text)));
	await assert.rejects(status(url), /ECONNREFUSED/);
	await viewer.command("gui stop");
	assert.ok(viewer.notices.some((n) => /not running/.test(n.text)));
	await viewer.command("gui");
	assert.equal(urlOf(viewer), url, "same port and token after a restart");
	assert.equal(await status(url), 200);
});

test("session shutdown stops the server", async () => {
	const viewer = world.agent({ id: "viewer", pane: "wA:p1", tab: "wA:t1", deps });
	await viewer.start();
	await viewer.command("gui");
	const url = urlOf(viewer);
	assert.equal(await status(url), 200);
	await viewer.stop();
	await assert.rejects(status(url), /ECONNREFUSED/);
});

test("a main agent and a tower can open it too, and a session in a sub workspace as well", async () => {
	world.herdr.workspace("wA").worktree = { checkout_path: "/w/alpha", is_linked_worktree: false, repo_key: "/r/alpha" };
	world.herdr.workspaces.push({ workspace_id: "wS", label: "Alpha feature", tokens: {}, worktree: { checkout_path: "/w/f", is_linked_worktree: true, repo_key: "/r/alpha" } });
	world.herdr.addTab("wS:t1", "feature", "wS:p1");
	const main = world.agent({ id: "main-1", name: "api-main", pane: "wA:p1", tab: "wA:t1", deps });
	const tower = world.tower("tower-wB", "wB:t9", "wB:p9", false);
	const sub = world.agent({ id: "sub-1", pane: "wS:p1", deps });
	await Promise.all([main.start(), tower.start(), sub.start()]);
	await main.join();
	for (const who of [main, sub]) {
		await who.command("gui");
		const seen = await snapshot(urlOf(who));
		assert.equal(seen.bases.find((b) => b.label === "Alpha")?.outposts[0]?.label, "Alpha feature", `${who.id} sees the sub workspace as an outpost`);
	}
	assert.deepEqual(sub.tokens, {}, "the sub workspace session joined nothing");
});

test("a browser that cannot be opened leaves the URL in a warning", async () => {
	const viewer = world.agent({ id: "viewer", pane: "wA:p1", tab: "wA:t1", deps: { bundle, openUrl: async () => { throw new Error("no display"); } } });
	await viewer.start();
	await viewer.command("gui");
	await settle();
	const warning = viewer.notices.find((n) => n.level === "warning");
	assert.match(warning?.text ?? "", /Could not open a browser \(no display\)/);
	assert.ok(urlOf(viewer));
});

test("without a built bundle the command says how to build it", async () => {
	const viewer = world.agent({ id: "viewer", pane: "wA:p1", tab: "wA:t1", deps: { bundle: join(scratch, "nowhere"), openUrl: deps.openUrl } });
	await viewer.start();
	await viewer.command("gui");
	await until(() => viewer.notices.some((n) => n.level === "error"), "an error notice");
	assert.match(viewer.notices.find((n) => n.level === "error")!.text, /npm run gui:build/);
});

test("one server per machine: two calls at once in one session, and a call from another session, open the same server", async () => {
	const a = world.agent({ id: "viewer-a", pane: "wA:p1", tab: "wA:t1", deps });
	const b = world.agent({ id: "viewer-b", pane: "wB:p1", tab: "wB:t1", deps });
	await Promise.all([a.start(), b.start()]);
	await Promise.all([a.command("gui"), a.command("gui"), b.command("gui")]);
	const urls = [a, b].flatMap((who) => who.notices.map((n) => /Straw net GUI: (\S+)/.exec(n.text)?.[1]).filter(Boolean));
	assert.equal(urls.length, 3);
	assert.equal(new Set(urls).size, 1, "every call got the same URL");
	const record = readRecord(world.stateDir)!;
	assert.equal(`http://127.0.0.1:${record.port}/${record.token}/`, urls[0], "gui.json records the running server");
	const other = record.owner.startsWith("viewer-a") ? b : a;
	await other.command("gui stop");
	assert.match(other.notices.at(-1)!.text, /runs in session viewer-[ab] \(pane w[AB]:p1\); stop it there/);
	assert.equal(await status(urls[0]!), 200, "a stop from another session leaves the server running");
});

test("when the session holding the server ends, the next /boss gui elsewhere starts it again on the same URL", async () => {
	const a = world.agent({ id: "viewer-a", pane: "wA:p1", tab: "wA:t1", deps });
	const b = world.agent({ id: "viewer-b", pane: "wB:p1", tab: "wB:t1", deps });
	await Promise.all([a.start(), b.start()]);
	await a.command("gui");
	const url = urlOf(a);
	await a.stop();
	await assert.rejects(status(url), /ECONNREFUSED/);
	await b.command("gui");
	assert.equal(urlOf(b), url, "an open page reconnects to the successor");
	assert.equal(await status(url), 200);
});
