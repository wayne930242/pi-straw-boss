import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { get, request } from "node:http";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { readRecord as readGuiJson } from "../src/handover.ts";
import { buildEnvelope } from "../src/link/envelope.ts";
import { encodePlaintext } from "../src/link/kinds.ts";
import { OPERATE_LIMITS } from "../src/link/operate.ts";
import { LinkStore } from "../src/link/store.ts";
import { addEntry, removeEntry, roleEntry } from "../src/link/roster.ts";
import type { Net } from "../src/net.ts";
import { addRoute } from "../src/server/allyroute.ts";
import { callControl } from "../src/server/socket.ts";
import { FakeRelay } from "./link/fake-relay.ts";
import { World } from "./fakes.ts";
import { alice, bob, clientFor, rosterOf, stateOf, TEAM_HEX, writeDevice, writeTeam } from "./link/holder-world.ts";
import { det, DEVICES, LABELS, TEAM, teamKey, view } from "./link/scenario.ts";
import { assistant, header, lines, text, user } from "./sessions.ts";
import { timerSpy } from "./timer-spy.ts";
import { ServerWorld, sleep, until } from "./server-world.ts";

// Operate end to end in the running sb server (todo #121 wiring, docs/specs/2026-11-07-link-operate.md §11.3 and §11.4): two real servers in one test world over the fake relay, a Mac (attended, bob's device) and a box (unattended, dave's device
// whose policy lets bob operate). The Mac's page is a real HTTP client of the Mac's GUI: it sees the box's session as a remote base, watches a box unit's history, reads the box's finished runs, and drives a pad key; a roster change on the box,
// the Mac leaving the team, and either server stopping each close the session.

const { dave } = DEVICES;
const WS = "wA", TAB = "wA:t1", PANE = "wA:p1", SESSION = "box-main";
/** How long a step may take on a loaded machine; a mutation check shortens it (SB_WIRING_WAIT) so a dropped wire fails fast. */
const WAIT = Number(process.env.SB_WIRING_WAIT) || 20_000;

interface Page { events: { event: string; data: string }[]; nets(): Net[]; close(): void }
const GUI = (sw: ServerWorld) => { const g = sw.record()!.gui!, json = readGuiJson(sw.slot.dir); return { port: g.port, token: g.token, url: `http://127.0.0.1:${g.port}/${g.token}/`, csrf: json!.csrf }; };
type Gui = ReturnType<typeof GUI>;
function listen(gui: Gui, watch?: string): Page {
	const events: { event: string; data: string }[] = [];
	const req = get(`${gui.url}events${watch ? `?watch=${encodeURIComponent(watch)}` : ""}`, { headers: { host: `127.0.0.1:${gui.port}` } }, (res) => {
		res.setEncoding("utf8");
		let buffer = "";
		res.on("data", (chunk: string) => {
			buffer += chunk;
			for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
				const part = buffer.slice(0, end).split("\n");
				buffer = buffer.slice(end + 2);
				events.push({ event: part.find((l) => l.startsWith("event: "))?.slice(7) ?? "message", data: part.find((l) => l.startsWith("data: "))?.slice(6) ?? "" });
			}
		});
	});
	req.on("error", () => {});
	return { events, close: () => req.destroy(), nets: () => events.filter((e) => e.event === "message" && e.data).map((e) => JSON.parse(e.data) as Net) };
}
const fetchJson = (gui: Gui, path: string) => new Promise<{ status: number; body: any }>((resolve, reject) => get(`${gui.url}${path}`, { headers: { host: `127.0.0.1:${gui.port}` } }, (res) => {
	const parts: Buffer[] = [];
	res.on("data", (c: Buffer) => parts.push(c)).on("end", () => { const raw = Buffer.concat(parts).toString(); resolve({ status: res.statusCode!, body: raw ? JSON.parse(raw) : undefined }); });
}).on("error", reject));
const postJson = (gui: Gui, path: string, json: unknown) => new Promise<{ status: number; body: any }>((resolve, reject) => {
	const req = request(`${gui.url}${path}`, { method: "POST", headers: { host: `127.0.0.1:${gui.port}`, origin: `http://127.0.0.1:${gui.port}`, "content-type": "application/json", "x-sb-csrf": gui.csrf } }, (res) => {
		let raw = "";
		res.on("data", (c) => (raw += c)).on("end", () => resolve({ status: res.statusCode!, body: raw ? JSON.parse(raw) : undefined }));
	});
	req.on("error", reject).end(JSON.stringify(json));
});

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

