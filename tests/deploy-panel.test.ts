import assert from "node:assert/strict";
import { test } from "node:test";
import type { Progress } from "../src/deploy.ts";

// The deploy panel (gui/deploy.ts) as the page drives it: its steps advance from the server's progress and from nothing else, the elapsed time ticks on the
// running step, a finished open flashes ready before the page goes on, and a failure names the failed step and the server's reason.

/** The few DOM calls the panel makes. */
class El {
	attrs = new Map<string, string>();
	kids: (El | string)[] = [];
	dataset: Record<string, string> = {};
	style = { setProperty: (name: string, value: string) => void this.attrs.set(`style:${name}`, value) };
	onclick: (() => void) | null = null;
	focused = false;
	tag: string;
	constructor(tag = "") {
		this.tag = tag;
	}
	setAttribute(name: string, value: string) {
		this.attrs.set(name, value);
	}
	append(...kids: (El | string)[]) {
		this.kids.push(...kids);
	}
	replaceChildren(...kids: (El | string)[]) {
		this.kids = [...kids];
	}
	focus() {
		this.focused = true;
	}
	get text(): string {
		return this.kids.map((k) => (typeof k === "string" ? k : k.text)).join("");
	}
	set textContent(value: string) {
		this.kids = [value];
	}
	find(pred: (el: El) => boolean): El[] {
		return [this, ...this.kids.flatMap((k) => (typeof k === "string" ? [] : k.find(pred)))].filter(pred);
	}
	cls(name: string) {
		return this.find((el) => el.attrs.get("class") === name)[0]!;
	}
}
Object.assign(globalThis, { document: { createElement: (tag: string) => new El(tag), createElementNS: (_: string, tag: string) => new El(tag) }, matchMedia: () => ({ matches: false }) });
const { deployPanel } = await import("../gui/deploy.ts");

function fake() {
	let t = 1_000_000;
	const ticks: { run: () => void; ms: number }[] = [], waits: { run: () => void; at: number }[] = [];
	return {
		now: () => t,
		every: (run: () => void, ms: number) => (ticks.push({ run, ms }), () => ticks.splice(ticks.indexOf(ticks.find((x) => x.run === run)!), 1)),
		after: (run: () => void, ms: number) => (waits.push({ run, at: t + ms }), () => waits.splice(0, waits.length, ...waits.filter((w) => w.run !== run))),
		/** Moves the clock on by `ms`, firing each tick (every 500 ms) and each due wait on the way. */
		async advance(ms: number) {
			for (let left = ms; left > 0; left -= 500) {
				t += Math.min(500, left);
				for (const w of waits.filter((x) => x.at <= t)) (waits.splice(waits.indexOf(w), 1), w.run());
				for (const tick of [...ticks]) tick.run();
				for (let i = 0; i < 5; i++) await Promise.resolve();
			}
		},
	};
}
const ok = (body: Record<string, unknown>) => ({ ok: true, status: 200, body });
function setup(over: { hasPrompt?: boolean; kind?: "base" | "main" | "member"; split?: boolean } = {}) {
	const clock = fake();
	let snapshot: (() => Progress) | undefined, reply!: (a: { ok: boolean; status: number; body: Record<string, unknown> }) => void, ids: string[] = [];
	const events: string[] = [], trusts: Record<string, unknown>[] = [];
	let served = 0;
	const panel = deployPanel({
		kind: over.kind ?? "member", split: over.split ?? false, hasPrompt: over.hasPrompt ?? true, name: "hello-test2", clock,
		open: (id) => (ids.push(id), new Promise((done) => (reply = done))),
		progress: async (id) => (ids.push(id), snapshot ? ok(snapshot() as never) : { ok: false, status: 404, body: {} }),
		ready: (body) => events.push(`ready:${JSON.stringify(body)}`),
		back: () => events.push("back"),
		chime: () => events.push("chime"),
		trust: async (body) => (trusts.push(body), ok({ outcome: "accepted" }) as never),
	}) as unknown as El;
	const rows = () => panel.find((e) => e.tag === "li" && e.attrs.has("data-step")).map((li) => `${li.dataset.state}~${li.kids.slice(1).map((k) => (typeof k === "string" ? k : k.text)).join("|")}`);
	return { panel, clock, rows, events, ids, trusts, /** What the server answers from now on: a snapshot, or a function of how long the running step has run since this call. */
		serve: (s: Progress | ((since: number) => Progress)) => ((snapshot = () => (typeof s === "function" ? s(clock.now() - served) : s)), (served = clock.now())), answer: (a: Parameters<typeof reply>[0]) => reply(a) };
}
const step = (id: "create" | "start" | "join" | "deliver" | "trust", state: Progress["steps"][number]["state"], ms = 0) => ({ id, state, ms });

