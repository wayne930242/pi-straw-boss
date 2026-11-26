import assert from "node:assert/strict";
import { test } from "node:test";
import { headCosts, headGate } from "../scripts/paint-head.mjs";

test("head timing sums all Paint but excludes SVG PrePaint; missing document or duration invalidates the capture", () => {
	const start = { name: "TracingStartedInBrowser", args: { data: { frames: [{ frame: "doc", isOutermostMainFrame: true, processId: 4, url: "http://localhost/demo/head?head=talk" }] } } };
	const event = (name: string, frame: string, dur: number) => ({ name, ph: "X", dur, args: { data: { frame } } });
	const doc = event("PrePaint", "doc", 500), svg = event("PrePaint", "svg", 2000);
	assert.deepEqual(headCosts([start], [doc, svg, event("Paint", "doc", 1200), event("Paint", "svg", 100)], 4),
		{ documentPrePaint: 1, paintMs: 1.3, documentPrePaintMs: 0.5 });
	assert.throws(() => headCosts([start], [svg], 4));
	assert.throws(() => headCosts([start], [doc], 5));
	assert.throws(() => headCosts([start], [{ ...doc, dur: undefined }], 4));
});

test("each live head window must meet BOTH limits, inclusive, against measured same-build references", () => {
	const run = (paint: number, paintMs: number) => headGate({ paint: 4 }, { paint, paintMs, documentPrePaintMs: 1 }, { paintMs: 7, documentPrePaintMs: 3 });
	assert.equal(run(12, 5).pass, true);
	assert.equal(run(13, 5).pass, false);
	assert.equal(run(12, 5.1).pass, false);
	assert.throws(() => headGate({ paint: 0 }, { paint: 1, paintMs: 1, documentPrePaintMs: 0 }, { paintMs: 1, documentPrePaintMs: 1 }));
});
