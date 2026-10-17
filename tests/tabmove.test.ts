import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { herdrApi } from "../src/herdr.ts";
import { World } from "./fakes.ts";

let world = new World();
afterEach(async () => {
	await world.stopAll();
	world = new World();
});

/** A stand-in for Herdr's socket: answers each newline-delimited JSON request with `answer`. */
async function fakeSocket(answer: (request: { id: string; method: string; params: object }) => object) {
	const dir = mkdtempSync(join(tmpdir(), "psb-dash-sock-"));
	const requests: string[] = [];
	const server: Server = createServer((socket) => {
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk;
			for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
				const line = buffer.slice(0, end);
				buffer = buffer.slice(end + 1);
				requests.push(line);
				socket.write(`${JSON.stringify(answer(JSON.parse(line)))}\n`);
			}
		});
	});
	const path = join(dir, "herdr.sock");
	await new Promise<void>((resolve) => server.listen(path, resolve));
	return { path, requests, close: () => (server.close(), rmSync(dir, { recursive: true, force: true })) };
}

test("herdrApi sends one newline-delimited JSON request and resolves on a result", async () => {
	const socket = await fakeSocket((request) => ({ id: request.id, result: { type: "tab_list" } }));
	try {
		await herdrApi(socket.path)("tab.move", { tab_id: "wA:t9", insert_index: 0 });
		assert.equal(socket.requests.length, 1);
		const { id, ...request } = JSON.parse(socket.requests[0]!);
		assert.equal(typeof id, "string");
		assert.deepEqual(request, { method: "tab.move", params: { tab_id: "wA:t9", insert_index: 0 } });
	} finally {
		socket.close();
	}
});

test("herdrApi rejects with Herdr's error code, and with the reason when the socket is unreachable", async () => {
	const socket = await fakeSocket((request) => ({ id: request.id, error: { code: "tab_not_found", message: "tab nope not found" } }));
	try {
		await assert.rejects(herdrApi(socket.path)("tab.move", { tab_id: "nope", insert_index: 0 }), /herdr tab\.move failed: tab_not_found tab nope not found/);
	} finally {
		socket.close();
	}
	await assert.rejects(herdrApi(join(tmpdir(), "psb-dash-no-such.sock"))("tab.move", {}), /herdr tab\.move failed: .*ENOENT/);
});

const main = async () => {
	const a = world.agent({ id: "main-1", pane: "wA:p1", tab: "wA:t1" });
	await a.start();
	await a.join();
	return a;
};
const order = () => world.herdr.tabs.filter((t) => t.workspace_id === "wA").map((t) => t.tab_id);

test("a new tower tab moves to the first position right after it is created, before pi starts in it", async () => {
	world.autoTowers();
	const a = await main();
	await a.tool("call_tower", { message: "hi" });
	const created = world.herdr.tabs.find((t) => t.label === "tower")!;
	assert.deepEqual(world.herdr.moves, [{ tab_id: created.tab_id, insert_index: 0 }]);
	assert.equal(order()[0], created.tab_id);
	assert.deepEqual(world.herdr.commands("tab", "focus"), [], "moving never changes focus");
});

test("a leftover tower tab is moved first when a tower adopts it, and a live tower moves nothing", async () => {
	world.autoTowers();
	world.herdr.addTab("wA:t8", "tower", "wA:p8", "shell");
	world.herdr.pane("wA:p8").tokens.sb_role = "tower";
	const a = await main();
	await a.tool("call_tower", { message: "hi" });
	assert.deepEqual(world.herdr.moves, [{ tab_id: "wA:t8", insert_index: 0 }]);
	assert.equal(order()[0], "wA:t8");
	await a.tool("call_tower", { message: "again" });
	assert.equal(world.herdr.moves.length, 1, "the live tower is not moved again");
});

test("a failed move is reported as a warning and ignored: the tower still opens and gets the message", async () => {
	world.autoTowers();
	world.herdr.failMove = true;
	const a = await main();
	const result = await a.tool("call_tower", { message: "hi" });
	assert.equal((result.details as { opened: boolean }).opened, true);
	assert.equal(world.broker.delivered[0]?.to, "tower-wA");
	assert.ok(a.notices.some((n) => n.level === "warning" && /could not move the tower tab first: herdr tab\.move failed/.test(n.text)), JSON.stringify(a.notices));
});
