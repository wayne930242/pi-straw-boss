// @ts-nocheck: the plugin script is plain JavaScript and the fake Herdr's panes are loose test data.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { activeView, fileStore, instanceOf, main, netView, reapply, socketCall, startup, toggle } from "../herdr-plugin/net-view.mjs";

const PLUGIN = fileURLToPath(new URL("../herdr-plugin/", import.meta.url));

const SOURCE = "plugin:wayne930242.straw-boss";
/** The probe: a clear naming a source nobody owns (Herdr 0.9.5 answers it with the active view and changes nothing). Its source is outside the `plugin:` namespace, so no plugin id can produce it. */
const PROBE = /^straw-boss-probe:/;
/** The clears that took a view away: every clear but the probe. */
const wiping = (herdr) => herdr.clears.filter((params) => !PROBE.test(params.source));

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

test("netView sorts by the sb_order token, ascending, then by Herdr's own place order, and filters nothing", () => {
	assert.deepEqual(netView(), {
		label: "net",
		sort: [
			{ field: { token: "sb_order" }, order: "asc" },
			{ field: "workspace_order", order: "asc" },
			{ field: "tab_order", order: "asc" },
			{ field: "pane_order", order: "asc" },
		],
	}, "an agent without the token comes last, and the agents without it stay in a fixed order");
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
	assert.ok(wiping(herdr).every((params) => params.source === SOURCE), "every clear names this plugin, so it never wipes another owner's view");

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
	assert.ok(wiping(herdr).every((params) => params.source === SOURCE));
});

test("the view dropped inside one server run (the plugin unlinked and linked, or disabled and enabled) while the state still says on: the first press turns it on, the second off (B6 VM, #40)", async () => {
	const herdr = fakeHerdr(), store = memoryStore();
	await startup(deps(herdr, store));
	herdr.view = undefined; // Herdr dropped the view with the plugin; no startup hook ran; the state still says on for this server
	assert.deepEqual(store.state, { on: true, instance: "server-1" });
	assert.deepEqual(await toggle(deps(herdr, store)), { on: true }, "one press gives a visible change");
	assert.equal(herdr.view.source, SOURCE);
	assert.deepEqual(await toggle(deps(herdr, store)), { on: false });
	assert.equal(herdr.view, undefined);
	assert.deepEqual(store.state, { on: false, instance: "server-1" });
});

test("activeView reads the active view with a clear that names a source nobody owns, which changes nothing", async () => {
	const herdr = fakeHerdr();
	assert.deepEqual(await activeView({ call: (m, p) => herdr.handle(m, p), source: SOURCE }), { active: false, source: undefined });
	herdr.view = { source: "plugin:someone.else", label: "theirs" };
	assert.deepEqual(await activeView({ call: (m, p) => herdr.handle(m, p), source: SOURCE }), { active: true, source: "plugin:someone.else" });
	assert.equal(herdr.view.source, "plugin:someone.else", "the view is untouched");
	assert.ok(herdr.clears.every((params) => /^[A-Za-z0-9:._-]{1,120}$/.test(params.source)), "a source Herdr accepts: ASCII letters, digits, colon, dot, underscore, hyphen");
});

test("RV7-F008: the probe's source is outside the plugin namespace: a plugin whose id is <this id>-probe owns plugin:<this id>-probe, and probing never clears its view", async () => {
	const herdr = fakeHerdr(), store = memoryStore();
	herdr.view = { source: `${SOURCE}-probe`, label: "theirs" };
	assert.deepEqual(await activeView(deps(herdr, store)), { active: true, source: `${SOURCE}-probe` });
	assert.equal(herdr.view?.source, `${SOURCE}-probe`, "the other plugin's view is untouched by a probe");
	await reapply(deps(herdr, store));
	await toggle(deps(herdr, store)); // installs over it, as a press does: that is the press, not the probe
	assert.ok(herdr.clears.length >= 2 && herdr.clears.filter((params) => PROBE.test(params.source)).length === herdr.clears.length - wiping(herdr).length);
	for (const params of herdr.clears.filter((p) => PROBE.test(p.source))) {
		assert.ok(!params.source.startsWith("plugin:"), params.source);
		assert.match(params.source, /^[A-Za-z0-9:._-]{1,120}$/);
	}
});

