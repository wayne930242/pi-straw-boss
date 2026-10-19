import assert from "node:assert/strict";
import { test } from "node:test";
import { checkAnswer } from "../src/dialogs.ts";
import { checkProbe, probeEditor } from "../src/probe.ts";
import { type Bus, type Dialog, digestOf, mcpAdapter, OWNERS, piCode, questionsDigest, robotHand, rpiv, selectDigest, selectOf } from "../src/owners.ts";

/** pi's event bus as far as owners use it: listeners run synchronously inside emit. */
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
const TITLE = "Robot Hand — Deploy needs your sudo password\n\n  ! npm run deploy";
const LABELS = ["Type it into a new Herdr pane (I press Enter)", "Put it in my prompt", "No, thanks"];

test("the spec's three digest vectors, and the select form robot_hand hashes", () => {
	assert.equal(digestOf(["select", TITLE, LABELS]), "2974924308b3389b43761124fc7cbc4a4feced24e7f83706ae3f568a21b45faf");
	assert.equal(digestOf(["ask", "When should the deploy go out?", "Staging is green.", [["Tonight 22:00", "Low traffic"], ["Tomorrow 08:00", null]], false, true, false]), "969e37c87fca0cca7300a8cafcf2a5b6f3c1eb3db230bc36be69e9695023d886");
	assert.equal(digestOf(["ask", "要部署嗎？", null, [], false, true, true]), "bd6a8b43e10b511e31de0213834b8a27b136b9335e3c5786e5bb257dff9cfbb3");
	assert.equal(selectDigest({ title: TITLE, choices: LABELS.map((label, i) => ({ label, ...(i ? {} : { note: "a hint, not hashed", localOnly: true as const }) })), copy: "npm run deploy" }), "2974924308b3389b43761124fc7cbc4a4feced24e7f83706ae3f568a21b45faf");
	assert.notEqual(questionsDigest([{ question: "Q", header: "H", multiple: false, options: [{ title: "a" }] }]), questionsDigest([{ question: "Q", header: "H", multiple: true, options: [{ title: "a" }] }]), "the multi-select flag is part of what was shown");
});

test("a contract-v1 pending is taken only in its own shape and version; hints are kept, nothing else", () => {
	const ok = { version: 1, id: "d1", toolCallId: "c1", digest: "a".repeat(64), select: { title: "T", choices: [{ label: "A", note: "n", localOnly: true, extra: 1 }, { label: "B", localOnly: "yes" }], copy: "ls" } };
	assert.deepEqual(selectOf("robot-hand", ok), { owner: "robot-hand", id: "d1", toolCallId: "c1", digest: "a".repeat(64), select: { title: "T", choices: [{ label: "A", note: "n", localOnly: true }, { label: "B" }], copy: "ls" } });
	for (const bad of [{ ...ok, version: 2 }, { ...ok, id: 3 }, { ...ok, id: "x".repeat(65) }, { ...ok, select: { title: "T", choices: [] } }, { ...ok, select: { title: 1, choices: [{ label: "A" }] } }, { ...ok, select: { title: "T", choices: [{ label: 2 }] } }, { ...ok, toolCallId: 5 }, null, "x"])
		assert.equal(selectOf("robot-hand", bad), undefined, JSON.stringify(bad));
});

test("robot_hand: pending and closed reach the bridge; an answer goes out as one selection and its verdict is matched by id and answerId", () => {
	const b = bus(), opened: Dialog[] = [], closed: [string, string?][] = [];
	const off = robotHand.listen(b, { open: (adapter, d) => (assert.equal(adapter, robotHand), opened.push(d)), closed: (id, by) => closed.push([id, by]) });
	b.emit("robot-hand:pending", { version: 1, id: "d1", toolCallId: "c1", digest: "f".repeat(64), select: { title: "T", choices: [{ label: "A" }] } });
	b.emit("robot-hand:pending", { version: 2, id: "d2", digest: "f".repeat(64), select: { title: "T", choices: [{ label: "A" }] } });
	b.emit("robot-hand:closed", { version: 1, id: "d1", by: "local" });
	b.emit("robot-hand:closed", { version: 2, id: "d1", by: "remote" });
	assert.deepEqual([opened.map((d) => d.id), closed], [["d1"], [["d1", "local"]]], "another version is ignored by a relay");
	const verdicts: unknown[] = [];
	// The owner answers synchronously inside its listener; results for another id, answerId, or version are not this answer's.
	b.on("robot-hand:answer", (a) => {
		const { id, answerId } = a as { id: string; answerId: string };
		b.emit("robot-hand:answer-result", { version: 1, id: "other", answerId, accepted: true });
		b.emit("robot-hand:answer-result", { version: 2, id, answerId, accepted: true });
		b.emit("robot-hand:answer-result", { version: 1, id, answerId: "x".repeat(16), accepted: true });
		b.emit("robot-hand:answer-result", { version: 1, id, answerId, accepted: false, reason: "digest" });
	});
	const stop = robotHand.answer(b, opened[0]!, { id: "d1", answerId: "a".repeat(16), digest: "f".repeat(64), choice: 2 }, (v) => verdicts.push(v));
	assert.deepEqual(b.seen.find(([c]) => c === "robot-hand:answer")?.[1], { version: 1, id: "d1", answerId: "a".repeat(16), digest: "f".repeat(64), selections: [2] });
	assert.deepEqual(verdicts, [{ accepted: false, reason: "digest" }]);
	stop();
	off();
	assert.equal(b.count(), 1, "only the test's own owner listener is left");
	assert.deepEqual(OWNERS.map((o) => o.name), ["robot-hand", "rpiv", "pi-mcp-adapter", "pi-code"]);
	assert.equal(mcpAdapter.tool, undefined, "MCP approvals belong to no tool call");
});

