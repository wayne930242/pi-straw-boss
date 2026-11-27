import assert from "node:assert/strict";
import { test } from "node:test";
import { annotateLost, LOST_NOTE, lostOf } from "../src/host/lost.ts";
import { setHostState } from "../src/host/state.ts";
import { World } from "./fakes.ts";

// A worker of sb's own host whose pane or pi went before its report: sb tells the launcher once, on the failed result itself (name, session file, the
// resume call), and does nothing else. The revive, inherit, orphan-nudge and restore paths, written for pi-herdr-agents' runs, stand aside.

const PANE_GONE = "Subagent pane disappeared before completion evidence was recorded.";
const result = (details: Record<string, unknown>) => ({ role: "custom", customType: "subagent_result", content: `Sub-agent "scout-1" failed.`, details, display: true });

test("a closed pane, a pi that ended, and a non-zero exit with no report are a lost worker; a cancel, a reported error, exit 0 and Ctrl-C are not", () => {
	const file = "/s/2026_abc-11111111-22222222-3333.jsonl";
	assert.deepEqual(lostOf({ name: "scout-1", sessionFile: file, errorMessage: PANE_GONE }), { file, name: "scout-1", why: "its pane closed" });
	assert.equal(lostOf({ name: "x", sessionFile: file, errorMessage: "Subagent process exited before completion evidence was recorded." })?.why, "its pi ended");
	assert.equal(lostOf({ name: "x", sessionFile: file, exitCode: 137 })?.why, "its pi exited with code 137");
	for (const d of [{ exitCode: 0 }, { exitCode: 130 }, { error: "cancelled", cancellation: {} }, { errorMessage: "429 rate limited" }, {}]) assert.equal(lostOf({ name: "x", sessionFile: file, ...d }), undefined, JSON.stringify(d));
});

test("the failed result gets one paragraph naming the worker, its session file and the resume call, and a message already told is left alone", () => {
	const told = annotateLost(result({ name: "scout-1", sessionFile: "/s/f.jsonl", errorMessage: PANE_GONE }))!;
	assert.match(told.content as string, /^Sub-agent "scout-1" failed\.\n\nStraw Boss: this worker ended without a result\. "scout-1" stopped before it reported: its pane closed\. Its session file is \/s\/f\.jsonl\. To continue it, call subagent_resume with sessionPath "\/s\/f\.jsonl"/);
	assert.doesNotMatch(told.content as string, /revive[sd]? it from|Do not resume/);
	assert.equal(annotateLost(told), undefined, "once");
	assert.equal(annotateLost({ ...result({ name: "x", sessionFile: "/s/f.jsonl", exitCode: 0 }) }), undefined);
});

test("under sb's host a session hands the lost paragraph, not the revive promise", async (t) => {
	const w = new World(), a = w.agent({ id: "s1", pane: "w1:p1", tab: "w1:t1" });
	await a.start();
	setHostState({ state: "active", from: "default" });
	t.after(() => setHostState({ state: "pending", from: "default" }));
	const out = (await a.fireResult("message_end", { message: result({ name: "scout-1", sessionFile: "/s/f.jsonl", exitCode: 137 }) })) as { message: { content: string } };
	assert.ok(out.message.content.includes(LOST_NOTE));
	assert.doesNotMatch(out.message.content, /Straw Boss revives it/);
	setHostState({ state: "stood-down", from: "default", why: "pi-herdr-agents registered /subagent", others: [] });
	const old = (await a.fireResult("message_end", { message: result({ name: "scout-1", sessionFile: "/s/f.jsonl", exitCode: 137 }) })) as { message?: { content: string } } | undefined;
	assert.ok(!old?.message?.content.includes(LOST_NOTE), "with pi-herdr-agents as the host the older paths keep their runs");
	await a.stop();
});
