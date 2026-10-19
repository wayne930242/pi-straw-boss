import assert from "node:assert/strict";
import { test } from "node:test";
import { along } from "../gui/packets.ts";

test("a packet's keyframes lie evenly along its wire, so its pace stays even", () => {
	const wire = { x1: 0, y1: 0, x2: 300, y2: 180, mid: 150 };
	const points = along(wire);
	assert.deepEqual([points[0], points.at(-1)], [[0, 0], [300, 180]]);
	const steps = points.slice(1).map((p, i) => Math.hypot(p[0] - points[i]![0], p[1] - points[i]![1]));
	const mean = steps.reduce((a, b) => a + b) / steps.length;
	assert.ok(steps.every((s) => Math.abs(s - mean) < 0.5), `steps vary from ${Math.min(...steps).toFixed(2)} to ${Math.max(...steps).toFixed(2)}`);
});
