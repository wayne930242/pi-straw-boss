import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { AUTO_FILE, seal } from "../src/autostate.ts";
import { offNotice } from "../src/autotext.ts";
import { CALL_TOWER_DESCRIPTION } from "../src/link/waitcall.ts";
import { PROMPT_DIR, World } from "./fakes.ts";

// Boss questions asked by the main (docs/specs/2026-11-25-idle-wrap-up.md, part 2; boss 2026-11-25): with auto mode off a main asks the boss itself with ask_user_question in its own pane, so the boss sees
// which agent asks; `call_tower blocked` is for waits on someone other than the boss. Under auto mode sb refuses the ask and says to park it with call_tower, and the parked card comes back as wait_returned.

let world = new World();
afterEach(async () => {
	await world.stopAll();
	world = new World();
});
const read = (file: string) => readFileSync(join(PROMPT_DIR, file), "utf8");

test("main.md: blocked is for someone other than the boss; the boss's own decision is asked with ask_user_question, and parked with blocked under auto mode", () => {
	const main = read("main.md");
	assert.ok(main.includes("`blocked` when you wait on someone outside your tab other than the boss, or need a work's owner and do not know who"));
	assert.ok(main.includes("A decision only the boss can make: ask him yourself with `ask_user_question`; under auto mode sb refuses it (he is away), so `blocked` parks it and it returns as `wait_returned` when he is back."));
	assert.ok(!main.includes("or on a decision your authorizations do not cover"), "the old catch-all is gone");
	assert.match(CALL_TOWER_DESCRIPTION, /blocked \(you wait on someone outside your tab other than the boss; a boss decision: ask_user_question, or this under auto mode\)/);
});

test("tower-run.md: a local main's boss decision with auto mode off goes back to the main to ask itself; the other cards stay", () => {
	const run = read("tower-run.md");
	assert.ok(run.includes("A local main's decision only the boss can make, while your brief has no auto mode line: record no wait; tell the main with `tower_reply` to ask the boss itself with `ask_user_question` in its pane."));
	assert.ok(run.includes("Any other decision only the boss can make (under auto mode, a train's, a teammate device's, your own) is not sent back to the caller: record a wait for the boss in your memory"));
});

test("the signal a main reads: under auto mode its ask_user_question is refused with the way to park it, and the end notice sends it back to ask_user_question", async () => {
	const a = world.agent({ id: "main-1", pane: "wA:p1", tab: "wA:t1", ui: true });
	await a.start();
	await a.promote();
	const ask = () => a.fireResult("tool_call", { toolName: "ask_user_question", toolCallId: "q1", input: { questions: [{ header: "Deploy?", question: "Deploy to prod?" }] } }) as Promise<{ block?: boolean; reason?: string } | undefined>;
	assert.equal(await ask(), undefined, "with auto mode off the main asks the boss itself");
	writeFileSync(join(world.stateDir, AUTO_FILE), `${JSON.stringify(seal({ v: 1, rev: 1, on: true, since: "2026-11-25T00:00:00Z", by: { via: "pi", name: "test" } }))}\n`);
	const refused = await ask();
	assert.equal(refused?.block, true);
	assert.match(String(refused?.reason), /auto mode is on .*the boss is away.*park it: call_tower why: blocked/s);
	assert.match(offNotice("2026-11-25T01:00:00Z", "main"), /comes back to you as a wait_returned message.*Ask them again yourself then, with ask_user_question\./s);
});
