import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, test } from "node:test";
import type { BossWait, WaitCardView, WaitPressView } from "../src/net.ts";
import { El, page, sessionGlobals } from "./fake-dom.ts";

// The wait card (gui/waitcardmodel.ts, gui/waitcard.ts; docs/specs/2026-11-07-wait-cards.md, The card in the GUI): the model's table (kind × state → parts, buttons, words), the DOM per kind, a URL drawn as text and opened by nothing but a click,
// copying that posts nothing, a paired device's secret card with no start button, a legacy card, Skip needing two taps, and the 44 px rules of the phone layout.

sessionGlobals();
const sent: { path: string; body: Record<string, unknown> }[] = [];
let reply: { ok: boolean; status: number; body: Record<string, unknown> } = { ok: true, status: 200, body: { rev: 2, proposals: [], entries: [] } };
const opened: unknown[] = [];
Object.assign(globalThis, {
	HTMLButtonElement: El, requestAnimationFrame: (run: () => void) => run(), innerWidth: 1000,
	fetch: async (path: string, init: { body: string }) => (sent.push({ path, body: JSON.parse(init.body) }), { ok: reply.ok, status: reply.status, json: async () => reply.body }),
	open: (...args: unknown[]) => void opened.push(args),
});
Object.assign(globalThis.document, { querySelector: () => ({ content: "CSRF" }) });
const { m } = await import("../gui/paraglide/messages.js");
const { cardModel, ago, pressedLine, raisedLine } = await import("../gui/waitcardmodel.ts");
const { waitCard, safeHref } = await import("../gui/waitcard.ts");
const { waitActions } = await import("../gui/asks.ts");

const NOW = Date.parse("2026-11-07T11:00:00Z"), AT = "2026-11-07T10:48:00Z"; // 12 minutes before
const FROM = { name: "mp3946-print", role: "main", workspace: "MP Center", tab: "MP-3946", key: "sb-main-3946" };
const fonstar = (over: Partial<WaitCardView> = {}): WaitCardView => ({
	type: "action", lang: "en",
	happened: "The Tailscale login key of fonstar-staging expired at about 10:30, so it is offline. The print feature of MP-3946 is deployed there, but nobody can reach it to test it.",
	do: "Open the Tailscale admin page and re-authorize fonstar-staging, or set its key to never expire.",
	url: "https://login.tailscale.com/admin/machines", after: "Once the machine is back, the tower asks the MP-3946 main to verify the print feature.", from: { ...FROM }, ...over,
});
const wait = (card: WaitCardView | undefined, extra: Partial<BossWait> = {}): BossWait => ({ id: "W9", text: card?.do ?? "api-fix asks: deploy ws01?", at: AT, ...(card ? { card } : {}), ...extra });
const choice = () => fonstar({ type: "choice", do: "Roll the ledger fix out tonight, or wait for Friday?", url: undefined, after: undefined, options: [{ label: "Tonight", then: "The tower asks the main to deploy now." }, { label: "Friday", then: "The tower holds the fix until Friday." }] });
const secret = (over: Partial<WaitCardView> = {}) => fonstar({ type: "secret", do: "Create a key in the Tailscale admin page and enter it when the entry box opens.", secret: { name: "fonstar-staging Tailscale auth key" }, ...over });
const press = (act: WaitPressView["act"], extra: Partial<WaitPressView> = {}): WaitPressView => ({ act, at: "2026-11-07T10:58:00Z", ...extra });
const base = { phase: "open" as const, remote: false, open: true, now: NOW };
const ids = (w: BossWait, extra: Partial<Parameters<typeof cardModel>[0]> = {}, o?: { locale: "en" | "zh-TW" }) => cardModel({ ...base, wait: w, ...extra }, o).buttons.map((b) => b.id);

test("the model: each kind has its buttons in order, the primary first, then the raiser, the reply box, and Skip", () => {
	assert.deepEqual(ids(wait(fonstar())), ["done", "main", "reply", "skip"]);
	assert.deepEqual(ids(wait(choice())), ["choose", "choose", "main", "reply", "skip"]);
	assert.deepEqual(ids(wait(secret())), ["secret", "main", "reply", "skip"]);
	assert.deepEqual(ids(wait(undefined)), ["restate", "reply", "skip"]);
	assert.equal(cardModel({ ...base, wait: wait(fonstar()) }).buttons[0]!.primary, true);
	const choose = cardModel({ ...base, wait: wait(choice()) }).buttons.filter((b) => b.id === "choose");
	assert.deepEqual(choose.map((b) => [b.label, b.then, b.option]), [["Tonight", "The tower asks the main to deploy now.", 0], ["Friday", "The tower holds the fix until Friday.", 1]]);
	assert.equal(choose.some((b) => b.primary), false, "a choice has no primary: every option is the same width and weight");
});

test("the model: no Open <raiser> for a tower's own wait, a raiser that left, a raiser the net has no unit for, or a page that cannot open it", () => {
	assert.equal(ids(wait(fonstar({ from: undefined }))).includes("main"), false, "self");
	assert.equal(ids(wait(fonstar({ from: { ...FROM, gone: true } }))).includes("main"), false, "gone");
	assert.equal(ids(wait(fonstar({ from: { name: "x", role: "main" } }))).includes("main"), false, "no unit key");
	assert.equal(ids(wait(fonstar()), { open: false }).includes("main"), false, "the host has no route");
	assert.equal(cardModel({ ...base, wait: wait(fonstar()) }).buttons.find((b) => b.id === "main")!.label, m.wc_b_main({ name: "mp3946-print" }));
});

test("the model: the parts of a card, in order, with the labels of the kind (a choice says Your call, and its options carry their own after)", () => {
	const a = cardModel({ ...base, wait: wait(fonstar({ command: "tailscale up" })) });
	assert.deepEqual(a.parts.map((p) => [p.id, p.label]), [["happened", m.wc_p_happened()], ["do", m.wc_p_do()], ["where", m.wc_p_where()], ["after", m.wc_p_after()]]);
	assert.deepEqual([a.parts[2]!.url, a.parts[2]!.command], ["https://login.tailscale.com/admin/machines", "tailscale up"]);
	const c = cardModel({ ...base, wait: wait(choice()) });
	assert.deepEqual(c.parts.map((p) => [p.id, p.label]), [["happened", m.wc_p_happened()], ["do", m.wc_p_decide()]], "no where, no after");
	const legacy = cardModel({ ...base, wait: wait(undefined) });
	assert.deepEqual(legacy.parts.map((p) => [p.id, p.text]), [["words", "api-fix asks: deploy ws01?"]]);
	assert.equal(legacy.tag, m.wc_tag_legacy());
	assert.deepEqual([a.tag, c.tag, cardModel({ ...base, wait: wait(secret()) }).tag], [m.wc_tag_action(), m.wc_tag_choice(), m.wc_tag_secret()]);
});

