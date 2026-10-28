import assert from "node:assert/strict";
import { test } from "node:test";
import { deskMode, phoneHidden } from "../gui/desk.ts";
import { aimStash, showStashed } from "../gui/quit.ts";
import type { Base, Net } from "../src/net.ts";

// Desk mode in the page (desk-mode spec S9): the server marks the page with <meta name="sb-desk" content="1">, and the page then leaves out GUI remote access (the Phone button and its tile)
// and stash (each base's Stash button, the HUD's Stashed button and list). Hiding is presentation only: the server's routes stay.

const page = (content?: string) => ({ querySelector: (selector: string) => (selector === 'meta[name="sb-desk"]' && content !== undefined ? { content } : null) }) as unknown as Pick<Document, "querySelector">;
/** The few things the Stash button and the Stashed list touch. */
const button = () => Object.assign({ dataset: {} as Record<string, string>, hidden: true, textContent: "", setAttribute() {} }) as unknown as HTMLElement;
const list = () => {
	const el = { dataset: {} as Record<string, string>, kids: [] as unknown[], closest: () => null, replaceChildren(...kids: unknown[]) { el.kids = kids; } };
	return el as unknown as HTMLElement & { kids: unknown[] };
};
Object.assign(globalThis, { document: { createElement: () => ({ append() {}, className: "", setAttribute() {}, dataset: {} as Record<string, string> }) } });
const base = { id: "w1", label: "Harbor", mark: "idle", head: true, tower: null, outposts: [], outside: [], tabs: [] } as unknown as Base;
const stashed: Net = { bases: [], stashed: [{ name: "Harbor", label: "Harbor", at: "2026-10-22T09:00:00.000Z" }] } as unknown as Net;

test("the page is in desk mode only when the meta says 1", () => {
	assert.equal(deskMode(page("1")), true);
	assert.equal(deskMode(page()), false, "no meta");
	for (const other of ["", "0", "true", "yes"]) assert.equal(deskMode(page(other)), false, `content "${other}"`);
});

test("the Phone button is hidden in desk mode, and elsewhere only off this computer", () => {
	assert.equal(phoneHidden("127.0.0.1", true), true);
	assert.equal(phoneHidden("box.tail1.ts.net", true), true);
	assert.equal(phoneHidden("127.0.0.1", false), false, "without the marker nothing changes");
	assert.equal(phoneHidden("box.tail1.ts.net", false), true, "a paired device never had it");
});

test("a base's Stash button stays hidden in desk mode and is aimed as before without it", () => {
	const off = button(), on = button();
	aimStash(off, base, true);
	aimStash(on, base, false);
	assert.equal(off.hidden, true);
	assert.equal(on.hidden, false);
	assert.deepEqual({ ...on.dataset }, { ws: "w1", name: "Harbor" });
	assert.equal(on.textContent, "Stash");
});

test("the HUD's Stashed button and list stay empty and hidden in desk mode, and show a stash without it", () => {
	const [b, l] = [button(), list()];
	showStashed(b, l, stashed, true);
	assert.equal(b.hidden, true);
	assert.deepEqual(l.kids, []);
	showStashed(b, l, stashed, false);
	assert.equal(b.hidden, false);
	assert.equal(l.kids.length, 1);
});
