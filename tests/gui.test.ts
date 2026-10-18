import assert from "node:assert/strict";
import fs, { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { get, request, type IncomingMessage } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { type Asked, requestStop, startGui, type Gui } from "../src/gui.ts";
import { canonical } from "../src/history.ts";
import type { Found, Ref } from "../src/net.ts";
import type { Net } from "../src/net.ts";
import { until } from "./fakes.ts";
import { assistant, header, lines, message, text, user } from "./sessions.ts";

const scratch = mkdtempSync(join(tmpdir(), "psb-gui-test-"));
const dir = join(scratch, "bundle");
mkdirSync(join(dir, "assets"), { recursive: true });
writeFileSync(join(dir, "index.html"), "<!doctype html><html><head><title>Straw Net</title></head><body></body></html>");
writeFileSync(join(dir, "assets", "app.js"), "console.log(1)");
writeFileSync(join(dir, "assets", "Symbols-ab12.woff2"), Buffer.from([0x77, 0x4f, 0x46, 0x32, 0xff]));
writeFileSync(join(scratch, "secret.txt"), "outside the bundle");
const running: Gui[] = [];
after(async () => {
	await Promise.all(running.map((g) => g.stop()));
	rmSync(scratch, { recursive: true, force: true });
});

const net = (label: string): Net => ({ bases: [{ id: "w", label, mark: "idle", head: true, tower: null, tabs: [], outposts: [], outside: [] }] });
async function serve(read: () => Promise<Net>, options: { pollMs?: number; pingMs?: number; port?: number; token?: string; csrf?: string; net?: { lookup(key: string): Found | undefined; workspace(id: string): Ref[] }; call?: (method: string, params: Record<string, unknown>) => Promise<unknown>; onStop?(asked: Asked): void; onRemote?(): Promise<void> } = {}, bundle = dir) {
	const gui = await startGui({ read, dir: bundle, pollMs: 20, pingMs: 50, ...options });
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
	assert.match(String(page.headers["content-security-policy"]), /font-src 'self'/, "the page may load its own font");
	const font = await raw(gui, `/${gui.token}/assets/Symbols-ab12.woff2`);
	assert.deepEqual([font.status, font.headers["content-type"], font.headers["cache-control"]], [200, "font/woff2", "private, max-age=31536000, immutable"], "a font, named for its hash, is kept");
	const bare = await raw(gui, `/${gui.token}`);
	assert.deepEqual([bare.status, bare.headers.location], [308, `/${gui.token}/`], "the token path without its slash redirects to the page");
	assert.equal((await raw(gui, `/${gui.token}/assets/missing.js`)).status, 404);
	assert.equal((await raw(gui, `/${gui.token}/..%2fsecret.txt`)).status, 404, "nothing outside the bundle is served");
	assert.equal((await raw(gui, `/${gui.token}/assets/..%2f..%2fsecret.txt`)).status, 404);
});

test("a package update that replaces the bundle under a running server leaves its page and assets as they were at start", async () => {
	const own = join(scratch, "updated");
	mkdirSync(join(own, "assets"), { recursive: true });
	writeFileSync(join(own, "index.html"), "<!doctype html><html><head></head><body>old</body></html>");
	writeFileSync(join(own, "assets", "old.js"), "old()");
	const gui = await serve(async () => net("a"), {}, own);
	rmSync(join(own, "assets", "old.js"));
	writeFileSync(join(own, "assets", "new.js"), "next()");
	writeFileSync(join(own, "index.html"), "<!doctype html><html><head></head><body>new</body></html>");
	assert.match((await raw(gui, `/${gui.token}/`)).body, /old/);
	assert.deepEqual(await raw(gui, `/${gui.token}/assets/old.js`).then((r) => [r.status, r.body]), [200, "old()"]);
	assert.equal((await raw(gui, `/${gui.token}/assets/new.js`)).status, 404, "a file added after start is not served");
});

test("the page and each stream's hello name the bundle's build, so a page from another build can tell", async () => {
	const gui = await serve(async () => net("a"));
	const build = /<meta name="sb-build" content="([0-9a-f]{16})">/.exec((await raw(gui, `/${gui.token}/`)).body)?.[1];
	assert.ok(build);
	const s = listen(gui);
	await until(() => s.events.some((e) => e.event === "hello"), "hello");
	s.close();
	assert.equal(JSON.parse(s.events.find((e) => e.event === "hello")!.data).build, build);
});

