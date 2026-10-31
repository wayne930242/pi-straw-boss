import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { get, request } from "node:http";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { writeRecordFile } from "../src/handover.ts";
import { until, World } from "./fakes.ts";
import { type Hosted, startHosted, stopHosted } from "./gui-world.ts";

// The server's default view (docs/how-it-works.md, Browser view): `/boss gui view <auto|standard|geek>` in pi → the control request `gui-view` → gui-prefs.json in the state folder → the `sb-view` meta of the
// served page, `view` in the stream's `hello` and a `view` event to the open pages, and the optional `view` of gui.json for a shell. Only the pi command writes it.

let world = new World();
afterEach(async () => {
	await stopHosted();
	await world.stopAll();
	world = new World();
});
const deps = { openUrl: async () => {} };

const pageOf = (h: Hosted) => new Promise<string>((resolve, reject) => void get(h.url, { agent: false }, (res) => { let body = ""; res.on("data", (c) => (body += c)).on("end", () => resolve(body)); }).on("error", reject));
const metaOf = (page: string) => /<meta name="sb-view" content="([^"]*)">/.exec(page)?.[1];
const prefs = (h: Hosted) => join(h.slot.dir, "gui-prefs.json");

/** An open stream of the page: the named events it has heard so far, as `[event, data]`. */
function stream(h: Hosted) {
	const heard: [string, string][] = [];
	const req = get(`${h.url}events`, { agent: false }, (res) => {
		res.setEncoding("utf8");
		let buffer = "";
		res.on("data", (chunk: string) => {
			buffer += chunk;
			const blocks = buffer.split("\n\n");
			buffer = blocks.pop() ?? "";
			for (const block of blocks) {
				const event = /^event: (.*)$/m.exec(block)?.[1], data = /^data: (.*)$/m.exec(block)?.[1];
				if (event && data !== undefined) heard.push([event, data]);
			}
		});
	});
	req.on("error", () => {});
	return { heard, close: () => req.destroy() };
}
const helloOf = (heard: [string, string][]) => heard.filter(([e]) => e === "hello").map(([, d]) => JSON.parse(d) as { stream: string; build: string; view?: string });

test("a server that was never told a default serves the page with <meta name=\"sb-view\" content=\"auto\"> and a hello without a surprise: view is auto", async () => {
	const h = await startHosted(world);
	assert.equal(metaOf(await pageOf(h)), "auto");
	const s = stream(h);
	await until(() => helloOf(s.heard).length > 0, "the stream's hello");
	assert.equal(helloOf(s.heard)[0]!.view, "auto");
	s.close();
	assert.equal(existsSync(prefs(h)), false, "nothing is written until the boss sets a default");
	assert.equal(h.gui().view, undefined, "gui.json carries no view for Auto");
	assert.deepEqual(await h.ask("gui-view"), { ok: true, view: "auto" }, "a bare ask only tells");
});

test("gui-view stores the default (gui-prefs.json, mode 600, renamed into place), writes the page's meta, hello, and gui.json's view; a bare ask tells it", async () => {
	const h = await startHosted(world);
	const reply = await h.ask("gui-view", { view: "geek" });
	assert.deepEqual(reply, { ok: true, view: "geek", changed: true });
	assert.deepEqual(JSON.parse(readFileSync(prefs(h), "utf8")), { v: 1, view: "geek" });
	if (process.platform !== "win32") assert.equal(statSync(prefs(h)).mode & 0o777, 0o600);
	assert.deepEqual(readdirSync(h.slot.dir).filter((f: string) => f.includes("gui-prefs") && f.endsWith(".tmp")), [], "no temporary file is left");
	assert.equal(metaOf(await pageOf(h)), "geek");
	const s = stream(h);
	await until(() => helloOf(s.heard).length > 0, "the stream's hello");
	assert.equal(helloOf(s.heard)[0]!.view, "geek");
	s.close();
	assert.equal(h.gui().view, "geek");
	assert.deepEqual(await h.ask("gui-view"), { ok: true, view: "geek" });
	assert.deepEqual(await h.ask("gui-view", { view: "geek" }), { ok: true, view: "geek", changed: false }, "the same value again changes nothing");
	assert.deepEqual(await h.ask("gui-view", { view: "standard" }), { ok: true, view: "standard", changed: true });
	assert.equal(h.gui().view, "standard");
	assert.deepEqual(await h.ask("gui-view", { view: "auto" }), { ok: true, view: "auto", changed: true });
	assert.equal(h.gui().view, undefined, "Auto leaves the record as it was before the field existed");
	assert.equal(metaOf(await pageOf(h)), "auto");
});

