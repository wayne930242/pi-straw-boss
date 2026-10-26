import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { startGui, type Gui } from "../src/gui.ts";
import { readRecord, writeRecord } from "../src/handover.ts";
import { collectNet } from "../src/net.ts";
import type { Pane, Workspace } from "../src/herdr.ts";
import { answerFile, listRequests, requestFile, resultFile, sweep, writeAtomic } from "../src/trust/files.ts";
import { digestOf } from "../src/trust/found.ts";
import { createTrustServe } from "../src/trust/serve.ts";
import type { TrustRequest, TrustResult } from "../src/trust/types.ts";

// The server's side of the trust question: the listing, the cleanup, the answer route, and who may call it.

const scratch = mkdtempSync(join(tmpdir(), "psb-trust-serve-"));
mkdirSync(join(scratch, "bundle"));
writeFileSync(join(scratch, "bundle", "index.html"), "<!doctype html><html><head><title>Straw Net</title></head><body></body></html>");
const running: Gui[] = [];
after(async () => {
	await Promise.all(running.map((g) => g.stop()));
	rmSync(scratch, { recursive: true, force: true });
});

const HERDR = "/tmp/herdr-test.sock", ANSWER = "a".repeat(20);
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const panes: Pane[] = [1, 2, 3].map((n) => ({ pane_id: `p${n}`, tab_id: "t1", workspace_id: "w1" }));
const workspaces: Workspace[] = [{ workspace_id: "w1", label: "Base One" }];
let dirs = 0;
const dirOf = () => join(scratch, `state-${dirs++}`, "trust");

function put(dir: string, n: number, over: Partial<TrustRequest> = {}) {
	const found = over.found ?? [{ kind: "settings", path: ".pi/settings.json", items: ["package: npm:demo"], more: 0 }], cwd = over.cwd ?? "/work/demo";
	const r: TrustRequest = { version: 1, id: id(n), pid: process.pid, herdr: HERDR, pane: `p${n}`, role: "member", cwd, at: 1000 + n, found, digest: digestOf(cwd, found), ...over };
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	writeAtomic(dir, requestFile(r.id), r);
	return r;
}
const serve = (dir: string, over: Partial<Parameters<typeof createTrustServe>[0]> = {}) => createTrustServe({ dir, herdr: HERDR, world: async () => ({ panes, workspaces }), sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))), ...over });
/** The asking pi: when it finds its answer file it writes its result and removes its request, as ask.ts does. */
function pi(dir: string, r: TrustRequest, by: TrustResult["by"] = "remote") {
	const timer = setInterval(() => {
		if (!existsSync(join(dir, answerFile(r.id)))) return;
		const a = JSON.parse(readFileSync(join(dir, answerFile(r.id)), "utf8")) as { answerId: string };
		writeAtomic(dir, resultFile(r.id), { version: 1, id: r.id, by, ...(by === "remote" && { answerId: a.answerId }), at: Date.now() });
		rmSync(join(dir, requestFile(r.id)), { force: true });
		clearInterval(timer);
	}, 2);
	return () => clearInterval(timer);
}

test("the listing: only this Herdr's requests, of a live process, whose pane Herdr lists; text is cleaned; two requests for one folder and digest are one entry", () => {
	const dir = dirOf();
	put(dir, 1, { found: [{ kind: "settings", path: ".pi/settings.json", items: ["package: npm:\u202edemo\u0007x"], more: 0 }], cwd: "/work/\u200bdemo" });
	put(dir, 2, { found: [{ kind: "settings", path: ".pi/settings.json", items: ["package: npm:\u202edemo\u0007x"], more: 0 }], cwd: "/work/\u200bdemo" });
	put(dir, 3, { herdr: "/other.sock" }); // another Herdr
	put(dir, 4, { pane: "p9" }); // a pane Herdr does not list
	put(dir, 5, { pid: 2_000_000_000, pane: "p1" }); // a process that does not run
	writeFileSync(join(dir, `${id(6)}.json`), "{broken");
	const asks = serve(dir).asks(panes, workspaces);
	assert.equal(asks.length, 1);
	const [a] = asks;
	assert.equal(a!.id, id(1), "the oldest request names the entry");
	assert.deepEqual(a!.agents.map((x) => [x.pane, x.base, x.role]), [["p1", "Base One", "member"], ["p2", "Base One", "member"]]);
	assert.equal(a!.folder, "/work/�demo", "format characters are drawn as U+FFFD");
	assert.deepEqual(a!.found[0]!.items, ["package: npm:�demo" + "x"], "control characters are removed");
	assert.equal(a!.digest, digestOf("/work/\u200bdemo", [{ kind: "settings", path: ".pi/settings.json", items: ["package: npm:\u202edemo\u0007x"], more: 0 }]), "the digest covers the raw text");
	assert.ok(!existsSync(join(dir, requestFile(id(5)))), "a request whose process is gone is removed at once");
});

