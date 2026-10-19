import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { get, request, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Hub, Target } from "../src/dialogs.ts";
import { startGui, type Gui } from "../src/gui.ts";
import type { Found, Net } from "../src/net.ts";
import { secretDigest } from "../src/owners.ts";

// A secret_drop on the server (SB-F001): no page, this computer's or a paired device's, may answer it. Both streams hold the same plain read-only wait,
// and a request that carries a value is refused before anything is looked up or relayed.

const scratch = mkdtempSync(join(tmpdir(), "psb-secret-test-"));
mkdirSync(join(scratch, "bundle"));
writeFileSync(join(scratch, "bundle", "index.html"), "<!doctype html><html><head></head><body></body></html>");
const running: Gui[] = [];
after(async () => {
	await Promise.all(running.map((g) => g.stop()));
	rmSync(scratch, { recursive: true, force: true });
});

const FILE = "/s/2026_sess-1.jsonl", HOST = "box.tail1.ts.net:8443", LOGIN = "me@example.com";
const SECRET = { label: "Deploy token", instructions: ["Open the link.", "Create a token."], url: "https://example.com/tokens", destination: ".env.local" };
const digest = secretDigest(SECRET);
const unit = (key: string, pending?: Net["bases"][number]["outside"][number]["pending"]) => ({ id: key, key, control: true, name: key, role: "main" as const, mark: "waiting" as const, subs: [], pending });
const net = (): Net => ({ bases: [{ id: "wA", label: "Alpha", mark: "waiting", head: true, tower: null, outposts: [], outside: [], tabs: [{ id: "wA:t1", label: "work", units: [unit("sess-1", { callId: "c1", tool: "secret_drop", why: "It waits for a secret." }), unit("sess-2", { callId: "c2", tool: "robot_hand", answer: { dialog: "d2", digest: "a".repeat(64), select: { title: "T", choices: [{ label: "A" }] } } })] }] }] });

async function server() {
	const sent: Record<string, unknown>[] = [], targets: Record<string, Target> = {};
	const hub = {
		running: true, me: "G", start() {}, stop() {}, receive() {}, relayed: () => ({ dialogsOf: () => undefined, merge: () => ({ callId: "", tool: "" }) }),
		replay: () => undefined, ended: () => undefined, target: (key: string) => targets[key], commands: async () => [], probe: async () => undefined,
		send: async (_key: string, _t: Target, a: Record<string, unknown>) => (sent.push(a), { status: 200, body: { outcome: "accepted" } }),
	};
	const lookup = (key: string): Found | undefined => (key.startsWith("sess-") ? { key, base: "wA", name: key, role: "main", file: FILE, pane: "wA:p1", live: true } : undefined);
	const call = async (method: string) => (method === "pane.get" ? { pane: { pane_id: "wA:p1", agent: "pi", agent_status: "blocked", agent_session: { value: FILE } } } : {});
	const gui = await startGui({ read: async () => net(), net: { lookup, workspace: () => [] }, call, hub: hub as unknown as Hub, dir: join(scratch, "bundle"), pollMs: 30 });
	running.push(gui);
	gui.access.enable({ host: HOST, login: LOGIN });
	return { gui, sent };
}
const tailnet = { host: HOST, "tailscale-user-login": LOGIN, "x-forwarded-for": "100.87.7.97" };
/** A paired device's requests reach the remote listener, this computer's the local one: the Host header says which, as it would behind `tailscale serve`. */
const portOf = (gui: Gui, headers: Record<string, string>) => (headers.host === `127.0.0.1:${gui.port}` ? gui.port : gui.remotePort);
const fetchRawOn = (port: number, path: string, headers: Record<string, string>, body: unknown) =>
	new Promise<number>((resolve, reject) => {
		const data = JSON.stringify(body), req = request({ host: "127.0.0.1", port, path, method: "POST", headers: { ...headers, "content-length": String(Buffer.byteLength(data)) }, agent: false }, (res) => (res.resume(), resolve(res.statusCode!)));
		req.on("error", reject).end(data);
	});
const fetchRaw = (gui: Gui, path: string, headers: Record<string, string>, method = "GET", body?: unknown) =>
	new Promise<{ status: number; headers: IncomingHttpHeaders; text: string }>((resolve, reject) => {
		const data = body === undefined ? undefined : JSON.stringify(body);
		const req = request({ host: "127.0.0.1", port: portOf(gui, headers), path, method, headers: { ...headers, ...(data ? { "content-length": String(Buffer.byteLength(data)) } : {}) }, agent: false }, (res) => {
			let text = "";
			res.on("data", (c) => (text += c)).on("end", () => resolve({ status: res.statusCode!, headers: res.headers, text }));
		});
		req.on("error", reject).end(data);
	});