test("an open page hears the new default at once, as a view event, with no reload and no new hello", async () => {
	const h = await startHosted(world);
	const s = stream(h);
	await until(() => helloOf(s.heard).length > 0, "the stream's hello");
	await h.ask("gui-view", { view: "geek" });
	await until(() => s.heard.some(([e]) => e === "view"), "a view event");
	assert.deepEqual(s.heard.filter(([e]) => e === "view").map(([, d]) => JSON.parse(d)), ["geek"]);
	await h.ask("gui-view", { view: "geek" });
	await h.ask("gui-view", { view: "auto" });
	await until(() => s.heard.filter(([e]) => e === "view").length === 2, "two view events");
	assert.deepEqual(s.heard.filter(([e]) => e === "view").map(([, d]) => JSON.parse(d)), ["geek", "auto"], "an unchanged value is not told again");
	assert.equal(helloOf(s.heard).length, 1, "the terminal tiles attach to a hello: a view change must not send another");
	s.close();
});

test("a default survives a restart of the server (page, hello, gui.json), and a corrupt or foreign prefs file reads as Auto", async () => {
	const h = await startHosted(world);
	await h.ask("gui-view", { view: "geek" });
	await h.ask("restart", { reason: "test", by: "test" });
	await h.handle.done;
	const next = await startHosted(world);
	assert.equal(metaOf(await pageOf(next)), "geek");
	assert.equal(next.gui().view, "geek");
	await next.ask("stop", { by: "test" });
	await next.handle.done;
	for (const text of ["{", JSON.stringify({ v: 1, view: "sparkly" }), JSON.stringify({ v: 2, view: "geek" }), "[]", "null"]) {
		writeFileSync(prefs(next), text);
		const again = await startHosted(world);
		assert.equal(metaOf(await pageOf(again)), "auto", text);
		assert.equal(again.gui().view, undefined, text);
		await again.ask("stop", { by: "test" });
		await again.handle.done;
	}
});

test("an unknown value is refused and changes nothing", async () => {
	const h = await startHosted(world);
	await h.ask("gui-view", { view: "geek" });
	for (const view of ["sparkly", "GEEK", "", 1, null, ["geek"], { view: "geek" }]) {
		const reply = await h.ask("gui-view", { view });
		assert.equal(reply.ok, false, JSON.stringify(view));
		assert.match(String(reply.error), /auto, standard, or geek/);
	}
	assert.deepEqual(JSON.parse(readFileSync(prefs(h), "utf8")), { v: 1, view: "geek" });
	assert.equal(metaOf(await pageOf(h)), "geek");
});

test("with the GUI stopped on purpose the default is still stored, and gui.json (stopped) carries it for a shell; the boss's own start serves it; the command does not start the GUI", async () => {
	const h = await startHosted(world);
	await h.ask("gui-stop");
	assert.deepEqual(await h.ask("gui-view", { view: "geek" }), { ok: true, view: "geek", changed: true });
	assert.equal(h.gui().stopped, true, "the command did not start the GUI");
	assert.equal(h.gui().view, "geek");
	assert.equal(h.record().gui?.stopped, true);
	const started = await h.ask("gui", { boss: true });
	assert.equal(started.ok, true);
	assert.equal(metaOf(await pageOf(h)), "geek");
	assert.equal(h.gui().view, "geek", "a start keeps the field");
});

test("a GUI record of another process is left alone by the command", async () => {
	const h = await startHosted(world);
	await h.ask("gui-stop");
	writeRecordFile(h.slot.dir, { ...h.gui(), pid: 999_999, owner: "an older host" });
	await h.ask("gui-view", { view: "geek" });
	assert.equal(h.gui().view, undefined);
	assert.equal(h.gui().owner, "an older host");
});

