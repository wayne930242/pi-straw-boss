import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// The map's cards and base headers carry a stretched link (`.hit`, `.enter-base::after`) that covers them. A quit button inside one has to stack above it:
// a button that is not positioned paints under that link as soon as hovering lifts its opacity to 1 (it is a stacking context only while it is below 1),
// so its click navigated into the unit instead of opening the confirmation.
const css = readFileSync(new URL("../gui/style.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** What the stylesheet declares for `property` on exactly `selector` (as one of a comma-separated list, at any nesting), the last rule winning. */
function declared(selector: string, property: string): string | undefined {
	let found: string | undefined;
	for (const [, list, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
		if (!list!.split(",").some((s) => s.trim() === selector)) continue;
		const value = body!.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`))?.[1]?.trim();
		if (value) found = value;
	}
	return found;
}

const link = Math.max(...[".hit", ".enter-base::after"].map((s) => Number(declared(s, "z-index"))));

test("every quit button on a card or a base header stacks above the stretched link", () => {
	assert.ok(link >= 0, "the stretched links declare a z-index");
	for (const selector of [".card > .quit-btn", ".base > header > .quit-btn", ".tower-quit"]) {
		assert.ok(["relative", "absolute", "fixed", "sticky"].includes(declared(selector, "position") ?? "static"), `${selector} is positioned`);
		assert.ok(Number(declared(selector, "z-index")) > link, `${selector} is above the link (z-index ${link})`);
	}
});