test("another session's stop request ends the server through onStop; one without the CSRF secret, or from a paired device, is refused", async () => {
	const asked: Asked[] = [];
	const gui: Gui = await serve(async () => net("a"), { onStop: (a) => (asked.push(a), void gui.stop()) });
	const record = { pid: process.pid, port: gui.port, token: gui.token, csrf: gui.csrf, owner: "x" }, nap = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
	assert.equal(await requestStop({ ...record, csrf: "wrong" }, { by: "s", take: false }, nap), false);
	const host = "box.tail1.ts.net:8443", tailnet = { host, "tailscale-user-login": "me@example.com", "x-forwarded-for": "100.87.7.97" };
	gui.access.enable({ host, login: "me@example.com" });
	const post = (path: string, headers: Record<string, string>, method = "POST") =>
		new Promise<IncomingMessage>((done, fail) => request({ host: "127.0.0.1", port: gui.port, path, method, headers, agent: false }, (res) => (res.resume(), done(res))).on("error", fail).end(method === "POST" ? "{}" : undefined));
	const cookie = String((await post(`/${gui.token}/pair/${gui.access.pair()}`, tailnet, "GET")).headers["set-cookie"]).split(";")[0]!;
	const remote = await post(`/${gui.token}/api/server/stop`, { ...tailnet, cookie, origin: `https://${host}`, "content-type": "application/json", "x-sb-csrf": gui.csrf });
	assert.equal(remote.statusCode, 403, "a paired device cannot stop the server");
	assert.deepEqual(asked, []);
	assert.equal(await requestStop(record, { by: "s", take: true }, nap), true);
	assert.deepEqual(asked, [{ by: "s", take: true }]);
	await assert.rejects(raw(gui, `/${gui.token}/`), /ECONNREFUSED/);
});