test("a failed write is told and nothing changes: the page and the open streams keep the default they had", async () => {
	const h = await startHosted(world);
	mkdirSync(prefs(h)); // a directory where the file goes: the rename onto it fails
	try {
		const s = stream(h);
		await until(() => helloOf(s.heard).length > 0, "the stream's hello");
		const reply = await h.ask("gui-view", { view: "geek" });
		assert.equal(reply.ok, false);
		assert.match(String(reply.error), /gui-prefs\.json/);
		assert.equal(metaOf(await pageOf(h)), "auto");
		assert.equal(h.gui().view, undefined);
		assert.equal(s.heard.some(([e]) => e === "view"), false);
		s.close();
	} finally {
		rmSync(prefs(h), { recursive: true, force: true });
	}
});

test("only the pi command writes it: the page's API has no route for it, and a request with the right CSRF secret changes nothing", async () => {
	const h = await startHosted(world);
	const gui = h.gui();
	// Raw, as the page's own fetch sends it: the answer of a path with no route is plain text, not JSON.
	const posted = (path: string) => new Promise<number>((resolve, reject) => {
		const body = JSON.stringify({ view: "geek" });
		const req = request({ host: "127.0.0.1", port: gui.port, path: `/${gui.token}/api/${path}`, method: "POST", agent: false, headers: { host: `127.0.0.1:${gui.port}`, origin: `http://127.0.0.1:${gui.port}`, "content-type": "application/json", "x-sb-csrf": gui.csrf!, "content-length": Buffer.byteLength(body) } }, (res) => (res.resume(), resolve(res.statusCode!)));
		req.on("error", reject).end(body);
	});
	for (const path of ["view", "gui/view", "server/view", "remote/view", "server/gui-view", "gui-view"]) {
		const got = await posted(path);
		assert.ok(got === 403 || got === 404 || got === 400, `${path}: ${got}`);
	}
	assert.equal(existsSync(prefs(h)), false);
	assert.equal(metaOf(await pageOf(h)), "auto");
});

test("/boss gui view <auto|standard|geek> in a pi session sets the server's default and tells it; a bare /boss gui view shows it; a wrong value is an error that changes nothing", async () => {
	const h = await startHosted(world);
	const viewer = world.agent({ id: "viewer", pane: "wA:p1", tab: "wA:t1", deps });
	await viewer.start();
	await viewer.command("gui view");
	assert.match(viewer.notices.at(-1)!.text, /default view is Auto/);
	await viewer.command("gui view geek");
	assert.match(viewer.notices.at(-1)!.text, /default view is now Geek/);
	assert.notEqual(viewer.notices.at(-1)!.level, "error");
	assert.equal(metaOf(await pageOf(h)), "geek");
	assert.equal(h.gui().view, "geek");
	await viewer.command("gui view");
	assert.match(viewer.notices.at(-1)!.text, /default view is Geek/);
	await viewer.command("gui view geek");
	assert.match(viewer.notices.at(-1)!.text, /already Geek/);
	await viewer.command("gui view standard");
	assert.match(viewer.notices.at(-1)!.text, /now Standard/);
	await viewer.command("gui view sparkly");
	assert.equal(viewer.notices.at(-1)!.level, "error");
	assert.match(viewer.notices.at(-1)!.text, /auto, standard, or geek/);
	assert.equal(metaOf(await pageOf(h)), "standard", "a wrong value changed nothing");
	await viewer.command("gui view auto");
	assert.equal(metaOf(await pageOf(h)), "auto");
});

test("/boss gui view with no sb server to ask is told as an error", async () => {
	const viewer = world.agent({ id: "viewer", pane: "wA:p1", tab: "wA:t1", deps });
	await viewer.start();
	await viewer.command("gui view geek");
	assert.equal(viewer.notices.at(-1)!.level, "error");
});

test("the docs name the command, the store, the meta, the event, and gui.json's optional view; the README lists the command in both languages", () => {
	const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
	const doc = read("docs/how-it-works.md");
	for (const word of ["/boss gui view", "gui-prefs.json", '<meta name="sb-view"', "`view` event", "`gui-view`", "Follow server"]) assert.ok(doc.includes(word), word);
	const contract = doc.split("\n").find((l) => l.startsWith("- **`gui.json` is a contract.**")) ?? "";
	assert.match(contract, /`owner`, and `view`/);
	assert.match(contract, /`view` \(optional, `standard` or `geek`, absent when the boss has set no default\)/);
	for (const f of ["README.md", "README.zh-TW.md"]) assert.ok(read(f).includes("`/boss gui view`"), f);
});
