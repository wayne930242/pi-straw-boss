import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { createCaps, docsOf, fieldsOk, listenDocs, submitForm } from "../src/documents.ts";
import type { Bus } from "../src/owners.ts";

// The fixtures are pi-herdr-doc-review 0.4.x's event shapes (its README's "Browser viewers" and src/index.ts: PublishedDocument, FormResult).
const DOC = { id: "6f1e2d3c-4b5a-4968-8776-655443322110", path: "/work/docs/plan.html", kind: "html", display: "docs/plan.html", reason: "Plan ready", revision: 1, onScreen: true };
function bus() {
	const on = new Map<string, ((data: unknown) => void)[]>(), seen: [string, unknown][] = [];
	const b: Bus & { seen: typeof seen; count(): number } = {
		seen,
		emit: (channel, data) => (seen.push([channel, data]), [...(on.get(channel) ?? [])].forEach((h) => h(data))),
		on: (channel, handler) => (on.set(channel, [...(on.get(channel) ?? []), handler]), () => on.set(channel, (on.get(channel) ?? []).filter((h) => h !== handler))),
		count: () => [...on.values()].reduce((n, hs) => n + hs.length, 0),
	};
	return b;
}

test("a contract-v1 list is taken whole or not at all: every field in its shape, absolute paths, positive revisions, unique ids, at most 32", () => {
	assert.deepEqual(docsOf({ version: 1, documents: [{ ...DOC, extra: "dropped" }] }), [DOC], "unknown fields are not relayed");
	assert.deepEqual(docsOf({ version: 1, documents: [] }), [], "an empty list (the session ended) is a list");
	assert.deepEqual(docsOf({ version: 1, documents: [{ ...DOC, display: "d".repeat(2000), reason: "r".repeat(9000) }] })!.map((d) => [d.display.length, d.reason.length]), [[1024, 2048]], "display and reason are cut, not refused");
	for (const bad of [{ ...DOC, path: "docs/plan.html" }, { ...DOC, kind: "pdf" }, { ...DOC, revision: 0 }, { ...DOC, revision: 1.5 }, { ...DOC, onScreen: "yes" }, { ...DOC, id: 7 }, { ...DOC, id: "x".repeat(65) }, { ...DOC, reason: undefined }, null])
		assert.equal(docsOf({ version: 1, documents: [bad] }), undefined, JSON.stringify(bad));
	assert.equal(docsOf({ version: 2, documents: [DOC] }), undefined, "another version");
	assert.equal(docsOf({ version: 1, documents: [DOC, DOC] }), undefined, "two entries with one id");
	assert.equal(docsOf({ version: 1, documents: Array.from({ length: 33 }, (_, i) => ({ ...DOC, id: `d${i}` })) }), undefined, "past the owner's 32");
	assert.ok(fieldsOk([["a", "1"], ["a", "2"]]) && fieldsOk([]));
	for (const bad of [[["a"]], [["a", 1]], "a=1", Array.from({ length: 65 }, () => ["a", "b"])]) assert.equal(fieldsOk(bad), false, JSON.stringify(bad).slice(0, 40));
});

test("listening asks the owner for its list once and takes each list it publishes in shape; the off removes the listener", () => {
	const b = bus(), lists: unknown[] = [];
	b.on("doc-review:documents-request", () => b.emit("doc-review:documents", { version: 1, documents: [DOC] }));
	const off = listenDocs(b, (docs) => lists.push(docs));
	assert.deepEqual(b.seen[0], ["doc-review:documents-request", { version: 1 }]);
	b.emit("doc-review:documents", { version: 1, documents: [{ ...DOC, revision: 2 }] });
	b.emit("doc-review:documents", { version: 1, documents: [{ ...DOC, path: "relative" }] });
	b.emit("doc-review:documents", { version: 2, documents: [DOC] });
	assert.deepEqual(lists, [[DOC], [{ ...DOC, revision: 2 }], []], "a v1 list out of shape is none; another version is not heard");
	off();
	assert.equal(b.count(), 1, "only the test's owner listener is left");
});

