import assert from "node:assert/strict";
import { test } from "node:test";
import { branchProblem, clampPoints, parseWorker, workerMessage, workerSpec } from "../src/workerslip.ts";

// The worker slip (docs/specs/2026-11-26-ally-workers.md): the line the controller's code writes and the box's code reads back, and the branch rules both sides share.

test("a slip written by workerMessage reads back to the same spec and brief", () => {
	const spec = workerSpec({ label: "MP-12 | fix", branch: "feat/mp-12", base: "origin/develop", model: "openai-codex/gpt-6.2-astra", points: 2 });
	assert.equal(spec.label, "MP-12 fix", "a | in the label is no field separator");
	const text = workerMessage(spec, "Do the thing.\nLine two | kept");
	assert.equal(text.split("\n")[0], "worker: MP-12 fix | branch: feat/mp-12 | base: origin/develop | model: openai-codex/gpt-6.2-astra | points: 2");
	assert.deepEqual(parseWorker(text), { spec, brief: "Do the thing.\nLine two | kept" });
	assert.deepEqual(parseWorker("worker: x | branch: fix/a\nbrief"), { spec: { label: "x", branch: "fix/a", points: 1 }, brief: "brief" }, "base, model and points are optional");
	assert.equal(parseWorker("hello\nworker: x | branch: a"), undefined, "only the first line is a slip");
});

test("the points are clamped to 0.25..10 in quarter steps; none is 1", () => {
	assert.deepEqual([clampPoints(undefined), clampPoints(0.01), clampPoints(0.6), clampPoints(99)], [1, 0.25, 0.5, 10]);
	assert.ok("error" in parseWorker("worker: x | branch: a | points: zero\nb")!);
	assert.ok("error" in parseWorker("worker: x | branch: a | points: -1\nb")!);
});

test("the branch, base, model and line are refused as the table says", () => {
	for (const b of ["main", "develop", "release/1.2", "pre-dev/x", "train-3", "agent-train/a", "-x", "a..b", "a//b", "a/.b", "x.lock", "a b", "a;rm", "/a", "a/", ""]) assert.ok(branchProblem(b), `refuses ${JSON.stringify(b)}`);
	for (const b of ["feat/ally-workers", "fix/MP-123", "a_b.c-d"]) assert.equal(branchProblem(b), undefined, b);
	assert.ok(branchProblem("hotfix/x", ["hotfix/x"]), "apps.json integration names are reserved too");
	const bad = ["worker: x\nb", "worker: x | branch: a | base: --upload-pack=x\nb", "worker: x | branch: a | model: $(id)\nb", "worker: x | branch: a | colour: red\nb", "worker: x | branch: a | branch: b\nb", "worker: x | branch: a"];
	for (const t of bad) assert.ok("error" in parseWorker(t)!, t);
	assert.throws(() => workerMessage(workerSpec({ branch: "a" }), "  "), /needs a brief/);
});
