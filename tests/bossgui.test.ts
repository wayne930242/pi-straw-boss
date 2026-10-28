import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { get } from "node:http";
import { afterEach, test } from "node:test";
import type { Net } from "../src/net.ts";
import { fileOf } from "../src/server/record.ts";
import { type Agent, decode, fromLines, until, World } from "./fakes.ts";
import { fakeTailscale, startHosted, stopHosted } from "./gui-world.ts";

// The session's side of the GUI (src/host.ts): /boss gui and its variants ask the sb server over the control socket and tell the user what it answered. The server's own behavior is in server-gui.test.ts.

let world = new World();
afterEach(async () => {
	await stopHosted();
	await world.stopAll();
	world = new World();
});

const opened: string[] = [];
const deps = { openUrl: async (url: string) => void opened.push(url) };
const urlOf = (a: Agent) => a.notices.map((n) => /Straw net GUI: (\S+)/.exec(n.text)?.[1]).filter(Boolean).at(-1)!;
/** The first snapshot of the live stream at a GUI URL. */
const snapshot = (url: string) =>
	new Promise<Net>((resolve, reject) => {
		const req = get(`${url}events`, (res) => {
			res.setEncoding("utf8");
			let buffer = "";
			res.on("data", (chunk: string) => {
				buffer += chunk;
				// The first plain message: named events (hello) come before it.
				const block = buffer.split("\n\n").slice(0, -1).find((b) => !b.startsWith("event: "));
				if (block) (req.destroy(), resolve(JSON.parse(block.slice(6)) as Net));
			});
		});
		req.on("error", reject);
	});
const status = (url: string) =>
	new Promise<number>((resolve, reject) => {
		// No pooled socket: a kept-alive connection to a stopped server fails as a hang-up instead of a refusal.
		get(url, { agent: false }, (res) => (res.resume(), resolve(res.statusCode!))).on("error", reject);
	});

test("any pi session can open the GUI: the notice carries the server's URL, the page shows the whole net, and the browser opens", async () => {
	world.autoTowers();
	const main = world.agent({ id: "main-1", name: "api-main", pane: "wA:p1", tab: "wA:t1" });
	await main.start();
	await main.promote();
	const hosted = await startHosted(world);
	const viewer = world.agent({ id: "viewer", name: "just looking", pane: "wA:p2", tab: "wA:t2", deps });
	await viewer.start();
	await viewer.command("gui");
	const url = urlOf(viewer), before = opened.length;
	assert.equal(url, hosted.url);
	assert.equal(opened.at(-1), url);
	const seen = await snapshot(url);
	assert.ok(seen.bases.length > 0, "the page shows the whole net");
	await viewer.command("gui");
	assert.equal(urlOf(viewer), url, "the same URL each time");
	assert.equal(opened.length, before + 1);
	assert.equal(await status(url), 200);
});

test("a main agent and a tower can open it too, and a session in a sub workspace as well; the sub workspace shows as an outpost", async () => {
	world.herdr.workspace("wA").worktree = { checkout_path: "/w/alpha", is_linked_worktree: false, repo_key: "/r/alpha" };
	world.herdr.workspaces.push({ workspace_id: "wS", label: "Alpha feature", tokens: {}, worktree: { checkout_path: "/w/f", is_linked_worktree: true, repo_key: "/r/alpha" } });
	world.herdr.addTab("wS:t1", "feature", "wS:p1");
	const hosted = await startHosted(world);
	const main = world.agent({ id: "main-1", name: "api-main", pane: "wA:p1", tab: "wA:t1", deps });
	const tower = world.tower("tower-wB", "wB:t9", "wB:p9", false);
	const sub = world.agent({ id: "sub-1", pane: "wS:p1", deps });
	await Promise.all([main.start(), tower.start(), sub.start()]);
	await main.promote();
	for (const who of [sub, main]) {
		await who.command("gui");
		assert.equal(urlOf(who), hosted.url);
		const seen = await snapshot(urlOf(who));
		assert.equal(seen.bases.find((b) => b.label === "Alpha")?.outposts[0]?.label, "Alpha feature", `${who.id} sees the sub workspace as an outpost`);
	}
	assert.deepEqual(sub.tokens, {}, "the sub workspace session joined nothing");
});

