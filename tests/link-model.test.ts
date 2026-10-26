import assert from "node:assert/strict";
import { test } from "node:test";
import type { LinkAlert } from "../src/link/holder.ts";
import { alertLine, allyMark, countdown, hasLinkNews, lastSeen, stateName, urgentFirst } from "../gui/linkmodel.ts";
import { m } from "../gui/paraglide/messages.js";

// What the page says about Straw Link (gui/linkmodel.ts): the notices in words, an invite's countdown, a teammate's last presence, and the marks of an ally base.

const alert = (kind: LinkAlert["kind"], data: LinkAlert["data"], level: LinkAlert["level"] = "warning"): LinkAlert => ({ id: kind, kind, level, team: "t", teamName: "moldplan", data });

test("every notice kind reads in English and in Chinese, with the teammate's words only as data", () => {
	const all: LinkAlert[] = [
		alert("join-request", { label: "bob-mac", short: "abc123", unattended: 0 }), alert("join-request", { label: "ci-box", short: "def456", unattended: 1 }),
		alert("confirm", { label: "bob-mac", short: "abc123", tool: "bash" }), alert("fork", { reason: "entry 4 is invalid" }, "error"),
		alert("mismatch", { label: "bob-mac", short: "abc123" }, "error"), alert("unreachable", { minutes: 3 }), alert("inbox", { count: 2 }, "info"), alert("held", { count: 1 }, "info"),
	];
	const en = all.map(alertLine), zh = all.map((a) => ((l) => l)(alertLine(a)));
	assert.deepEqual(en.slice(0, 3), [
		"bob-mac (abc123) asks to join team moldplan",
		"ci-box (def456), an unattended device, asks to join team moldplan",
		"bob-mac (abc123) asks you to confirm a bash call from its tower",
	]);
	assert.match(en[3]!, /^Team moldplan stopped: entry 4 is invalid$/);
	assert.match(en[5]!, /unreachable for 3 minutes/);
	assert.match(m.link_a_join({ label: "bob-mac", short: "abc123", team: "moldplan" }, { locale: "zh-TW" }), /bob-mac（abc123）要求加入團隊 moldplan/);
	assert.ok(zh.every((t) => t.length > 0));
	// Markup in a teammate's label stays text: the function returns a string and the page puts it in a text node.
	assert.equal(alertLine(alert("join-request", { label: "<img src=x onerror=1>", short: "abc123", unattended: 0 })), "<img src=x onerror=1> (abc123) asks to join team moldplan");
});

test("the worst notice comes first", () => {
	const sorted = urgentFirst([alert("inbox", {}, "info"), alert("unreachable", {}, "warning"), alert("fork", {}, "error")]);
	assert.deepEqual(sorted.map((a) => a.level), ["error", "warning", "info"]);
});

test("an invite counts down as m:ss and stops at 0:00", () => {
	assert.equal(countdown(10 * 60_000), "10:00");
	assert.equal(countdown(61_000), "1:01");
	assert.equal(countdown(999), "0:01");
	assert.equal(countdown(-5), "0:00");
	assert.equal(countdown(3600_000), "1:00:00");
	assert.equal(countdown(23 * 3600_000 + 54 * 60_000 + 26_000), "23:54:26");
});

test("a teammate's last presence: online, how long ago, or not seen", () => {
	assert.equal(lastSeen(null, false), "not seen yet");
	assert.equal(lastSeen(10_000, true), "online");
	assert.equal(lastSeen(5 * 60_000, false), "seen 5m ago");
	assert.equal(lastSeen(3 * 3600_000, false), "seen 3h ago");
});

test("an ally base takes its mark from the tower's state, dim while offline", () => {
	assert.equal(allyMark({ online: false, tower: "working" }), "unknown");
	assert.equal(allyMark({ online: true, tower: "working" }), "working");
	assert.equal(allyMark({ online: true, tower: "blocked" }), "waiting");
	assert.equal(allyMark({ online: true, tower: "idle" }), "idle");
	assert.equal(allyMark({ online: true, tower: "unknown" }), "unknown");
	assert.equal(stateName("blocked"), "waiting on a question");
	assert.equal(stateName("brand-new-state"), "brand-new-state");
});

test("the HUD's Link button shows only when there is a notice or a confirm", () => {
	assert.equal(hasLinkNews(undefined), false);
	assert.equal(hasLinkNews({ allies: [], alerts: [], confirms: [] }), false);
	assert.equal(hasLinkNews({ allies: [], alerts: [alert("inbox", {})], confirms: [] }), true);
});
