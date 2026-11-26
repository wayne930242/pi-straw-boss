import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { onTheme, showTheme } from "../gui/themes/registry.ts";
import { manifests } from "./theme-fixture.ts";

const events: string[] = [], geek = Promise.withResolvers<void>();
// Fake only the two lazy entry modules. Hold Geek's import until the page is back in Storybook.
export async function loadEntry(view: string) {
	if (view === "geek") await geek.promise;
	return { mount() { events.push(`mount ${view}`); return { stop: () => events.push(`stop ${view}`) }; } };
}

test("Storybook → pending Geek → Storybook stops the old mount and clock; the late Geek cannot mount or notify", async (t) => {
	const hook = registerHooks({ load(url, ctx, next) {
		const match = /\/gui\/themes\/(storybook|geek)\/index\.ts$/.exec(url);
		if (!match) return next(url, ctx);
		return { format: "module", shortCircuit: true, source: `import { loadEntry } from ${JSON.stringify(import.meta.url)}; export const theme = await loadEntry(${JSON.stringify(match[1])});` };
	} });
	t.after(() => hook.deregister());
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const doc = Object.assign(new EventTarget(), { documentElement: { dataset: { view: "storybook" } }, querySelector: () => ({ content: JSON.stringify(manifests) }), querySelectorAll: () => [] });
	const win = new EventTarget();
	Object.assign(globalThis, { document: doc, window: win });
	t.after(() => { Reflect.deleteProperty(globalThis, "document"); Reflect.deleteProperty(globalThis, "window"); });
	const clocks = () => [getEventListeners(doc, "visibilitychange").length, getEventListeners(win, "pageshow").length];
	const show = (view: "storybook" | "geek" | "standard") => showTheme(view, () => {});
	onTheme(view => events.push(`show ${view}`));

	await show("storybook");
	assert.deepEqual(clocks(), [1, 1]);
	const late = show("geek");
	assert.deepEqual(events, ["mount storybook", "show storybook", "stop storybook"]);
	assert.deepEqual(clocks(), [0, 0], "leave before the next import finishes");
	await show("storybook");
	geek.resolve();
	await late;
	assert.deepEqual(clocks(), [1, 1], "only the new clock listens");
	await show("standard");
	assert.deepEqual(clocks(), [0, 0]);
	assert.deepEqual(events, ["mount storybook", "show storybook", "stop storybook", "mount storybook", "show storybook", "stop storybook", "show standard"]);
});