test("a request with another digest than its findings give, another id than its file, or a link in its place is not listed", () => {
	const dir = dirOf();
	put(dir, 1);
	writeFileSync(join(dir, requestFile(id(2))), JSON.stringify({ ...JSON.parse(readFileSync(join(dir, requestFile(id(1))), "utf8")), id: id(2), pane: "p2", digest: "0".repeat(64) }));
	writeFileSync(join(dir, requestFile(id(3))), JSON.stringify({ ...JSON.parse(readFileSync(join(dir, requestFile(id(1))), "utf8")), pane: "p3" })); // the id of another file
	assert.deepEqual(listRequests(dir).map((r) => r.id), [id(1)]);
});

test("sweep removes the dead and the forgotten, and leaves a live request alone", () => {
	const dir = dirOf(), old = new Date(Date.now() - 10 * 60_000);
	const live = put(dir, 1), dead = put(dir, 2, { pid: 2_000_000_000 });
	writeFileSync(join(dir, answerFile(id(7))), "{}");
	writeFileSync(join(dir, resultFile(id(8))), "{}");
	writeFileSync(join(dir, `${id(9)}.json.1.0.tmp`), "{");
	for (const f of [answerFile(id(7)), resultFile(id(8)), `${id(9)}.json.1.0.tmp`]) utimesSync(join(dir, f), old, old);
	writeFileSync(join(dir, resultFile(id(10))), "{}"); // fresh: the server may still be reading it
	sweep(dir);
	assert.deepEqual(readdirSync(dir).sort(), [requestFile(live.id), resultFile(id(10))].sort());
	assert.ok(!existsSync(join(dir, requestFile(dead.id))));
	if (process.platform !== "win32") assert.equal(statSync(dir).mode & 0o777, 0o700);
});

test("an answer writes the answer file of every request of the folder, and is accepted when a pi says it took it", async () => {
	const dir = dirOf(), a = put(dir, 1), b = put(dir, 2), c = put(dir, 3, { cwd: "/work/other" });
	const s = serve(dir), stops = [pi(dir, a), pi(dir, b)];
	const r = await s.answer({ id: a.id, digest: a.digest, choice: "once", answerId: ANSWER });
	stops.forEach((stop) => stop());
	assert.deepEqual([r.status, r.body], [200, { outcome: "accepted" }]);
	assert.ok(existsSync(join(dir, resultFile(a.id))) && existsSync(join(dir, resultFile(b.id))), "both took it");
	assert.ok(!existsSync(join(dir, answerFile(c.id))), "another folder's request is untouched");
	const written = JSON.parse(readFileSync(join(dir, resultFile(b.id)), "utf8")) as TrustResult;
	assert.deepEqual([written.by, written.answerId], ["remote", ANSWER]);
	assert.deepEqual((await s.answer({ id: a.id, digest: a.digest, choice: "once", answerId: ANSWER })).body, { outcome: "accepted" }, "the same answer sent again hears the outcome it had");
	assert.deepEqual((await s.answer({ id: a.id, digest: a.digest, choice: "no", answerId: "b".repeat(20) })).body, { error: "busy", reason: "Another answer for this question is on its way.", outcome: "busy" }, "a second answer is busy");
});

