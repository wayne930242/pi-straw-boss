import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, get } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { readRecord } from "../src/gui.ts";
import type { Net } from "../src/net.ts";
import { type Agent, decode, fromLines, settle, until, World } from "./fakes.ts";

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

async function net() {
	world.autoTowers();
	const main = world.agent({ id: "main-1", name: "api-main", pane: "wA:p1", tab: "wA:t1" });
	const other = world.agent({ id: "main-b", name: "ops-main", pane: "wB:p1", tab: "wB:t1" });
	await Promise.all([main.start(), other.start()]);
	await Promise.all([main.promote(), other.promote()]);
	return { main, other };
}

test("any session can open the GUI: it shows the whole net with the viewer as a member, adds no channel of its own, and opens the browser", async () => {
	await net();
	const viewer = world.agent({ id: "viewer", name: "just looking", pane: "wA:p2", tab: "wA:t2", deps });
	await viewer.start();
	await viewer.command("gui");
	const url = urlOf(viewer);
	assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/$/);
	assert.deepEqual(opened.slice(-1), [url]);
	const seen = await snapshot(url);
	assert.deepEqual(seen.bases.map((b) => [b.label, b.tabs.flatMap((t) => t.units.map((u) => [u.name, u.role]))]), [["Alpha", [["api-main", "main"], ["just looking", "member"]]], ["Beta", [["ops-main", "main"]]]], "both workspaces; the viewer joined at start as a member");
	assert.deepEqual(seen.bases[0]!.outside, []);
	assert.deepEqual(viewer.tokens, { sb_role: "member" });
	assert.deepEqual(viewer.entries, [], "nothing written to the session");
	assert.deepEqual(world.broker.registrations.filter((r) => r.id === "viewer").map((r) => r.namespace.split("/").slice(0, 2).join("/")), ["straw-boss/tab", "straw-boss/gui"], "it reads through its tab channel; the server's dialog channel is its only other one");
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
	assert.deepEqual(world.broker.registrations.filter((r) => r.id === "viewer").map((r) => r.namespace.split("/")[1]), ["tab", "gui"], "one tab channel and one dialog channel for the session, however often the server restarts");
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
	await main.promote();
	for (const who of [sub, main]) {
		await who.command("gui");
		const seen = await snapshot(urlOf(who));
		assert.equal(seen.bases.find((b) => b.label === "Alpha")?.outposts[0]?.label, "Alpha feature", `${who.id} sees the sub workspace as an outpost`);
	}
	assert.deepEqual(sub.tokens, {}, "the sub workspace session joined nothing");
	assert.deepEqual(world.broker.registrations.filter((r) => r.id === "sub-1").map((r) => [r.namespace.split("/").slice(0, 2).join("/"), r.ownerEligible]), [["straw-boss/gui", true], ["straw-boss/view", false]], "it reads through a channel of its own that never takes part in a tab (and its server's dialog channel)");
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

test("one server per machine: two calls at once in one session, and a call from another session, open the same server; a stop from any session stops it", async () => {
	const a = world.agent({ id: "viewer-a", pane: "wA:p1", tab: "wA:t1", deps });
	const b = world.agent({ id: "viewer-b", pane: "wB:p1", tab: "wB:t1", deps });
	await Promise.all([a.start(), b.start()]);
	await Promise.all([a.command("gui"), a.command("gui"), b.command("gui")]);
	const urls = [a, b].flatMap((who) => who.notices.map((n) => /Straw net GUI: (\S+)/.exec(n.text)?.[1]).filter(Boolean));
	assert.equal(urls.length, 3);
	assert.equal(new Set(urls).size, 1, "every call got the same URL");
	const record = readRecord(world.stateDir)!;
	assert.equal(`http://127.0.0.1:${record.port}/${record.token}/`, urls[0], "gui.json records the running server");
	const [owner, other] = record.owner.startsWith("viewer-a") ? [a, b] : [b, a];
	await other.command("gui stop");
	assert.match(other.notices.at(-1)!.text, /^Straw net GUI stopped \(it ran in session viewer-[ab] \(pane w[AB]:p1\)\)$/);
	await assert.rejects(status(urls[0]!), /ECONNREFUSED/, "a stop from another session stops the server");
	await until(() => /^Straw net GUI stopped from session viewer-[ab] \(pane w[AB]:p1\)$/.test(owner.notices.at(-1)?.text ?? ""), "the owner's notice");
});

test("a session with a newer pi-straw-boss takes the running server over when it starts, on the same URL; an older one leaves it", async () => {
	const a = world.agent({ id: "viewer-a", pane: "wA:p1", tab: "wA:t1", deps: { ...deps, version: "1.0.0" } });
	await a.start();
	await a.command("gui");
	const url = urlOf(a), before = opened.length;
	const b = world.agent({ id: "viewer-b", pane: "wB:p1", tab: "wB:t1", deps: { ...deps, version: "1.1.0" } });
	await b.start();
	await until(() => readRecord(world.stateDir)?.version === "1.1.0", "the takeover");
	const record = readRecord(world.stateDir)!;
	assert.deepEqual([record.owner, `http://127.0.0.1:${record.port}/${record.token}/`], ["viewer-b (pane wB:p1)", url], "the new server keeps the URL an open page has");
	assert.equal(await status(url), 200);
	await until(() => a.notices.at(-1)?.text === "The straw net GUI moved to session viewer-b (pane wB:p1)", "the old owner's notice");
	const c = world.agent({ id: "viewer-c", pane: "wC:p1", tab: "wC:t1", deps: { ...deps, version: "0.12.0" } });
	await c.start();
	await c.command("gui");
	assert.equal(urlOf(c), url);
	assert.equal(readRecord(world.stateDir)!.owner, "viewer-b (pane wB:p1)", "an older session opens the newer server as it is");
	assert.equal(opened.length, before + 1, "a takeover opens no browser");
});

test("the server a session ran comes back on its URL after the session's /reload or /new, and not after it quits", async () => {
	const a = world.agent({ id: "viewer", pane: "wA:p1", tab: "wA:t1", deps });
	await a.start();
	await a.command("gui");
	const url = urlOf(a);
	await a.stop("reload");
	await assert.rejects(status(url), /ECONNREFUSED/);
	const reloaded = world.agent({ id: "viewer", pane: "wA:p1", tab: "wA:t1", deps });
	await reloaded.fire("session_start", { reason: "reload" });
	await until(() => status(url).then((code) => code === 200, () => false), "the server again");
	assert.equal(readRecord(world.stateDir)!.reload, undefined, "the new record carries no reload mark");
	await reloaded.stop("new");
	const fresh = world.agent({ id: "viewer-new", pane: "wA:p1", tab: "wA:t1", deps });
	await fresh.fire("session_start", { reason: "new" });
	await until(() => readRecord(world.stateDir)?.ownerSession === "viewer-new", "the server under the new session");
	assert.equal(await status(url), 200, "a /new keeps it too, owned by the new session");
	await fresh.stop();
	const next = world.agent({ id: "viewer", pane: "wA:p1", tab: "wA:t1", deps });
	await next.start();
	await assert.rejects(status(url), /ECONNREFUSED/, "a session that quit does not bring it back");
});

test("a server from before 0.11.0, which cannot hand over, keeps running; stop, remote, and the URL say where it runs", async () => {
	const old = createServer((req, res) => res.writeHead(req.url === "/tok/" ? 200 : 404).end()).listen(0, "127.0.0.1");
	await once(old, "listening");
	const port = (old.address() as AddressInfo).port;
	writeFileSync(join(world.stateDir, "gui.json"), JSON.stringify({ pid: process.pid, port, token: "tok", csrf: "c", owner: "old (pane wZ:p1)" }));
	const a = world.agent({ id: "viewer-a", pane: "wA:p1", tab: "wA:t1", deps });
	await a.start();
	for (const mode of ["gui stop", "gui remote", "gui remote off"]) {
		await a.command(mode);
		assert.match(a.notices.at(-1)!.text, /^The straw net GUI runs in session old \(pane wZ:p1\) on a pi-straw-boss older than 0\.11\.0/, mode);
	}
	await a.command("gui");
	assert.deepEqual(a.notices.slice(-2).map((n) => [n.level, n.text.split(";")[0]]), [["warning", "The straw net GUI runs in session old (pane wZ:p1) on a pi-straw-boss older than 0.11.0, which cannot hand it over"], ["info", `Straw net GUI: http://127.0.0.1:${port}/tok/`]]);
	old.close();
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

/** A fake tailscale for /boss gui remote: this machine is box on the tailnet, and serve keeps one background config. */
function fakeTailscale() {
	let config: Record<string, unknown> = {};
	const run = async (args: string[]) => {
		if (args[0] === "status") return JSON.stringify({ BackendState: "Running", Self: { DNSName: "box.tail1.ts.net.", UserID: 7 }, User: { "7": { LoginName: "me@example.com" } } });
		if (args.join(" ") === "serve status --json") return JSON.stringify(config);
		if (args[1] === "--bg") config = { TCP: { "8443": { HTTPS: true } }, Web: { "box.tail1.ts.net:8443": { Handlers: { "/": { Proxy: args[3] } } } } };
		if (args.join(" ") === "serve --https=8443 off") config = {};
		return "";
	};
	return { run, config: () => config };
}

test("/boss gui remote serves this session's GUI on the tailnet with a pairing QR in an overlay; stop and the session's end take the entry down", async () => {
	const ts = fakeTailscale(), copied: string[] = [], shown: string[] = [];
	const a = world.agent({ id: "viewer-a", pane: "wA:p1", tab: "wA:t1", deps: { ...deps, tailscale: ts.run, copy: async (text) => void copied.push(text), openUrl: async (url) => void shown.push(url) } });
	const b = world.agent({ id: "viewer-b", pane: "wB:p1", tab: "wB:t1", deps: { ...deps, tailscale: ts.run } });
	await Promise.all([a.start(), b.start()]);
	const before = opened.length, blocked: boolean[] = [];
	// What the Herdr pi integration would hear (it counts herdr:blocked events), through the fake's private event bus.
	(a as unknown as { bus: Map<string, ((data: unknown) => void)[]> }).bus.set("herdr:blocked", [(data) => blocked.push((data as { active: boolean }).active)]);
	const command = a.command("gui remote");
	await until(() => a.overlays.length === 1, "the QR overlay");
	const overlay = a.overlays[0]!, screen = overlay.render(120);
	assert.ok(screen.some((line) => line.includes("█")), "the QR shows in an overlay");
	assert.deepEqual(screen.slice(-3), ["c  copy a new one-time link", "o  open one in this computer's browser", "Esc or q  close"], "with its keys under it");
	assert.deepEqual(blocked, [true], "the session reads as waiting while the overlay takes its keys");
	overlay.handleInput!("c");
	await until(() => copied.length === 1, "the copy");
	overlay.handleInput!("\x1b[111u"); // o, as the kitty keyboard protocol sends it
	await until(() => shown.length === 1, "the open");
	await until(() => overlay.render(120).at(-1)!.startsWith("Opened a new one-time link"), "the overlay saying so");
	const record = readRecord(world.stateDir)!, pair = new RegExp(`^https://box\\.tail1\\.ts\\.net:8443/${record.token}/pair/([\\w-]{22})$`);
	const shownQr = decode(fromLines(screen.slice(0, screen.indexOf("")))), codes = [shownQr?.data ?? "", ...copied, ...shown].map((url) => pair.exec(url)?.[1]);
	assert.ok(codes.every(Boolean) && new Set(codes).size === 3, "the QR, c, and o each carry their own one-time code, so neither key spends the QR's");
	assert.match(overlay.render(24).join(" "), /^This pane is 24 columns wide; the QR code needs \d+\. Widen it, or use Phone in the GUI\. {2}c {2}copy/, "a narrow pane says how wide the QR needs it, wrapped");
	assert.ok(overlay.render(24).every((line) => [...line].length <= 24));
	overlay.handleInput!("q");
	await command;
	assert.deepEqual(blocked, [true, false]);
	assert.equal(opened.length, before, "no browser opens for remote access by itself");
	assert.deepEqual(ts.config(), { TCP: { "8443": { HTTPS: true } }, Web: { "box.tail1.ts.net:8443": { Handlers: { "/": { Proxy: `http://127.0.0.1:${record.port}` } } } } });
	assert.match(a.notices.at(-1)!.text, /Remote access is on for me@example.com, tailnet only: https:\/\/box\.tail1\.ts\.net:8443\//);
	assert.ok(!a.notices.some((n) => n.text.includes("/pair/")), "the one-time code stays out of the notices");
	// Another session's remote takes the server over on the same URL, and its remote off takes it back with the entry gone.
	const moved = b.command("gui remote");
	await until(() => b.overlays.length === 1, "b's overlay");
	b.overlays[0]!.handleInput!("q");
	await moved;
	const taken = readRecord(world.stateDir)!;
	assert.deepEqual([taken.owner, taken.port, taken.token], ["viewer-b (pane wB:p1)", record.port, record.token]);
	assert.equal((ts.config() as { Web: Record<string, { Handlers: { "/": { Proxy: string } } }> }).Web["box.tail1.ts.net:8443"]!.Handlers["/"].Proxy, `http://127.0.0.1:${record.port}`);
	assert.ok(a.notices.some((n) => n.text === "The straw net GUI moved to session viewer-b (pane wB:p1)"));
	await a.command("gui remote off");
	assert.deepEqual(ts.config(), {});
	assert.equal(readRecord(world.stateDir)!.owner, "viewer-a (pane wA:p1)");
	const again = a.command("gui remote");
	await until(() => a.overlays.length === 2, "the second overlay");
	a.overlays[1]!.handleInput!("\x1b");
	await again;
	await a.command("gui stop");
	assert.deepEqual(ts.config(), {}, "stopping the server removes the entry");
	assert.deepEqual(a.notices.slice(-2).map((n) => n.text), ["Remote access is off; the Tailscale serve entry on 8443 is removed", "Straw net GUI stopped"]);
	const third = a.command("gui remote");
	await until(() => a.overlays.length === 3, "the third overlay");
	a.overlays[2]!.handleInput!("\r");
	await third;
	await a.stop();
	assert.deepEqual(ts.config(), {}, "so does the end of the session that runs it");
});

test("a serve entry a crashed server left is removed when the next server starts, and a moved one is left alone", async () => {
	const ts = fakeTailscale(), a = world.agent({ id: "viewer-c", pane: "wA:p1", tab: "wA:t1", deps: { ...deps, tailscale: ts.run } });
	await a.start();
	await ts.run(["serve", "--bg", "--https=8443", "http://127.0.0.1:1"]);
	writeFileSync(join(world.stateDir, "remote.json"), JSON.stringify({ target: "http://127.0.0.1:1" }));
	await a.command("gui");
	assert.deepEqual(ts.config(), {}, "nothing behind the old port is left on the tailnet");
	assert.equal(existsSync(join(world.stateDir, "remote.json")), false);
	await a.command("gui stop");
	await ts.run(["serve", "--bg", "--https=8443", "http://127.0.0.1:2"]);
	writeFileSync(join(world.stateDir, "remote.json"), JSON.stringify({ target: "http://127.0.0.1:1" }));
	await a.command("gui");
	assert.equal(JSON.stringify(ts.config()).includes("127.0.0.1:2"), true, "an entry that points elsewhere now is not ours to remove");
	await a.command("gui stop");
	// Recorded by a server whose process still runs (its session was too busy to answer): live, so it stays.
	writeFileSync(join(world.stateDir, "remote.json"), JSON.stringify({ target: "http://127.0.0.1:2", pid: process.ppid }));
	await a.command("gui");
	assert.equal(JSON.stringify(ts.config()).includes("127.0.0.1:2"), true, "another live server's entry stays");
	await a.stop();
});