test("RV7-F007: a press that turns the view off writes the off before it clears, so a reapply that sees the cleared view also sees the off; a state that cannot be written clears nothing", async () => {
	const herdr = fakeHerdr(), order = [];
	const store = { state: undefined, read: async () => store.state, write: async (state) => (order.push(`write:${state.on}`), void (store.state = state)) };
	const call = herdr.handle.bind(herdr);
	herdr.handle = async (method, params) => (!PROBE.test(params.source ?? "") && method === "agent.view.clear" && order.push("clear"), call(method, params));
	await toggle(deps(herdr, store));
	order.length = 0;
	await toggle(deps(herdr, store));
	assert.deepEqual(order, ["write:false", "clear"], "off is on disk before the view goes");
	// The write fails: the view stays, nothing is cleared, the press says why.
	await toggle(deps(herdr, store)); // on again
	store.write = async () => { throw new Error("disk full"); };
	herdr.clears.length = 0;
	await assert.rejects(toggle(deps(herdr, store)), /disk full/);
	assert.ok(herdr.view, "the view stays");
	assert.deepEqual(wiping(herdr), [], "and was not cleared");
	// The clear fails after the off was written: the wish goes back to on, so the next agent's reapply and the next press agree with what shows.
	store.write = async (state) => void (store.state = state);
	herdr.handle = async (method, params) => { if (method === "agent.view.clear" && !PROBE.test(params.source ?? "")) throw new Error("socket gone"); return call(method, params); };
	await assert.rejects(toggle(deps(herdr, store)), /socket gone/);
	assert.equal(store.state.on, true);
});

test("RV7-F007: reapply reads the wish again after it sees no view, so an off pressed between its first read and its install stands", async () => {
	const herdr = fakeHerdr();
	const reads = [{ on: true, instance: "server-1" }, { on: false, instance: "server-1" }];
	const store = { read: async () => reads.length > 1 ? reads.shift() : reads[0], write: async () => {} };
	assert.deepEqual(await reapply(deps(herdr, store)), { on: false });
	assert.equal(herdr.view, undefined, "nothing was installed over the press");
});

test("reapply puts the view back when none is active and the wish is not this server's off; it leaves an active view, its own or another's, and a pressed off alone", async () => {
	const herdr = fakeHerdr(), store = memoryStore();
	assert.deepEqual(await reapply(deps(herdr, store)), { on: true }, "a plugin installed into a running server, with no state yet, gets the default");
	assert.equal(herdr.view.source, SOURCE);
	herdr.calls.length = 0;
	assert.deepEqual(await reapply(deps(herdr, store)), { on: true });
	assert.deepEqual(herdr.calls, ["agent.view.clear"], "an active view of its own is only probed, never replaced");

	herdr.view = undefined; // the relink dropped it
	assert.deepEqual(await reapply(deps(herdr, store)), { on: true });
	assert.equal(herdr.view.source, SOURCE);

	herdr.view = { source: "plugin:someone.else", label: "theirs" };
	assert.deepEqual(await reapply(deps(herdr, store)), { on: false }, "another owner's view stays");
	assert.equal(herdr.view.source, "plugin:someone.else");

	herdr.view = undefined;
	await toggle(deps(herdr, store)); // installs
	await toggle(deps(herdr, store)); // off
	herdr.calls.length = 0;
	assert.deepEqual(await reapply(deps(herdr, store)), { on: false }, "this server's own off stands");
	assert.deepEqual(herdr.calls, []);
	assert.deepEqual(await reapply(deps(herdr, store, "server-2")), { on: true }, "a new server's wish is the default");
});

test("startup turns the view on without a press, and the key then toggles it off and on again", async () => {
	const herdr = fakeHerdr(), store = memoryStore();
	assert.deepEqual(await startup(deps(herdr, store)), { on: true });
	assert.deepEqual(herdr.view, { source: SOURCE, label: "net", sort: netView().sort, filter: undefined }, "the same view the key installs, owned as plugin:<id>");
	assert.deepEqual(store.state, { on: true, instance: "server-1" });
	assert.deepEqual(herdr.clears, [], "startup never clears: a server that has just started has no view to clear");

	assert.deepEqual(await toggle(deps(herdr, store)), { on: false }, "the first press after startup turns it off, not on again");
	assert.equal(herdr.view, undefined);
	assert.deepEqual(await toggle(deps(herdr, store)), { on: true });
	assert.equal(herdr.view.source, SOURCE);
});

