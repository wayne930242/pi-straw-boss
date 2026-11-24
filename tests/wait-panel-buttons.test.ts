import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { BossWait, TowerService } from "../src/net.ts";
import { El } from "./fake-dom.ts";

// The wait card's rows on the tower card and in the comms (gui/waitcard.ts, gui/towernotes.ts): a row is the card folded to one line with no press beside it; a tap unfolds the panel, where an act is picked and Send presses (docs/specs/2026-11-10-wait-cards-tui.md, Q1). The card has no link to the tower's comms there (the dock's
// dialog has it in its footer); a card wait whose raiser the net has a unit for offers Open <raiser>. A press or an answer the server took says so; a stale stream says why the buttons are off.

const { fillNotices } = await import("../gui/towernotes.ts");
const { m } = await import("../gui/paraglide/messages.js");

const LEGACY: BossWait = { id: "W1", text: "Decide the release", at: new Date().toISOString() };
const CARD: BossWait = { id: "W2", text: "Open the Tailscale admin page.", at: new Date().toISOString(), card: { type: "action", lang: "en", happened: "A key expired.", do: "Open the Tailscale admin page.", url: "https://login.tailscale.com/admin/machines", after: "The tower checks the machine.", from: { name: "mp3946-print", role: "main", key: "sb-main-3946" } } };
const service = (waits: BossWait[] = [LEGACY], rev = 1): TowerService => ({ state: "standing", queued: 0, allyRuns: [], notices: [], parked: [], memory: { rev, standing: 0, decisions: 0, waits: waits.length, bossWaits: waits, proposals: [] } });
let status = 200;
const PRESS = { act: "decline", at: new Date().toISOString(), main: { status: "delivered", at: new Date().toISOString() } };
const rig = async (ws: string, key: string, waits: BossWait[] = [LEGACY]) => {
	Object.assign(globalThis.document, { querySelector: () => ({ content: "CSRF" }), body: { dataset: {} } });
	Object.assign(globalThis, { fetch: async () => ({ ok: status < 400, status, json: async () => (status < 400 ? { rev: 2, proposals: [], entries: [], accepted: true, press: PRESS } : { error: "gone", reason: "No such wait" }) }) });
	const box = new El("div");
	fillNotices(box as unknown as HTMLElement, ws, service(waits), key);
	await new Promise((done) => setTimeout(done, 50));
	type Btn = { textContent: string; onclick(): void; click(): void; hidden: boolean; disabled: boolean };
	return { box, buttons: () => box.find((el) => el.tag === "button") as unknown as Btn[], text: () => box.find((el) => el.tag === "small" || el.tag === "p").map((el) => el.textContent), unfold: () => (box.find((el) => el.classes.has("wc-fold"))[0] as unknown as Btn).click(), by: (label: string) => (box.find((el) => el.tag === "button" && el.textContent === label)[0] ?? undefined) as unknown as Btn | undefined };
};
const settle = () => new Promise((done) => setTimeout(done, 5));

test("a wait row is the card folded to one line with no press beside it; a tap on the line unfolds the panel with its acts", async () => {
	const r = await rig("wA", "sb-tower-wa", [CARD]);
	const card = r.box.find((el) => el.classes.has("wait-card"))[0]!;
	assert.equal(card.getAttribute("data-folded"), "true");
	assert.equal(r.box.find((el) => el.classes.has("ask-opts"))[0]!.hidden, true, "a folded row loses its inline button");
	assert.equal(r.box.find((el) => el.classes.has("ask-acts"))[0]!.hidden, true, "and its Send");
	r.unfold();
	assert.equal(r.box.find((el) => el.classes.has("ask-opts"))[0]!.hidden, false);
	assert.ok(r.by(m.wc_b_done()), "the acts come with the unfolding");
	assert.ok(r.by(m.wc_b_skip()));
	assert.ok(r.by(m.wc_b_reply()));
});