/** The two computers. `grant`: the box's operate grant for bob. */
async function boot(o: { grant?: "team" | "box" | "none"; late?: boolean } = {}) {
	const relay = new FakeRelay(), macWorld = new ServerWorld(), boxWorld = new ServerWorld(), boxHerdr = new World(), macHerdr = new World();
	cleanups.push(async () => { await Promise.allSettled([macWorld.close(), boxWorld.close()]); await Promise.allSettled([boxHerdr.stopAll(), macHerdr.stopAll()]); });
	const entries = rosterOf();
	entries.push(addEntry({ state: view(entries), signer: alice, record: dave, label: LABELS.dave, attended: false, ...det("add-dave") }));
	entries.push(roleEntry({ state: stateOf(entries, alice), signer: alice, subjectId: bob.id, role: "admin" }));
	relay.addTeam(TEAM, [alice.id, bob.id, dave.id], entries);
	const link = (world: ServerWorld, policy: Record<string, unknown>) => ({ tickMs: 15, drainMs: 20, presenceMs: 40, capsMs: 3_600_000, capsMinMs: 5, operateNetMs: 100, relay: clientFor(relay), home: join(world.root, "home"), policy });

	// The box: a team project, a main there that bob dispatched (the box's records and the pane's token say so), a session file in pi's folder, and a policy that grants bob operate.
	const project = join(boxWorld.root, "home", "project");
	mkdirSync(project, { recursive: true });
	const real = realpathSync(project), boxStore = new LinkStore(join(boxWorld.stateDir, "link"));
	writeDevice(boxStore, dave, "ci-box");
	writeTeam(boxStore, entries, dave);
	const sessions = join(process.env.PI_CODING_AGENT_DIR!, "sessions");
	mkdirSync(sessions, { recursive: true });
	const file = join(sessions, `2026-11-07T00-00-00-000Z_${SESSION}.jsonl`);
	writeFileSync(file, lines([header(SESSION), user("u1", null, "please fix the build"), assistant("a1", "u1", [text("the build is fixed")])]));
	boxHerdr.herdr.addPane(PANE, TAB);
	Object.assign(boxHerdr.herdr.pane(PANE), { cwd: real, agent: "pi", agent_session: { value: realpathSync(file) }, tokens: { sb_role: "main", sb_opened_by: `link:${bob.id}` } });
	addRoute(boxWorld.slot, WS, { to: SESSION, device: bob.id, team: TEAM_HEX, kind: "opened", at: Date.now(), name: SESSION, label: "x", short: "x", teamName: "x", pane: PANE }, Date.now());
	const policyOf = (grant: "team" | "box" | "none") => JSON.stringify({ unattended: true, trust: { [bob.id]: "dispatch" }, teams: { [TEAM_HEX]: { project: real, share: "status" } }, ...(grant === "none" ? {} : { operate: { [bob.id]: grant } }) });
	let policy = policyOf(o.grant ?? "box");
	const boxLink = link(boxWorld, { path: "/etc/straw-link/policy.json", uid: 501, stat: () => ({ uid: 0, symlink: false }), writable: () => false, read: () => policy });
	const boxCall = async (method: string) => {
		if (method === "pane.get") return { pane: { pane_id: PANE, terminal_id: "term_1", agent: "pi", agent_status: "idle", agent_session: { value: realpathSync(file) } } };
		if (method === "pane.list") return { panes: [{ pane_id: PANE, tab_id: TAB }] };
		if (method === "pane.read") return { read: { text: "pi\r\n> \r\n" } };
		if (method === "pane.layout") return { layout: { panes: [{ pane_id: PANE, rect: { width: 80, height: 24 } }] } };
		if (method === "pane.process_info") return { process_info: { shell_pid: 10, foreground_processes: [{ pid: 11, name: "pi", argv0: "pi" }] } };
		return {};
	};
	const box = await boxWorld.start({ link: boxLink, herdr: { run: boxHerdr.herdr.runFor(""), call: boxCall as never } });
	box.client.sessions = [{ id: SESSION, name: "box main", herdrLocation: { status: "current", paneId: PANE, tab: { id: TAB, label: "work" }, workspace: { id: WS, label: "Alpha" } } }] as never;

	// The Mac: bob's device, attended (no policy file), with the team in its config.
	const macProject = join(macWorld.root, "home", "project");
	mkdirSync(macProject, { recursive: true });
	const macStore = new LinkStore(join(macWorld.stateDir, "link"));
	writeDevice(macStore, bob, "bob-mac");
	writeTeam(macStore, entries, bob);
	writeFileSync(join(macWorld.stateDir, "config.json"), JSON.stringify({ towerRuns: { enabled: false }, link: { relay: "http://relay.test", teams: { [TEAM_HEX]: { project: realpathSync(macProject), share: "status" } } } }));
	const none = { path: "/etc/straw-link/policy.json", read: () => { throw Object.assign(new Error("no policy file"), { code: "ENOENT" }); } };
	// `late`: another candidate of a newer build holds the Mac's election record, so the server is no holder until `release()` (RR-F002: the holder comes after the page is connected).
	let blocked = Boolean(o.late);
	if (o.late) await macStore.withLock(() => macStore.writeHolder({ session: "blocker", version: "99.0.0", pid: process.pid, tower: false, since: Date.now() }));
	const release = () => void (blocked = false);
	const mac = await macWorld.start({ link: { ...link(macWorld, none), alive: (r: { session: string }) => r.session !== "blocker" || blocked }, herdr: { run: macHerdr.herdr.runFor("") } });
	await Promise.all([box.handle.ready, mac.handle.ready]);
	// Each device has told the other its caps (they go to the streams open when they are sent, and the second to start sends its own after the first's reached it): the box checks the Mac's before it answers an open.
	const capsFrom = (id: string) => relay.stored.some((x) => x.envelope.header.kind === "caps" && x.envelope.header.from === id);
	await until(() => capsFrom(dave.id) && (o.late || capsFrom(bob.id)), "both devices' caps", WAIT);
	/** The box's policy as the file reads from now on (the holder reads it at each tick). */
	const setGrant = (grant: "team" | "box" | "none") => void (policy = policyOf(grant));
	await sleep(150);
	// A server that stops and starts again at once (a pi-straw-boss update, `/boss server restart`): the same state folders, link folders and policy, a new holder with an empty memory of its peers' caps. The real relay replays a `caps` only past
	// the cursor a restarted holder resumes from, and any queued envelope after the peer's last `caps` (a dispatch, a tower's reply) has moved it there: the stored cursor is set past everything the relay holds, as that leaves it.
	const restartBox = async () => { writeTeam(boxStore, entries, dave, { lastEventId: 1_000_000 }); const again = await boxWorld.start({ link: boxLink, herdr: { run: boxHerdr.herdr.runFor(""), call: boxCall as never } }); again.client.sessions = box.client.sessions; await again.handle.ready; return again; };
	const restartMac = async () => { writeTeam(macStore, entries, bob, { lastEventId: 1_000_000 }); const again = await macWorld.start({ link: link(macWorld, none), herdr: { run: macHerdr.herdr.runFor("") } }); await again.handle.ready; return again; };
	return { release, relay, entries, macWorld, boxWorld, boxHerdr, mac, box, file, restartBox, restartMac, setGrant, boxLog: () => logOf(boxWorld), macLog: () => logOf(macWorld), gui: () => GUI(macWorld) };
}
const logOf = (w: ServerWorld) => { const f = join(w.stateDir, "link", "link.log"); return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : []; };
const boxBase = (net: Net) => net.bases.find((b) => b.box);
const latest = (page: Page) => page.nets().at(-1);