test("the page turns remote access on through onRemote and gets a pairing code at once; a failure says why; a paired device cannot ask", async () => {
	const host = "box.tail1.ts.net:8443";
	let fail: string | undefined, calls = 0;
	const gui: Gui = await serve(async () => net("a"), { onRemote: async () => (calls++, fail ? Promise.reject(new Error(fail)) : gui.access.enable({ host, login: "me@example.com" })) });
	const post = (path: string, headers: Record<string, string> = {}) =>
		new Promise<{ status: number; body: { error?: string; reason?: string; url?: string; rows?: string[] } }>((done, reject) => {
			const req = request({ host: "127.0.0.1", port: gui.port, path: `/${gui.token}/api/${path}`, method: "POST", agent: false, headers: { host: `127.0.0.1:${gui.port}`, origin: `http://127.0.0.1:${gui.port}`, "content-type": "application/json", "x-sb-csrf": gui.csrf, ...headers } }, (res) => {
				let body = "";
				res.on("data", (c) => (body += c)).on("end", () => done({ status: res.statusCode!, body: body.startsWith("{") ? JSON.parse(body) : {} }));
			});
			req.on("error", reject).end("{}");
		});
	const off = await post("remote/pair");
	assert.deepEqual([off.status, off.body.error], [409, "remote_off"], "the page learns it is off and can offer to turn it on");
	fail = "Tailscale is not running";
	assert.deepEqual(await post("remote/on").then((r) => [r.status, r.body.error, r.body.reason]), [502, "remote_failed", "Tailscale is not running"]);
	fail = undefined;
	const on = await post("remote/on");
	assert.equal(on.status, 200);
	assert.match(String(on.body.url), new RegExp(`^https://${host.replace(/\./g, "\\.")}/${gui.token}/pair/`));
	assert.ok(Array.isArray(on.body.rows) && on.body.rows.length > 20, "with the QR's rows");
	const tailnet = { host, "tailscale-user-login": "me@example.com", "x-forwarded-for": "100.87.7.97" };
	const cookie = await new Promise<string>((done) => request({ host: "127.0.0.1", port: gui.port, path: `/${gui.token}/pair/${gui.access.pair()}`, headers: tailnet, agent: false }, (res) => (res.resume(), done(String(res.headers["set-cookie"]).split(";")[0]!))).end());
	assert.equal((await post("remote/on", { ...tailnet, cookie, origin: `https://${host}` })).status, 403, "a paired device cannot ask");
	assert.equal(calls, 2);
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

test("an entry's images are served one by one as their bytes, png, jpeg, gif, or webp only, for keys in the registry", async () => {
	const pic = (mimeType: string, bytes: string) => ({ type: "image", mimeType, data: Buffer.from(bytes).toString("base64") });
	const s = session([header(), message("u1", null, { role: "user", content: [{ type: "text", text: "look" }, pic("image/png", "PNG-BYTES"), pic("image/svg+xml", "<svg/>"), pic("image/webp", "WEBP-BYTES")], timestamp: 1 })]);
	const gui = await serve(async () => net("a"), { net: s.net });
	const first = await raw(gui, `/${gui.token}/api/image/k1/u1/0`), second = await raw(gui, `/${gui.token}/api/image/k1/u1/1`);
	assert.deepEqual([first.status, first.body, first.headers["content-type"], first.headers["cache-control"], first.headers["x-content-type-options"]], [200, "PNG-BYTES", "image/png", "private, max-age=86400", "nosniff"]);
	assert.deepEqual([second.status, second.body, second.headers["content-type"]], [200, "WEBP-BYTES", "image/webp"], "the svg is skipped, so the index counts the shown images");
	for (const path of ["/api/image/k1/u1/2", "/api/image/k1/u1/-1", "/api/image/k1/u1/x", "/api/image/k1/u1", "/api/image/nobody/u1/0", "/api/image/k1/missing/0"]) assert.equal((await raw(gui, `/${gui.token}${path}`)).status, 404, path);
	assert.equal((await raw(gui, `/api/image/k1/u1/0`)).status, 403, "the token is still required");
});

test("each stream is named in hello; a page attaches the terminal mirror to its own stream, under the write guards, and closing the stream stops the reads", async () => {
	const file = canonical(join(scratch, "2026_k1.jsonl"))!, reads: string[] = [];
	const call = async (method: string, params: Record<string, unknown>) => {
		if (method === "pane.get") return { pane: { pane_id: "p1", agent: "pi", agent_session: { value: file } } };
		if (method === "pane.layout") return { layout: { panes: [{ pane_id: "p1", rect: { width: 40 } }] } };
		reads.push(String(params.pane_id));
		return { read: { text: "hello\r\n\x1b]8;;https://x.test\x07world\x1b]8;;\x07" } };
	};
	const lookup = (key: string): Found | undefined => (key === "k1" ? { key, base: "w", name: "k1", role: "main", file, pane: "p1", live: true } : undefined);
	const gui = await serve(async () => net("a"), { net: { lookup, workspace: () => [] }, call });
	const a = listen(gui), b = listen(gui);
	await until(() => a.events.some((e) => e.event === "hello") && b.events.some((e) => e.event === "hello"), "hello");
	const id = (s: typeof a) => (JSON.parse(s.events.find((e) => e.event === "hello")!.data) as { stream: string }).stream;
	assert.match(id(a), /^[0-9a-f]{32}$/);
	assert.notEqual(id(a), id(b));
	const post = (body: unknown, headers: Record<string, string> = {}) => new Promise<number>((resolve, reject) => {
		const data = JSON.stringify(body);
		request({ host: "127.0.0.1", port: gui.port, path: `/${gui.token}/api/sessions/k1/mirror`, method: "POST", agent: false, headers: { host: `127.0.0.1:${gui.port}`, origin: `http://127.0.0.1:${gui.port}`, "content-type": "application/json", "x-sb-csrf": gui.csrf, ...headers } }, (res) => (res.resume(), resolve(res.statusCode!))).on("error", reject).end(data);
	});
	assert.equal(await post({ stream: id(a), on: true }, { "x-sb-csrf": "nope" }), 403, "the write guards apply");
	assert.equal(await post({ stream: id(a), on: true }, { origin: "http://evil.test" }), 403);
	assert.equal(reads.length, 0);
	assert.equal(await post({ stream: id(a), on: true }), 200);
	await until(() => a.events.some((e) => e.event === "mirror"), "a frame");
	assert.deepEqual(JSON.parse(a.events.find((e) => e.event === "mirror")!.data), { key: "k1", seq: 1, rows: 2, cols: 40, whole: true, set: [[0, "hello"], [1, "world"]] });
	assert.ok(!b.events.some((e) => e.event === "mirror"), "only the stream that asked");
	a.close();
	await new Promise((resolve) => setTimeout(resolve, 100));
	const n = reads.length;
	await new Promise((resolve) => setTimeout(resolve, 1200));
	assert.equal(reads.length, n, "the closed stream took its mirror with it");
	b.close();
});

test("a server that has not read the net yet names the stream after its first reading, so a page reconnecting to a new server attaches its terminals to a known session", async () => {
	let release = () => {};
	const gate = new Promise<void>((resolve) => (release = resolve));
	const gui = await serve(async () => (await gate, net("a")));
	const a = listen(gui);
	await new Promise((resolve) => setTimeout(resolve, 150));
	const named = (s: ReturnType<typeof listen>) => s.events.map((e) => e.event).filter((e) => e !== "ping");
	assert.deepEqual(named(a), [], "nothing but pings before the first reading");
	release();
	await until(() => a.events.some((e) => e.event === "hello"), "hello");
	assert.deepEqual(named(a).slice(0, 2), ["message", "hello"], "the snapshot first, then the name");
	const b = listen(gui);
	await until(() => named(b).length >= 2, "b's first events");
	assert.equal(named(b)[0], "hello", "once a reading exists, the name comes first as before");
	a.close();
	b.close();
});