test("with STRAW_BOSS_DESK=1 (a desk shell shows the page) /boss gui tells the URL and opens no browser", async () => {
	const hosted = await startHosted(world);
	const before = opened.length;
	const viewer = world.agent({ id: "viewer", pane: "wA:p1", tab: "wA:t1", env: { STRAW_BOSS_DESK: "1" }, deps });
	await viewer.start();
	await viewer.command("gui");
	assert.equal(urlOf(viewer), hosted.url);
	assert.equal(opened.length, before, "no browser opened");
	assert.deepEqual(viewer.notices.filter((n) => n.level === "warning"), []);
});

test("a browser that cannot be opened leaves the URL in a warning", async () => {
	await startHosted(world);
	const viewer = world.agent({ id: "viewer", pane: "wA:p1", tab: "wA:t1", deps: { openUrl: async () => { throw new Error("no display"); } } });
	await viewer.start();
	await viewer.command("gui");
	await until(() => viewer.notices.some((n) => n.level === "warning"), "a warning");
	assert.match(viewer.notices.find((n) => n.level === "warning")!.text, /Could not open a browser \(no display\)/);
	assert.ok(urlOf(viewer));
});

test("when no server answers, the command says so as an error and opens nothing", async () => {
	const viewer = world.agent({ id: "viewer", pane: "wA:p1", tab: "wA:t1", deps });
	await viewer.start();
	const before = opened.length;
	await viewer.command("gui");
	assert.deepEqual(viewer.notices.map((n) => [n.level, n.text]), [["error", "Straw net GUI: no server"]]);
	assert.equal(opened.length, before);
});

test("/boss gui stop from any session stops the GUI and says when none runs; /boss gui starts it again on the same port under a new token, and an automatic ask is told it was stopped on purpose", async () => {
	const hosted = await startHosted(world);
	const a = world.agent({ id: "viewer-a", pane: "wA:p1", tab: "wA:t1", deps });
	const b = world.agent({ id: "viewer-b", pane: "wB:p1", tab: "wB:t1", deps });
	await Promise.all([a.start(), b.start()]);
	await a.command("gui");
	const url = urlOf(a);
	await b.command("gui stop");
	assert.equal(b.notices.at(-1)!.text, "Straw net GUI stopped");
	await assert.rejects(status(url), /ECONNREFUSED/);
	await b.command("gui stop");
	assert.equal(b.notices.at(-1)!.text, "The straw net GUI is not running");
	assert.equal((await hosted.ask("gui", { boss: false })).error, "stopped");
	await b.command("gui");
	const again = new URL(urlOf(b));
	assert.equal(again.port, new URL(url).port, "same port after the stop");
	assert.notEqual(again.pathname, new URL(url).pathname, "and a new token: the GUI that starts again is a new listener");
	assert.equal(await status(urlOf(b)), 200);
	assert.equal(await status(url), 403);
});

test("/boss gui in a session on a stopped server asks the server to start it only when it is the boss's own ask", async () => {
	const hosted = await startHosted(world);
	const viewer = world.agent({ id: "viewer", pane: "wA:p1", tab: "wA:t1", deps });
	await viewer.start();
	await hosted.ask("gui-stop");
	assert.deepEqual(await hosted.ask("gui", { boss: false }), { ok: false, error: "stopped" });
	await viewer.command("gui");
	assert.equal(urlOf(viewer), hosted.url);
});

