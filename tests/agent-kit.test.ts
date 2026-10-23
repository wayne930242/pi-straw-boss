import assert from "node:assert/strict";
import { test } from "node:test";
import { createHeadlessKit } from "../src/agent/kit.ts";
import { type Channel, type Config, REGISTER } from "../src/state.ts";
import { StubClient } from "./agent-fakes.ts";
import { until } from "./fakes.ts";

const OUTBOX = "intercom:outbox-request", RESULT = "intercom:outbox-result";
const NS = "straw-boss/tab/7762";
const setup = () => {
	const client = new StubClient(), kit = createHeadlessKit({ client, env: { PI_INTERCOM_SESSION_ID: "claude-aaaa" }, cfg: {} as Config });
	kit.attach(client);
	const events: Record<string, unknown>[] = [];
	let channel!: Channel;
	kit.pi.events.emit(REGISTER, { namespace: NS, ownerEligible: true, onReady: (c: Channel) => (channel = c), onEvent: (e: Record<string, unknown>) => events.push(e) });
	const results: Record<string, unknown>[] = [];
	kit.pi.events.on(RESULT, (data) => results.push(data as Record<string, unknown>));
	const request = (over: Record<string, unknown> = {}) => kit.pi.events.emit(OUTBOX, { version: 1, requestId: "r1", extensionId: "pi-straw-boss", extensionName: "Pi Straw Boss", to: "tower", message: "hi", ...over });
	return { client, kit, events, channel, results, request };
};

test("the kit is the session's id and the event bus, and any other member of pi throws", () => {
	const { kit } = setup();
	assert.equal(kit.me(), "claude-aaaa");
	assert.throws(() => kit.pi.registerTool({} as never), /not available in a net sidecar/);
	assert.throws(() => kit.pi.on("session_start", () => {}), /not available/);
});

test("registering a namespace tells the broker the capability, hands over a channel at once, and says it is connected", () => {
	const { client, events, channel, kit } = setup();
	assert.deepEqual(client.capabilities, [[{ namespace: NS, ownerEligible: true }]]);
	assert.deepEqual(channel.snapshot(), { connected: true, supported: true });
	assert.deepEqual(events, [{ type: "connection", connected: true, supported: true }]);
	assert.throws(() => kit.pi.events.emit(REGISTER, { namespace: NS, ownerEligible: true, onReady: () => {}, onEvent: () => {} }), /already registered/);
	assert.throws(() => kit.pi.events.emit(REGISTER, { namespace: "Bad Name", ownerEligible: true, onReady: () => {}, onEvent: () => {} }), /Invalid intercom extension namespace/);
});

test("owner, state, claims, and the roster's changes reach the namespace as they do in pi-intercom, and the snapshot follows", () => {
	const { client, events, channel } = setup();
	events.length = 0;
	client.broker({ type: "extension_owner", namespace: NS, ownerId: "claude-aaaa", ownerEpoch: "e1" });
	client.broker({ type: "extension_state", namespace: NS, revision: 3, payload: { v: 1, main: "pi-b" } });
	client.broker({ type: "extension_message", namespace: NS, fromSessionId: "pi-b", ownerId: "claude-aaaa", ownerEpoch: "e1", payload: { type: "claim", force: false } });
	client.broker({ type: "extension_state_result", namespace: NS, committed: false, revision: 3, reason: "stale" });
	client.broker({ type: "session_left", sessionId: "pi-b" });
	client.broker({ type: "extension_owner", namespace: "other/ns", ownerId: "x", ownerEpoch: "e" });
	assert.deepEqual(channel.snapshot(), { connected: true, supported: true, owner: { sessionId: "claude-aaaa", epoch: "e1" }, state: { revision: 3, payload: { v: 1, main: "pi-b" } } });
	assert.deepEqual(events, [
		{ type: "owner", owner: { sessionId: "claude-aaaa", epoch: "e1" } },
		{ type: "state", state: { revision: 3, payload: { v: 1, main: "pi-b" } } },
		{ type: "message", fromSessionId: "pi-b", owner: { sessionId: "claude-aaaa", epoch: "e1" }, payload: { type: "claim", force: false } },
		{ type: "state_result", committed: false, revision: 3, reason: "stale" },
		{ type: "session_left", sessionId: "pi-b" },
	]);
	client.broker({ type: "extension_owner", namespace: NS });
	assert.equal(channel.snapshot().owner, undefined);
});

test("publish goes to the owner by default, commitState carries the owner's epoch and revision and only the owner may commit", () => {
	const { client, channel } = setup();
	channel.publish({ type: "claim", force: true });
	channel.publish({ n: 1 }, { audience: "capable" });
	assert.throws(() => channel.commitState({ v: 1 }), /not the owner of/);
	client.broker({ type: "extension_owner", namespace: NS, ownerId: "claude-aaaa", ownerEpoch: "e9" });
	client.broker({ type: "extension_state", namespace: NS, revision: 4, payload: {} });
	channel.commitState({ v: 1, main: "claude-aaaa" });
	channel.commitState({ v: 1 }, 7);
	assert.deepEqual(client.frames, [
		{ type: "extension_publish", namespace: NS, audience: "owner", payload: { type: "claim", force: true } },
		{ type: "extension_publish", namespace: NS, audience: "capable", payload: { n: 1 } },
		{ type: "extension_state_commit", namespace: NS, ownerEpoch: "e9", expectedRevision: 4, payload: { v: 1, main: "claude-aaaa" } },
		{ type: "extension_state_commit", namespace: NS, ownerEpoch: "e9", expectedRevision: 7, payload: { v: 1 } },
	]);
	client.connected = false;
	assert.throws(() => channel.publish({}), /not connected/);
	assert.rejects(channel.listSessions(), /not connected/);
});