test("pi-code's hook gate: contract v1 under pi-code:dialog, a gate of any tool; Allow and Deny go out as selections 0 and 1", () => {
	assert.deepEqual([piCode.name, piCode.tool, piCode.gate], ["pi-code", undefined, true]);
	assert.deepEqual([robotHand.gate, rpiv.gate, mcpAdapter.gate], [undefined, undefined, undefined]);
	const b = bus(), opened: Dialog[] = [], closed: [string, string?][] = [], verdicts: unknown[] = [];
	const off = piCode.listen(b, { open: (adapter, d) => (assert.equal(adapter, piCode), opened.push(d)), closed: (id, by) => closed.push([id, by]) });
	const select = { title: "Allow bash?\n\n  npm run deploy", choices: [{ label: "Allow" }, { label: "Deny" }] };
	b.emit("pi-code:dialog:pending", { version: 1, id: "g1", toolCallId: "t1", digest: selectDigest(select), select });
	b.emit("pi-code:dialog:pending", { version: 2, id: "g2", toolCallId: "t1", digest: selectDigest(select), select });
	b.emit("robot-hand:pending", { version: 1, id: "g3", digest: selectDigest(select), select });
	assert.deepEqual(opened, [{ owner: "pi-code", id: "g1", toolCallId: "t1", digest: selectDigest(select), select }]);
	b.on("pi-code:dialog:answer", (raw) => {
		const a = raw as { id: string; answerId: string; selections: number[] };
		b.emit("pi-code:dialog:answer-result", { version: 1, id: a.id, answerId: a.answerId, accepted: a.selections[0] !== 1, ...(a.selections[0] === 1 ? { reason: "closed" } : {}) });
	});
	piCode.answer(b, opened[0]!, { id: "g1", answerId: "a".repeat(16), digest: opened[0]!.digest, choice: 0 }, (v) => verdicts.push(v))();
	piCode.answer(b, opened[0]!, { id: "g1", answerId: "b".repeat(16), digest: opened[0]!.digest, choice: 1 }, (v) => verdicts.push(v))();
	assert.deepEqual(b.seen.filter(([c]) => c === "pi-code:dialog:answer").map(([, d]) => d), [
		{ version: 1, id: "g1", answerId: "a".repeat(16), digest: opened[0]!.digest, selections: [0] },
		{ version: 1, id: "g1", answerId: "b".repeat(16), digest: opened[0]!.digest, selections: [1] },
	]);
	assert.deepEqual(verdicts, [{ accepted: true }, { accepted: false, reason: "closed" }]);
	b.emit("pi-code:dialog:closed", { version: 1, id: "g1", by: "local" });
	assert.deepEqual(closed, [["g1", "local"]]);
	off();
});

const PROMPT = { toolCallId: "q1", questions: [{ question: "When?", header: "Window", multiSelect: false, options: [{ label: "Tonight", description: "Low traffic", hasPreview: true }, { label: "Tomorrow", description: "" }] }, { question: "Who?", header: "Notify", multiSelect: true, options: [{ label: "ops", description: "d" }, { label: "billing", description: "d" }] }] };