test("/boss stash and /boss close all do not start a GUI that was stopped on purpose, or a server that was: they say so and the GUI stays down", async () => {
	world.autoTowers();
	const main = world.agent({ id: "main-1", name: "api-main", pane: "wA:p1", tab: "wA:t1", deps });
	await main.start();
	await main.promote();
	const hosted = await startHosted(world);
	const url = hosted.url;
	await hosted.ask("gui-stop");
	for (const command of ["stash", "close all"]) {
		const before = main.notices.length;
		await main.command(command);
		const told = main.notices.slice(before);
		assert.ok(told.some((n) => n.level === "error" && /stopped on purpose; \/boss gui starts it, then run this again/.test(n.text)), `${command}: ${JSON.stringify(told)}`);
	}
	await assert.rejects(status(url), /ECONNREFUSED/, "the GUI stays down");
	assert.equal(hosted.record().gui?.stopped, true);
	// A server stopped on purpose: nothing starts it or its GUI either.
	const started = await hosted.ask("gui", { boss: true });
	assert.equal(await status(`http://127.0.0.1:${started.port}/${started.token}/`), 200);
	await hosted.ask("stop", { by: "test" });
	await hosted.handle.done;
	for (const command of ["stash", "close all"]) {
		const before = main.notices.length;
		await main.command(command);
		assert.ok(main.notices.slice(before).some((n) => n.level === "error"), `${command} after a server stop is an error`);
	}
	await assert.rejects(status(`http://127.0.0.1:${started.port}/${started.token}/`), /ECONNREFUSED/, "the GUI stays down after a server stop");
	assert.equal(hosted.record().stopped, true, "and no server was started");
});

const proxyOf = (config: unknown) => (config as { Web?: Record<string, { Handlers: { "/": { Proxy: string } } }> }).Web?.["box.tail1.ts.net:8443"]?.Handlers["/"].Proxy;

