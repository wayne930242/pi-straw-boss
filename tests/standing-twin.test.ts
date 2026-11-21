import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { type Agent, World } from "./fakes.ts";

let world: World;
afterEach(() => world.stopAll());
const NAME = "Work-on API watch";
const OLD_ID = "12345678-old";
const WARNING = /Warning: .*12345678/;
const duty = async (agent: Agent) => (await agent.tool("boss_duty", { duty: "standing", reason: "minds the API" })).content[0] as { text: string };
const rename = async (agent: Agent, name: string) => (await agent.tool("boss_rename", { name })).content[0] as { text: string };

async function twoMains({ name = NAME, otherWorkspace = false, otherStanding = true } = {}) {
	world = new World();
	const old = world.agent({ id: OLD_ID, name, pane: otherWorkspace ? "wB:p1" : "wA:p1", tab: otherWorkspace ? "wB:t1" : "wA:t1" });
	await old.start();
	await old.promote();
	if (otherStanding) await duty(old);
	const next = world.agent({ id: "new-main", name: NAME, pane: "wA:p2", tab: "wA:t2" });
	await next.start();
	await next.promote();
	await world.quiet();
	assert.equal(world.herdr.pane(old.pane).tokens.sb_role, "main");
	assert.equal(world.herdr.pane(old.pane).tokens.sb_duty, otherStanding ? "standing" : "coordinator");
	return { old, next };
}

function assertWarning(text: string) {
	assert.match(text, WARNING);
	assert.match(text, /work-on API WATCH/);
	assert.doesNotMatch(text, /12345678-old/, "only the short id is shown");
	assert.match(text, /link wait.*matches both/i);
	assert.match(text, /intercom.*boss_duty.*coordinator.*boss_rename.*rename one/i);
}

test("boss_duty declares standing and warns about a live standing twin (trimmed, case-insensitive)", async () => {
	const { old, next } = await twoMains({ name: "  work-on API WATCH  " });
	const reply = await duty(next);
	await world.quiet();
	assert.equal(world.herdr.pane(next.pane).tokens.sb_duty, "standing");
	assert.equal(world.herdr.pane(old.pane).tokens.sb_duty, "standing", "the warning does not demote the other main");
	assert.match(reply.text, /Your kind is now standing/);
	assertWarning(reply.text);
});

// TWR-F001: the warning folds names as the link-wait router does (src/namefold.ts), so names that differ only in inner whitespace are twins.
test("boss_duty warns about a twin whose name differs only in inner whitespace, as the router folds it", async () => {
	const { next } = await twoMains({ name: "work-on  API   watch" });
	const reply = await duty(next);
	assert.match(reply.text, WARNING);
	assert.match(reply.text, /matches both/, "TWR-F002: the warning names the harm of the shared name");
});

test("boss_duty standing warns on a repeated declaration without changing the kind", async () => {
	const { next } = await twoMains({ name: "work-on API WATCH" });
	await duty(next);
	const reply = await duty(next);
	assert.match(reply.text, /Your kind is already standing/);
	assertWarning(reply.text);
});

test("boss_rename lets a standing main take the name and warns about the twin", async () => {
	const { old, next } = await twoMains({ name: "work-on API WATCH" });
	assert.doesNotMatch((await rename(next, NAME)).text, /Warning:/, "a coordinator's rename does not warn");
	await rename(next, "Different watch");
	assert.doesNotMatch((await duty(next)).text, /Warning:/);
	const reply = await rename(next, `  ${NAME}  `);
	assert.equal(next.name, NAME);
	assert.equal(old.name, "work-on API WATCH");
	assert.match(reply.text, /This session is now named "Work-on API watch"/);
	assertWarning(reply.text);
});

test("the warning uses the current workspace after a tab moves", async () => {
	const { next } = await twoMains({ name: "work-on API WATCH", otherWorkspace: true });
	world.herdr.tabs.find((tab) => tab.tab_id === "wA:t2")!.workspace_id = "wB";
	world.herdr.pane(next.pane).workspace_id = "wB";
	assertWarning((await duty(next)).text);
});

test("a remote rename does not reveal a matching local standing main", async () => {
	const { next } = await twoMains();
	await rename(next, "Different watch");
	await duty(next);
	await next.fire("message_start", { message: { role: "custom", customType: "straw-link" } });
	await assert.rejects(duty(next), /A teammate's turn cannot change this main's kind/);
	assert.doesNotMatch((await rename(next, NAME)).text, /Warning:/);
	assert.equal(next.name, NAME);
});

const exclusions = [
	{ why: "the names differ (even with the same tab-label prefix)", options: { name: `${NAME} east` } },
	{ why: "the other main is in another workspace", options: { otherWorkspace: true } },
	{ why: "the other main is not standing", options: { otherStanding: false } },
	{ why: "the other session is not a main", arrange: ({ old }: { old: Agent }) => { world.herdr.pane(old.pane).tokens.sb_role = "member"; } },
	{ why: "the other session is gone despite leftover pane tokens", arrange: async ({ old }: { old: Agent }) => {
		const pane = world.herdr.pane(old.pane), tokens = { ...pane.tokens };
		await old.stop();
		Object.assign(pane.tokens, tokens);
		assert.ok(!(await world.broker.sessionList()).some((session) => session.id === old.id));
	} },
	{ why: "the net cannot be read", arrange: () => { world.herdr.failPanes = true; } },
];
for (const { why, options, arrange } of exclusions) {
	test(`no warning when ${why}`, async () => {
		const pair = await twoMains(options);
		await arrange?.(pair);
		const changed = await duty(pair.next);
		assert.match(changed.text, /Your kind is now standing/);
		assert.doesNotMatch(changed.text, /Warning:/);
		const renamed = await rename(pair.next, NAME.toUpperCase());
		assert.equal(pair.next.name, NAME.toUpperCase());
		assert.doesNotMatch(renamed.text, /Warning:/);
	});
}
