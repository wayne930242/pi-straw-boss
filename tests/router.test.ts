import assert from "node:assert/strict";
import { test } from "node:test";
import { formatRoute, parseRoute, type Route, upOf, watchOf } from "../gui/router.ts";

test("routes parse below the base and format back, for the map, a workspace, and a session", () => {
	assert.deepEqual(parseRoute(""), { view: "map" });
	assert.deepEqual(parseRoute("w/wA"), { view: "workspace", ws: "wA" });
	assert.deepEqual(parseRoute("w/wA/s/abc"), { view: "session", ws: "wA", key: "abc" });
	assert.deepEqual(parseRoute("/w/wA/s/abc/"), { view: "session", ws: "wA", key: "abc" }, "slashes at either end do not matter");
	assert.deepEqual(parseRoute("w/wA/s/abc?x=1#top"), { view: "session", ws: "wA", key: "abc" });
	for (const route of [{ view: "map" }, { view: "workspace", ws: "wA" }, { view: "session", ws: "wA", key: "abc" }] as Route[]) assert.deepEqual(parseRoute(formatRoute(route)), route);
});

test("ids with slashes, spaces, percent signs, and non-ASCII letters survive a round trip", () => {
	for (const id of ["a/b", "a b", "100%", "w:1", "成型機 #3", "c-1/lint sweep", "..", ".", "../etc", "q?x=1#y"]) {
		const route: Route = { view: "session", ws: id, key: id };
		const path = formatRoute(route);
		assert.ok(!/[?#]/.test(path) && path.split("/").every((seg) => seg !== "" && seg !== "." && seg !== ".."), `${id} is encoded in ${path}`);
		assert.deepEqual(parseRoute(path), route, id);
	}
	assert.equal(formatRoute({ view: "session", ws: "a/b", key: "c d" }), "w/a%2Fb/s/c%20d");
});

test("a session route keeps the entry it opens at, and going up or watching ignores it", () => {
	const at: Route = { view: "session", ws: "wA", key: "k/1", at: "e 9/x" };
	assert.equal(formatRoute(at), "w/wA/s/k%2F1?at=e%209%2Fx");
	assert.deepEqual(parseRoute(formatRoute(at)), at);
	assert.deepEqual(parseRoute("w/wA/s/k?at="), { view: "session", ws: "wA", key: "k" }, "an empty anchor is no anchor");
	assert.deepEqual(parseRoute("w/wA?at=e1"), { view: "workspace", ws: "wA" }, "only a session has an anchor");
	assert.deepEqual([upOf(at), watchOf(at)], [{ view: "workspace", ws: "wA" }, "k/1"]);
});

test("anything that is not a route is the map, and a bad escape does not throw", () => {
	for (const rel of ["w", "w/", "x/y", "w//s/k", "assets/app.js", "events"]) assert.deepEqual(parseRoute(rel), { view: "map" }, rel);
	assert.deepEqual(parseRoute("w/%E0%A4%A"), { view: "workspace", ws: "%E0%A4%A" });
	assert.deepEqual(parseRoute("w/wA/s"), { view: "workspace", ws: "wA" }, "a session route needs its key");
});

test("one level up goes from a session to its workspace to the map, and each route says what the stream should watch", () => {
	const session: Route = { view: "session", ws: "wA", key: "k" };
	assert.deepEqual(upOf(session), { view: "workspace", ws: "wA" });
	assert.deepEqual(upOf(upOf(session)), { view: "map" });
	assert.deepEqual(upOf({ view: "map" }), { view: "map" });
	assert.deepEqual([watchOf({ view: "map" }), watchOf({ view: "workspace", ws: "wA" }), watchOf(session)], [null, "w:wA", "k"]);
});
