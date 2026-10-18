// @ts-nocheck: the plugin script is plain JavaScript and the fake Herdr's panes are loose test data.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fileStore, instanceOf, main, netView, socketCall, toggle } from "../herdr-plugin/net-view.mjs";

const PLUGIN = fileURLToPath(new URL("../herdr-plugin/", import.meta.url));

const SOURCE = "plugin:wayne930242.straw-boss";

/** A Herdr that keeps the one active Agents view, with the guard of `agent.view.clear`: a named source clears only its own view. */
function fakeHerdr({ failView = false } = {}) {
	const herdr = {
		view: undefined,
		calls: [],
		clears: [],
		async handle(method, params) {
			herdr.calls.push(method);
			if (method === "agent.view.set") {
				if (failView) throw Object.assign(new Error("invalid_params"), { code: "invalid_params" });
				herdr.view = { source: params.source, label: params.label, sort: params.sort, filter: params.filter };
				return { type: "agent_view", active: true, source: params.source, label: params.label };
			}
			if (method === "agent.view.clear") {
				herdr.clears.push(params);
				if (herdr.view && (params.source === undefined || params.source === herdr.view.source)) herdr.view = undefined;
				return herdr.view ? { type: "agent_view", active: true, source: herdr.view.source, label: herdr.view.label } : { type: "agent_view", active: false };
			}
			throw new Error(`unexpected ${method}`);
		},
	};
	return herdr;
}

function memoryStore() {
	const store = { state: undefined, read: async () => store.state, write: async (state) => void (store.state = state) };
	return store;
}

const deps = (herdr, store, instance = "server-1") => ({ call: (method, params) => herdr.handle(method, params), store, source: SOURCE, instance });

test("netView sorts by the sb_order token, ascending, and filters nothing", () => {
	assert.deepEqual(netView(), { label: "net", sort: [{ field: { token: "sb_order" }, order: "asc" }] });
	assert.equal("filter" in netView(), false, "agents outside the net stay visible, after the net");
});

test("the first press installs the view as plugin:<id>, the second clears it, the third installs it again", async () => {
	const herdr = fakeHerdr(), store = memoryStore();
	assert.deepEqual(await toggle(deps(herdr, store)), { on: true });
	assert.deepEqual(herdr.view, { source: SOURCE, label: "net", sort: netView().sort, filter: undefined });
	assert.deepEqual(store.state, { on: true, instance: "server-1" });

	assert.deepEqual(await toggle(deps(herdr, store)), { on: false });
	assert.equal(herdr.view, undefined);
	assert.deepEqual(store.state, { on: false, instance: "server-1" });
	assert.ok(herdr.clears.every((params) => params.source === SOURCE), "every clear names this plugin, so it never wipes another owner's view");

	assert.deepEqual(await toggle(deps(herdr, store)), { on: true });
	assert.ok(herdr.view);
});

test("a state left by an earlier server, or a view another owner installed over this one, counts as off", async () => {
	const herdr = fakeHerdr(), store = memoryStore();
	await toggle(deps(herdr, store, "server-1"));
	herdr.view = undefined; // the server restarted: its view is gone
	assert.deepEqual(await toggle(deps(herdr, store, "server-2")), { on: true }, "a restarted server takes one press to turn on, not two");
	assert.equal(herdr.view.source, SOURCE);
	assert.deepEqual(store.state, { on: true, instance: "server-2" });

	herdr.view = { source: "plugin:someone.else", label: "theirs" };
	assert.deepEqual(await toggle(deps(herdr, store, "server-2")), { on: true }, "the stored on is stale, so the press brings this view back");
	assert.equal(herdr.view.source, SOURCE);
	assert.ok(herdr.clears.every((params) => params.source === SOURCE));
});

test("a failed install leaves no state behind and is rethrown", async () => {
	const herdr = fakeHerdr({ failView: true }), store = memoryStore();
	await assert.rejects(toggle(deps(herdr, store)), (error) => error.code === "invalid_params");
	assert.equal(herdr.view, undefined);
	assert.equal(store.state, undefined);

	const refused = fakeHerdr(), unsaved = memoryStore();
	await assert.rejects(toggle({ ...deps(refused, unsaved), call: async (method, params) => (method === "agent.view.set" ? { type: "agent_view", active: false } : refused.handle(method, params)) }), /did not install the view/);
	assert.ok(refused.clears.length === 1 && refused.clears[0].source === SOURCE, "a view that may be installed is cleared before the error goes out");
});

test("a view that was installed but whose state could not be saved is cleared, so a later press cannot lose track of it", async () => {
	const herdr = fakeHerdr(), store = { read: async () => undefined, write: async () => Promise.reject(new Error("ENOSPC")) };
	await assert.rejects(toggle(deps(herdr, store)), /ENOSPC/);
	assert.equal(herdr.view, undefined);
	assert.deepEqual(herdr.clears, [{ source: SOURCE }]);
});