test("the panel starts from the steps the open will have and advances them only from the server's progress, with the count and the bar following", async () => {
	const p = setup();
	assert.equal(p.panel.dataset.state, "running");
	assert.match(p.panel.cls("deploy-title").text, /Deploying member · hello-test2/);
	assert.deepEqual(p.rows().map((r) => r.split("~")[0]), ["pending", "pending", "pending", "pending"]);
	await p.clock.advance(5000);
	assert.deepEqual(p.rows().map((r) => r.split("~")[0]), ["pending", "pending", "pending", "pending"], "no progress arrived: nothing moves, however long it takes");
	assert.equal(p.panel.cls("deploy-count").text, "0/4");
	p.serve({ steps: [step("create", "done", 800), step("start", "active", 3000), step("join", "pending"), step("deliver", "pending")], finished: false });
	await p.clock.advance(500);
	assert.deepEqual(p.rows().map((r) => r.split("~")[0]), ["done", "active", "pending", "pending"]);
	assert.equal(p.panel.cls("deploy-count").text, "1/4");
	assert.equal(p.panel.cls("deploy-fill").attrs.get("style:--done"), "1");
	assert.equal(p.panel.cls("deploy-fill").attrs.get("style:--of"), "4");
	assert.deepEqual(p.rows().map((r) => r.split("~")[1]), ["Open a tab|", "Start the agent|00:03", "Join the Straw Net|", "Deliver the task|"]);
	p.serve({ steps: [step("create", "done", 800), step("start", "done", 12_000), step("join", "active", 0), step("deliver", "pending")], finished: false });
	await p.clock.advance(500);
	assert.deepEqual(p.rows().map((r) => r.split("~")[0]), ["done", "done", "active", "pending"]);
	assert.equal(p.panel.cls("deploy-count").text, "2/4");
	assert.ok(p.ids.every((id) => id === p.ids[0]), "the open and every poll carry one id");
});

test("the running step's elapsed time ticks every second from the server's figure, and only that step shows a clock", async () => {
	const p = setup({ hasPrompt: false });
	p.serve((since) => ({ steps: [step("create", "done", 400), step("start", "done", 2000), step("join", "active", 12_000 + since)], finished: false }));
	await p.clock.advance(500);
	const timeOf = () => p.panel.find((e) => e.tag === "time").map((e) => e.text);
	assert.deepEqual(timeOf(), ["", "00:02", "00:12"]);
	await p.clock.advance(3000);
	assert.deepEqual(timeOf(), ["", "00:02", "00:15"], "three seconds on, only the running step moved");
});

test("an open without a first message shows no delivery step, and a split member names its pane, a base its creation", () => {
	assert.deepEqual(setup({ hasPrompt: false }).rows().map((r) => r.split("~")[1]), ["Open a tab|", "Start the agent|", "Join the Straw Net|"]);
	assert.match(setup({ split: true }).rows()[0]!, /Split a pane/);
	assert.match(setup({ kind: "base" }).rows()[0]!, /Create the base/);
	assert.match(setup({ kind: "base" }).panel.cls("deploy-title").text, /Deploying base/);
});

