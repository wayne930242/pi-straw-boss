import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEMO_REVIEW_PICKS } from "../gui/demo-blocks.ts";
import { createAnswered } from "../src/answered.ts";
import { type FormMessage, type FormReply, REGISTER } from "../src/bridge.ts";
import { createHub } from "../src/dialogs.ts";
import { type Doc, listenDocs, submitAnswer } from "../src/documents.ts";
import { type Gui, startGui } from "../src/gui.ts";
import { canonical } from "../src/history.ts";
import type { Found, Ref } from "../src/net.ts";
import "./pbs-loader.ts";

// The contract v2 round trip against the real extension (pi-better-show's `install`, its own page server and all), as the package's spec asks of its straw-boss host: the extension lists a document, this server reads it by the capability the
// bridge relayed, a page answers a block, and the agent gets the message the extension makes of the Answer. Only pi is faked: its event bus, its `sendMessage`, and its context.

const { install, defaultDeps } = (await import("pi-better-show/extension")) as typeof import("pi-better-show/extension");

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "psb-roundtrip-test-")));
const work = join(scratch, "work"), bundle = join(scratch, "bundle");
for (const d of [work, bundle]) mkdirSync(d, { recursive: true });
writeFileSync(join(bundle, "index.html"), "<!doctype html><html><head><title>Straw Net</title></head><body></body></html>");
writeFileSync(join(work, "plan.md"), "# Plan\n\n```options\n- {title: SQLite}\n- {title: Postgres}\n```\n\n![a](a.png)\n");
writeFileSync(join(work, "reviews.md"), DEMO_REVIEW_PICKS);
writeFileSync(join(work, "a.png"), Buffer.from([0x89, 0x50]));
writeFileSync(join(work, "page.html"), `<!doctype html><html><head></head><body><form action="cgi-bin:pi-answer"><input name="choice" value="a"></form></body></html>`);
writeFileSync(join(work, "notes.txt"), "plain notes");
const sessionFile = join(scratch, "2026_S.jsonl");
writeFileSync(sessionFile, "");

const handlers = new Map<string, ((data: unknown) => void)[]>();
const bus = {
	emit: (channel: string, data: unknown) => void [...(handlers.get(channel) ?? [])].forEach((h) => h(structuredClone(data))),
	on: (channel: string, handler: (data: unknown) => void) => (handlers.set(channel, [...(handlers.get(channel) ?? []), handler]), () => handlers.set(channel, (handlers.get(channel) ?? []).filter((h) => h !== handler))),
};
const sent: { message: { content: string }; options: unknown }[] = [];
const pi = { registerTool: () => {}, on: () => () => {}, sendMessage: (message: { content: string }, options: unknown) => sent.push({ message, options }), events: bus } as unknown as ExtensionAPI;
const show = install(pi, { ...defaultDeps(), openUrl: () => {}, watch: () => () => {}, launch: async () => {}, editor: "fake-editor", onPath: () => true });
show.setContext({ cwd: work, hasUI: false, isIdle: () => true, ui: { notify: () => {} } } as never);
const running: Gui[] = [];
after(async () => {
	show.shutdown();
	await Promise.all(running.map((g) => g.stop()));
	rmSync(scratch, { recursive: true, force: true });
});

async function host() {
	const listed: { docs: Doc[] } = { docs: [] };
	const forms: FormMessage[] = [];
	const off = listenDocs(bus as never, (docs) => (listed.docs = docs));
	const events = { emit: (ch: string, r: never) => ch === REGISTER && (r as { onReady(c: unknown): void }).onReady({ snapshot: () => ({ connected: true, owner: { sessionId: "S", epoch: "e1" } }), publish: () => {} }), on: () => () => {} };
	// The bridge's half: a form for a v2 document is submitted to the owner as an Answer and its result goes back.
	const local = { deliver: () => {}, sync: () => {}, probe: () => ({ editor: "empty" as const }), commands: () => [], close: () => ({ accepted: false }), stashCheck: () => undefined, pull: () => ({ reason: "no_editor" }), form: (m: FormMessage, r: (x: FormReply) => void) => { forms.push(m); submitAnswer(bus as never, m.id, m.answerId, m.answer!, (x) => r({ version: 1, type: "form-result", bridgeId: "B", id: m.id, answerId: m.answerId, ...x })); } };
	const hub = createHub({ events } as unknown as ExtensionAPI, "S", local);
	const found: Found = { key: "S", base: "wA", name: "billing-main", role: "main", file: canonical(sessionFile), pane: "wA:p1", live: true };
	const gui = await startGui({ read: async () => ({ bases: [] }), net: { lookup: (key) => (key === "S" ? found : undefined), workspace: () => [] }, hub, dir: bundle, pollMs: 50, pingMs: 1000, answered: createAnswered({ load: () => undefined, save: () => {} }) });
	running.push(gui);
	const relay = () => {
		hub.receive("S", { version: 1, type: "dialogs", bridgeId: "B", pane: "wA:p1", file: sessionFile, dialogs: [], closed: [], documents: listed.docs } as never);
		const relayed = hub.relayed([{ id: "S", herdrLocation: { status: "current", paneId: "wA:p1" } }], new Map<string, Ref>([["S", found]]));
		return Object.fromEntries((relayed.docsOf?.("S")?.docs ?? []).map((c) => [c.display, c.cap]));
	};
	return { gui, forms, listed, relay, off };
}
const ask = (gui: Gui, path: string, { method = "GET", body, headers = {} }: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
	new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
		const data = body === undefined ? undefined : JSON.stringify(body);
		const all = { host: `127.0.0.1:${gui.port}`, ...(method === "POST" ? { origin: `http://127.0.0.1:${gui.port}`, "sec-fetch-site": "same-origin", "content-type": "application/json", "x-sb-csrf": gui.csrf, "content-length": String(Buffer.byteLength(data ?? "")) } : {}), ...headers };
		const req = request({ host: "127.0.0.1", port: gui.port, path: `/${gui.token}/${path}`, method, headers: all, agent: false }, (res) => {
			const parts: Buffer[] = [];
			res.on("data", (c: Buffer) => parts.push(c)).on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(parts).toString("latin1") }));
		});
		req.on("error", reject).end(data);
	});