test("an outbox request resolves the target by id, name, or id prefix, sends it with the request id, and answers sent", async () => {
	const { client, results, request } = setup();
	client.sessions = [{ id: "claude-aaaa", name: "me" }, { id: "tower-1234", name: "Tower" }, { id: "pi-5678", name: "Worker" }];
	request({ requestId: "by-name", to: "tower" });
	request({ requestId: "by-prefix", to: "pi-56", message: "second" });
	await until(() => results.length === 2, "two results");
	assert.deepEqual(client.sent.map((s) => [s.to, s.text, s.messageId]), [["tower-1234", "hi", "by-name"], ["pi-5678", "second", "by-prefix"]]);
	assert.deepEqual(results.map((r) => [r.requestId, r.status, r.messageId, r.extensionId]), [["by-name", "sent", "by-name", "pi-straw-boss"], ["by-prefix", "sent", "by-prefix", "pi-straw-boss"]]);
});

test("an outbox request that cannot go says why: no such session, several, itself, a refusal, a closed socket, a repeated or malformed request", async () => {
	const { client, kit, results, request } = setup();
	client.sessions = [{ id: "claude-aaaa", name: "me" }, { id: "a-1", name: "dup" }, { id: "a-2", name: "dup" }, { id: "b-1", name: "ok" }];
	request({ requestId: "none", to: "nobody" });
	request({ requestId: "many", to: "dup" });
	request({ requestId: "self", to: "me" });
	client.deliver = { delivered: false, reason: "gone" };
	request({ requestId: "refused", to: "ok" });
	request({ requestId: "none", to: "ok" });
	request({ requestId: "bad", version: 2 });
	request({ requestId: "empty", message: "  " });
	kit.pi.events.emit(OUTBOX, "nonsense");
	await until(() => results.length === 7, "results");
	const by = (id: string, status?: string) => results.find((r) => r.requestId === id && (!status || r.status === status));
	assert.deepEqual([by("none", "blocked")?.status, by("none", "blocked")?.code], ["blocked", "target_not_found"]);
	assert.deepEqual([by("many")?.status, by("many")?.code], ["blocked", "target_ambiguous"]);
	assert.deepEqual([by("self")?.status, by("self")?.code], ["blocked", "self_target"]);
	assert.deepEqual([by("refused")?.status, by("refused")?.code, by("refused")?.detail], ["failed", "delivery_failed", "gone"]);
	assert.deepEqual([by("bad")?.status, by("bad")?.code], ["rejected", "invalid_request"]);
	assert.equal(results.filter((r) => r.code === "duplicate_request").length, 1);
	client.connected = false;
	request({ requestId: "closed" });
	await until(() => results.length === 8, "the closed result");
	assert.deepEqual([by("closed")?.status, by("closed")?.code], ["failed", "session_unavailable"]);
});

test("a dropped connection tells every namespace it is gone and fails what was in flight; the reconnection registers the capabilities again", async () => {
	const { client, kit, events, results, request } = setup();
	client.sessions = [{ id: "claude-aaaa" }, { id: "tower-1", name: "t" }];
	client.listSessions = () => new Promise(() => {}); // never answers
	request({ requestId: "inflight", to: "t" });
	events.length = 0;
	client.drop();
	assert.deepEqual(events, [{ type: "connection", connected: false, supported: false }, { type: "owner" }]);
	await until(() => results.length === 1, "the failed request");
	assert.equal(results[0]?.code, "session_unavailable");
	const next = new StubClient();
	kit.attach(next);
	events.length = 0;
	await next.connect({} as never, "claude-aaaa");
	assert.deepEqual(next.capabilities, [[{ namespace: NS, ownerEligible: true }]]);
	assert.deepEqual(events, [{ type: "connection", connected: true, supported: true }]);
	client.broker({ type: "session_left", sessionId: "x" });
	assert.equal(events.length, 1, "the client that was replaced is no longer listened to");
});

test("a broker without extension-bus-v1 is reported unsupported and gets no capabilities", async () => {
	const client = new StubClient();
	client.features.clear();
	const kit = createHeadlessKit({ client, env: {}, cfg: {} as Config });
	kit.attach(client);
	let channel!: Channel;
	const events: unknown[] = [];
	kit.pi.events.emit(REGISTER, { namespace: NS, ownerEligible: true, onReady: (c: Channel) => (channel = c), onEvent: (e: unknown) => events.push(e) });
	assert.deepEqual(client.capabilities, []);
	assert.equal(channel.snapshot().supported, false);
	assert.deepEqual(events, [{ type: "connection", connected: true, supported: false }]);
});
