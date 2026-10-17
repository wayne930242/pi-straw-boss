import assert from "node:assert/strict";
import fs, { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { get, request, type IncomingMessage } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { startGui, type Gui } from "../src/gui.ts";
import type { Found, Ref } from "../src/net.ts";
import type { Net } from "../src/net.ts";
import { until } from "./fakes.ts";
import { assistant, header, lines, text, user } from "./sessions.ts";

const scratch = mkdtempSync(join(tmpdir(), "psb-gui-test-"));
const dir = join(scratch, "bundle");
mkdirSync(join(dir, "assets"), { recursive: true });
writeFileSync(join(dir, "index.html"), "<!doctype html><html><head><title>Straw Net</title></head><body></body></html>");
writeFileSync(join(dir, "assets", "app.js"), "console.log(1)");
writeFileSync(join(scratch, "secret.txt"), "outside the bundle");
const running: Gui[] = [];
after(async () => {
	await Promise.all(running.map((g) => g.stop()));
	rmSync(scratch, { recursive: true, force: true });
});

const net = (label: string): Net => ({ bases: [{ id: "w", label, mark: "idle", head: true, tower: null, tabs: [], outposts: [], outside: [] }] });
async function serve(read: () => Promise<Net>, options: { pollMs?: number; pingMs?: number; port?: number; token?: string; csrf?: string; net?: { lookup(key: string): Found | undefined; workspace(id: string): Ref[] } } = {}) {
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
function listen(gui: Gui, watch?: string) {
	const events: { event: string; data: string }[] = [];
	let closed = false;
	const req = get(`${gui.url}events${watch ? `?watch=${encodeURIComponent(watch)}` : ""}`, { headers: { host: `127.0.0.1:${gui.port}` } }, (res) => {
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
	assert.notEqual(again.csrf, gui.csrf, "without a preferred one, a new CSRF secret");
	const kept = await serve(async () => net("c"), { token: again.token, csrf: again.csrf });
	assert.equal(kept.csrf, again.csrf, "a restart can keep the page's CSRF secret, as sharedGui does from gui.json");
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

test("a route that is not a file answers the page with <base href>, so assets and the stream resolve from any depth; the policy forbids framing and other bases", async () => {
	const gui = await serve(async () => net("a"));
	const page = await raw(gui, `/${gui.token}/`);
	assert.ok(page.body.includes(`<head>\n<base href="/${gui.token}/">\n<meta name="sb-csrf" content="${gui.csrf}">`), page.body);
	assert.match(gui.csrf, /^[0-9a-f]{32}$/);
	assert.notEqual(gui.csrf, gui.token, "the CSRF secret is a second secret");
	for (const path of [`/${gui.token}/w/wA`, `/${gui.token}/w/wA/s/abc`, `/${gui.token}/w/a%20b/s/x%2Fy`, `/${gui.token}/w/wA/s/abc/`]) {
		const deep = await raw(gui, path);
		assert.deepEqual([deep.status, deep.body], [200, page.body], path);
		assert.match(String(deep.headers["content-type"]), /text\/html/);
	}
	assert.match(String(page.headers["content-security-policy"]), /base-uri 'self'/);
	assert.match(String(page.headers["content-security-policy"]), /frame-ancestors 'none'/);
	assert.equal((await raw(gui, `/w/wA`)).status, 403, "a route still needs the token");
	assert.equal((await raw(gui, `/${gui.token}/w/wA`, { method: "POST" })).status, 403, "and is read only");
});

const jsonOf = (r: { body: string }) => JSON.parse(r.body);
/** A live session file and a registry that knows it, standing in for the net reader. */
function session(entries: unknown[], extra: Partial<Found> = {}) {
	const file = join(scratch, `s-${Math.random().toString(36).slice(2)}.jsonl`);
	writeFileSync(file, lines(entries));
	const found: Found = { key: "k1", base: "wA", name: "api-main", role: "main", file, live: true, ...extra };
	const refs = new Map<string, Found>([["k1", found]]);
	return { file, found, net: { lookup: (key: string) => refs.get(key), workspace: (id: string) => [...refs.values()].filter((r) => r.base === id) } };
}
const named = [header(), user("u1", null, "question"), assistant("a1", "u1", [text("the answer")])];

test("events?watch=<key> sends the newest history first, then each new entry, and the unwatched stream stays as it was", async () => {
	const s = session(named);
	const gui = await serve(async () => net("a"), { net: s.net });
	const watcher = listen(gui, "k1");
	const plain = listen(gui);
	await until(() => watcher.events.some((e) => e.event === "history"), "the history");
	const first = JSON.parse(watcher.events.find((e) => e.event === "history")!.data);
	assert.deepEqual([first.key, first.state, first.reset, first.items.map((i: { id: string }) => i.id), first.header, first.name], ["k1", "live", true, ["u1", "a1"], { id: "sess-1", cwd: "/work/demo" }, "api-main"]);
	appendFileSync(s.file, lines([user("u2", "a1", "more")]));
	await until(() => watcher.events.filter((e) => e.event === "history").length === 2, "the appended entry");
	const next = JSON.parse(watcher.events.filter((e) => e.event === "history")[1]!.data);
	assert.deepEqual([next.reset, next.items.map((i: { id: string }) => i.id)], [false, ["u2"]]);
	await until(() => plain.messages().length === 1, "the net snapshot on the plain stream");
	assert.ok(!plain.events.some((e) => e.event === "history"), "a stream with no watch carries no history");
	watcher.close();
	plain.close();
});

test("a stream that disconnects releases its reader: the session file is no longer watched", async () => {
	const real = fs.watch;
	let watching = 0;
	fs.watch = ((...args: Parameters<typeof real>) => {
		const watcher = real(...args), close = watcher.close.bind(watcher);
		watching++;
		watcher.close = () => (watching--, close());
		return watcher;
	}) as typeof real;
	syncBuiltinESMExports();
	try {
		const s = session(named);
		const gui = await serve(async () => net("a"), { net: s.net });
		const stream = listen(gui, "k1");
		await until(() => stream.events.some((e) => e.event === "history"), "the history");
		assert.equal(watching, 1, "the watched session's file is watched");
		stream.close();
		await until(() => watching === 0, "the watcher closed after the disconnect");
		const again = listen(gui, "k1");
		await until(() => again.events.some((e) => e.event === "history") && watching === 1, "a new stream attaches again");
		again.close();
		await until(() => watching === 0, "and releases again");
	} finally {
		fs.watch = real;
		syncBuiltinESMExports();
	}
});

test("a key the registry does not know, or whose file is not known yet, is answered without touching the file system", async () => {
	const s = session(named, { key: "k2", file: undefined });
	const gui = await serve(async () => net("a"), { net: s.net });
	const unknown = listen(gui, "nobody");
	await until(() => unknown.events.some((e) => e.event === "history"), "the answer for an unknown key");
	assert.deepEqual(pick(unknown), { key: "nobody", state: "unknown", reset: true, items: [] });
	unknown.close();
	const fileless = session(named, { file: undefined });
	const gui2 = await serve(async () => net("a"), { net: fileless.net });
	const early = listen(gui2, "k1");
	await until(() => early.events.some((e) => e.event === "history"), "the answer for a session with no file");
	assert.deepEqual([pick(early).items, pick(early).state, pick(early).name], [[], "live", "api-main"]);
	early.close();
});
const pick = (stream: ReturnType<typeof listen>) => JSON.parse(stream.events.find((e) => e.event === "history")!.data);

test("a session that left the net reads on as recent, and a state change is announced once", async () => {
	const s = session(named);
	const gui = await serve(async () => net("a"), { net: s.net });
	const stream = listen(gui, "k1");
	await until(() => stream.events.some((e) => e.event === "history"), "the history");
	s.found.live = false;
	s.found.successor = "k9";
	await until(() => stream.events.filter((e) => e.event === "history").length === 2, "the state change");
	const change = JSON.parse(stream.events.filter((e) => e.event === "history")[1]!.data);
	assert.deepEqual([change.state, change.successor, change.reset, change.items], ["recent", "k9", false, []]);
	await new Promise((resolve) => setTimeout(resolve, 80));
	assert.equal(stream.events.filter((e) => e.event === "history").length, 2, "unchanged state is not repeated");
	stream.close();
});

test("a workspace watch sends each session's last assistant line, and again only for the session whose file changed", async () => {
	const s = session(named);
	const gui = await serve(async () => net("a"), { net: s.net });
	const stream = listen(gui, "w:wA");
	await until(() => stream.events.some((e) => e.event === "cards"), "the cards");
	assert.deepEqual(JSON.parse(stream.events.find((e) => e.event === "cards")!.data), { k1: "the answer" });
	appendFileSync(s.file, lines([assistant("a2", "a1", [text("first line\nsecond line")])]));
	await until(() => stream.events.filter((e) => e.event === "cards").length === 2, "the changed card");
	assert.deepEqual(JSON.parse(stream.events.filter((e) => e.event === "cards")[1]!.data), { k1: "second line" });
	stream.close();
});

test("the API pages older history and returns one entry in full, only for keys in the registry", async () => {
	const entries: unknown[] = [header()];
	for (let i = 0; i < 12; i++) entries.push(user(`u${i}`, i ? `u${i - 1}` : null, `m${i}`));
	const s = session(entries);
	const gui = await serve(async () => net("a"), { net: s.net });
	const newest = jsonOf(await raw(gui, `/${gui.token}/api/history/k1?limit=5`));
	assert.deepEqual([newest.items.map((i: { id: string }) => i.id), newest.before], [["u7", "u8", "u9", "u10", "u11"], "u7"]);
	const older = jsonOf(await raw(gui, `/${gui.token}/api/history/k1?before=u7&limit=5`));
	assert.deepEqual(older.items.map((i: { id: string }) => i.id), ["u2", "u3", "u4", "u5", "u6"]);
	const one = await raw(gui, `/${gui.token}/api/entry/k1/u3`);
	assert.deepEqual([one.status, jsonOf(one).text, one.headers["content-type"]], [200, "m3", "application/json"]);
	for (const path of ["/api/history/nobody", "/api/entry/nobody/u3", "/api/entry/k1/missing", "/api/entry/k1", "/api/other/k1", "/api/history/%E0%A4%A", "/api/"]) assert.equal((await raw(gui, `/${gui.token}${path}`)).status, 404, path);
	assert.equal((await raw(gui, `/api/history/k1`)).status, 403, "the token is still required");
	assert.equal((await raw(gui, `/${gui.token}/api/history/k1`, { method: "POST" })).status, 403, "and nothing here writes");
});
