import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { get, request, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { startGui, type Gui } from "../src/gui.ts";
import type { Net } from "../src/net.ts";
import { until } from "./fakes.ts";

const scratch = mkdtempSync(join(tmpdir(), "psb-gui-test-"));
const dir = join(scratch, "bundle");
mkdirSync(join(dir, "assets"), { recursive: true });
writeFileSync(join(dir, "index.html"), "<!doctype html><title>Straw Net</title>");
writeFileSync(join(dir, "assets", "app.js"), "console.log(1)");
writeFileSync(join(scratch, "secret.txt"), "outside the bundle");
const running: Gui[] = [];
after(async () => {
	await Promise.all(running.map((g) => g.stop()));
	rmSync(scratch, { recursive: true, force: true });
});

const net = (label: string): Net => ({ bases: [{ id: "w", label, mark: "idle", head: true, tower: null, tabs: [], outposts: [] }] });
async function serve(read: () => Promise<Net>, options: { pollMs?: number; pingMs?: number; port?: number; token?: string } = {}) {
	const gui = await startGui({ read, dir, pollMs: 20, pingMs: 50, ...options });
	running.push(gui);
	return gui;
}
/** One raw request, so the Host header and method can be chosen. */
const raw = (gui: Gui, path: string, options: { host?: string; method?: string } = {}) =>
	new Promise<{ status: number; headers: IncomingMessage["headers"]; body: string }>((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port: gui.port, path, method: options.method ?? "GET", headers: { host: options.host ?? `127.0.0.1:${gui.port}` }, agent: false }, (res) => {
			let body = "";
			res.on("data", (chunk) => (body += chunk)).on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
		});
		req.on("error", reject).end();
	});
/** An open event stream: every event received so far, as { event, data }. */
function listen(gui: Gui) {
	const events: { event: string; data: string }[] = [];
	let closed = false;
	const req = get(`${gui.url}events`, { headers: { host: `127.0.0.1:${gui.port}` } }, (res) => {
		res.setEncoding("utf8");
		let buffer = "";
		res.on("data", (chunk: string) => {
			buffer += chunk;
			for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
				const lines = buffer.slice(0, end).split("\n");
				buffer = buffer.slice(end + 2);
				events.push({ event: lines.find((l) => l.startsWith("event: "))?.slice(7) ?? "message", data: lines.find((l) => l.startsWith("data: "))?.slice(6) ?? "" });
			}
		});
		res.on("close", () => (closed = true));
	});
	req.on("error", () => (closed = true));
	return { events, messages: () => events.filter((e) => e.event === "message").map((e) => (JSON.parse(e.data) as Net).bases[0]!.label), closed: () => closed, close: () => req.destroy() };
}

test("the page and its assets are served under the token, with no caching and a strict content policy", async () => {
	const gui = await serve(async () => net("a"));
	assert.match(gui.url, new RegExp(`^http://127\\.0\\.0\\.1:${gui.port}/${gui.token}/$`));
	const page = await raw(gui, `/${gui.token}/`);
	assert.equal(page.status, 200);
	assert.match(String(page.headers["content-type"]), /text\/html/);
	assert.match(page.body, /Straw Net/);
	assert.equal(page.headers["cache-control"], "no-store");
	assert.match(String(page.headers["content-security-policy"]), /default-src 'none'/);
	const asset = await raw(gui, `/${gui.token}/assets/app.js`);
	assert.deepEqual([asset.status, asset.headers["content-type"]], [200, "text/javascript; charset=utf-8"]);
	const bare = await raw(gui, `/${gui.token}`);
	assert.deepEqual([bare.status, bare.headers.location], [308, `/${gui.token}/`], "the token path without its slash redirects to the page");
	assert.equal((await raw(gui, `/${gui.token}/assets/missing.js`)).status, 404);
	assert.equal((await raw(gui, `/${gui.token}/..%2fsecret.txt`)).status, 404, "nothing outside the bundle is served");
	assert.equal((await raw(gui, `/${gui.token}/assets/..%2f..%2fsecret.txt`)).status, 404);
});

