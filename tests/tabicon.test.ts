import assert from "node:assert/strict";
import { test } from "node:test";
import { manifests } from "./theme-fixture.ts";
import { badgeOf, iconHref, plainOf } from "../gui/tabicon.ts";

const badge = badgeOf(manifests, "standard", "day");
const SVG = "<svg xmlns='http://www.w3.org/2000/svg'><rect/></svg>";

test("the plain icon is the data URL decoded, or the built file fetched; a failed fetch leaves the icon alone (Z3R-F003, D1)", async () => {
	assert.equal(await plainOf(`data:image/svg+xml,${encodeURIComponent(SVG)}`), SVG);
	const asked: string[] = [];
	assert.equal(await plainOf("http://127.0.0.1:1/icon.svg", async (url) => (asked.push(url), { text: async () => SVG })), SVG, "a built page's link is a file URL");
	assert.deepEqual(asked, ["http://127.0.0.1:1/icon.svg"]);
	assert.equal(await plainOf("http://x/icon.svg", () => Promise.reject(new Error("offline"))), undefined);
});

test("the icon is plain for none waiting and carries the dot with the count, 9+ above nine, otherwise", () => {
	assert.equal(decodeURIComponent(iconHref(SVG, 0, badge).split(",")[1]!), SVG);
	const three = decodeURIComponent(iconHref(SVG, 3, badge).split(",")[1]!);
	assert.ok(three.includes("<circle") && three.includes(">3</text>") && three.endsWith("</svg>"));
	assert.ok(decodeURIComponent(iconHref(SVG, 12, badge).split(",")[1]!).includes(">9+</text>"));
	assert.ok(iconHref(SVG, 1, badge).startsWith("data:image/svg+xml,"), "never the URL string glued behind the prefix");
});

test("the link bar's chime stays quiet while Zen is on, and for a count of none (Z3RR-F003)", async () => {
	const { linkChime } = await import("../gui/linkbar.ts");
	let zen = false, rang = 0;
	const hear = linkChime(() => zen, () => void rang++);
	hear(0);
	hear(2);
	zen = true;
	hear(2);
	assert.equal(rang, 1);
});