const json = (r: { body: string }) => JSON.parse(r.body) as Record<string, unknown>;

test("the extension's documents reach the page as cards, are read from its page server by capability, and a block's answer becomes the agent's message", async () => {
	const t = await host();
	await show.show(work, ["plan.md", "page.html"], "Read these", "page");
	await show.show(work, ["notes.txt"], "Edit this", "edit");
	const caps = t.relay();
	assert.deepEqual(Object.keys(caps).sort(), ["notes.txt", "page.html", "plan.md"]);
	assert.deepEqual(t.listed.docs.map((d) => [d.display, d.kind, d.v]), [["plan.md", "blocks", 2], ["page.html", "html", 2], ["notes.txt", "text", 2]]);
	assert.ok(t.listed.docs.every((d) => d.path === undefined && d.capability?.startsWith("http://127.0.0.1:") && d.assets?.endsWith("/")), "no path; the owner's loopback server");
	// The text of the Markdown document, by the capability.
	const text = json(await ask(t.gui, `api/doc/${caps["plan.md"]}`));
	assert.match(String(text.text), /```options/);
	assert.match(String(text.rev), /^[0-9a-f]{16}$/);
	// The image beside it, through the owner's assets.
	assert.equal((await ask(t.gui, `doc/${caps["plan.md"]}/a.png`, { headers: { "sec-fetch-dest": "image", "sec-fetch-site": "same-origin" } })).headers["content-type"], "image/png");
	// The HTML document, framed.
	const page = await ask(t.gui, `doc/${caps["page.html"]}/`, { headers: { "sec-fetch-dest": "iframe", "sec-fetch-site": "same-origin" } });
	assert.equal(page.status, 200);
	assert.match(page.body, /<form action="answer\/[0-9a-f]{32}"/);
	assert.ok(!page.body.includes("frame.js"));
	// A pick in the Markdown document is the agent's message.
	const answer = { kind: "pick", title: "Store", fields: [["picked", "SQLite"]], ref: { block: 0 } };
	const r = await ask(t.gui, `api/doc/${caps["plan.md"]}/answer`, { method: "POST", body: { answerId: "a".repeat(32), answer, rev: text.rev } });
	assert.equal(r.status, 200, r.body);
	assert.deepEqual(json(r), { accepted: true });
	assert.equal(sent.length, 1);
	assert.match(sent[0]!.message.content, /SQLite/, "the message the extension makes of the Answer");
	assert.deepEqual((json(await ask(t.gui, `api/doc/${caps["plan.md"]}`)).answered as { done: unknown }).done, [[0, [["picked", "SQLite"]]]]);
	// The same block again is not sent: the record refuses it before the owner is asked.
	const again = await ask(t.gui, `api/doc/${caps["plan.md"]}/answer`, { method: "POST", body: { answerId: "b".repeat(32), answer, rev: text.rev } });
	assert.equal(again.status, 409);
	assert.equal(sent.length, 1);
	// The form of the HTML document is an Answer too.
	const nonce = /answer\/([0-9a-f]{32})/.exec(page.body)![1];
	const form = await ask(t.gui, `doc/${caps["page.html"]}/answer/${nonce}?choice=b`, { headers: { "sec-fetch-dest": "iframe", "sec-fetch-site": "same-origin", "sec-fetch-mode": "navigate" } });
	assert.equal(form.status, 200, form.body);
	assert.equal(sent.length, 2);
	assert.match(sent[1]!.message.content, /choice/);
	assert.match(sent[1]!.message.content, /page\.html/, "the agent is told which page sent it");
	// The extension refuses a text document's answer; this server never asks.
	const refused = await ask(t.gui, `api/doc/${caps["notes.txt"]}/answer`, { method: "POST", body: { answerId: "c".repeat(32), answer, rev: text.rev } });
	assert.equal(refused.status, 409);
	assert.equal(sent.length, 2);
	t.off();
});

test("a grouped review and a multi review reach the agent and reload with all their picks", async () => {
	const t = await host();
	await show.show(work, ["reviews.md"], "Review the release", "page");
	const path = `api/doc/${t.relay()["reviews.md"]}`, { rev } = json(await ask(t.gui, path));
	const choices = [
		{ fields: [["picked:Header", "Compact"], ["picked:Changelog", "Timeline"]], lines: ["Picked (Header): Compact", "Picked (Changelog): Timeline"] },
		{ fields: [["picked", "Desktop"], ["picked", "Phone"]], lines: ["Picked: Desktop", "Picked: Phone"] },
	];
	for (const [block, { fields, lines }] of choices.entries()) {
		const before = sent.length;
		const r = await ask(t.gui, `${path}/answer`, { method: "POST", body: { answerId: String(block + 7).repeat(32), rev, answer: { kind: "review", fields, ref: { block } } } });
		assert.equal(r.status, 200, r.body);
		assert.deepEqual(sent.slice(before).map((s) => s.message.content), [['User reviewed "":', ...lines].join("\n")]);
	}
	assert.deepEqual((json(await ask(t.gui, path)).answered as { done: unknown }).done, choices.map(({ fields }, i) => [i, fields]));
	t.off();
});