test("a request without the token, with a wrong one, with another Host header, or that is not a GET is refused", async () => {
	const gui = await serve(async () => net("a"));
	for (const path of ["/", "/index.html", "/events", `/${gui.token.slice(0, -1)}x/`, `/${gui.token}x/events`, `/x${gui.token}/`, `/?t=${gui.token}`]) assert.equal((await raw(gui, path)).status, 403, path);
	assert.equal((await raw(gui, `/${gui.token}/`, { host: "evil.example" })).status, 403, "a rebound DNS name is refused");
	assert.equal((await raw(gui, `/${gui.token}/`, { host: `localhost:${gui.port}` })).status, 403);
	assert.equal((await raw(gui, `/${gui.token}/`, { method: "POST" })).status, 403);
	assert.equal((await raw(gui, `/${gui.token}/events`, { host: "evil.example" })).status, 403);
	assert.equal((await raw(gui, `/${gui.token}/`)).status, 200, "the right URL still works");
});

test("the stream sends the full snapshot on connect, again only on change, and a ping between", async () => {
	let label = "a";
	const gui = await serve(async () => net(label));
	const stream = listen(gui);
	await until(() => stream.messages().length === 1, "the first snapshot");
	await until(() => stream.events.some((e) => e.event === "ping"), "a ping");
	assert.deepEqual(stream.messages(), ["a"], "an unchanged net is not resent");
	label = "b";
	await until(() => stream.messages().length === 2, "the change");
	assert.deepEqual(stream.messages(), ["a", "b"]);
	const late = listen(gui);
	await until(() => late.messages().length === 1, "the full snapshot for a late client");
	assert.deepEqual(late.messages(), ["b"], "a new client gets the current net at once, not what it missed");
	stream.close();
	late.close();
});

test("an unreadable net is reported as a problem once, and the next good read sends the snapshot again", async () => {
	let state: "ok" | "bad" = "ok";
	const gui = await serve(async () => {
		if (state === "bad") throw new Error("herdr is gone");
		return net("same");
	});
	const stream = listen(gui);
	await until(() => stream.messages().length === 1, "the snapshot");
	state = "bad";
	await until(() => stream.events.some((e) => e.event === "problem"), "the problem");
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.deepEqual(stream.events.filter((e) => e.event === "problem").map((e) => JSON.parse(e.data)), ["herdr is gone"], "once per reason");
	state = "ok";
	await until(() => stream.messages().length === 2, "the recovery snapshot");
	stream.close();
});

test("the net is read only while someone listens", async () => {
	let reads = 0;
	const gui = await serve(async () => (reads++, net("a")));
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(reads, 0, "no listener, no reads");
	const stream = listen(gui);
	await until(() => reads >= 3, "polling");
	stream.close();
	await until(() => stream.closed(), "the client to leave");
	await new Promise((resolve) => setTimeout(resolve, 60));
	const settled = reads;
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(reads, settled, "polling stopped with the last listener");
});

test("stop ends open streams and frees the port, and a restart with the same port and token keeps the URL", async () => {
	const gui = await serve(async () => net("a"));
	const stream = listen(gui);
	await until(() => stream.messages().length === 1, "the snapshot");
	await gui.stop();
	await until(() => stream.closed(), "the stream to end");
	await assert.rejects(raw(gui, `/${gui.token}/`), /ECONNREFUSED/);
	const again = await serve(async () => net("b"), { port: gui.port, token: gui.token });
	assert.equal(again.url, gui.url);
	assert.equal((await raw(again, `/${again.token}/`)).status, 200);
});

test("a taken preferred port falls back to a free one", async () => {
	const first = await serve(async () => net("a"));
	const second = await serve(async () => net("b"), { port: first.port, token: first.token });
	assert.notEqual(second.port, first.port);
	assert.equal((await raw(second, `/${second.token}/`)).status, 200);
});

test("a missing bundle is refused with the command that builds it", async () => {
	await assert.rejects(startGui({ read: async () => net("a"), dir: join(scratch, "nowhere") }), /npm run gui:build/);
});