test("the Mac's page sees the box's session as a remote base, watches a box unit, and reads the box's finished runs", async () => {
	const w = await boot();
	const gui = w.gui(), page = listen(gui);
	cleanups.push(() => page.close());
	await until(() => page.nets().some((n) => boxBase(n)?.box?.state === "live"), "the box's base in the Mac's net", WAIT);
	const net = page.nets().findLast((n) => boxBase(n)?.box?.state === "live")!, base = boxBase(net)!;
	assert.deepEqual([base.box!.device, base.box!.label, base.box!.team, base.box!.scope], [dave.id, "ci-box", "project", "box"]);
	const unit = base.tabs.flatMap((t) => t.units).find((u) => u.name === "box main")!;
	assert.ok(unit, "the box's main is a unit of the base");
	assert.match(unit.key, /^x[0-9a-f]{16}$/);
	// A watch: the page loaded at the unit's address gets the box's history.
	const watching = listen(gui, unit.key);
	cleanups.push(() => watching.close());
	await until(() => watching.events.some((e) => e.event === "history" && e.data.includes("please fix the build")), "the box's history on the watch", WAIT);
	// The box's finished runs: while the main is live it is the live unit, not an earlier run; the unit then leaves the box (its pane closes), the ledger ends it, the list names it, and its transcript is read through the key the list gave.
	const live = await fetchJson(gui, `api/transcripts?base=${base.id}`);
	assert.equal(live.status, 200, JSON.stringify(live.body));
	assert.deepEqual(live.body.rows, [], "a run the box sees live is no earlier run");
	// The box has another main of its own, so the base stays when this one leaves.
	const herdr = boxHerdr(w), session = (id: string, name: string, paneId: string) => ({ id, name, herdrLocation: { status: "current", paneId, tab: { id: TAB, label: "work" }, workspace: { id: WS, label: "Alpha" } } });
	herdr.addPane("wA:p2", TAB);
	Object.assign(herdr.pane("wA:p2"), { agent: "pi", tokens: { sb_role: "main" } });
	w.box.client.sessions = [session(SESSION, "box main", PANE), session("box-other", "other main", "wA:p2")] as never;
	await until(() => boxBase(page.nets().at(-1)!)?.tabs.some((t) => t.units.some((u) => u.name === "other main")), "the box's other main in the Mac's net", WAIT);
	herdr.panes.splice(herdr.panes.findIndex((p) => p.pane_id === PANE), 1);
	w.box.client.sessions = [session("box-other", "other main", "wA:p2")] as never;
	await until(() => boxBase(page.nets().at(-1)!)?.tabs.some((t) => t.units.length && !t.units.some((u) => u.name === "box main")), "the main gone from the Mac's net", WAIT);
	let listed = await fetchJson(gui, `api/transcripts?base=${base.id}`);
	for (let i = 0; i < 100 && !listed.body.rows?.length; i++) (await sleep(100), (listed = await fetchJson(gui, `api/transcripts?base=${base.id}`)));
	assert.equal(listed.status, 200, JSON.stringify(listed.body));
	assert.deepEqual(listed.body.rows.map((r: { name: string; role: string }) => [r.name, r.role]), [["box main", "main"]]);
	const run = listed.body.rows[0];
	assert.match(run.key, /^x[0-9a-f]{16}$/);
	assert.ok(!JSON.stringify(listed.body).includes(SESSION), "the box's own id is not passed on as a key of the page");
	const old = await fetchJson(gui, `api/history/${run.key}?limit=10`);
	assert.equal(old.status, 200, JSON.stringify(old.body));
	assert.ok(JSON.stringify(old.body).includes("the build is fixed"), "the transcript of a run that is over");
	const ledger = readFileSync(join(w.boxWorld.stateDir, "link", "operate-ledger.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { ended?: boolean; team: string });
	assert.deepEqual(ledger.map((r) => [r.team, r.ended === true]), [[TEAM_HEX, false], [TEAM_HEX, true]]);
	void postJson, OPERATE_LIMITS, callControl;
});
const boxHerdr = (w: { boxHerdr: World }) => w.boxHerdr.herdr;

/** The Mac's page and the box's base on it, live, with the page's own stream id. */
async function paged(o: Parameters<typeof boot>[0] = {}) {
	const w = await boot(o), gui = w.gui(), page = listen(gui);
	cleanups.push(() => page.close());
	await until(() => page.nets().some((n) => boxBase(n)?.box?.state === "live" && boxBase(n)!.tabs.some((t) => t.units.length)), "the box's base in the Mac's net", WAIT);
	const base = boxBase(page.nets().findLast((n) => boxBase(n)?.box?.state === "live")!)!, unit = base.tabs.flatMap((t) => t.units)[0]!;
	await until(() => page.events.some((e) => e.event === "hello"), "the page's stream id", WAIT);
	const stream = JSON.parse(page.events.find((e) => e.event === "hello")!.data).stream as string;
	return { ...w, gui, page, base, unit, stream };
}

test("a pad key goes through the Mac's page to the box's own guard: the terminal mirror is shared, and the box's answer comes back whole", async () => {
	const w = await paged();
	const mirror = await postJson(w.gui, `api/sessions/${w.unit.key}/mirror`, { stream: w.stream, on: true });
	assert.deepEqual([mirror.status, mirror.body], [200, { attached: true }]);
	await until(() => w.page.events.some((e) => e.event === "mirror" && e.data.includes(w.unit.key)), "a frame of the box's terminal on the page's stream", WAIT);
	// The Mac checks what it can (a fresh frame on this stream), the box the rest. A box with no pi bridge gets no answer about its pi's key bindings, so it refuses every key, and says so in its own words.
	const key = await postJson(w.gui, `api/sessions/${w.unit.key}/keys`, { key: "up", stream: w.stream });
	assert.deepEqual([key.status, key.body.error, key.body.why], [403, "operate_refused", "noanswer"]);
	assert.deepEqual(w.boxLog().filter((l) => l.event === "operate-refused").map((l) => [l.route, l.reason]), [["sessions/*/keys", "noanswer"]], "the request reached the box's guard and was logged there");
	// A key for a page that shows no terminal never leaves the Mac.
	const stale = await postJson(w.gui, `api/sessions/${w.unit.key}/keys`, { key: "up", stream: "no-such-stream" });
	assert.equal(stale.status, 409);
	assert.equal(w.boxLog().filter((l) => l.event === "operate-refused").length, 1);
});

test("a roster change on the box that takes bob's admin away ends the session with a close, and the Mac's base says the grant is gone", async () => {
	const w = await paged({ grant: "team" });
	w.relay.pushRoster(TEAM, roleEntry({ state: stateOf(w.entries, alice), signer: alice, subjectId: bob.id, role: "member" }));
	await until(() => w.boxLog().some((l) => l.event === "operate-close"), "the box's close", WAIT);
	assert.deepEqual(w.boxLog().filter((l) => l.event === "operate-close").map((l) => [l.by, l.reason]), [["box", "roster"]]);
	await until(() => boxBase(w.page.nets().at(-1)!)?.box?.state === "ended", "the base ended on the Mac's page", WAIT);
	const ended = boxBase(w.page.nets().at(-1)!)!.box!;
	assert.deepEqual([ended.state, ended.why], ["ended", "roster"]);
	assert.deepEqual(w.macLog().filter((l) => l.event === "operate-close").map((l) => [l.by, l.reason]), [["box", "roster"]]);
});

test("the Mac leaving the team closes its sessions at once, with no wait for the box's silence", async () => {
	const w = await paged();
	assert.equal((await operateStatus(w.macWorld)).sessions.length, 1);
	// The founder removes bob: the Mac's holder stops the team, and its roster hook closes the sessions of that team.
	w.relay.pushRoster(TEAM, removeEntry({ state: stateOf(w.entries, alice), signer: alice, subjectId: bob.id, newKey: new Uint8Array(32).fill(7), ...det("remove-bob") }));
	await until(async () => (await operateStatus(w.macWorld)).sessions.length === 0, "no session on the Mac", WAIT);
	assert.deepEqual(w.macLog().filter((l) => l.event === "operate-close").map((l) => [l.by, l.reason]), [["controller", "team-stopped"]]);
	await until(() => !boxBase(w.page.nets().at(-1)!), "the box's base off the Mac's page", WAIT);
});

test("stopping the Mac's server sends each session's close to the box while the holder still runs", async () => {
	const w = await paged();
	await w.mac.handle.shutdown(0);
	await until(() => w.boxLog().some((l) => l.event === "operate-close"), "the box's line", WAIT);
	assert.deepEqual(w.boxLog().filter((l) => l.event === "operate-close").map((l) => [l.by, l.reason]), [["operator", "stop"]]);
});

test("stopping the box's server greys the Mac's base for a reopen: it is not a revoked grant", async () => {
	const w = await paged();
	await w.box.handle.shutdown(0);
	await until(() => boxBase(w.page.nets().at(-1)!)?.box?.state === "unreachable", "the base greyed", WAIT);
	assert.equal(boxBase(w.page.nets().at(-1)!)!.box!.why, undefined);
	assert.deepEqual(w.macLog().filter((l) => l.event === "operate-close").map((l) => [l.by, l.reason]), [["box", "stopped"]]);
});

test("/boss link operate lists the session and `operate off` ends it on both computers", async () => {
	const w = await paged();
	const status = await operateStatus(w.macWorld);
	assert.deepEqual(status.sessions.map((x: Record<string, unknown>) => [x.label, x.short, x.teamName, x.scope, x.state, x.pages]), [["ci-box", dave.shortId, "project", "box", "live", 1]]);
	assert.deepEqual(await linkGui(w.macWorld, "operate-off"), { ok: true, saved: true });
	assert.deepEqual((await operateStatus(w.macWorld)).sessions, []);
	await until(() => w.boxLog().some((l) => l.event === "operate-close"), "the box's line", WAIT);
	assert.deepEqual(w.boxLog().filter((l) => l.event === "operate-close").map((l) => [l.by, l.reason]), [["operator", "off"]]);
	// The page that stays does not bring them back.
	await sleep(1500);
	assert.deepEqual((await operateStatus(w.macWorld)).sessions, []);
	assert.equal(typeof (await operateStatus(w.macWorld)).off, "number", "the status says since when");
});

test("OW-F003: operate off stays off across a GUI that starts again and a server that starts again, until operate on, and the switch is a mode 600 file of the device's own", async () => {
	const w = await paged(), socket = () => ({ socket: w.macWorld.record()!.socket, secret: w.macWorld.record()!.secret });
	assert.deepEqual(await linkGui(w.macWorld, "operate-off"), { ok: true, saved: true });
	const file = join(w.macWorld.stateDir, "link", "operate-off.json");
	assert.equal(statSync(file).mode & 0o777, 0o600);
	const since = (JSON.parse(readFileSync(file, "utf8")) as { since: number }).since;
	assert.equal((await operateStatus(w.macWorld)).off, since);
	// The GUI stops and starts again (a new host is built for it): still off.
	assert.equal((await callControl(socket().socket, socket().secret, { cmd: "gui-stop" })).reply?.ok, true);
	w.page.close();
	assert.equal((await callControl(socket().socket, socket().secret, { cmd: "gui", boss: true } as never)).reply?.ok, true);
	const again = listen(GUI(w.macWorld));
	cleanups.push(() => again.close());
	await sleep(2000);
	assert.equal(again.nets().some((n) => boxBase(n)), false, "a new GUI, a new host, and no base");
	assert.deepEqual((await operateStatus(w.macWorld)).sessions, []);
	// The server stops and starts again: still off, since the same moment.
	again.close();
	await w.mac.handle.shutdown(0);
	await w.restartMac();
	const afterRestart = listen(GUI(w.macWorld));
	cleanups.push(() => afterRestart.close());
	await sleep(2000);
	assert.equal(afterRestart.nets().some((n) => boxBase(n)), false, "a new server, and no base");
	assert.equal((await operateStatus(w.macWorld)).off, since);
	// On: the base comes back at the next tick, and the file is gone.
	assert.deepEqual(await linkGui(w.macWorld, "operate-on"), { ok: true, saved: true });
	assert.equal(existsSync(file), false);
	await until(() => afterRestart.nets().some((n) => boxBase(n)?.box?.state === "live"), "the base after on", WAIT);
	assert.equal((await operateStatus(w.macWorld)).off, undefined);
});

test("OW-F003: operate off and on answer on the box with the other ops: an unattended device has no switch", async () => {
	const w = await boot();
	assert.equal((await linkGui(w.boxWorld, "operate-off")).ok, false);
	assert.equal((await linkGui(w.boxWorld, "operate-on")).ok, false);
});

test("an unattended box answers the same command with no session, and a box whose policy has no operate entry is offered to nobody: no open, no line, no timer", async () => {
	const w = await boot({ grant: "none" }), gui = w.gui(), page = listen(gui);
	cleanups.push(() => page.close());
	await sleep(1500); // the Mac's host looks at its offers every second; the box has no operate/1 in its caps, so it has none
	assert.equal(page.nets().some((n) => boxBase(n)), false, "the box is no base of the Mac's net");
	assert.deepEqual((await operateStatus(w.boxWorld)).sessions, [], "an unattended device has no controller end");
	assert.deepEqual(w.boxLog().filter((l) => String(l.event).startsWith("operate")), [], "the box wrote no operate line");
	assert.deepEqual(w.macLog().filter((l) => String(l.event).startsWith("operate")), [], "nor did the Mac");
	assert.equal(existsSync(join(w.boxWorld.stateDir, "link", "operate-ledger.jsonl")), false, "and the box has no bridge, so no ledger and no reading of its net");
});

test("OW-F002: an open that comes to a box whose policy grants nobody is dropped before any bridge is built: no line, no policy watch, no ledger", async () => {
	const w = await boot({ grant: "none" });
	const roster = view(w.entries), m = { session: Buffer.alloc(16, 7), type: "open" as const, eph: Buffer.alloc(32, 9), caps: ["operate/1"], want: "box" as const };
	const forged = buildEnvelope({ team: TEAM, epoch: roster.epoch, teamKey: teamKey(roster.epoch), head: roster.head, from: bob, seq: 0, ts: Date.now(), kind: "operate", to: [dave.id], plaintext: encodePlaintext("operate", m) });
	assert.equal(w.relay.injectLive(TEAM_HEX, forged, dave.id), 1);
	await sleep(500);
	assert.deepEqual(w.boxLog().filter((l) => String(l.event).startsWith("operate")), []);
	assert.equal(existsSync(join(w.boxWorld.stateDir, "link", "operate-ledger.jsonl")), false);
});

test("OW-F002: a policy that gains an operate grant offers the box to the Mac at once, and one that loses it takes the base away", async () => {
	const w = await boot({ grant: "none" }), gui = w.gui(), page = listen(gui);
	cleanups.push(() => page.close());
	await sleep(500);
	assert.equal(page.nets().some((n) => boxBase(n)), false);
	w.setGrant("box");
	await until(() => page.nets().some((n) => boxBase(n)?.box?.state === "live"), "the base after the grant", WAIT);
	w.setGrant("none");
	await until(() => !boxBase(page.nets().at(-1)!), "the base gone after the grant went", WAIT);
});

test("OW-F002: a policy that gains an operate grant starts the box's slow reading of its net, and one that loses it stops it", async () => {
	const w = await boot({ grant: "none" });
	const file = join(w.boxWorld.stateDir, "link", "operate-ledger.jsonl");
	await sleep(400);
	assert.equal(existsSync(file), false, "no grant, no reading");
	w.setGrant("box");
	await until(() => existsSync(file) && readFileSync(file, "utf8").includes(TEAM_HEX), "the ledger row after the grant, with no page", WAIT);
	w.setGrant("none");
	await sleep(500); // the holder reads the policy at each tick (15 ms here)
	boxHerdr(w).panes.splice(0);
	w.box.client.sessions = [] as never;
	await sleep(1000); // ten readings of the box's net, had its timer kept running
	assert.equal(readFileSync(file, "utf8").trim().split("\n").some((l) => (JSON.parse(l) as { ended?: boolean }).ended), false, "the box no longer reads its net: the run that ended after the grant went has no end line");
});

test("the box reads its own net on a slow timer while its policy grants operate, with no session and no page: a run that starts and ends unobserved still has a ledger row", async () => {
	const w = await boot();
	const file = join(w.boxWorld.stateDir, "link", "operate-ledger.jsonl");
	await until(() => existsSync(file) && readFileSync(file, "utf8").includes(TEAM_HEX), "the ledger row, with no page", WAIT);
	boxHerdr(w).panes.splice(0);
	w.box.client.sessions = [] as never;
	await until(() => readFileSync(file, "utf8").trim().split("\n").some((l) => (JSON.parse(l) as { ended?: boolean }).ended), "the end line, with no page", WAIT);
});

test("a GUI that stops and starts again in the same server gets a host of its own: the stopped one is final, and the box's base comes back", async () => {
	const w = await paged(), socket = () => ({ socket: w.macWorld.record()!.socket, secret: w.macWorld.record()!.secret });
	assert.equal((await callControl(socket().socket, socket().secret, { cmd: "gui-stop" })).reply?.ok, true);
	await until(() => w.boxLog().some((l) => l.event === "operate-close"), "the box's line for the stopped GUI's session", WAIT);
	assert.deepEqual(w.boxLog().filter((l) => l.event === "operate-close").map((l) => [l.by, l.reason]), [["operator", "stop"]]);
	w.page.close();
	assert.equal((await callControl(socket().socket, socket().secret, { cmd: "gui", boss: true } as never)).reply?.ok, true);
	const again = listen(GUI(w.macWorld));
	cleanups.push(() => again.close());
	await until(() => again.nets().some((n) => boxBase(n)?.box?.state === "live"), "the box's base on the new GUI's page", WAIT);
	assert.deepEqual((await operateStatus(w.macWorld)).sessions.map((x: Record<string, unknown>) => x.state), ["live"]);
});

const link = async (w: ServerWorld, body: Record<string, unknown>) => (await callControl(w.record()!.socket, w.record()!.secret, { cmd: "link", from: w.record()!.intercomId, body } as never)).reply!.answer as Record<string, any>;
const linkGui = (w: ServerWorld, name: string) => link(w, { op: "gui", name, args: {} });
const operateStatus = (w: ServerWorld) => linkGui(w, "operate");

// ---- a quick restart of either end (review OW-F001) -------------------------------------------------------------------------------------------------------------------------

test("OW-F001: the box's server restarts at once: the Mac's base is live again with no wait for an hourly caps", async () => {
	const w = await paged();
	await w.box.handle.shutdown(0);
	await until(() => boxBase(w.page.nets().at(-1)!)?.box?.state === "unreachable", "the base greyed", WAIT);
	await w.restartBox();
	await until(() => boxBase(w.page.nets().at(-1)!)?.box?.state === "live", "the base live again", WAIT);
	assert.equal(w.boxLog().filter((l) => l.event === "operate-send-failed" && l.why === "peer").length, 0, "the box never met a controller whose caps it did not know");
});

test("OW-F001: the Mac's server restarts at once: a new page sees the box's base live again", async () => {
	const w = await paged();
	w.page.close();
	await w.mac.handle.shutdown(0);
	await w.restartMac();
	const again = listen(GUI(w.macWorld));
	cleanups.push(() => again.close());
	await until(() => again.nets().some((n) => boxBase(n)?.box?.state === "live"), "the base live on the restarted Mac", WAIT);
});

// ---- review RR-F002, RR-F005, RR-F007 ------------------------------------------------------------------------------------------------------------------------------------

test("RR-F002: a holder gained after the page is connected starts the host's clock: the box's base comes with no reconnect of the page", async () => {
	const w = await boot({ late: true }), gui = w.gui(), page = listen(gui);
	cleanups.push(() => page.close());
	await sleep(1500); // the page is connected and the Mac has no holder: the host's clock does not run, and the page has no box
	assert.equal(page.nets().some((n) => boxBase(n)), false);
	w.release();
	await until(() => page.nets().some((n) => boxBase(n)?.box?.state === "live"), "the base after the holder was gained", WAIT);
});

test("RR-F005: a box that loses its last grant with no session left stops the bridge's policy watch, and the next grant builds a new bridge that works", async () => {
	const spy = timerSpy();
	cleanups.push(() => spy.restore());
	const w = await boot({ grant: "team" }), gui = w.gui(), page = listen(gui);
	cleanups.push(() => page.close());
	await until(() => page.nets().some((n) => boxBase(n)?.box?.state === "live"), "the base", WAIT);
	const watching = spy.live(2000, "timeout");
	assert.ok(watching >= 1, "the bridge's policy watch polls while a session lives");
	// The policy is read from memory here, so no file event ends the session: a roster change takes bob's admin away, and then the grant goes.
	w.relay.pushRoster(TEAM, roleEntry({ state: stateOf(w.entries, alice), signer: alice, subjectId: bob.id, role: "member" }));
	await until(() => w.boxLog().some((l) => l.event === "operate-close"), "the box's session closed", WAIT);
	assert.equal(spy.live(2000, "timeout"), watching, "the grant still stands: the bridge stays");
	w.setGrant("none");
	await until(() => spy.live(2000, "timeout") < watching, "the policy watch stopped with the last grant", WAIT);
	assert.equal(spy.live(100, "interval"), 0, "and the slow reading of the net is stopped");
	w.setGrant("box");
	await until(() => spy.live(100, "interval") === 1, "a new bridge: its slow reading runs", WAIT);
});

test("RR-F005: a box that loses its grant while a session lives keeps the bridge until that session ends, and then drops it", async () => {
	const spy = timerSpy();
	cleanups.push(() => spy.restore());
	const w = await boot({ grant: "team" }), page = listen(w.gui());
	cleanups.push(() => page.close());
	await until(() => page.nets().some((n) => boxBase(n)?.box?.state === "live"), "the base", WAIT);
	const watching = spy.live(2000, "timeout");
	w.setGrant("none");
	await sleep(500); // the holder reads the policy at each tick (15 ms here)
	assert.equal(spy.live(2000, "timeout"), watching, "a session is still open: the bridge stays");
	w.relay.pushRoster(TEAM, roleEntry({ state: stateOf(w.entries, alice), signer: alice, subjectId: bob.id, role: "member" }));
	await until(() => spy.live(2000, "timeout") < watching, "the policy watch stopped when the last session ended", WAIT);
});

test("RR-F007: an unattended box's own host never ticks with a page connected, and an attended Mac's does (the spy sees the host's one-second clock)", async () => {
	const spy = timerSpy();
	cleanups.push(() => spy.restore());
	const w = await boot({ grant: "none" });
	await sleep(300);
	const base = spy.live(OPERATE_LIMITS.tickMs, "interval");
	const onBox = listen(GUI(w.boxWorld));
	cleanups.push(() => onBox.close());
	await sleep(500);
	assert.equal(spy.live(OPERATE_LIMITS.tickMs, "interval"), base, "a page on the box's GUI arms no clock: one device is never both ends");
	const onMac = listen(w.gui());
	cleanups.push(() => onMac.close());
	await until(() => spy.live(OPERATE_LIMITS.tickMs, "interval") > base, "the Mac's host clock", WAIT);
});
