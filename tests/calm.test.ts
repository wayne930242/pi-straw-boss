import assert from "node:assert/strict";
import { test } from "node:test";
import { mountCalm } from "../gui/calm.ts";

// calm.ts (gui): after 30 s without input the page rests its infinite motion. In the Geek view nothing moves, so it does nothing there.

/** The globals calm.ts reads, with a clock the test moves; restored when `done` runs. */
function page() {
	let now = 1_000_000, id = 0;
	const timers = new Map<number, { at: number; fn: () => void }>(), listeners: Record<string, (() => void)[]> = {};
	const g = globalThis as Record<string, unknown>, saved = ["matchMedia", "addEventListener", "document", "setTimeout", "clearTimeout"].map((k) => [k, g[k]] as const), realNow = Date.now;
	g.matchMedia = () => ({ matches: false });
	g.addEventListener = (type: string, fn: () => void) => void (listeners[type] ??= []).push(fn);
	g.document = { hidden: false, addEventListener: (type: string, fn: () => void) => void (listeners[type] ??= []).push(fn) };
	g.setTimeout = (fn: () => void, ms: number) => (timers.set(++id, { at: now + ms, fn }), id);
	g.clearTimeout = (n: number) => void timers.delete(n);
	Date.now = () => now;
	const attrs = new Set<string>();
	const root = { dataset: {} as Record<string, string>, toggleAttribute: (name: string, on?: boolean) => void (on ? attrs.add(name) : attrs.delete(name)) } as unknown as HTMLElement;
	const advance = (ms: number) => {
		const end = now + ms;
		for (;;) {
			const next = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
			if (!next) break;
			timers.delete(next[0]);
			now = Math.max(now, next[1].at);
			next[1].fn();
		}
		now = end;
	};
	return {
		root, attrs, advance, pending: () => timers.size, input: () => (listeners.pointermove ?? []).forEach((fn) => fn()),
		done: () => (saved.forEach(([k, v]) => (v === undefined ? delete g[k] : (g[k] = v))), (Date.now = realNow)),
	};
}

test("in the Standard view the page calms after 30 s without input, and input wakes it", () => {
	const p = page();
	try {
		mountCalm(p.root);
		p.advance(29_000);
		assert.ok(!p.attrs.has("data-calm"));
		p.advance(2_000);
		assert.ok(p.attrs.has("data-calm"), "calm after 31 s");
		p.input();
		assert.ok(!p.attrs.has("data-calm"), "input restores the motion");
	} finally {
		p.done();
	}
});

test("in the Geek view calm does nothing: no timer, no data-calm, however long the page rests", () => {
	const p = page();
	try {
		p.root.dataset.view = "geek";
		mountCalm(p.root);
		assert.equal(p.pending(), 0, "no timer is armed");
		p.advance(10 * 60_000);
		p.input();
		assert.equal(p.pending(), 0);
		p.advance(10 * 60_000);
		assert.ok(!p.attrs.has("data-calm"));
	} finally {
		p.done();
	}
});

test("leaving the Geek view for Standard on input starts the calm clock again", () => {
	const p = page();
	try {
		p.root.dataset.view = "geek";
		mountCalm(p.root);
		p.root.dataset.view = "standard";
		p.input();
		p.advance(31_000);
		assert.ok(p.attrs.has("data-calm"));
	} finally {
		p.done();
	}
});