test("a server that has just started is on by default whatever an earlier server left in the state", async () => {
	for (const left of [undefined, { on: true, instance: "server-1" }, { on: false, instance: "server-1" }]) {
		const herdr = fakeHerdr(), store = memoryStore();
		store.state = left;
		assert.deepEqual(await startup(deps(herdr, store, "server-2")), { on: true }, `after ${JSON.stringify(left)}`);
		assert.equal(herdr.view.source, SOURCE);
		assert.deepEqual(store.state, { on: true, instance: "server-2" });
	}
});

test("a startup that runs again in the same server keeps a press that turned the view off, and installs again over its own on", async () => {
	const herdr = fakeHerdr(), store = memoryStore();
	await startup(deps(herdr, store));
	await toggle(deps(herdr, store));
	herdr.calls.length = 0;
	assert.deepEqual(await startup(deps(herdr, store)), { on: false }, "this server's own off stands");
	assert.equal(herdr.view, undefined);
	assert.deepEqual(herdr.calls, [], "and it asks Herdr for nothing");

	await toggle(deps(herdr, store)); // on again
	assert.deepEqual(await startup(deps(herdr, store)), { on: true });
	assert.equal(herdr.view.source, SOURCE, "the same view replaced by itself");
	assert.deepEqual(store.state, { on: true, instance: "server-1" });
});

test("startup replaces another owner's view, as a press does, and a failed install leaves no view and no state", async () => {
	const herdr = fakeHerdr(), store = memoryStore();
	herdr.view = { source: "plugin:someone.else", label: "theirs" };
	await startup(deps(herdr, store));
	assert.equal(herdr.view.source, SOURCE);

	const broken = fakeHerdr({ failView: true }), unsaved = memoryStore();
	await assert.rejects(startup(deps(broken, unsaved)), (error) => error.code === "invalid_params");
	assert.equal(broken.view, undefined);
	assert.equal(unsaved.state, undefined);

	const lost = fakeHerdr();
	await assert.rejects(startup(deps(lost, { read: async () => undefined, write: async () => Promise.reject(new Error("ENOSPC")) })), /ENOSPC/);
	assert.equal(lost.view, undefined, "a view whose state could not be saved is cleared again");
});

test("a failed install leaves no state behind and is rethrown", async () => {
	const herdr = fakeHerdr({ failView: true }), store = memoryStore();
	await assert.rejects(toggle(deps(herdr, store)), (error) => error.code === "invalid_params");
	assert.equal(herdr.view, undefined);
	assert.equal(store.state, undefined);

	const refused = fakeHerdr(), unsaved = memoryStore();
	await assert.rejects(toggle({ ...deps(refused, unsaved), call: async (method, params) => (method === "agent.view.set" ? { type: "agent_view", active: false } : refused.handle(method, params)) }), /did not install the view/);
	assert.ok(wiping(refused).length === 1 && wiping(refused)[0].source === SOURCE, "a view that may be installed is cleared before the error goes out");
});

test("a view that was installed but whose state could not be saved is cleared, so a later press cannot lose track of it", async () => {
	const herdr = fakeHerdr(), store = { read: async () => undefined, write: async () => Promise.reject(new Error("ENOSPC")) };
	await assert.rejects(toggle(deps(herdr, store)), /ENOSPC/);
	assert.equal(herdr.view, undefined);
	assert.deepEqual(wiping(herdr), [{ source: SOURCE }]);
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

		// The startup hook of a new server (no state of this server yet): on without a press, and the state is the toggle's own.
		rmSync(join(fake.dir, "state", "net-view.json"));
		await main(env, ["startup"]);
		assert.equal(herdr.view.source, SOURCE);
		assert.deepEqual(JSON.parse(readFileSync(join(fake.dir, "state", "net-view.json"), "utf8")), { on: true, instance: instanceOf(fake.path) });
		await main(env);
		assert.equal(herdr.view, undefined, "the key's first press after startup turns the view off");
		await main(env, ["startup"]);
		assert.equal(herdr.view, undefined, "a startup that runs again in this server leaves its off alone");
		assert.deepEqual(lines.slice(2), ["net view on", "net view off", "net view off"]);
		// The event hook: the view is back when nothing shows it, and left alone when this server's off stands.
		rmSync(join(fake.dir, "state", "net-view.json"));
		await main(env, ["reapply"]);
		assert.equal(herdr.view.source, SOURCE);
		await main(env); // off
		await main(env, ["reapply"]);
		assert.equal(herdr.view, undefined);
		assert.deepEqual(lines.slice(5), ["net view on", "net view off", "net view off"]);
		await assert.rejects(main(env, ["start"]), /takes no argument/);
		await assert.rejects(main(env, ["startup", "now"]), /takes no argument/);
	} finally {
		console.log = log;
		fake.close();
	}
});

