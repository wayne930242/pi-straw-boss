import assert from "node:assert/strict";
import { test } from "node:test";
import { PAD } from "../src/keys.ts";

// The key pad (gui/keypad.ts) as the page drives it: one key per trusted press of its own button, the server's confirm inline, and the
// buttons the mirror's state allows.

/** The few DOM calls the pad makes: elements with attributes, data, children, handlers, disabled, and focus. */
class El {
	attrs = new Map<string, string>();
	kids: (El | string)[] = [];
	dataset: Record<string, string> = {};
	disabled = false;
	focused = false;
	onclick: ((e: { isTrusted: boolean }) => void) | null = null;
	setAttribute(name: string, value: string) {
		this.attrs.set(name, value);
		if (name.startsWith("data-")) this.dataset[name.slice(5)] = value;
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
	all(): El[] {
		return this.kids.flatMap((k) => (k instanceof El ? [k, ...k.all()] : []));
	}
}
Object.assign(globalThis, { document: { createElement: () => new El() } });
const mod = await import("../gui/keypad.ts");
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function pad(state: "live" | "hidden" | "off" = "live") {
	const posts: Record<string, unknown>[] = [], replies: ((r: { ok: boolean; status: number; body: Record<string, unknown> }) => void)[] = [];
	const s = { state };
	const p = mod.keypad({ name: "billing", state: () => s.state, stream: () => "st", post: (action, body) => (assert.equal(action, "keys"), posts.push(body), new Promise((resolve) => replies.push(resolve))) });
	const el = p.el as unknown as El;
	const key = (k: string) => el.all().find((b) => b.dataset.key === k)!;
	const reply = async (status: number, body: Record<string, unknown> = {}) => (replies.shift()!({ ok: status < 300, status, body }), await tick());
	return { p, el, s, posts, key, reply, press: (k: string, isTrusted = true) => key(k).onclick!({ isTrusted }), keys: () => el.all().filter((b) => b.dataset.key).map((b) => b.dataset.key) };
}

test("the module exposes the pad and nothing that sends a sequence; the pad has exactly the server's keys", () => {
	assert.deepEqual(Object.keys(mod), ["keypad"]);
	const { keys, el } = pad();
	assert.deepEqual(keys().sort(), [...PAD].sort());
	assert.equal(el.attrs.get("aria-label"), "Keys for billing");
});

test("one key per trusted press of its button; a synthetic click sends nothing, and presses while a key is on its way wait their turn", async () => {
	const { press, posts, reply, key } = pad();
	press("up", false);
	assert.equal(posts.length, 0, "not the user's own press");
	press("up");
	assert.deepEqual(posts, [{ key: "up", stream: "st" }]);
	assert.ok(!key("down").disabled, "the buttons stay as they are while the key is on its way, so they do not flicker as you type");
	press("down");
	press("3");
	assert.equal(posts.length, 1, "one write at a time");
	await reply(200, { accepted: true });
	await new Promise((r) => setTimeout(r, 160));
	assert.deepEqual(posts.at(-1), { key: "down", stream: "st" }, "then the next, after the gap");
	await reply(200, { accepted: true });
	await new Promise((r) => setTimeout(r, 160));
	assert.deepEqual(posts.map((p) => p.key), ["up", "down", "3"]);
});

const gap = () => new Promise((r) => setTimeout(r, 160));

test("the server's confirm shows inline with its reason, and sends the same key with the token it named, once; Cancel sends nothing", async () => {
	const { press, posts, reply, el } = pad();
	press("enter");
	await reply(409, { error: "confirm", confirm: "reload", reason: "Enter would run /reload, which ends or replaces this session." });
	const note = el.all().find((x) => x.attrs.get("class") === "pad-note")!;
	assert.match(note.text, /\/reload/);
	const yes = note.all().find((x) => x.attrs.get("class") === "pad-yes")!;
	assert.ok(!yes.focused && note.all().find((x) => x.text === "Cancel")!.focused, "the focus goes to Cancel, so a second or held Enter does not confirm");
	yes.onclick!({ isTrusted: false });
	assert.equal(posts.length, 1, "a synthetic confirm sends nothing");
	yes.onclick!({ isTrusted: true });
	assert.deepEqual(posts.at(-1), { key: "enter", stream: "st", confirmed: "reload" });
	await reply(200, { accepted: true });
	assert.equal(note.text, "");
	press("esc");
	await gap(); // a press goes out after the gap since the last write, as typed keys do
	await reply(409, { error: "confirm", confirm: "double-esc", reason: "A second Escape on an idle session runs pi's double-Escape action." });
	note.all().find((x) => x.text === "Cancel")!.onclick!({ isTrusted: true });
	assert.equal(note.text, "");
	assert.equal(posts.length, 3);
	press("tab");
	await gap(); // a press goes out after the gap since the last write, as typed keys do
	await reply(409, { error: "no_mirror", reason: "Keys are sent only while this page shows the session's terminal live; open it again." });
	assert.match(note.text, /terminal live/, "a refusal says why");
});

test("a mirror hidden for a secret leaves only Escape; a stale, ended, or paused one leaves nothing", () => {
	const { p, s, key, keys } = pad("hidden");
	assert.deepEqual(keys().filter((k) => !key(k!).disabled), ["esc"]);
	s.state = "off";
	p.update();
	assert.deepEqual(keys().filter((k) => !key(k!).disabled), []);
	s.state = "live";
	p.update();
	assert.equal(keys().filter((k) => !key(k!).disabled).length, PAD.length);
});