test("a finished open completes the steps, flashes ready with the chime, and goes on to the unit after the finish", async () => {
	const p = setup();
	p.serve({ steps: [step("create", "done"), step("start", "done"), step("join", "done"), step("deliver", "active", 800)], finished: false });
	await p.clock.advance(500);
	p.answer(ok({ session: "S1", workspace: "wA" }));
	await p.clock.advance(0);
	for (let i = 0; i < 5; i++) await Promise.resolve();
	assert.equal(p.panel.dataset.state, "ready");
	assert.deepEqual(p.rows().map((r) => r.split("~")[0]), ["done", "done", "done", "done"]);
	assert.equal(p.panel.cls("deploy-count").text, "4/4");
	assert.equal(p.panel.cls("deploy-note").text, "Unit ready");
	assert.deepEqual(p.events, ["chime"], "the page does not move on yet");
	await p.clock.advance(1500);
	assert.deepEqual(p.events, ["chime", `ready:${JSON.stringify({ session: "S1", workspace: "wA" })}`]);
});

test("a failure names the step it failed at and the server's reason, stops polling, and can be dismissed", async () => {
	const p = setup();
	p.serve({ steps: [step("create", "done", 500), step("start", "active", 2000), step("join", "pending"), step("deliver", "pending")], finished: false });
	await p.clock.advance(500);
	p.answer({ ok: false, status: 502, body: { error: "open_failed", reason: "agent_pane_busy: the shell is not ready", step: "start" } });
	await p.clock.advance(0);
	for (let i = 0; i < 5; i++) await Promise.resolve();
	assert.equal(p.panel.dataset.state, "failed");
	assert.deepEqual(p.rows().map((r) => r.split("~")[0]), ["done", "failed", "pending", "pending"]);
	assert.match(p.panel.cls("deploy-note").text, /Failed at “Start the agent”\. agent_pane_busy: the shell is not ready/);
	assert.equal(p.panel.cls("deploy-note").attrs.get("role"), "alert");
	const polled = p.ids.length;
	await p.clock.advance(3000);
	assert.equal(p.ids.length, polled, "no more polling after the failure");
	p.panel.find((e) => e.tag === "button")[0]!.onclick!();
	assert.deepEqual(p.events, ["back"]);
});

test("a refusal over the folder's .pi/settings.json is worded by the page, in both languages, from the server's facts, with the path and the limit", async () => {
	const { m } = await import("../gui/paraglide/messages.js");
	const { reasonOf } = await import("../gui/refusal.ts");
	const path = "/home/me/proj/.pi/settings.json";
	const special = { path, why: "special" }, large = { path, why: "large", size: 300_000, limit: 262_144 }, locked = { path, why: "unreadable", code: "EACCES" };
	assert.match(reasonOf("server words", special as never)!, /^Not started: \/home\/me\/proj\/\.pi\/settings\.json is not a plain file/);
	assert.match(reasonOf("server words", large as never)!, /is 293 KB, over the 256 KB limit/);
	assert.match(reasonOf("server words", locked as never)!, /cannot be read \(EACCES\)/);
	assert.match(reasonOf("server words", { path, why: "unchecked", code: "ETIMEDOUT" } as never)!, /could not be checked in time \(ETIMEDOUT\)/);
	assert.match(m.deploy_settings_unchecked({ path: "/a", code: " (ETIMEDOUT)" }, { locale: "zh-TW" }), /^沒有啟動：\/a 在時限內沒能檢查完 \(ETIMEDOUT\)/);
	assert.equal(reasonOf("server words", undefined), "server words", "without facts, the server's own words");
	assert.match(m.deploy_settings_special({ path: "/a/.pi/settings.json → /dev/zero" }, { locale: "zh-TW" }), /^沒有啟動：\/a\/\.pi\/settings\.json → \/dev\/zero 不是一般檔案/);
	assert.match(m.deploy_settings_large({ path: "/a", size: "293", limit: "256" }, { locale: "zh-TW" }), /有 293 KB，超過 256 KB 的上限/);
	assert.match(m.deploy_settings_unreadable({ path: "/a", code: " (EACCES)" }, { locale: "zh-TW" }), /^沒有啟動：讀不到 \/a \(EACCES\)/);
	const p = setup({ kind: "base" });
	p.serve({ steps: [step("create", "active", 0), step("start", "pending"), step("join", "pending")], finished: false });
	await p.clock.advance(500);
	p.answer({ ok: false, status: 409, body: { error: "settings_unsafe", reason: "pi was not started: ...", step: "create", settings: special } });
	await p.clock.advance(0);
	for (let i = 0; i < 5; i++) await Promise.resolve();
	assert.equal(p.panel.dataset.state, "failed");
	assert.deepEqual(p.rows().map((r) => r.split("~")[0]).slice(0, 2), ["failed", "pending"], "the create step failed");
	assert.match(p.panel.cls("deploy-note").text, /^Failed at “Create the base”\. Not started: .*settings\.json is not a plain file/);
	assert.doesNotMatch(p.panel.cls("deploy-note").text, /11421/, "the upstream issue is in the docs only");
});