test("the manifest declares the startup hook and the action, the minimum Herdr version, and commands whose files exist", () => {
	const manifest = readFileSync(join(PLUGIN, "herdr-plugin.toml"), "utf8");
	assert.match(manifest, /^id = "wayne930242\.straw-boss"$/m, "the view's source is plugin:<this id>");
	assert.match(manifest, /^min_herdr_version = "0\.9\.5"$/m, "the probe's answer was checked on 0.9.5");
	assert.match(manifest, /^platforms = \["macos", "linux", "windows"\]$/m);
	assert.match(manifest, /\[\[startup\]\]\nplatforms = \["macos", "linux"\]\ncommand = \["\/bin\/bash", "run\.sh", "net-view\.mjs", "startup"\]/);
	assert.match(manifest, /\[\[startup\]\]\nplatforms = \["windows"\]\ncommand = \["node", "net-view\.mjs", "startup"\]/, "Windows has no bash: its twin runs node");
	assert.equal(manifest.match(/\[\[startup\]\]/g).length, 2, "one hook per platform, and it is the one-shot startup of net-view.mjs");
	assert.match(manifest, /\[\[events\]\]\non = "pane\.agent_detected"\nplatforms = \["macos", "linux"\]\ncommand = \["\/bin\/bash", "run\.sh", "net-view\.mjs", "reapply"\]/, "Herdr runs no startup hook at a link: the next agent it detects puts the view back");
	assert.match(manifest, /\[\[events\]\]\non = "pane\.agent_detected"\nplatforms = \["windows"\]\ncommand = \["node", "net-view\.mjs", "reapply"\]/);
	assert.equal(manifest.match(/\[\[events\]\]/g).length, 2);
	assert.match(manifest, /\[\[actions\]\]\nid = "net"\ntitle = .*\ncontexts = \["global"\]\nplatforms = \["macos", "linux"\]\ncommand = \["\/bin\/bash", "run\.sh", "net-view\.mjs"\]/);
	assert.match(manifest, /\[\[actions\]\]\nid = "net-windows"\ntitle = .*\ncontexts = \["global"\]\nplatforms = \["windows"\]\ncommand = \["node", "net-view\.mjs"\]/, "an action id is unique across platforms");
	for (const file of ["run.sh", "net-view.mjs"]) assert.ok(existsSync(join(PLUGIN, file)), file);
});

test("the startup command from the manifest turns the view on and then exits by itself, leaving no process behind", async () => {
	const herdr = fakeHerdr();
	const fake = await socket(async (request, reply) => reply(`${JSON.stringify({ id: request.id, result: await herdr.handle(request.method, request.params) })}\n`));
	const manifest = readFileSync(join(PLUGIN, "herdr-plugin.toml"), "utf8");
	const platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
	const command = JSON.parse([...manifest.matchAll(/\[\[startup\]\]\nplatforms = (\[.*\])\ncommand = (\[.*\])/g)].find((m) => JSON.parse(m[1]).includes(platform))[2]);
	// Herdr runs it from the plugin directory with the plugin's environment and the PATH of whatever started the server.
	const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: fake.dir, HERDR_PLUGIN_ID: "wayne930242.straw-boss", HERDR_PLUGIN_STATE_DIR: join(fake.dir, "state"), HERDR_SOCKET_PATH: fake.path, HERDR_PLUGIN_EVENT: "startup" };
	const child = spawn(command[0], command.slice(1), { cwd: PLUGIN, env, stdio: ["ignore", "pipe", "pipe"] });
	let out = "", err = "";
	child.stdout.on("data", (chunk) => (out += chunk));
	child.stderr.on("data", (chunk) => (err += chunk));
	const limit = setTimeout(() => child.kill("SIGKILL"), 15_000);
	try {
		const [code, signal] = await once(child, "close");
		assert.deepEqual([code, signal, err], [0, null, ""], "the hook ends by itself with success: it is not a daemon");
		assert.equal(out.trim(), "net view on");
		assert.equal(herdr.view.source, SOURCE);
		assert.deepEqual(JSON.parse(readFileSync(join(fake.dir, "state", "net-view.json"), "utf8")), { on: true, instance: instanceOf(fake.path) });
		assert.equal(child.exitCode, 0);
		assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" }, "no process of the hook is left");
	} finally {
		clearTimeout(limit);
		child.kill("SIGKILL");
		fake.close();
	}
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