test("rpiv-ask-user-question: a prompt becomes a questionnaire with a minted id and its digest; blocked {active: false} closes it", () => {
	const b = bus(), opened: Dialog[] = [], closed: [string, string?][] = [];
	const off = rpiv.listen(b, { open: (_a, d) => opened.push(d), closed: (id, by) => closed.push([id, by]) });
	b.emit("rpiv:ask-user:prompt", PROMPT);
	b.emit("rpiv:ask-user:prompt", PROMPT); // the same call twice is one dialog
	for (const bad of [{ questions: PROMPT.questions }, { toolCallId: "q2", questions: [] }, { toolCallId: "q3", questions: Array(5).fill(PROMPT.questions[0]) }, { toolCallId: "q4", questions: [{ question: "Q", options: [{ label: 1 }] }] }]) b.emit("rpiv:ask-user:prompt", bad);
	assert.equal(opened.length, 1);
	const d = opened[0]!;
	assert.match(d.id, /^[0-9a-f-]{36}$/);
	assert.deepEqual(d.questions, [{ question: "When?", header: "Window", multiple: false, options: [{ title: "Tonight", description: "Low traffic", preview: true }, { title: "Tomorrow" }] }, { question: "Who?", header: "Notify", multiple: true, options: [{ title: "ops", description: "d" }, { title: "billing", description: "d" }] }]);
	assert.equal(d.digest, questionsDigest(d.questions!));
	b.emit("rpiv:ask-user:blocked", { active: true, toolCallId: "q1" });
	b.emit("rpiv:ask-user:blocked", { active: false, toolCallId: "other" });
	b.emit("rpiv:ask-user:blocked", { active: false, toolCallId: "q1" });
	assert.deepEqual(closed, [[d.id, undefined]], "who answered is left to the bridge");
	off();
	assert.equal(b.count(), 0, "no listener left");
});

test("rpiv-ask-user-question: an answer is checked against the shown digest, mapped to its payload, and its verdict codes become reasons; abort cancels", () => {
	const b = bus(), opened: Dialog[] = [];
	rpiv.listen(b, { open: (_a, d) => opened.push(d), closed: () => {} });
	b.emit("rpiv:ask-user:prompt", PROMPT);
	const d = opened[0]!, verdicts: unknown[] = [];
	rpiv.answer(b, d, { id: d.id, answerId: "b".repeat(16), digest: "0".repeat(64), answers: [{ choices: [0] }, { choices: [1] }] }, (v) => verdicts.push(v));
	assert.deepEqual([verdicts, b.seen.filter(([c]) => c === "rpiv:ask-user:answer")], [[{ accepted: false, reason: "digest" }], []], "another digest never reaches the owner");
	let code: string | undefined = "invalid_answer";
	b.on("rpiv:ask-user:answer", (raw) => {
		const p = raw as { requestId: string; toolCallId: string };
		b.emit("rpiv:ask-user:answer-result", { ok: true, requestId: "someone-else", toolCallId: p.toolCallId });
		b.emit("rpiv:ask-user:answer-result", code ? { ok: false, code, requestId: p.requestId, toolCallId: p.toolCallId } : { ok: true, requestId: p.requestId, toolCallId: p.toolCallId });
	});
	for (const next of ["invalid_payload", "not_found", "unsupported_host", undefined]) {
		rpiv.answer(b, d, { id: d.id, answerId: "c".repeat(16), digest: d.digest, answers: [{ choices: [1], note: "n" }, { choices: [0, 1], text: "and support" }] }, (v) => verdicts.push(v))();
		code = next;
	}
	rpiv.answer(b, d, { id: d.id, answerId: "d".repeat(16), digest: d.digest, answers: [{ text: "Friday" }, { choices: [0] }] }, (v) => verdicts.push(v))();
	assert.deepEqual(verdicts.slice(1), [{ accepted: false, reason: "not-allowed" }, { accepted: false, reason: "malformed" }, { accepted: false, reason: "closed" }, { accepted: false, reason: "not-allowed" }, { accepted: true }]);
	assert.deepEqual(b.seen.filter(([c]) => c === "rpiv:ask-user:answer").at(-1)![1], { toolCallId: "q1", requestId: "d".repeat(16), answers: [{ questionIndex: 0, text: "Friday" }, { questionIndex: 1, optionIndexes: [0] }] });
	assert.deepEqual(b.seen.filter(([c]) => c === "rpiv:ask-user:answer").at(-2)![1], { toolCallId: "q1", requestId: "c".repeat(16), answers: [{ questionIndex: 0, optionIndexes: [1], notes: "n" }, { questionIndex: 1, optionIndexes: [0, 1], text: "and support" }] });
	rpiv.cancel!(b, d);
	assert.deepEqual(b.seen.filter(([c]) => c === "rpiv:ask-user:answer").at(-1)![1], { toolCallId: "q1", requestId: `cancel-${d.id}`, cancel: true });
});