test("an answer file is written privately, by rename, with the choice as the page sent it", async () => {
	const dir = dirOf(), a = put(dir, 1);
	let seen: { mode: number; json: unknown } | undefined;
	const timer = setInterval(() => {
		if (!existsSync(join(dir, answerFile(a.id)))) return;
		seen = { mode: statSync(join(dir, answerFile(a.id))).mode & 0o777, json: JSON.parse(readFileSync(join(dir, answerFile(a.id)), "utf8")) };
		writeAtomic(dir, resultFile(a.id), { version: 1, id: a.id, by: "remote", answerId: ANSWER, at: 1 });
		clearInterval(timer);
	}, 2);
	await serve(dir).answer({ id: a.id, digest: a.digest, choice: "trust", answerId: ANSWER });
	clearInterval(timer);
	assert.deepEqual(seen!.json, { version: 1, id: a.id, digest: a.digest, choice: "trust", answerId: ANSWER });
	if (process.platform !== "win32") assert.equal(seen!.mode, 0o600);
	assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".tmp")), []);
});

test("stale when the terminal or the end of the pi came first, unknown when no result comes; a changed digest or an unknown id is 409 stale, a bad body 400", async () => {
	const dir = dirOf(), a = put(dir, 1), s = serve(dir);
	const stop = pi(dir, a, "terminal");
	assert.deepEqual((await s.answer({ id: a.id, digest: a.digest, choice: "trust", answerId: ANSWER })).body, { outcome: "stale", by: "terminal" });
	stop();
	const dir1 = dirOf(), slow = put(dir1, 1);
	assert.deepEqual((await serve(dir1).answer({ id: slow.id, digest: slow.digest, choice: "trust", answerId: ANSWER })).body, { outcome: "unknown" }, "a pi that is slow: its result still closes the alert");
	const dir2 = dirOf(), b = put(dir2, 1), s2 = serve(dir2);
	const wrong = await s2.answer({ id: b.id, digest: "f".repeat(64), choice: "trust", answerId: "c".repeat(20) });
	assert.deepEqual([wrong.status, (wrong.body as { error: string }).error], [409, "stale"]);
	assert.equal((await s2.answer({ id: id(99), digest: b.digest, choice: "trust", answerId: "d".repeat(20) })).status, 409);
	for (const bad of [{ id: "../x", digest: b.digest, choice: "trust", answerId: ANSWER }, { id: b.id, digest: "short", choice: "trust", answerId: ANSWER }, { id: b.id, digest: b.digest, choice: "always", answerId: ANSWER }, { id: b.id, digest: b.digest, choice: "trust", answerId: "x" }, {}]) {
		assert.equal((await s2.answer(bad)).status, 400, JSON.stringify(bad));
	}
	assert.ok(!readdirSync(dir2).some((f) => f.includes("answer") && f.startsWith("..")), "no path from the page reaches a file name");
});

test("an answer for a request whose pane Herdr no longer lists, or on another Herdr, is stale and writes nothing", async () => {
	const dir = dirOf(), a = put(dir, 1), other = put(dir, 2, { herdr: "/other.sock" });
	const s = serve(dir);
	assert.equal((await s.answer({ id: other.id, digest: other.digest, choice: "trust", answerId: ANSWER })).status, 409);
	const gone = serve(dir, { world: async () => ({ panes: [], workspaces }) });
	assert.equal((await gone.answer({ id: a.id, digest: a.digest, choice: "trust", answerId: "e".repeat(20) })).status, 409);
	assert.ok(!readdirSync(dir).some((f) => f.endsWith(".answer.json")));
});

test("the opening that waits on a pane is named in its entry", () => {
	const dir = dirOf();
	put(dir, 1);
	assert.equal(serve(dir, { opening: (pane) => (pane === "p1" ? "deploy-1234" : undefined) }).asks(panes, workspaces)[0]!.opening, "deploy-1234");
});

// The route.
const HOST = "box.tail1.ts.net:8443", LOGIN = "me@example.com";
async function start(over = {}) {
	const dir = dirOf(), s = serve(dir, over), gui = await startGui({ read: async () => ({ bases: [] }), dir: join(scratch, "bundle"), pollMs: 50, trust: { answer: s.answer, watch: s.watch } });
	running.push(gui);
	return { gui, dir };
}
function send(port: number, path: string, headers: Record<string, string>, payload: unknown, method = "POST") {
	const data = JSON.stringify(payload);
	return new Promise<{ status: number; headers: Record<string, unknown>; body: Record<string, unknown> }>((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port, path, method, headers: { ...headers, ...(method === "POST" ? { "content-length": String(Buffer.byteLength(data)) } : {}) }, agent: false }, (res) => {
			let text = "";
			res.on("data", (c) => (text += c)).on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: /^application\/json/.test(String(res.headers["content-type"])) ? JSON.parse(text) : {} }));
		});
		req.on("error", reject).end(method === "POST" ? data : undefined);
	});
}
const local = (gui: Gui, body: unknown, over: Record<string, string> = {}) => send(gui.port, `/${gui.token}/api/trust/answer`, { host: `127.0.0.1:${gui.port}`, origin: `http://127.0.0.1:${gui.port}`, "sec-fetch-site": "same-origin", "content-type": "application/json", "x-sb-csrf": gui.csrf, ...over }, body);