test("/boss gui remote turns remote access on in the server and draws the pairing QR in an overlay of this session; its keys mint links of their own; stop and the server's end take the entry down", async () => {
	const ts = fakeTailscale(), copied: string[] = [], shown: string[] = [];
	const hosted = await startHosted(world, { tailscale: ts.run });
	const a = world.agent({ id: "viewer-a", pane: "wA:p1", tab: "wA:t1", deps: { ...deps, copy: async (text) => void copied.push(text), openUrl: async (url) => void shown.push(url) } });
	await a.start();
	const before = opened.length, blocked: boolean[] = [];
	// What the Herdr pi integration would hear (it counts herdr:blocked events), through the fake's private event bus.
	(a as unknown as { bus: Map<string, ((data: unknown) => void)[]> }).bus.set("herdr:blocked", [(data) => blocked.push((data as { active: boolean }).active)]);
	const command = a.command("gui remote");
	await until(() => a.overlays.length === 1, "the QR overlay");
	const overlay = a.overlays[0]!, screen = overlay.render(120);
	assert.ok(screen.some((line) => line.includes("█")), "the QR shows in an overlay");
	assert.deepEqual(screen.slice(-3), ["c  copy a new one-time link", "o  open one in this computer's browser", "Esc or q  close"], "with its keys under it");
	const codeAt = screen.findIndex((line) => /installed app, type this code/.test(line));
	assert.match(screen[codeAt + 1]!, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/, "the code to type in an installed app, under the QR");
	assert.ok(overlay.render(40).some((line) => /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/.test(line)), "and still in a pane too narrow for the QR");
	assert.deepEqual(blocked, [true], "the session reads as waiting while the overlay takes its keys");
	overlay.handleInput!("c");
	await until(() => copied.length === 1, "the copy");
	overlay.handleInput!("\x1b[111u"); // o, as the kitty keyboard protocol sends it
	await until(() => shown.length === 1, "the open");
	await until(() => overlay.render(120).at(-1)!.startsWith("Opened a new one-time link"), "the overlay saying so");
	const gui = hosted.gui(), pair = new RegExp(`^https://box\\.tail1\\.ts\\.net:8443/${gui.token}/pair/([\\w-]{22})$`);
	const shownQr = decode(fromLines(screen.slice(0, screen.indexOf("")))), codes = [shownQr?.data ?? "", ...copied, ...shown].map((url) => pair.exec(url)?.[1]);
	assert.ok(codes.every(Boolean) && new Set(codes).size === 3, "the QR, c, and o each carry their own one-time code, so neither key spends the QR's");
	assert.match(overlay.render(24).join(" "), /^This pane is 24 columns wide; the QR code needs \d+\. Widen it, or use Phone in the GUI\. {2}Or in an installed app, type this code \(it works once, within ten minutes\): [0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4} c {2}copy/, "a narrow pane says how wide the QR needs it, wrapped, and still gives the code to type and the keys");
	assert.ok(overlay.render(24).every((line) => [...line].length <= 24));
	overlay.handleInput!("q");
	await command;
	assert.deepEqual(blocked, [true, false]);
	assert.equal(opened.length, before, "no browser opens for remote access by itself");
	assert.equal(proxyOf(ts.config()), `http://127.0.0.1:${gui.remotePort}`);
	assert.match(a.notices.at(-1)!.text, /Remote access is on for me@example.com, tailnet only: https:\/\/box\.tail1\.ts\.net:8443\//);
	assert.ok(!a.notices.some((n) => n.text.includes("/pair/")), "the one-time code stays out of the notices");
	assert.ok(!readFileSync(fileOf(hosted.slot, "log"), "utf8").includes("/pair/"), "and out of the server's log");
	await a.command("gui remote off");
	assert.deepEqual(ts.config(), {});
	assert.equal(a.notices.at(-1)!.text, "Remote access is off; the Tailscale serve entry on 8443 is removed");
	const again = a.command("gui remote");
	await until(() => a.overlays.length === 2, "the second overlay");
	a.overlays[1]!.handleInput!("\x1b");
	await again;
	assert.ok(proxyOf(ts.config()));
	await hosted.stop();
	assert.deepEqual(ts.config(), {}, "the end of the server takes the entry down");
});

test("with STRAW_BOSS_DESK=1 the pairing overlay has no o key: it lists none, and pressing o opens nothing and says nothing", async () => {
	const copied: string[] = [], shown: string[] = [];
	await startHosted(world, { tailscale: fakeTailscale().run });
	const a = world.agent({ id: "viewer-a", pane: "wA:p1", tab: "wA:t1", env: { STRAW_BOSS_DESK: "1" }, deps: { ...deps, copy: async (text) => void copied.push(text), openUrl: async (url) => void shown.push(url) } });
	await a.start();
	const command = a.command("gui remote");
	await until(() => a.overlays.length === 1, "the QR overlay");
	const overlay = a.overlays[0]!;
	assert.deepEqual(overlay.render(120).slice(-2), ["c  copy a new one-time link", "Esc or q  close"], "the o key is not listed");
	overlay.handleInput!("\x1b[111u");
	overlay.handleInput!("o");
	overlay.handleInput!("c"); // the c after the o has been handled, so the o had run (or not) by then
	await until(() => copied.length === 1, "the copy");
	assert.deepEqual(shown, [], "no browser is opened");
	assert.ok(!overlay.render(120).some((line) => line.startsWith("Opened")), "and the overlay does not claim it did");
	overlay.handleInput!("q");
	await command;
});

test("the page's Turn on remote access serves the GUI on the tailnet from the server and answers with a pairing code", async () => {
	const ts = fakeTailscale();
	const hosted = await startHosted(world, { tailscale: ts.run });
	const r = hosted.gui();
	const answer = await hosted.post("remote/on");
	assert.equal(answer.status, 200);
	assert.match(String(answer.body.url), new RegExp(`^https://box\\.tail1\\.ts\\.net:8443/${r.token}/pair/`));
	assert.equal(proxyOf(ts.config()), `http://127.0.0.1:${r.remotePort}`);
	await hosted.ask("gui-remote", { on: false });
	assert.deepEqual(ts.config(), {});
});

test("a pi session never hosts the GUI: it binds no listener and writes no gui.json of its own", async () => {
	const viewer = world.agent({ id: "viewer", pane: "wA:p1", tab: "wA:t1", deps });
	await viewer.start();
	await viewer.command("gui");
	await viewer.command("gui stop");
	assert.equal(existsSync(world.stateDir + "/gui.json"), false);
	assert.equal(viewer.notices.some((n) => n.level === "error" && /no server/.test(n.text)), true);
});