test("the server checks an answer against what the page may answer: a select's one choice, or each question in full", () => {
	const select = { dialog: "d", digest: "0".repeat(64), select: { title: "T", choices: [{ label: "A" }, { label: "Copy", localOnly: true as const }] } };
	assert.deepEqual(checkAnswer(select, { choice: 0 }, false), { choice: 0 });
	assert.deepEqual(checkAnswer(select, { choice: 1 }, false), { choice: 1 });
	assert.match(String(checkAnswer(select, { choice: 1 }, true)), /computer the GUI runs on/, "a local-only choice is refused from a remote page");
	for (const bad of [{}, { choice: 2 }, { choice: -1 }, { choice: 0.5 }, { choice: "0" }, { choice: 0, answers: [] }]) assert.equal(typeof checkAnswer(select, bad, false), "string", JSON.stringify(bad));
	const qs = { dialog: "d", digest: "0".repeat(64), questions: [{ question: "Q1", multiple: false, options: [{ title: "a" }, { title: "b" }] }, { question: "Q2", multiple: true, options: [{ title: "x" }, { title: "y" }] }] };
	assert.deepEqual(checkAnswer(qs, { answers: [{ choices: [1], note: "" }, { choices: [0, 1], text: "also z\r\nand w", note: "fyi" }] }, false), { answers: [{ choices: [1] }, { choices: [0, 1], text: "also z\nand w", note: "fyi" }] });
	assert.deepEqual(checkAnswer(qs, { answers: [{ text: "own" }, { text: "words" }] }, true), { answers: [{ text: "own" }, { text: "words" }] });
	const cases: [unknown, RegExp][] = [
		[[{ choices: [0] }], /every question/], [[{ choices: [0] }, { choices: [0] }, {}], /every question/], [[{ choices: [0, 1] }, { choices: [0] }], /Question 1: pick/],
		[[{ choices: [0] }, { choices: [1, 1] }], /Question 2: pick/], [[{ choices: [2] }, { choices: [0] }], /Question 1: pick/], [[{ choices: [0] }, {}], /Question 2: pick an option or write/],
		[[{ choices: [0], text: "x" }, { choices: [0] }], /not both/], [[{ text: "  " }, { choices: [0] }], /blank/], [[{ text: "a\u001b[2Jb" }, { choices: [0] }], /control/],
		[[{ text: "x".repeat(8193) }, { choices: [0] }], /too long/], [[{ choices: [0], note: "n".repeat(2049) }, { choices: [0] }], /too long/], [[{ text: "x".repeat(8000) }, { text: "y".repeat(8000) }], /too long together/],
	];
	for (const [answers, why] of cases) assert.match(String(checkAnswer(qs, { answers }, false)), why, JSON.stringify(answers).slice(0, 80));
	assert.equal(typeof checkAnswer(qs, { choice: 0, answers: [{ choices: [0] }, { choices: [0] }] }, false), "string");
});

test("probe contract: the editor's class, the ending command by name only, and the server takes nothing else", () => {
	const ui = (text: unknown) => ({ hasUI: true, ui: { getEditorText: () => text } }) as never;
	const cases: [unknown, unknown][] = [["/reload", { editor: "text", ending: "reload" }], ["\n /quit", { editor: "text", ending: "quit" }], ["/exit now", { editor: "text", ending: "exit" }], ["/re", { editor: "command" }], ["/re ", { editor: "command" }], ["/re\n", { editor: "command" }], ["/im foo", { editor: "command" }], [" /compact now", { editor: "command" }], ["/model", { editor: "command" }], ["/reload-all", { editor: "command" }], ["say /reload", { editor: "text" }], ["!rm -rf build", { editor: "command" }], [" !ls", { editor: "command" }], ["it's done!", { editor: "text" }], ["", { editor: "empty" }], [" \t", { editor: "empty" }], [undefined, { editor: "unknown" }], [42, { editor: "unknown" }]];
	for (const [text, want] of cases) assert.deepEqual(probeEditor(ui(text)), want, JSON.stringify(text));
	assert.deepEqual(probeEditor({ hasUI: false, ui: { getEditorText: () => "/quit" } } as never), { editor: "unknown" });
	assert.deepEqual(probeEditor(undefined), { editor: "unknown" });
	for (const name of ["quit", "exit", "new", "resume", "fork", "clone", "import", "reload"]) assert.deepEqual(checkProbe({ editor: "text", ending: name }), { editor: "text", ending: name });
	for (const ok of ["empty", "text", "command", "unknown"]) assert.deepEqual(checkProbe({ editor: ok, extra: "dropped" }), { editor: ok });
	for (const bad of [undefined, {}, { editor: "draft" }, { editor: "text", ending: "model" }, { editor: "text", ending: "RELOAD" }, { editor: "text", ending: "reload x" }, { editor: "text", ending: 1 }, { editor: "command", ending: "new" }, { editor: "unknown", ending: "quit" }])
		assert.equal(checkProbe(bad as never), undefined, JSON.stringify(bad));
});
