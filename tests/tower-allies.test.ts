import assert from "node:assert/strict";
import { test } from "node:test";
import type { TowerService } from "../src/net.ts";
import { El } from "./chat-dom.ts";

// The ally runs of a tower as chips (gui/towerallies.ts): a chip per run, a link to the run's comms while its unit is known and a plain statement while it is not, a count first with several, and nothing
// drawn again while the runs are the same.

const { fillAllies } = await import("../gui/towerallies.ts");
const { m } = await import("../gui/paraglide/messages.js");

const run = (id: string, label: string, key?: string) => ({ id, device: "d".repeat(26), label, startedAt: "2026-10-28T08:00:00Z", ...(key ? { key } : {}) });
const service = (...allyRuns: TowerService["allyRuns"]): TowerService => ({ state: "standing", queued: 0, allyRuns, notices: [], parked: [] });
const draw = (box: El, s?: TowerService) => fillAllies(box as unknown as HTMLElement, "wA", s);

test("one run is one chip: a link to its comms while the net knows its unit, else a plain chip that says why it opens nothing", () => {
	const box = new El("div");
	draw(box, service(run("r1", "Laptop", "ally-r1"), run("r2", "Desk")));
	const chips = box.find((el) => el.attrs.get("class") === "ally-chip");
	assert.deepEqual(chips.map((c) => [c.tag, c.textContent]), [["a", m.ally_run({ device: "Laptop" })], ["span", m.ally_run({ device: "Desk" })]]);
	assert.equal(chips[0]!.attrs.get("data-route"), "w/wA/s/ally-r1");
	assert.equal(chips[0]!.attrs.get("title"), m.ally_run_open());
	assert.equal(chips[1]!.attrs.get("title"), m.ally_run_unseen());
	assert.equal(box.hidden, false);
	assert.equal(box.find((el) => el.tag === "b")[0]!.textContent, m.ally_runs({ count: 2 }), "with several runs the count comes first");
});

test("one run has no count, no runs hide the box, and a device label is only ever text", () => {
	const box = new El("div");
	draw(box, service(run("r1", "<img src=x onerror=1>", "ally-r1")));
	assert.equal(box.find((el) => el.tag === "b").length, 0);
	assert.equal(box.find((el) => el.attrs.get("class") === "ally-chip")[0]!.textContent, m.ally_run({ device: "<img src=x onerror=1>" }));
	assert.equal(box.find((el) => el.tag === "img").length, 0);
	draw(box, service());
	assert.equal(box.hidden, true);
	assert.deepEqual(box.kids, []);
	draw(box, undefined);
	assert.equal(box.hidden, true);
});

test("the chips are drawn again only when the runs change, so a click never lands on a replaced chip", () => {
	const box = new El("div"), s = service(run("r1", "Laptop", "ally-r1"));
	draw(box, s);
	const first = box.kids[0];
	draw(box, service(run("r1", "Laptop", "ally-r1")));
	assert.equal(box.kids[0], first, "the same runs: the same elements");
	draw(box, service(run("r1", "Laptop", "ally-r1"), run("r3", "Desk")));
	assert.notEqual(box.kids[0], first);
});
