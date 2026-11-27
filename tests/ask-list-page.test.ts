import assert from "node:assert/strict";
import { test } from "node:test";
import type { AskView } from "../src/asktypes.ts";
import { El, sessionGlobals } from "./fake-dom.ts";

// The open questions to the boss on the page (docs/specs/2026-11-28-boss-asks.md, The GUI): the list on the head and workspace pages, a row's card (a wait card's alert, else its unit's), Terminal only for an asker
// with a pane, and the count pill on a plate.

sessionGlobals();
const { askAlert, fillAskList } = await import("../gui/asklist.ts");
const { asksBadge } = await import("../gui/render.ts");

const NOW = Date.now(), MIN = 60_000;
const ASKS: AskView[] = [
	{ id: "a1", n: 3, kind: "boss", subject: "Deploy tonight?", asker: "billing-main", where: "Harbor API › billing", since: NOW - 7 * MIN, ws: "w1", unit: "a1", pane: true, item: { session: "a1", id: 2 } },
	{ id: "a2", n: 5, kind: "wait", subject: "Approve the key", asker: "checkout-main", where: "Lighthouse Web › checkout", since: NOW - 26 * MIN, ws: "w2", unit: "b1", wait: "W2" },
	{ id: "a3", n: 6, kind: "link", subject: "ci-box asks", asker: "ci-box", where: "ci-box", since: NOW - 64 * MIN, ws: "w2", unit: "t2", wait: "W3" },
];

test("the list: hidden with none; a row per Ask with its number, kind, subject, asker and where, the todo it blocks, its card, and Terminal only with a pane", () => {
	const box = new El("section") as unknown as HTMLElement;
	fillAskList(box, []);
	assert.equal(box.hidden, true);
	fillAskList(box, ASKS);
	assert.equal(box.hidden, false);
	const rows = [...box.querySelectorAll<HTMLElement>(".ask-row")];
	assert.equal(rows.length, 3);
	const [boss, wait, link] = rows.map((r) => ({ id: r.querySelector(".ask-id")!.textContent, who: r.querySelector(".ask-who")!.textContent, blocks: r.querySelector(".ask-blocks")!.textContent, open: r.querySelector<HTMLElement>(".ask-open")!.dataset, term: r.querySelector<HTMLButtonElement>(".ask-term")! }));
	assert.deepEqual([boss!.id, boss!.who, boss!.blocks, boss!.open.askAlert, boss!.open.askUnit, boss!.term.hidden, boss!.term.dataset.askTerm], ["Q3", "billing-main · Harbor API › billing", "blocks #2", "a1", "a1", false, "a1"]);
	assert.deepEqual([wait!.open.askAlert, wait!.term.hidden], ["wait\u001fw2\u001fW2", true], "a wait opens its card; no pane, no Terminal");
	assert.equal(link!.who, "ci-box", "a device is named once");
	assert.equal(askAlert(ASKS[2]!), "wait\u001fw2\u001fW3");
});

test("the plate's pill shows the count and hides at none", () => {
	const plate = new El("div") as unknown as HTMLElement, pill = new El("b");
	pill.className = "asks";
	plate.append(pill as unknown as HTMLElement);
	asksBadge(plate, 2);
	assert.deepEqual([(pill as unknown as HTMLElement).hidden, pill.textContent], [false, "2"]);
	asksBadge(plate, 0);
	assert.equal((pill as unknown as HTMLElement).hidden, true);
});