test("the model: who raised it, where, and how long ago, in the page's language; a tower's own wait and a raiser that left say so", () => {
	assert.equal(raisedLine(wait(fonstar()), NOW, { locale: "zh-TW" }), "由 mp3946-print 提出 · MP Center › MP-3946 · 12 分鐘前");
	assert.equal(raisedLine(wait(fonstar()), NOW, { locale: "en" }), "Raised by mp3946-print · MP Center › MP-3946 · 12m ago");
	assert.equal(raisedLine(wait(fonstar({ from: undefined })), NOW, { locale: "zh-TW" }), "塔台自己提出 · 12 分鐘前");
	assert.match(raisedLine(wait(fonstar({ from: { ...FROM, gone: true } })), NOW, { locale: "zh-TW" }), /^由 mp3946-print （已離開） 提出/);
	assert.equal(ago(AT, NOW + 3 * 3600_000, { locale: "en" }), "3h ago", "hours once an hour has passed");
	assert.equal(ago(AT, Date.parse(AT) - 5000, { locale: "en" }), "0s ago", "a time in the future reads as 0 s");
});

test("the model: the boss's words in both languages for the fonstar case", () => {
	const zh = cardModel({ ...base, wait: wait(fonstar({ lang: "zh-TW" })) }, { locale: "zh-TW" });
	assert.deepEqual(zh.buttons.map((b) => b.label), ["我做完了", "打開 mp3946-print", "回覆塔台", "略過"]);
	assert.deepEqual([zh.tag, zh.parts[0]!.label, zh.parts[1]!.label, zh.parts[2]!.label, zh.parts[3]!.label], ["需要你處理", "發生什麼事", "你要做的事", "在哪裡", "做完之後"]);
	const en = cardModel({ ...base, wait: wait(fonstar()) }, { locale: "en" });
	assert.deepEqual(en.buttons.map((b) => b.label), ["I'm done", "Open mp3946-print", "Reply to the tower", "Skip"]);
});

