import assert from "node:assert/strict";
import { test } from "node:test";
import { createFaces, LEASE_MS, SETTLE_MS } from "../src/lan/faces.ts";
import { fakeClock } from "./fake-clock.ts";

// The overlay-open marks of /boss gui lan (docs/specs/2026-10-30-sb-gui-lan.md, "Approval on this computer", *Not from a paired device*, D9; Steps L5): the face id, the 5 s lease the overlay's poll renews, the mark per pane, and the
// per-pane time of the last paired write that a face's answers look at.

const world = () => {
	const clock = fakeClock(1_000_000);
	return { clock, faces: createFaces(clock.now) };
};

test("a face's open sets a mark on its pane and answers a 32-hex id; a pane that is no pane id, or a non-string, gets none", () => {
	const { faces } = world();
	const id = faces.open("wA:p1")!;
	assert.match(id, /^[0-9a-f]{32}$/);
	assert.equal(faces.marked("wA:p1"), true);
	assert.equal(faces.marked("wA:p2"), false, "only that pane");
	assert.equal(faces.marked(undefined), false);
	for (const bad of ["", "a b", "x".repeat(65), "wA:p1\n", 7, undefined, {}]) assert.equal(faces.open(bad), undefined, JSON.stringify(bad));
	assert.notEqual(faces.open("wA:p1"), id, "every open is a new id");
});

test("a pi outside Herdr (pane null) gets a face id and no mark anywhere", () => {
	const { faces } = world();
	const id = faces.open(null)!;
	assert.ok(id);
	assert.equal(faces.any(), true);
	assert.equal(faces.marked("wA:p1"), false);
	assert.deepEqual(faces.accepts(id), { ok: true }, "and nothing can have been typed into it");
});

test("the mark is a lease: 5 s after the last renewal it is gone, a renewal makes it 5 s again, and a lapsed face is unknown", () => {
	const { clock, faces } = world();
	const id = faces.open("wA:p1")!;
	clock.advance(LEASE_MS - 1);
	assert.equal(faces.marked("wA:p1"), true);
	assert.equal(faces.renew(id), true);
	clock.advance(LEASE_MS - 1);
	assert.equal(faces.marked("wA:p1"), true, "the renewal made another 5 s");
	clock.advance(2);
	assert.equal(faces.marked("wA:p1"), false, "a pi that hung leaves a mark for at most 5 s");
	assert.equal(faces.renew(id), false, "and its face is unknown to a renewal (the overlay opens a new one)");
	assert.deepEqual(faces.accepts(id), { ok: false, error: "unknown_face" });
	assert.equal(faces.any(), false);
});

test("closing needs the face's own id: a close or a renewal with another id, a made-up one, or none changes nothing; the right one drops the mark", () => {
	const { faces } = world();
	const a = faces.open("wA:p1")!, b = faces.open("wA:p2")!;
	for (const wrong of ["wA:p1", "0".repeat(32), "", undefined, null, 7]) {
		assert.equal(faces.close(wrong), false, JSON.stringify(wrong));
		assert.equal(faces.renew(wrong), false, JSON.stringify(wrong));
	}
	assert.equal(faces.marked("wA:p1"), true);
	assert.equal(faces.close(b), true);
	assert.equal(faces.marked("wA:p2"), false);
	assert.equal(faces.marked("wA:p1"), true, "another face's close left this one");
	assert.equal(faces.close(b), false, "closed twice is closed once");
	assert.equal(faces.renew(a), true);
	assert.equal(faces.close(a), true);
	assert.equal(faces.marked("wA:p1"), false);
});

test("two faces on one pane: the mark stays until both are gone; an open naming another pane marks only that one and clears nothing", () => {
	const { faces } = world();
	const a = faces.open("wA:p1")!, b = faces.open("wA:p1")!;
	faces.close(a);
	assert.equal(faces.marked("wA:p1"), true);
	faces.open("wA:p9");
	assert.equal(faces.marked("wA:p9"), true, "it can add a mark where it names");
	assert.equal(faces.marked("wA:p1"), true, "and clear none");
	faces.close(b);
	assert.equal(faces.marked("wA:p1"), false);
});

test("a face's answers are refused after a paired device wrote to its pane less than 1.5 s before it opened, or at any time after; Escape never counts, and another pane's writes do not", () => {
	const { clock, faces } = world();
	faces.wrote("wA:p1"); // a composer send, a pad key, a take-back: not Escape (the routes do not note Escape)
	clock.advance(SETTLE_MS - 1);
	const tainted = faces.open("wA:p1")!;
	assert.deepEqual(faces.accepts(tainted), { ok: false, error: "typed_into" }, "a key that passed its check before the mark was set may still be read after the face mounts");
	clock.advance(10);
	const other = faces.open("wA:p9")!;
	assert.deepEqual(faces.accepts(other), { ok: true }, "a write to another pane is not this face's");
	clock.advance(SETTLE_MS * 2);
	const clean = faces.open("wA:p1")!;
	assert.deepEqual(faces.accepts(clean), { ok: true }, "a write more than 1.5 s before the open is past");
	faces.wrote("wA:p1");
	assert.deepEqual(faces.accepts(clean), { ok: false, error: "typed_into" }, "and one after the open taints it (it would have been refused by the mark, so this is a write that raced it)");
	faces.wrote(undefined);
	assert.deepEqual(faces.accepts(other), { ok: true });
});

test("a face's answers need a live face: an unknown, closed, or lapsed id is refused; the id of one face does not answer for another", () => {
	const { clock, faces } = world();
	const a = faces.open("wA:p1")!, b = faces.open("wA:p2")!;
	assert.deepEqual(faces.accepts(undefined), { ok: false, error: "unknown_face" });
	assert.deepEqual(faces.accepts("0".repeat(32)), { ok: false, error: "unknown_face" });
	faces.wrote("wA:p2");
	assert.deepEqual(faces.accepts(a), { ok: true }, "p2's write is not a's");
	assert.deepEqual(faces.accepts(b), { ok: false, error: "typed_into" });
	faces.close(a);
	assert.deepEqual(faces.accepts(a), { ok: false, error: "unknown_face" });
	clock.advance(LEASE_MS + 1);
	assert.deepEqual(faces.accepts(b), { ok: false, error: "unknown_face" }, "lapsed wins over tainted: it is not live");
});

test("faces are bounded: past 64 live ones an open is refused until some lapse", () => {
	const { clock, faces } = world();
	for (let i = 0; i < 64; i++) assert.ok(faces.open("wA:p1"));
	assert.equal(faces.open("wA:p1"), undefined);
	clock.advance(LEASE_MS + 1);
	assert.ok(faces.open("wA:p1"));
});
