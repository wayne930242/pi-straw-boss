import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { get, request, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { forRemote } from "../src/ask.ts";
import type { Hub, Target } from "../src/dialogs.ts";
import { startGui, type Gui } from "../src/gui.ts";
import type { Found, Net } from "../src/net.ts";
import { secretDigest } from "../src/owners.ts";

// A secret_drop's masked dialog on the server: this computer's page may answer it, a paired remote device never gets it to answer (its stream
// holds a plain read-only wait) and a request from one that carries a value is refused before anything is looked up or relayed.

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
const answer = { dialog: "s1", digest: secretDigest(SECRET), secret: SECRET };
const unit = (key: string, pending?: Net["bases"][number]["outside"][number]["pending"]) => ({ id: key, key, control: true, name: key, role: "main" as const, mark: "waiting" as const, subs: [], pending });
const net = (): Net => ({ bases: [{ id: "wA", label: "Alpha", mark: "waiting", head: true, tower: null, outposts: [], outside: [], tabs: [{ id: "wA:t1", label: "work", units: [unit("sess-1", { callId: "c1", tool: "secret_drop", answer }), unit("sess-2", { callId: "c2", tool: "robot_hand", answer: { dialog: "d2", digest: "a".repeat(64), select: { title: "T", choices: [{ label: "A" }] } } })] }] }] });

async function server() {
	const sent: Record<string, unknown>[] = [], targets: Record<string, Target> = { "sess-1": { from: "S", bridgeId: "B", answer } };
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
const fetchRaw = (gui: Gui, path: string, headers: Record<string, string>, method = "GET", body?: unknown) =>
	new Promise<{ status: number; headers: IncomingHttpHeaders; text: string }>((resolve, reject) => {
		const data = body === undefined ? undefined : JSON.stringify(body);
		const req = request({ host: "127.0.0.1", port: gui.port, path, method, headers: { ...headers, ...(data ? { "content-length": String(Buffer.byteLength(data)) } : {}) }, agent: false }, (res) => {
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
		const req = get({ host: "127.0.0.1", port: gui.port, path: `/${gui.token}/events`, headers, agent: false }, (res) => {
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

test("forRemote turns every answerable secret into a plain secret_drop wait and leaves other dialogs and a net without one as they are", () => {
	const plain = net();
	plain.bases[0]!.tabs[0]!.units.shift();
	assert.equal(forRemote(plain), plain, "the same net when there is no secret");
	const original = net(), out = forRemote(original);
	assert.deepEqual(out.bases[0]!.tabs[0]!.units[0]!.pending, { callId: "c1", tool: "secret_drop", why: "Entering a secret is not supported from a remote page; answer it in the terminal." });
	assert.deepEqual(out.bases[0]!.tabs[0]!.units[1], original.bases[0]!.tabs[0]!.units[1], "a selector stays answerable");
	assert.deepEqual(original.bases[0]!.tabs[0]!.units[0]!.pending!.answer!.secret, SECRET, "the input is not changed");
	const tower = net();
	tower.bases[0]!.tower = { name: "t", mark: "waiting", key: "t", control: true, pending: { callId: "c", tool: "secret_drop", answer } };
	tower.bases[0]!.outside = [{ ...unit("o"), subs: [unit("o/s", { callId: "c", tool: "secret_drop", answer })] }];
	const cut = forRemote(tower);
	assert.equal(JSON.stringify(cut).includes("Deploy token"), false, "a tower's, an outside unit's, and a subagent's too");
});

test("the local stream carries the secret dialog; a paired device's stream carries a read-only wait and none of its content", async () => {
	const { gui } = await server();
	const mine = await snapshot(gui, local(gui)), theirs = await snapshot(gui, { ...tailnet, cookie: await pair(gui) });
	assert.deepEqual(unitsOf(mine)[0]!.pending, { callId: "c1", tool: "secret_drop", answer });
	const remote = unitsOf(theirs);
	assert.deepEqual([remote[0]!.pending!.answer, remote[0]!.pending!.tool, remote[0]!.pending!.why], [undefined, "secret_drop", "Entering a secret is not supported from a remote page; answer it in the terminal."]);
	assert.equal(remote[1]!.pending!.answer!.dialog, "d2", "its other dialogs stay answerable");
	for (const word of ["Deploy token", "Create a token", "example.com", ".env.local", SECRET.destination, answer.digest]) assert.equal(theirs.includes(word), false, `the remote stream has no ${word}`);
});

test("an answer with a value from a paired device is refused before anything is looked up or relayed; so is any answer to a secret dialog from one", async () => {
	const { gui, sent } = await server(), value = "tok-remote-do-not-accept";
	const path = `/${gui.token}/api/sessions/sess-1/answer`, headers = await remoteHeaders(gui);
	const withValue = await fetchRaw(gui, path, headers, "POST", { dialog: "s1", digest: answer.digest, answerId: "r".repeat(20), value });
	assert.deepEqual([withValue.status, JSON.parse(withValue.text).error], [403, "local_only"]);
	const without = await fetchRaw(gui, path, headers, "POST", { dialog: "s1", digest: answer.digest, answerId: "q".repeat(20) });
	assert.deepEqual([without.status, JSON.parse(without.text).error], [403, "local_only"], "a secret dialog takes nothing from a remote page");
	const sessionTwo = await fetchRaw(gui, `/${gui.token}/api/sessions/sess-2/answer`, headers, "POST", { dialog: "d2", digest: "a".repeat(64), answerId: "p".repeat(20), choice: 0, value });
	assert.equal(sessionTwo.status, 403, "a value is never taken from a remote page, whichever dialog it names");
	assert.deepEqual(sent, [], "nothing was relayed");
	for (const r of [withValue, without, sessionTwo]) assert.equal(r.text.includes(value), false);
});

test("this computer's page answers a secret dialog: the value goes to the bridge once, and no response quotes it", async () => {
	const { gui, sent } = await server(), value = "tok-local-ok-9921";
	const r = await fetchRaw(gui, `/${gui.token}/api/sessions/sess-1/answer`, localHeaders(gui), "POST", { dialog: "s1", digest: answer.digest, answerId: "l".repeat(20), value });
	assert.deepEqual([r.status, JSON.parse(r.text)], [200, { outcome: "accepted" }]);
	assert.deepEqual(sent, [{ id: "s1", answerId: "l".repeat(20), digest: answer.digest, value }]);
	for (const bad of [{}, { value: "" }, { value: "  " }, { value: 5 }, { choice: 0 }, { value: `${value}\u0001` }, { value: "x".repeat(8193) }]) {
		const refused = await fetchRaw(gui, `/${gui.token}/api/sessions/sess-1/answer`, localHeaders(gui), "POST", { dialog: "s1", digest: answer.digest, answerId: "m".repeat(20), ...bad });
		assert.deepEqual([refused.status, JSON.parse(refused.text).error], [400, "bad_answer"], JSON.stringify(bad).slice(0, 30));
		assert.equal(refused.text.includes(value), false);
	}
	assert.equal(sent.length, 1, "refused values never reach the bridge");
});