/** A fake Herdr socket: each connection gets `answer` with the request it read. */
async function socket(answer) {
	const dir = mkdtempSync(join(tmpdir(), "psb-net-")), path = join(dir, "herdr.sock");
	const server = createServer((c) => {
		let text = "";
		c.on("data", (chunk) => {
			text += chunk;
			if (text.includes("\n")) answer(JSON.parse(text.split("\n")[0]), (chunk) => c.write(chunk), () => c.end());
		});
		c.on("error", () => {});
	});
	await new Promise((resolve) => server.listen(path, resolve));
	return { dir, path, close: () => (server.close(), rmSync(dir, { recursive: true, force: true })) };
}

test("socketCall returns Herdr's result, even split mid-character, and rejects with Herdr's code", async () => {
	const fake = await socket((request, reply, end) => {
		if (request.method === "pane.list") {
			const frame = Buffer.from(`${JSON.stringify({ id: request.id, result: { panes: [{ label: "測試" }] } })}\n`), cut = frame.indexOf(Buffer.from("測")) + 1;
			reply(frame.subarray(0, cut));
			setTimeout(() => reply(frame.subarray(cut)), 20);
		} else if (request.method === "agent.view.set") reply(`${JSON.stringify({ id: request.id, error: { code: "invalid_params", message: "bad filter" } })}\n`);
		else if (request.method === "bad") reply("not json\n");
		else end();
	});
	try {
		const call = socketCall(fake.path);
		assert.deepEqual(await call("pane.list", {}), { panes: [{ label: "測試" }] });
		await assert.rejects(call("agent.view.set", {}), (e) => e.code === "invalid_params" && /bad filter/.test(e.message));
		await assert.rejects(call("bad", {}), (e) => e.code === "bad_frame");
		await assert.rejects(call("pane.close", {}), (e) => e.code === "closed");
		await assert.rejects(socketCall(join(tmpdir(), "psb-net-no-such.sock"))("ping", {}), (e) => e.code === "socket_error");
	} finally {
		fake.close();
	}
});

test("fileStore reads what it wrote, and a missing or unreadable file reads as off", async () => {
	const dir = mkdtempSync(join(tmpdir(), "psb-net-state-")), store = fileStore(join(dir, "nested", "state"));
	try {
		assert.equal(await store.read(), undefined);
		await store.write({ on: true, instance: "1:2" });
		assert.deepEqual(await store.read(), { on: true, instance: "1:2" });
		writeFileSync(join(dir, "nested", "state", "net-view.json"), "{not json");
		assert.equal(await store.read(), undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("main runs the action against a real socket: on, then off, with its state under the plugin's state directory", async () => {
	const herdr = fakeHerdr();
	const fake = await socket(async (request, reply) => {
		try {
			reply(`${JSON.stringify({ id: request.id, result: await herdr.handle(request.method, request.params) })}\n`);
		} catch (error) {
			reply(`${JSON.stringify({ id: request.id, error: { code: error.code, message: error.message } })}\n`);
		}
	});
	const env = { HERDR_PLUGIN_ID: "wayne930242.straw-boss", HERDR_PLUGIN_STATE_DIR: join(fake.dir, "state"), HERDR_SOCKET_PATH: fake.path };
	const lines = [], log = console.log;
	console.log = (line) => lines.push(line);
	try {
		await main(env);
		assert.equal(herdr.view.source, SOURCE, "the view is owned as plugin:<id>, so Herdr drops it when the plugin goes");
		assert.deepEqual(JSON.parse(readFileSync(join(fake.dir, "state", "net-view.json"), "utf8")), { on: true, instance: instanceOf(fake.path) });
		await main(env);
		assert.equal(herdr.view, undefined);
		assert.deepEqual(lines, ["net view on", "net view off"]);
		await assert.rejects(main({ HERDR_SOCKET_PATH: fake.path }), /is a Herdr plugin action/);
	} finally {
		console.log = log;
		fake.close();
	}
});

test("the manifest declares the action, its minimum Herdr version, and a command whose files exist", () => {
	const manifest = readFileSync(join(PLUGIN, "herdr-plugin.toml"), "utf8");
	assert.match(manifest, /^id = "wayne930242\.straw-boss"$/m, "the view's source is plugin:<this id>");
	assert.match(manifest, /^min_herdr_version = "0\.9\.3"$/m);
	assert.match(manifest, /\[\[actions\]\]\nid = "net"\ntitle = .*\ncontexts = \["global"\]\ncommand = \["\/bin\/bash", "run\.sh", "net-view\.mjs"\]/);
	for (const file of ["run.sh", "net-view.mjs"]) assert.ok(existsSync(join(PLUGIN, file)), file);
});

test("run.sh runs the script with the node on PATH, from the plugin directory, passing its arguments", () => {
	const dir = mkdtempSync(join(tmpdir(), "psb-net-node-"));
	try {
		writeFileSync(join(dir, "node"), '#!/bin/sh\necho "stub node in $(pwd): $*"\n');
		chmodSync(join(dir, "node"), 0o755);
		const run = spawnSync("/bin/bash", [join(PLUGIN, "run.sh"), "net-view.mjs", "one"], { encoding: "utf8", cwd: tmpdir(), env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir } });
		assert.equal(run.status, 0, run.stderr);
		assert.equal(run.stdout.trim(), `stub node in ${PLUGIN.replace(/\/$/, "")}: net-view.mjs one`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