test("the route: this computer's page answers; CSRF, origin, and content type are checked as for every write; a bad body is 400", async () => {
	const { gui, dir } = await start(), a = put(dir, 1);
	const body = { id: a.id, digest: a.digest, choice: "trust", answerId: ANSWER };
	assert.equal((await local(gui, body, { "x-sb-csrf": "nope" })).status, 403);
	assert.equal((await local(gui, body, { origin: "http://evil.example" })).status, 403);
	assert.equal((await local(gui, body, { "sec-fetch-site": "cross-site" })).status, 403);
	assert.equal((await local(gui, body, { "content-type": "text/plain" })).status, 415);
	assert.equal((await local(gui, { ...body, choice: "?" })).status, 400);
	assert.ok(!readdirSync(dir).some((f) => f.endsWith(".answer.json")), "a refused answer writes nothing");
	const stop = pi(dir, a);
	const r = await local(gui, body);
	stop();
	assert.deepEqual([r.status, r.body], [200, { outcome: "accepted" }]);
});

test("the route: a paired device answers; a device that is not paired is refused on the remote listener and nothing is written", async () => {
	const { gui, dir } = await start(), a = put(dir, 1);
	const tailnet = { host: HOST, "tailscale-user-login": LOGIN, "x-forwarded-for": "100.87.7.97" };
	gui.access.enable({ host: HOST, login: LOGIN });
	const path = `/${gui.token}/api/trust/answer`, body = { id: a.id, digest: a.digest, choice: "once", answerId: ANSWER };
	const headers = { ...tailnet, origin: `https://${HOST}`, "content-type": "application/json", "x-sb-csrf": gui.csrf };
	const stranger = await send(gui.remotePort, path, headers, body);
	assert.ok([401, 403].includes(stranger.status), `refused (${stranger.status})`);
	const forged = await send(gui.remotePort, path, { ...headers, cookie: "sb_remote=forged" }, body);
	assert.ok([401, 403].includes(forged.status), `a cookie that is not a paired device's is refused (${forged.status})`);
	assert.ok(!readdirSync(dir).some((f) => f.endsWith(".answer.json")), "nothing was written");
	const first = await send(gui.remotePort, `/${gui.token}/pair/${gui.access.pair()}`, tailnet, {}, "GET");
	const cookie = String(first.headers["set-cookie"]).split(";")[0]!;
	const stop = pi(dir, a);
	const ok = await send(gui.remotePort, path, { ...headers, cookie }, body);
	stop();
	assert.deepEqual([ok.status, ok.body], [200, { outcome: "accepted" }]);
});

test("the route is absent from a server started without trust support", async () => {
	const gui = await startGui({ read: async () => ({ bases: [] }), dir: join(scratch, "bundle"), pollMs: 50 });
	running.push(gui);
	assert.equal((await local(gui, { id: id(1) })).status, 503);
});

test("the snapshot carries `trust` only while a question is open, and every server writes `trust: 1` into gui.json", async () => {
	const dir = dirOf(), s = serve(dir);
	const read = () => collectNet({ run: async () => "{}", world: async () => ({ panes, workspaces, tabs: [] }), sessions: async () => [], trust: s });
	assert.equal("trust" in (await read()), false, "no question: the snapshot is as it was");
	put(dir, 1);
	assert.deepEqual((await read()).trust?.map((t) => [t.folder, t.agents.length]), [["/work/demo", 1]]);
	const state = join(scratch, "record");
	mkdirSync(state, { recursive: true });
	writeRecord(state, { port: 1, remotePort: 2, token: "t", csrf: "c" } as Gui, ["owner", "session"], "0.44.0", HERDR);
	assert.equal(readRecord(state)?.trust, 1);
});