/** A paired device's cookie. */
const pair = async (gui: Gui) => String((await fetchRaw(gui, `/${gui.token}/pair/${gui.access.pair()}`, tailnet)).headers["set-cookie"]).split(";")[0]!;
/** The first snapshot of a stream, as the page would read it. */
const snapshot = (gui: Gui, headers: Record<string, string>) =>
	new Promise<string>((resolve, reject) => {
		const req = get({ host: "127.0.0.1", port: portOf(gui, headers), path: `/${gui.token}/events`, headers, agent: false }, (res) => {
			let buffer = "";
			res.setEncoding("utf8").on("data", (chunk: string) => {
				buffer += chunk;
				const block = buffer.split("\n\n").slice(0, -1).find((b) => !b.startsWith("event: "));
				if (block) (req.destroy(), resolve(block.slice(6)));
			});
		});
		req.on("error", reject);
	});
const local = (gui: Gui) => ({ host: `127.0.0.1:${gui.port}` });
const remoteHeaders = async (gui: Gui) => ({ ...tailnet, cookie: await pair(gui), origin: `https://${HOST}`, "content-type": "application/json", "x-sb-csrf": gui.csrf });
const localHeaders = (gui: Gui) => ({ host: `127.0.0.1:${gui.port}`, origin: `http://127.0.0.1:${gui.port}`, "sec-fetch-site": "same-origin", "content-type": "application/json", "x-sb-csrf": gui.csrf });
const unitsOf = (json: string) => (JSON.parse(json) as Net).bases.flatMap((b) => b.tabs.flatMap((t) => t.units));

test("the local stream and a paired device's stream both carry the secret_drop as a plain read-only wait, with nothing of what it asks for", async () => {
	const { gui } = await server();
	const mine = await snapshot(gui, local(gui)), theirs = await snapshot(gui, { ...tailnet, cookie: await pair(gui) });
	for (const json of [mine, theirs]) {
		const units = unitsOf(json);
		assert.deepEqual(units[0]!.pending, { callId: "c1", tool: "secret_drop", why: "It waits for a secret." });
		assert.equal(units[1]!.pending!.answer!.dialog, "d2", "its other dialogs stay answerable");
		for (const word of ["Deploy token", "Create a token", "example.com", ".env.local", digest]) assert.equal(json.includes(word), false, `the stream has no ${word}`);
	}
});

test("a request with a value is refused from a paired device (403) and from this computer's page (400) before anything is looked up or relayed", async () => {
	const { gui, sent } = await server(), value = "tok-do-not-accept";
	const path = (n: number) => `/${gui.token}/api/sessions/sess-${n}/answer`, remote = await remoteHeaders(gui), mine = localHeaders(gui);
	const results = [];
	for (const [headers, expected] of [[remote, [403, "local_only"]], [mine, [400, "terminal_only"]]] as const) {
		for (const [n, body] of [[1, { dialog: "s1", digest, answerId: "r".repeat(20), value }], [1, { dialog: "s1", digest, answerId: "q".repeat(20), value: "" }], [2, { dialog: "d2", digest: "a".repeat(64), answerId: "p".repeat(20), choice: 0, value }]] as const) {
			const r = await fetchRaw(gui, path(n), headers, "POST", body);
			results.push(r);
			assert.deepEqual([r.status, JSON.parse(r.text).error], expected, JSON.stringify(body).slice(0, 40));
		}
	}
	assert.deepEqual(sent, [], "nothing reached any bridge");
	for (const r of results) assert.equal(r.text.includes(value), false);
});

test("an answer to the secret_drop's dialog without a value finds no dialog to answer, from either page", async () => {
	const { gui, sent } = await server();
	for (const headers of [await remoteHeaders(gui), localHeaders(gui)]) {
		const r = await fetchRaw(gui, `/${gui.token}/api/sessions/sess-1/answer`, headers, "POST", { dialog: "s1", digest, answerId: "u".repeat(20) });
		assert.deepEqual([r.status, JSON.parse(r.text).error], [409, "changed"]);
	}
	assert.deepEqual(sent, []);
});
