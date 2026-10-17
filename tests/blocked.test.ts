import assert from "node:assert/strict";
import { test } from "node:test";
import blockedRelay, { RPIV_BLOCKED } from "../src/blocked.ts";

function bus() {
	const handlers = new Map<string, ((data: unknown) => void)[]>();
	const sent: unknown[] = [];
	const events = {
		on: (name: string, fn: (data: unknown) => void) => void handlers.set(name, [...(handlers.get(name) ?? []), fn]),
		emit: (name: string, data: unknown) => (name === "herdr:blocked" ? sent.push(data) : handlers.get(name)?.forEach((fn) => fn(data))),
	};
	blockedRelay({ events } as never);
	return { emit: (data: unknown) => events.emit(RPIV_BLOCKED, data), sent };
}

test("each open questionnaire is relayed as one balanced herdr:blocked pair", () => {
	const { emit, sent } = bus();
	emit({ active: true, toolCallId: "a" });
	emit({ active: true, toolCallId: "a" });
	emit({ active: true, toolCallId: "b" });
	emit({ active: false, toolCallId: "a" });
	emit({ active: false, toolCallId: "a" });
	emit({ active: false, toolCallId: "b" });
	assert.deepEqual(sent.map((d) => (d as { active: boolean }).active), [true, true, false, false]);
	assert.match((sent[0] as { label: string }).label, /ask_user_question/);
});

test("an end without a start, or a payload without an id, is ignored", () => {
	const { emit, sent } = bus();
	emit({ active: false, toolCallId: "x" });
	emit({ active: true });
	emit(undefined);
	emit({ active: "yes", toolCallId: "y" });
	assert.equal(sent.length, 0);
});