test("a reloaded notice shows the answer instead of the question until resolved", async () => {
	for (const w of [{ ...CARD, answered: CARD.at }, { ...CARD, press: { act: "done" as const, at: CARD.at } }]) {
		const r = await rig("wA", "t", [w]);
		const line = r.box.querySelector(".wc-fold")!.textContent;
		assert.match(line, w.press ? /I'm done.*confirm/ : /[Aa]nswered.*tower/);
		fillNotices(r.box as unknown as HTMLElement, "wA", service([{ ...w, state: "resolved" }]), "t");
		assert.equal(r.box.querySelector(".wc-fold"), null);
	}
});

test("the head tower's row says the head tower (Q3) where a workspace tower's says the tower", async () => {
	const head = await rig("@head", "sb-head", [CARD]);
	head.unfold();
	assert.ok(head.by(m.wc_b_reply_head()), "Reply to the head tower");
	assert.equal(head.by(m.wc_b_reply()), undefined);
	const ws = await rig("wA", "sb-tower-wa", [CARD]);
	ws.unfold();
	assert.ok(ws.by(m.wc_b_reply()) && !ws.by(m.wc_b_reply_head()));
});

test("a row has no link to the tower's comms; a card wait whose raiser the net has a unit for has Open <raiser>, a legacy one has no link at all", async () => {
	assert.equal((await rig("wA", "sb-tower-wa", [LEGACY])).box.find((el) => el.tag === "a").length, 0);
	const withMain = await rig("wA", "sb-tower-wa", [CARD]);
	withMain.unfold();
	const links = withMain.box.find((el) => el.tag === "a").filter((a) => a.classes.has("wc-main"));
	assert.equal(links.length, 1);
	assert.equal(links[0]!.attrs.get("data-route"), "w/wA/s/sb-main-3946");
	assert.equal(links[0]!.textContent, m.wc_b_main({ name: "mp3946-print" }));
});

test("a Skip the server took (a second tap, the confirm) says so once in the flash under the rows, which outlives the row; one it refused says why and keeps the buttons", async () => {
	status = 404;
	const bad = await rig("wB", "sb-tower-wb");
	bad.unfold();
	bad.by(m.wc_b_skip())!.click();
	bad.by(m.send())!.click();
	await settle();
	assert.ok(bad.text().some((t) => t.includes("no such wait")), "the refusal is shown");
	assert.equal(bad.by(m.send())!.disabled, false, "Send can be tried again");
	status = 200;
	const good = await rig("wC", "sb-tower-wc");
	good.unfold();
	good.by(m.wc_b_skip())!.click();
	good.by(m.send())!.click();
	await settle();
	const line = m.wc_pressed_decline() + m.wc_sep() + m.wc_told_tower();
	assert.deepEqual(good.box.find((el) => el.getAttribute("class") === "tnote-flash").map((el) => el.textContent), [line], "said once, in the flash");
});

test("an answer the server took says so once, and the reply fold comes back for the next one", async () => {
	status = 200;
	const r = await rig("wE", "sb-tower-wE");
	r.unfold();
	r.by(m.wc_b_reply())!.click();
	const box = r.box.find((el) => el.tag === "textarea" && el.classes.has("wait-box"))[0] as unknown as { value: string };
	box.value = "ship it";
	(box as unknown as El).bubble("input", {});
	r.by(m.send())!.click();
	await settle();
	const flashes = () => r.box.find((el) => el.getAttribute("class") === "tnote-flash").map((el) => el.textContent);
	assert.deepEqual(flashes().filter((t) => t === m.wait_sent()), [m.wait_sent()], "said once");
	assert.equal(r.by(m.wc_b_reply())!.hidden, false, "the reply fold is back");
	assert.equal(r.by(m.wc_b_skip())!.hidden ?? false, false, "and so is Skip: the wait stays on the card");
	assert.equal(box.value, "", "the box is empty");
});

test("a redraw within the flash's four seconds keeps it; the flash is a status line", async () => {
	status = 200;
	const r = await rig("wF", "sb-tower-wF");
	r.unfold();
	r.by(m.wc_b_skip())!.click();
	r.by(m.send())!.click();
	await settle();
	fillNotices(r.box as unknown as HTMLElement, "wF", service([], 3), "sb-tower-wF"); // the snapshot after the press drops the row, and the box is redrawn
	assert.equal(r.box.find((el) => (el.getAttribute("class") ?? "").startsWith("tnote ")).length, 0, "the row is gone");
	const flash = r.box.find((el) => el.getAttribute("class") === "tnote-flash");
	assert.equal(flash.length, 1, "one flash after the redraw");
	assert.equal(flash[0]!.getAttribute("role"), "status");
});

test("with the stream stale the buttons are off and the card says why", async () => {
	const r = await rig("wD", "sb-tower-wd", [CARD]);
	r.unfold();
	(document.body.dataset as Record<string, string>).stale = "true";
	fillNotices(r.box as unknown as HTMLElement, "wD", service([CARD], 2), "sb-tower-wd");
	await settle();
	assert.equal(r.by(m.wc_b_done())?.disabled ?? true, true);
	assert.equal(r.by(m.wc_b_skip())!.disabled, true);
	assert.ok(r.text().includes(m.wc_stale()));
	assert.deepEqual(r.box.find((el) => el.tag === "p" && el.textContent === m.wc_stale()).map((el) => el.getAttribute("role")), ["status"], "a status, not an alert: the page banner already says offline and every card would announce it");
	delete (document.body.dataset as Record<string, string>).stale;
});

test("the answer box alone (the card mounts it under its Reply row) takes words, is ready only with some, and sends them to the tower's input; the box empties once the tower took them", async () => {
	Object.assign(globalThis.document, { querySelector: () => ({ content: "CSRF" }), body: { dataset: {} } });
	const { replyBox } = await import("../gui/waitpanel.ts");
	const { waitActions } = await import("../gui/asks.ts");
	const told: Record<string, unknown>[] = [];
	const reply = replyBox({ actions: waitActions({ ws: "wG", id: "W1", tower: "sb-tower-wG" }, async (_action, body) => (told.push(body), { ok: true, status: 200, body: { accepted: true } })) });
	const box = reply.box as unknown as El & { value: string };
	assert.equal(box.tag, "textarea");
	assert.equal(reply.ready(), false);
	assert.deepEqual(await reply.send(), { taken: false }, "no words, nothing sent");
	box.value = "  ship it ";
	assert.equal(reply.ready(), true);
	assert.deepEqual(await reply.send(), { taken: true });
	assert.deepEqual(told, [{ text: "  ship it ", as: "send", answers: "W1" }]);
	assert.equal(box.value, "");
	box.value = "x".repeat(16_385);
	assert.deepEqual(await reply.send(), { taken: false, why: m.too_long() }, "over the session's cap");
	assert.equal(told.length, 1);
});

test("every caller of the notices passes the workspace, the service and the tower's key, and nothing else: the card has no comms link to hide", () => {
	const call = (f: string) => readFileSync(new URL(`../gui/${f}`, import.meta.url), "utf8").split("\n").find((l) => l.includes("fillNotices(") && !l.includes("import"))!;
	for (const f of ["render.ts", "workspace.ts"]) assert.match(call(f), /fillNotices\(.*\.key, undefined, Boolean\(\w+\.box\)\)[;,]/, `${f} passes its tower's key and whether the base is a box's`);
	assert.match(call("session.ts"), /fillNotices\(.*u\?\.key, \(k\) => locate\(scene\.net, k\)\?\.base\.id, Boolean\(hit\?\.base\.box\)\)[;,]/, "the session view adds the finder of a raiser's workspace (the head's page is on no workspace) and whether its base is a box's");
	assert.doesNotMatch(call("session.ts"), /u\?\.key, true\)/);
});