test("the server's own failed step shows at once, and a request that gets no answer fails the running step instead of hanging", async () => {
	const early = setup();
	early.serve({ steps: [step("create", "done"), step("start", "done"), step("join", "failed", 60_000), step("deliver", "pending")], finished: false, failed: { step: "join", reason: "The pi in pane wA:p2 did not join the net within 60 s" } });
	await early.clock.advance(500);
	assert.equal(early.panel.dataset.state, "failed");
	assert.match(early.panel.cls("deploy-note").text, /Failed at “Join the Straw Net”\. The pi in pane wA:p2 did not join/);
	const silent = setup({ hasPrompt: false });
	silent.serve({ steps: [step("create", "done"), step("start", "active", 0), step("join", "pending")], finished: false });
	await silent.clock.advance(500);
	await silent.clock.advance(120_000);
	assert.equal(silent.panel.dataset.state, "failed");
	assert.deepEqual(silent.rows().map((r) => r.split("~")[0]), ["done", "failed", "pending"]);
	assert.match(silent.panel.cls("deploy-note").text, /No answer after 120 s/);
});

test("the timeout counts silence, not total time: progress that keeps changing keeps the panel running, and an open that answers ok after the timeout still shows ready", async () => {
	const slow = setup({ hasPrompt: false });
	slow.serve((since) => ({ steps: [step("create", "done", 400), step("start", "active", since), step("join", "pending")], finished: false }));
	await slow.clock.advance(150_000);
	assert.equal(slow.panel.dataset.state, "running", "the running step's time moves, so it is not silence");
	const stuck = setup({ hasPrompt: false });
	stuck.serve({ steps: [step("create", "done", 400), step("start", "active", 0), step("join", "pending")], finished: false });
	await stuck.clock.advance(125_000);
	assert.equal(stuck.panel.dataset.state, "failed");
	const late = setup({ hasPrompt: false });
	await late.clock.advance(125_000);
	assert.equal(late.panel.dataset.state, "failed");
	late.answer(ok({ session: "S2", workspace: "wB" }));
	for (let i = 0; i < 5; i++) await Promise.resolve();
	assert.equal(late.panel.dataset.state, "ready", "the open answered after all");
	await late.clock.advance(1500);
	assert.deepEqual(late.events, ["chime", `ready:${JSON.stringify({ session: "S2", workspace: "wB" })}`]);
});