test("the model: after a press the line says what was pressed and who was told, and the buttons are off but Skip and the reply box", () => {
	const done = wait(fonstar(), { answered: "x", press: press("done", { main: { status: "delivered", at: AT } }) });
	const md = cardModel({ ...base, wait: done }, { locale: "zh-TW" });
	assert.equal(md.line, "你按了「我做完了」・已通知塔台和 mp3946-print，等塔台確認");
	assert.deepEqual(md.buttons.map((b) => b.id), ["main", "reply", "skip"], "the primary is gone: the line says it");
	assert.equal(md.buttons.find((b) => b.id === "main")!.disabled, undefined, "the link to the raiser is a way to look, so it stays");
	assert.equal(md.buttons.find((b) => b.id === "skip")!.disabled, undefined, "Skip stays");
	const cases: [string, BossWait, RegExp][] = [
		["queued is told like delivered", wait(fonstar(), { press: press("done", { main: { status: "queued", at: AT } }) }), /tower and mp3946-print were told/],
		["gone", wait(fonstar(), { press: press("done", { main: { status: "gone", at: AT } }) }), /mp3946-print has left/],
		["failed", wait(fonstar(), { press: press("done", { main: { status: "failed", at: AT } }) }), /mp3946-print was not reached/],
		["self", wait(fonstar({ from: undefined }), { press: press("done") }), /^You pressed “I'm done”.*the tower was told/],
		["restate", wait(undefined, { press: press("restate") }), /^The tower was asked to rewrite it$/],
	];
	for (const [name, w, re] of cases) assert.match(pressedLine(w, { locale: "en" }), re, name);
});

test("the model: a pressed choice keeps the picked option marked and turns the rest off", () => {
	const w = wait(choice(), { press: press("choose", { option: 1, main: { status: "delivered", at: AT } }) });
	const md = cardModel({ ...base, wait: w }, { locale: "en" });
	const options = md.buttons.filter((b) => b.id === "choose");
	assert.deepEqual(options.map((b) => [b.picked ?? false, b.disabled]), [[false, true], [true, true]]);
	assert.match(md.line, /^You chose: Friday · the tower and mp3946-print were told/);
});

test("the model: a secret card has two steps, the start button only on this computer, and the second says where to enter it", () => {
	assert.deepEqual(ids(wait(secret())), ["secret", "main", "reply", "skip"]);
	const paired = cardModel({ ...base, remote: true, wait: wait(secret()) });
	assert.equal(paired.buttons.some((b) => b.id === "secret" || b.primary), false, "WC-D4: no start button and no primary on a paired device");
	assert.equal(paired.remote, m.wc_at_computer());
	assert.equal(paired.step, 1);
	const step2 = wait(secret(), { press: press("secret", { secretAsked: "2026-11-07T10:58:00Z" }) });
	const two = cardModel({ ...base, wait: step2 }, { locale: "zh-TW" });
	assert.equal(two.step, 2);
	assert.deepEqual(two.buttons.map((b) => [b.id, b.primary ?? false]), [["entered", true], ["main", false], ["reply", false], ["skip", false]]);
	assert.equal(two.line, "已請 mp3946-print 開啟輸入框。到電腦上 Herdr 的 MP-3946 分頁輸入。");
	assert.equal(cardModel({ ...base, wait: step2, secretOpen: true }, { locale: "zh-TW" }).line, "輸入框已開啟，請到終端機輸入。");
	assert.equal(cardModel({ ...base, wait: wait(secret({ from: { ...FROM, tab: undefined } }), { press: press("secret") }) }, { locale: "en" }).line.includes("in its terminal"), true, "no tab: its terminal");
});

test("the model: sending turns the pressed button into Sending… and every button off; a stale stream and an ended wait say so", () => {
	const sending = cardModel({ ...base, phase: "sending", sending: { id: "done" }, wait: wait(fonstar()) });
	assert.deepEqual(sending.buttons.map((b) => [b.id, b.label === m.wc_sending(), b.disabled ?? false]), [["done", true, true], ["main", false, true], ["reply", false, false], ["skip", false, true]]);
	const choosing = cardModel({ ...base, phase: "sending", sending: { id: "choose", option: 1 }, wait: wait(choice()) });
	assert.deepEqual(choosing.buttons.filter((b) => b.id === "choose").map((b) => b.label === m.wc_sending()), [false, true], "only the option pressed says it");
	const stale = cardModel({ ...base, phase: "stale", wait: wait(fonstar()) });
	assert.equal(stale.line, m.wc_stale());
	assert.equal(stale.buttons.filter((b) => b.id !== "reply").every((b) => b.disabled), true, "the reply fold keeps its own state: an offline page keeps it and says so in the box");
	const ended = cardModel({ ...base, phase: "ended", wait: wait(fonstar(), { state: "resolved", outcome: "declared done by the tower" }) });
	assert.equal(ended.line, m.wc_ended({ outcome: "declared done by the tower" }));
	assert.deepEqual(ended.buttons, [], "nothing answers an ended wait");
	assert.equal(cardModel({ ...base, phase: "ended", wait: wait(fonstar(), { state: "resolved" }) }).line, m.wc_ended_plain());
});

test("the model: a card the snapshot cut has only its words and no rewrite button until it is read", () => {
	const cut = cardModel({ ...base, wait: wait(undefined, { cut: true }) });
	assert.deepEqual(cut.buttons.map((b) => b.id), ["reply", "skip"]);
	assert.equal(cut.whole, false);
});

// --- the DOM --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const setNavigator = (value: unknown) => void Object.defineProperty(globalThis, "navigator", { value, configurable: true, writable: true });
const settle = () => new Promise((done) => setTimeout(done, 5));
const pressed: string[] = [];
const told: { action: string; body: Record<string, unknown> }[] = [];
const rig = (w: BossWait, o: Partial<Parameters<typeof waitCard>[0]> = {}) => {
	const card = waitCard({ host: "dialog", wait: w, actions: waitActions({ ws: "w", id: w.id, tower: "sb-tower-w" }, async (action, body) => (told.push({ action, body }), { ok: true, status: 200, body: { accepted: true } })), remote: false, main: (key) => (key ? { view: "session", ws: "w", key } : undefined), now: () => NOW, done: (said) => void pressed.push(said), ...o });
	page.body.append(card.el as never);
	return card;
};
const act = (card: ReturnType<typeof rig>, id: string, option?: number) => (card.el as unknown as El).find((el) => el.tag === "button" && el.dataset.act === id && (option === undefined || el.dataset.option === String(option)))[0];
const text = (card: ReturnType<typeof rig>) => (card.el as unknown as El).textContent;
const byClass = (card: ReturnType<typeof rig>, name: string) => (card.el as unknown as El).find((el) => el.classes.has(name));
/** A tap on an act's row only picks it (the question panel's way); Send is the press. */
const pick = (card: ReturnType<typeof rig>, id: string, option?: number) => act(card, id, option)!.click();
const send = (card: ReturnType<typeof rig>) => byClass(card, "ask-send")[0]!;
const go = (card: ReturnType<typeof rig>, id: string, option?: number) => (pick(card, id, option), send(card).click());
const note = (card: ReturnType<typeof rig>) => byClass(card, "ask-note")[0]!;
beforeEach(() => {
	page.body.replaceChildren();
	sent.length = pressed.length = opened.length = told.length = 0;
	reply = { ok: true, status: 200, body: { rev: 2, proposals: [], entries: [], id: "W9", press: press("done", { main: { status: "delivered", at: AT } }) } };
	setNavigator(undefined);
});
afterEach(() => setNavigator(undefined));

test("a box's wait card shows its URL as plain text only: no Open link, no anchor, no href (spec: no URL comes from a box); a local card keeps Open link", () => {
	const box = rig(wait(fonstar()), { box: true });
	assert.ok(text(box).includes("https://login.tailscale.com/admin/machines"), "the URL is still readable text");
	assert.equal(byClass(box, "wc-open").length, 0, "no Open link control");
	assert.equal((box.el as unknown as El).find((el) => el.tag === "a" && el.getAttribute("href") !== undefined && el.classes.has("wc-open")).length, 0);
	assert.equal(byClass(box, "wc-url")[0]!.tag, "span");
	page.body.replaceChildren();
	assert.equal(byClass(rig(wait(fonstar())), "wc-open").length, 1, "a local card still offers it");
});

test("the fonstar card: every part is drawn whole as text, the URL is text with a link that only a click opens, nothing is fetched or opened at mount", () => {
	const card = rig(wait(fonstar()));
	const t = text(card);
	for (const part of [fonstar().happened, fonstar().do, "https://login.tailscale.com/admin/machines", fonstar().after!, m.wc_b_done(), m.wc_b_reply(), m.wc_b_skip()]) assert.ok(t.includes(part), `the card says ${part}`);
	assert.equal(sent.length, 0, "no request at mount");
	assert.equal(opened.length, 0, "no window.open at mount: a URL is text opened only by a click");
	const link = byClass(card, "wc-open")[0]!;
	assert.equal(link.getAttribute("href"), "https://login.tailscale.com/admin/machines");
	assert.equal(link.getAttribute("target"), "_blank");
	assert.equal(link.getAttribute("rel"), "noopener noreferrer");
	assert.equal(link.textContent, m.wc_b_link());
	assert.equal(byClass(card, "wc-url")[0]!.tag, "span", "the URL itself is text, not an anchor");
	assert.equal(byClass(card, "wc-clamp").length, 0, "the dialog shows every part whole");
	assert.equal(byClass(card, "wc-more").length, 0);
	assert.equal(byClass(card, "wc-text")[0]!.getAttribute("lang"), "en", "the card's own language, for a screen reader");
});

test("the card's fields are text: markup in them stays characters, and a URL that is not http(s) is shown but never linked", () => {
	const bad = "<img src=x onerror=alert(1)> and <b>bold</b>";
	const card = rig(wait(fonstar({ happened: bad, url: "javascript:alert(1)" })));
	assert.equal((card.el as unknown as El).find((el) => el.tag === "img").length, 0, "no element is made from a field");
	assert.ok(text(card).includes(bad));
	assert.equal(byClass(card, "wc-open").length, 0, "no link for javascript:");
	assert.ok(text(card).includes("javascript:alert(1)"), "the text is shown as it is");
	assert.equal(safeHref("https://u:p@host.example/"), undefined, "no user info");
	assert.equal(safeHref("ftp://host.example/"), undefined);
	assert.equal(safeHref("https://bücher.example/a b"), "https://xn--bcher-kva.example/a%20b", "an IDN host shows in punycode");
});

test("a press posts to the memory route by the wait's id; picking the act only marks it, Send presses, and the host is told what happened", async () => {
	const card = rig(wait(fonstar()));
	pick(card, "done");
	await settle();
	assert.equal(sent.length, 0, "a tap on the row only picks it (Q1)");
	assert.equal(act(card, "done")!.getAttribute("aria-checked"), "true");
	assert.equal(send(card).disabled, false);
	send(card).click();
	assert.equal(act(card, "done")?.disabled ?? true, true, "off while it is on its way");
	await settle();
	assert.deepEqual(sent, [{ path: "api/tower/w/memory", body: { op: "press", id: "W9", act: "done" } }]);
	assert.equal(pressed.length, 1);
	assert.match(pressed[0]!, /^You pressed “I'm done”/);
	assert.equal(card.sending(), false);
	assert.match(text(card), /mp3946-print were told/, "the pressed line stays on the card until the snapshot brings it");
	assert.equal(act(card, "done"), undefined, "and the primary is gone");
});

test("a refused press says why under the buttons and turns them on again", async () => {
	reply = { ok: false, status: 409, body: { error: "refused", reason: "W9 was pressed already: I'm done at 10:58" } };
	const card = rig(wait(fonstar()));
	go(card, "done");
	await settle();
	assert.equal(pressed.length, 0);
	assert.equal(note(card).textContent, m.wc_refused({ reason: "W9 was pressed already: I'm done at 10:58" }));
	assert.equal(note(card).dataset.tone, "error");
	assert.equal(act(card, "done")!.disabled, false, "pressable again");
	assert.equal(act(card, "done")!.getAttribute("aria-checked"), "true", "and still picked, so Send tries again");
});

test("a choice sends the index of the option pressed", async () => {
	const card = rig(wait(choice()));
	pick(card, "choose", 1);
	assert.equal(sent.length, 0, "a pick alone posts nothing");
	assert.equal(act(card, "choose", 0)!.getAttribute("aria-checked"), "false");
	send(card).click();
	await settle();
	assert.deepEqual(sent.map((s) => s.body), [{ op: "press", id: "W9", act: "choose", option: 1 }]);
});

test("a legacy card offers the rewrite and sends restate", async () => {
	const card = rig(wait(undefined));
	assert.ok(text(card).includes("api-fix asks: deploy ws01?"), "the tower's own words");
	go(card, "restate");
	await settle();
	assert.deepEqual(sent.map((s) => s.body), [{ op: "press", id: "W9", act: "restate" }]);
});

test("a secret card on this computer starts with one press that leaves the card open for the second step; on a paired device there is no start button at all", async () => {
	const local = rig(wait(secret()));
	go(local, "secret");
	await settle();
	assert.deepEqual(sent.map((s) => s.body), [{ op: "press", id: "W9", act: "secret" }]);
	assert.equal(pressed.length, 0, "the first step ends nothing: the dialog stays");
	reply = { ok: true, status: 200, body: { rev: 3, entries: [], proposals: [], press: press("secret", { secretAsked: "2026-11-07T10:58:00Z" }) } };
	page.body.replaceChildren();
	const paired = rig(wait(secret()), { remote: true });
	assert.equal(act(paired, "secret"), undefined);
	assert.equal(act(paired, "entered"), undefined, "and no second step either");
	assert.ok(text(paired).includes(m.wc_at_computer()));
	assert.ok(text(paired).includes(m.wc_b_skip()) && text(paired).includes(m.wc_b_reply()), "the rest of the card stays");
});

test("a secret card's second step says where to enter it and finishes with done", async () => {
	const card = rig(wait(secret(), { press: press("secret", { secretAsked: "2026-11-07T10:58:00Z" }) }));
	assert.ok(text(card).includes(m.wc_secret_asked({ name: "mp3946-print", tab: "MP-3946" })));
	card.secretWhen(() => true);
	card.update(wait(secret(), { press: press("secret", { secretAsked: "2026-11-07T10:58:00Z" }) }));
	assert.ok(text(card).includes(m.wc_secret_open()), "the raiser's dialog is pending: enter it in the terminal");
	go(card, "entered");
	await settle();
	assert.deepEqual(sent.map((s) => s.body), [{ op: "press", id: "W9", act: "done" }]);
});

test("Skip is two taps: picking it shows the tells line and the reason box and sends nothing; Send declines with the reason; picking another act folds them (WC-D1 on the panel)", async () => {
	const card = rig(wait(fonstar()));
	const box = byClass(card, "wc-reveal")[0]!;
	assert.equal(box.hidden, true);
	pick(card, "skip");
	await settle();
	assert.equal(sent.length, 0, "the first tap sends nothing");
	assert.equal(box.hidden, false);
	assert.equal(byClass(card, "wc-skip-tells")[0]!.textContent, m.wc_skip_tells({ name: "mp3946-print" }));
	assert.equal(card.confirming(), true);
	pick(card, "done");
	assert.equal(box.hidden, true, "another act folds the reason box");
	assert.equal(card.confirming(), false);
	assert.equal(sent.length, 0);
	pick(card, "skip");
	const why = byClass(card, "wc-skip-reason")[0]!;
	assert.equal(why.getAttribute("maxlength"), "120");
	why.value = "  not needed any more ";
	send(card).click();
	await settle();
	assert.deepEqual(sent.map((s) => s.body), [{ op: "press", id: "W9", act: "decline", reason: "not needed any more" }]);
	assert.equal(pressed.length, 1);
});

test("Skip without a reason sends none, and for a tower's own wait it tells only the tower", async () => {
	const card = rig(wait(fonstar({ from: undefined })));
	pick(card, "skip");
	assert.equal(byClass(card, "wc-skip-tells")[0]!.textContent, m.wc_skip_tells_tower());
	send(card).click();
	await settle();
	assert.deepEqual(sent.map((s) => s.body), [{ op: "press", id: "W9", act: "decline" }]);
});

test("Reply picked shows the answer box; Send is off until it holds words, and sends them to the tower's input with the wait's id; the box empties and the host hears it", async () => {
	const card = rig(wait(fonstar()));
	const reveal = byClass(card, "wc-reveal")[0]!, box = byClass(card, "wait-box")[0]!;
	assert.equal(reveal.hidden, true);
	pick(card, "reply");
	assert.equal(reveal.hidden, false);
	assert.equal(card.isOpen(), true);
	assert.equal(send(card).disabled, true, "no words, nothing to send");
	box.value = "  I'll look at it after lunch ";
	box.dispatchEvent(new Event("input"));
	assert.equal(send(card).disabled, false);
	send(card).click();
	await settle();
	assert.deepEqual(told, [{ action: "input", body: { text: "  I'll look at it after lunch ", as: "send", answers: "W9" } }]);
	assert.equal(sent.length, 0, "no press: a reply is words, not a press");
	assert.equal(box.value, "");
	assert.equal(card.isOpen(), false);
	assert.deepEqual(pressed, [m.wait_sent()]);
});

test("foldReply puts the reply row back unpicked and keeps the draft: Escape's step for the dialog and Zen", () => {
	const card = rig(wait(fonstar()));
	assert.equal(card.foldReply(), false, "nothing to fold");
	pick(card, "reply");
	byClass(card, "wait-box")[0]!.value = "draft";
	assert.equal(card.foldReply(), true);
	assert.equal(card.isOpen(), false);
	assert.equal(byClass(card, "wait-box")[0]!.value, "draft");
	assert.equal(act(card, "reply")!.getAttribute("aria-checked"), "false");
});

test("the card is the question panel: a section.ask with the head, the context, a radiogroup of rows, Send and a status line; no pair-btn stands for an act", () => {
	const card = rig(wait(choice()));
	const el = card.el as unknown as El;
	assert.equal(el.tag, "section");
	assert.ok(el.classes.has("ask") && el.classes.has("wait-card"));
	assert.equal(byClass(card, "ask-head").length, 1);
	const group = byClass(card, "ask-opts")[0]!;
	assert.equal(group.getAttribute("role"), "radiogroup");
	assert.deepEqual(el.find((x) => x.classes.has("ask-opt")).map((x) => x.getAttribute("role")), ["radio", "radio", "radio", "radio"], "two options, Reply, Skip");
	assert.deepEqual(el.find((x) => x.classes.has("ask-opt") && x.tag === "button").map((x) => x.dataset.act), ["choose", "choose", "reply", "skip"]);
	assert.equal(el.find((x) => x.classes.has("ask-opt") && x.classes.has("pair-btn")).length, 0);
	assert.equal(note(card).getAttribute("role"), "status");
	assert.ok(byClass(card, "ask-q")[0]!.textContent.includes(choice().do), "what you decide is the question");
	assert.equal(byClass(card, "ask-send")[0]!.textContent, m.send());
	assert.equal(el.find((x) => x.classes.has("wc-primary") || x.classes.has("wc-btn") || x.classes.has("wc-skip-yes")).length, 0, "the old look classes are gone");
});

test("a pick whose row is gone (the wait was pressed elsewhere meanwhile) is dropped: Send is off and no row is marked", () => {
	const card = rig(wait(fonstar()));
	pick(card, "done");
	assert.equal(send(card).disabled, false);
	card.update(wait(fonstar(), { answered: AT, press: press("done", { main: { status: "delivered", at: AT } }) }));
	assert.equal(act(card, "done"), undefined, "the act is gone");
	assert.equal(send(card).disabled, true, "nothing picked, nothing to send");
	assert.equal(card.confirming(), false);
	assert.equal(byClass(card, "ask-opt").some((x) => x.getAttribute("aria-checked") === "true"), false);
});

test("the raiser's link is a quiet link beside Send, not an act row; a parked card says so in the head and keeps its acts (auto mode §7)", () => {
	const card = rig(wait(fonstar(), { parked: true }));
	const link = byClass(card, "wc-main")[0]!;
	assert.ok(link.classes.has("cmp-link"));
	assert.equal(link.parent, send(card).parent, "in the same row as Send");
	const head = byClass(card, "ask-head")[0]!;
	assert.ok(head.textContent.includes(m.wait_parked()), "the mark is in the head");
	assert.equal(card.el.getAttribute("data-parked"), "true");
	assert.ok(act(card, "done") && act(card, "reply") && act(card, "skip"), "the acts stay");
});

test("a parked secret card has no start row and says to end auto mode in the status line (spec wait-cards-tui, section 4)", () => {
	const card = rig(wait(secret(), { parked: true }));
	assert.equal(act(card, "secret"), undefined);
	assert.equal(note(card).textContent, m.wc_secret_parked());
	assert.equal(byClass(card, "ask-why").some((x) => x.textContent === m.wc_secret_parked()), false, "no second copy above the rows");
});

test("a head wait's card names the head tower in its own words (Q3), a workspace's keeps the tower", () => {
	const head = rig(wait(fonstar()), { head: true });
	assert.equal(act(head, "reply")!.textContent, m.wc_b_reply_head());
	pick(head, "skip");
	assert.equal(byClass(head, "wc-skip-tells")[0]!.textContent, m.wc_skip_tells_head({ name: "mp3946-print" }));
	assert.notEqual(m.wc_b_reply_head(), m.wc_b_reply());
	page.body.replaceChildren();
	assert.equal(act(rig(wait(fonstar())), "reply")!.textContent, m.wc_b_reply());
	assert.equal(cardModel({ ...base, head: true, wait: wait(fonstar({ from: undefined })) }).raised.startsWith(m.wc_raised_self_head()), true);
	assert.equal(cardModel({ ...base, head: true, wait: wait(undefined) }).tag, m.wc_tag_legacy_head());
	assert.equal(cardModel({ ...base, head: true, wait: wait(undefined, { press: press("restate") }) }).line, m.wc_pressed_restate_head());
	assert.equal(cardModel({ ...base, head: true, phase: "ended", wait: wait(fonstar(), { state: "resolved", outcome: "ok" }) }).line, m.wc_ended_head({ outcome: "ok" }));
	const done = cardModel({ ...base, head: true, wait: wait(fonstar(), { press: press("done", { main: { status: "delivered", at: AT } }) }) });
	assert.equal(done.line.endsWith(m.wc_told_both_head({ name: "mp3946-print" })), true);
});

test("copying a command puts it on the clipboard and posts nothing; where the clipboard is not allowed the text is selected and the card says to long-press", async () => {
	const card = rig(wait(fonstar({ url: undefined, command: "tailscale up --force-reauth\nsudo systemctl restart tailscaled" })));
	const pre = byClass(card, "wc-cmd")[0]!;
	assert.equal(pre.tag, "pre");
	assert.equal(pre.textContent, "tailscale up --force-reauth\nsudo systemctl restart tailscaled");
	assert.ok(text(card).includes(m.wc_not_run()), "sb does not run it");
	assert.equal(byClass(card, "wc-open").length, 0);
	const wrote: string[] = [];
	setNavigator({ clipboard: { writeText: async (s: string) => void wrote.push(s) } });
	byClass(card, "wc-copy")[0]!.click();
	await settle();
	assert.deepEqual(wrote, ["tailscale up --force-reauth\nsudo systemctl restart tailscaled"]);
	assert.equal(byClass(card, "wc-copied")[0]!.textContent, m.wc_copied());
	assert.equal(sent.length, 0, "copying posts nothing");
	assert.equal(opened.length, 0);
	let selected: unknown;
	setNavigator({ clipboard: { writeText: async () => { throw new Error("denied"); } } });
	Object.assign(page, { createRange: () => ({ selectNodeContents: (el: unknown) => void (selected = el) }) });
	Object.assign(globalThis, { getSelection: () => ({ removeAllRanges() {}, addRange() {} }) });
	byClass(card, "wc-copy")[0]!.click();
	await settle();
	assert.equal(selected, pre, "the command is selected");
	assert.equal(byClass(card, "wc-copied")[0]!.textContent, m.wc_copy_select());
	assert.equal(sent.length, 0);
	delete (globalThis as { getSelection?: unknown }).getSelection;
});

test("a folded device wait shows the subject even from a peer whose text is the action hint", () => {
	const body = { ...fonstar(), from: { name: "box", role: "device" } };
	const card = rig(wait(body, { text: body.do }), { host: "row" });
	assert.equal(byClass(card, "wc-do")[0]!.textContent, body.happened);
});

test("a row folds the card to one line with no press beside it; a tap on the line unfolds the panel, and an update keeps it unfolded (Q1)", () => {
	const card = rig(wait(fonstar()), { host: "row" });
	const fold = byClass(card, "wc-fold")[0]!;
	assert.equal(card.el.getAttribute("data-folded"), "true");
	assert.ok(fold.textContent.includes(m.wc_tag_action()) && fold.textContent.includes(fonstar().do) && fold.textContent.includes("mp3946-print"), "tag, what to do, who raised it");
	assert.equal(byClass(card, "wc-parts")[0]!.hidden, true);
	assert.equal(byClass(card, "ask-opts")[0]!.hidden, true, "no inline act: a folded row loses its button");
	assert.equal(send(card).parent!.hidden, true);
	fold.click();
	assert.equal(card.el.getAttribute("data-folded"), "false");
	assert.equal(byClass(card, "wc-parts")[0]!.hidden, false);
	assert.equal(byClass(card, "ask-opts")[0]!.hidden, false);
	card.update(wait(fonstar(), { at: AT }), true);
	assert.equal(card.el.getAttribute("data-folded"), "false", "unfolded across a redraw");
	assert.ok(text(card).includes(m.wc_b_reply()));
});

test("a successful press folds the row before its snapshot arrives; opening it again survives that snapshot", async () => {
	const card = rig(wait(fonstar()), { host: "row" });
	byClass(card, "wc-fold")[0]!.click();
	go(card, "done");
	await settle();
	assert.equal(card.el.dataset.folded, "true");
	assert.match(byClass(card, "wc-fold")[0]!.textContent, /I'm done.*confirm/);
	assert.equal(note(card).hidden, true);
	byClass(card, "wc-fold")[0]!.click();
	card.update(wait(fonstar(), { press: reply.body.press } as Partial<BossWait>));
	assert.equal(card.el.dataset.folded, "false");
	for (const id of ["reply", "skip"]) assert.equal(act(card, id)!.disabled, false);
});

test("outside the dock's dialog a long part is clamped to three lines with a More toggle", () => {
	const long = "x".repeat(150);
	const card = rig(wait(fonstar({ happened: long, do: "Re-authorize it.", after: "Then it goes on." })), { host: "row" });
	(card.el as unknown as El).find((el) => el.classes.has("wc-fold"))[0]!.click();
	assert.equal(byClass(card, "wc-clamp").length, 1, "the long part is clamped, the short ones are not");
	const more = byClass(card, "wc-more")[0]!;
	assert.equal(more.textContent, m.wc_more());
	more.click();
	assert.equal(byClass(card, "wc-clamp").length, 0);
	assert.equal(byClass(card, "wc-more")[0]!.textContent, m.wc_less());
});

test("a stale stream turns the buttons off and says so; an ended wait is struck with the tower's outcome", () => {
	const card = rig(wait(fonstar()));
	card.update(wait(fonstar()), false);
	assert.ok(text(card).includes(m.wc_stale()));
	assert.equal(act(card, "done")!.disabled, true);
	assert.equal(send(card).disabled, true, "Send is off with the stream");
	card.update(wait(fonstar(), { state: "resolved", outcome: "done, verified" }), true, true);
	assert.equal(card.el.getAttribute("data-phase"), "ended");
	assert.ok(text(card).includes(m.wc_ended({ outcome: "done, verified" })));
	assert.equal(act(card, "done"), undefined);
});

test("a card the snapshot cut is read whole from the memory route once, and drawn from it", async () => {
	reply = { ok: true, status: 200, body: { rev: 2, proposals: [], entries: [{ ...wait(fonstar()), card: { ...fonstar(), from: { id: "raw-session-id", name: "mp3946-print", role: "main" } } }] } };
	const card = rig(wait(undefined, { cut: true }));
	assert.equal(text(card).includes(fonstar().happened), false);
	await settle();
	assert.deepEqual(sent.map((s) => s.body), [{ op: "read" }]);
	card.update(wait(undefined, { cut: true }));
	await settle();
	assert.equal(sent.length, 1, "read once");
	assert.ok(text(card).includes(fonstar().happened));
	assert.equal(card.el.dataset.kind, "action");
	assert.equal((card.el as unknown as El).dump().includes("raw-session-id"), false, "a raw session id never reaches the page");
});

test("Enter on a card takes the chosen act, else the first row", () => {
	const a = rig(wait(fonstar()));
	assert.equal(a.enter(), true);
	assert.equal(page.activeElement, act(a, "done"));
	page.body.replaceChildren();
	const c = rig(wait(choice()));
	assert.equal(c.enter(), true);
	assert.equal(page.activeElement, act(c, "choose", 0));
	pick(c, "choose", 1);
	assert.equal(c.enter(), true);
	assert.equal(page.activeElement, act(c, "choose", 1), "the picked one");
});

// --- the CSS --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const css = readFileSync(new URL("../gui/style.css", import.meta.url), "utf8"), zen = readFileSync(new URL("../gui/zen.css", import.meta.url), "utf8");

test("the phone layout gives every row, Send and link of a wait card 44 px and 8 px between targets, in Standard and in Zen", () => {
	const open = css.indexOf("@media (max-width: 640px) {", css.indexOf("/* A phone's tap targets"));
	assert.ok(open > 0);
	let depth = 0, end = open;
	for (let at = open + "@media (max-width: 640px) {".length - 1; at < css.length; at++) {
		if (css[at] === "{") depth++;
		else if (css[at] === "}" && --depth === 0) { end = at; break; }
	}
	const block = css.slice(open, end);
	assert.match(block, /\.wait-card :is\(\.ask-opt, \.ask-send, \.cmp-link, \.pair-btn, \.wc-fold, \.wc-more\)\s*\{[^}]*min-height:\s*44px/);
	assert.match(block, /\.wait-card :is\(\.ask-opt, \.ask-send, \.cmp-link, \.pair-btn, \.wc-fold, \.wc-more\)\s*\{[^}]*min-width:\s*44px/);
	assert.match(block, /\.wait-card :is\(\.ask-opts, \.ask-acts\)\s*\{\s*gap:\s*8px/);
	assert.match(block, /\.wait-card \.wc-url\s*\{\s*overflow-wrap:\s*anywhere/, "a URL wraps anywhere");
	assert.doesNotMatch(block, /\.wait-card \.wc-cmd/, "a command wraps on a phone as everywhere: no sideways scroll");
	assert.match(zen, /\[data-view="zen"\] \.wait-card :is\(\.ask-opt, \.ask-send, \.cmp-link, \.pair-btn\)\s*\{[^}]*min-height:\s*44px/, "Zen's skin of the same rows");
});

test("a part is clamped to three lines by the standard property as well as the prefixed one, and the card has a Zen skin", () => {
	assert.match(css, /\.wait-card \.wc-clamp\s*\{[^}]*(?<!-webkit-)line-clamp:\s*3/);
	assert.match(css, /\.wait-card \.wc-clamp\s*\{[^}]*-webkit-line-clamp:\s*3/);
	assert.doesNotMatch(zen, /\.wait-card \.wc-(opt|primary)/, "Zen draws the card's acts as the question panel's rows, not a skin of its own");
});

test("Raven's ticks stay off a card nested in the tower card, the tower's notices, and the return panel: one set of corners, not two (the question card has no rule of its own since 2026-11-28: it keeps its amber hairline all round)", () => {
	const raven = readFileSync(new URL("../gui/themes/raven/raven.css", import.meta.url), "utf8");
	const lines = raven.split("\n").filter((l) => l.includes('html[data-view="raven"] .ask:not('));
	assert.equal(lines.length, 1, "its ticks");
	for (const line of lines) for (const host of [".dialog .ask", ".link-alert .ask", ".tcard .ask", ".tower-notices .ask", ".auto-back .ask"]) assert.ok(line.includes(host), `${host} is excluded`);
	assert.doesNotMatch(css + zen, /\.wait-card \.wc-(btn|opt|primary|state|fail|acts)\b/, "the old look rules are gone: the card wears the panel's");
});

// RR-F002 (todo #121 task 7): a wait card turned off because its unit's box is away says box_answer_blocked in the status line (role=status) and in the reply box's note; the stale-connection words are for a stream that is the cause.
test("RR-F002 the model: a stale card with a box reason shows the reason in place of the connection words", () => {
	const stale = cardModel({ ...base, phase: "stale", wait: wait(fonstar()), blocked: m.box_answer_blocked() });
	assert.equal(stale.line, m.box_answer_blocked());
	assert.equal(stale.buttons.filter((b) => b.id !== "reply").every((b) => b.disabled), true, "the buttons are off as for a stale stream");
	assert.equal(cardModel({ ...base, phase: "stale", wait: wait(fonstar()) }).line, m.wc_stale(), "no reason: the stream is the cause");
});

test("RR-F002 the card: a card off for an away box says box_answer_blocked in its status (not the stale words), and the box's return clears it", () => {
	const card = rig(wait(fonstar()));
	card.update(wait(fonstar()), false, false, m.box_answer_blocked());
	const status = note(card);
	assert.equal(status.getAttribute("role"), "status");
	assert.equal(status.textContent, m.box_answer_blocked());
	assert.ok(!text(card).includes(m.wc_stale()), "not the connection words");
	assert.equal(act(card, "done")!.disabled, true);
	pick(card, "reply");
	assert.equal(send(card).disabled, true, "nothing is sent while the box is away");
	assert.equal(status.textContent, m.box_answer_blocked(), "the same line, with the reply picked");
	card.update(wait(fonstar()), false);
	assert.equal(status.textContent, m.wc_stale(), "a dropped stream alone: the connection words");
	card.update(wait(fonstar()), true);
	assert.equal(status.textContent, "");
	assert.equal(act(card, "done")!.disabled, false);
});

// --- the review's fixes (wait-gui: wg-F003 to wg-F010) -------------------------------------------------------------------------------------------------------------------------------------------------------------

const key = (name: string, extra: object = {}) => ({ type: "keydown", key: name, shiftKey: false, isComposing: false, keyCode: 13, preventDefault() {}, ...extra });
const unfold = (card: ReturnType<typeof rig>) => byClass(card, "wc-fold")[0]!.click();
const marked = (card: ReturnType<typeof rig>) => (card.el as unknown as El).find((el) => el.tag === "button" && el.classes.has("ask-opt") && el.getAttribute("aria-checked") === "true").map((el) => `${el.dataset.act}:${el.dataset.option ?? ""}`);

test("wg-F003: what you do is the panel's question: read whole at any length outside the dialog (no clamp, no More), and Zen sets a long one at the long question's size", () => {
	const long = "Open the admin page of the machine and re-authorize it, then set its key to never expire, so that this does not come back.";
	assert.ok(long.length > 90);
	for (const host of ["row", "zen"] as const) {
		page.body.replaceChildren();
		const card = rig(wait(fonstar({ do: long, happened: "It expired." })), { host });
		if (host === "row") unfold(card);
		const q = byClass(card, "ask-q")[0]!;
		assert.equal(q.classes.has("wc-clamp"), false, `${host}: the question is not clamped`);
		assert.equal(q.getAttribute("data-long"), "", `${host}: a long one is marked`);
		assert.equal(byClass(card, "wc-more").length, 0, `${host}: nothing is behind More`);
	}
	const rule = zen.split("\n").find((l) => l.startsWith('[data-view="zen"] .wait-card .ask-q[data-long] {'));
	assert.ok(rule, "Zen's rule for a wait card's long question");
	assert.match(rule!, /font-size:\s*clamp\(1\.05rem, 2\.2vw, 1\.25rem\)/);
	assert.doesNotMatch(rule!, /line-clamp/, "and no clamp");
});

test("wg-F004: a choice pressed elsewhere while a row is picked here drops the pick: Send is off and only the pressed option is marked", () => {
	const card = rig(wait(choice()));
	pick(card, "choose", 0);
	assert.equal(send(card).disabled, false);
	card.update(wait(choice(), { press: press("choose", { option: 1 }) }));
	assert.equal(send(card).disabled, true);
	assert.deepEqual(marked(card), ["choose:1"]);
});

test("wg-F005: after a choice is pressed the group's tab stop is the first row that can be pressed (Reply), not a disabled one", async () => {
	const card = rig(wait(choice()));
	go(card, "choose", 0);
	await settle();
	const rows = (card.el as unknown as El).find((el) => el.tag === "button" && el.classes.has("ask-opt"));
	assert.deepEqual(rows.map((el) => [el.dataset.act, el.disabled, el.getAttribute("tabindex")]), [["choose", true, "-1"], ["choose", true, "-1"], ["reply", false, "0"], ["skip", false, "-1"]]);
	assert.equal(card.enter(), true, "the dialog's focus lands on a row that works");
	assert.equal(page.activeElement, act(card, "reply"));
});

test("wg-F006: a wait that ended keeps no Send", () => {
	const card = rig(wait(fonstar()));
	assert.equal(send(card).parent!.hidden, false);
	card.update(wait(fonstar(), { state: "resolved", outcome: "declared done by the tower" }));
	assert.equal(send(card).parent!.hidden, true, "no dead button under the outcome");
	assert.ok(note(card).textContent.includes("declared done by the tower"));
});

test("wg-F007: a reply on a head card says the head tower took it, a workspace card the tower", async () => {
	for (const [head, said] of [[true, m.wait_sent_head()], [false, m.wait_sent()]] as const) {
		page.body.replaceChildren();
		pressed.length = 0;
		const card = rig(wait(fonstar()), head ? { head: true } : {});
		pick(card, "reply");
		byClass(card, "wait-box")[0]!.value = "later";
		byClass(card, "wait-box")[0]!.dispatchEvent(new Event("input"));
		send(card).click();
		await settle();
		assert.deepEqual(pressed, [said]);
	}
	assert.notEqual(m.wait_sent_head(), m.wait_sent());
});

test("wg-F008: Enter in Skip's reason box moves on to Send and declines nothing; a second Enter on Send is the press. Enter in the reply box still sends it", async () => {
	const card = rig(wait(fonstar()));
	pick(card, "skip");
	const why = byClass(card, "wc-skip-reason")[0]!;
	why.value = "no";
	why.dispatchEvent(key("Enter") as never);
	await settle();
	assert.equal(sent.length, 0, "nothing was declined");
	assert.equal(page.activeElement, send(card), "the focus is on Send");
	send(card).click();
	await settle();
	assert.deepEqual(sent.map((s) => s.body), [{ op: "press", id: "W9", act: "decline", reason: "no" }]);
	page.body.replaceChildren();
	const r = rig(wait(fonstar()));
	pick(r, "reply");
	const box = byClass(r, "wait-box")[0]!;
	box.value = "ok";
	box.dispatchEvent(key("Enter", { isComposing: true }) as never);
	await settle();
	assert.equal(told.length, 0, "an IME's Enter is not a send");
	box.dispatchEvent(key("Enter") as never);
	await settle();
	assert.equal(told.length, 1, "Enter sends the words");
});

test("wg-F009: folding a row drops its pick, so an unfolded card never opens with Skip marked", () => {
	const card = rig(wait(fonstar()), { host: "row" });
	unfold(card);
	pick(card, "skip");
	assert.equal(send(card).disabled, false);
	unfold(card); // folds
	unfold(card); // unfolds again
	assert.deepEqual(marked(card), []);
	assert.equal(send(card).disabled, true);
	assert.equal(card.confirming(), false);
});

test("wg-F010: a reason typed under Skip goes with no other act, and an accepted press clears the pick (Send is off, nothing is marked)", async () => {
	const card = rig(wait(fonstar()));
	pick(card, "skip");
	byClass(card, "wc-skip-reason")[0]!.value = "not needed";
	go(card, "done");
	await settle();
	assert.deepEqual(sent.map((s) => s.body), [{ op: "press", id: "W9", act: "done" }], "no reason with I'm done");
	const c = rig(wait(choice()));
	go(c, "choose", 1);
	await settle();
	assert.equal(send(c).disabled, true, "the accepted choice left no pick behind");
	assert.equal(c.confirming(), false);
});