test("a form goes to the owner as doc-review:form; only the result for its document and answerId counts, once; a silent owner leaves nothing behind after 4 s", () => {
	const b = bus(), results: unknown[] = [];
	b.on("doc-review:form", (raw) => {
		const f = raw as { id: string; answerId: string };
		b.emit("doc-review:form-result", { version: 1, id: "other", answerId: f.answerId, accepted: true });
		b.emit("doc-review:form-result", { version: 1, id: f.id, answerId: "another", accepted: true });
		b.emit("doc-review:form-result", { version: 2, id: f.id, answerId: f.answerId, accepted: true });
		b.emit("doc-review:form-result", { version: 1, id: f.id, answerId: f.answerId, accepted: false, reason: "delivery failed: busy" });
		b.emit("doc-review:form-result", { version: 1, id: f.id, answerId: f.answerId, accepted: true });
	});
	submitForm(b, DOC.id, "n".repeat(32), [["choice", "b"]], (r) => results.push(r));
	assert.deepEqual(b.seen.find(([c]) => c === "doc-review:form")?.[1], { version: 1, id: DOC.id, answerId: "n".repeat(32), fields: [["choice", "b"]] });
	assert.deepEqual(results, [{ accepted: false, reason: "delivery failed: busy" }], "the first matching result, once");
	assert.equal(b.count(), 1, "its listener went with the result");
	mock.timers.enable({ apis: ["setTimeout"] });
	try {
		const quiet = bus(), heard: unknown[] = [];
		submitForm(quiet, DOC.id, "q".repeat(32), [["a", "b"]], (r) => heard.push(r));
		assert.equal(quiet.count(), 1);
		mock.timers.tick(4000);
		assert.deepEqual([quiet.count(), heard.length], [0, 0], "no result: nothing reported, nothing left listening");
	} finally {
		mock.timers.reset();
	}
});

test("capabilities: 128 random bits per (session, bridge, document), stable while some bridge lists it, unknown once it is not, all new after clear", () => {
	const caps = createCaps(), d = docsOf({ version: 1, documents: [DOC] })!;
	const listed = new Set([`S\nB\n${DOC.id}`]), first = caps.bind([{ key: "S", from: "S", bridgeId: "B", docs: d }], listed).get("S")![0]!;
	assert.match(first.cap, /^[0-9a-f]{32}$/);
	assert.deepEqual({ ...first, cap: "" }, { cap: "", display: "docs/plan.html", kind: "html", reason: "Plan ready", revision: 1, onScreen: true });
	assert.deepEqual(caps.find(first.cap), { key: "S", from: "S", bridgeId: "B", id: DOC.id });
	assert.equal(caps.bind([{ key: "S", from: "S", bridgeId: "B", docs: d }], listed).get("S")![0]!.cap, first.cap, "the next reading keeps it");
	assert.equal(caps.bind([], listed).size, 0);
	assert.equal(caps.find(first.cap), undefined, "a reading that does not bind it does not serve it");
	assert.equal(caps.bind([{ key: "S", from: "S", bridgeId: "B", docs: d }], listed).get("S")![0]!.cap, first.cap, "still listed by its bridge: the same capability when bound again");
	const other = caps.bind([{ key: "T", from: "T", bridgeId: "B2", docs: d }], new Set([...listed, `T\nB2\n${DOC.id}`])).get("T")![0]!.cap;
	assert.notEqual(other, first.cap, "the same owner id under another bridge is another document");
	caps.bind([], new Set());
	assert.notEqual(caps.bind([{ key: "S", from: "S", bridgeId: "B", docs: d }], listed).get("S")![0]!.cap, first.cap, "no bridge listed it for a while: a new one");
	const kept = caps.bind([{ key: "S", from: "S", bridgeId: "B", docs: d }], listed).get("S")![0]!.cap;
	caps.clear();
	assert.equal(caps.find(kept), undefined);
	assert.notEqual(caps.bind([{ key: "S", from: "S", bridgeId: "B", docs: d }], listed).get("S")![0]!.cap, kept, "a new server");
});