test("closing the tile stops the polling and the chime and never goes on to the unit", async () => {
	const p = setup();
	p.serve({ steps: [step("create", "done"), step("start", "active"), step("join", "pending"), step("deliver", "pending")], finished: false });
	await p.clock.advance(500);
	(p.panel as unknown as { close(): void }).close();
	const polled = p.ids.length;
	await p.clock.advance(3000);
	assert.equal(p.ids.length, polled);
	p.answer(ok({ session: "S3", workspace: "wC" }));
	for (let i = 0; i < 5; i++) await Promise.resolve();
	await p.clock.advance(2000);
	assert.deepEqual(p.events, []);
});

test("the server keeps the last 16 openings and forgets the older ones", async () => {
	const { createDeploys } = await import("../src/deploy.ts");
	const deploys = createDeploys(), ids = Array.from({ length: 17 }, (_, i) => `deploy-id-${String(i).padStart(2, "0")}`);
	for (const id of ids) deploys.begin(id, ["create"]);
	assert.equal(deploys.get(ids[0]), undefined, "the oldest was evicted");
	assert.ok(deploys.get(ids[1]) && deploys.get(ids[16]));
	deploys.begin(undefined, ["create"]);
	assert.ok(deploys.get(ids[1]), "an open without an id is not kept and evicts nothing");
});

// The trust step (src/deploy.ts holds the opening while its new pi waits on a project trust question): the question is inline, and the give-up does not count that time.
const ASK = { id: "00000000-0000-4000-8000-000000000001", digest: "a".repeat(64), folder: "/work/demo", found: [{ kind: "settings", path: ".pi/settings.json", items: ["package: npm:demo"], more: 0 }] };
const held = (ms = 0): Progress => ({ steps: [step("create", "done", 400), step("start", "done", 900), step("trust", "active", ms), step("join", "pending")], finished: false, trust: ASK });

test("a trust step shows the folder, what it holds, and the three choices inline, and a choice posts the question's id and digest", async () => {
	const p = setup({ hasPrompt: false });
	p.serve(held(2000));
	await p.clock.advance(500);
	assert.deepEqual(p.rows().map((r) => r.split("~")[1]!.split("|")[0]), ["Open a tab", "Start the agent", "Waiting for your OK to trust this folder", "Join the Straw Net"]);
	const trust = p.panel.cls("deploy-trust");
	assert.match(trust.text, /Trusting lets the agent load this folder's settings/);
	assert.match(trust.text, /\.pi\/settings\.json/);
	assert.match(trust.text, /package: npm:demo/);
	const buttons = trust.find((e) => e.tag === "button");
	assert.deepEqual(buttons.map((b) => b.text), ["Trust", "Trust this time", "Don't trust"]);
	buttons[1]!.onclick!();
	for (let i = 0; i < 5; i++) await Promise.resolve();
	assert.equal(p.trusts.length, 1);
	assert.deepEqual([p.trusts[0]!.id, p.trusts[0]!.digest, p.trusts[0]!.choice], [ASK.id, ASK.digest, "once"]);
	assert.match(trust.text, /Answered\./);
	p.serve({ steps: [step("create", "done"), step("start", "done"), step("trust", "done", 3000), step("join", "active")], finished: false });
	await p.clock.advance(500);
	assert.equal(trust.kids.length, 0, "the question goes with its step");
});

test("a trust question holds the page's give-up for as long as nobody answers it; without one the give-up fires as before", async () => {
	const p = setup({ hasPrompt: false });
	p.serve(held());
	await p.clock.advance(500);
	await p.clock.advance(400_000);
	assert.equal(p.panel.dataset.state, "running", "the question is the person's to answer, and the server fails it after ten minutes");
	p.serve({ steps: [step("create", "done"), step("start", "done"), step("trust", "done", 3000), step("join", "active", 0)], finished: false });
	await p.clock.advance(500);
	await p.clock.advance(125_000);
	assert.equal(p.panel.dataset.state, "failed", "silence after the question is the plain 120 s");
});
