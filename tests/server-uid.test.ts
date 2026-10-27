import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { type CliDeps, run } from "../src/server/cli.ts";
import { describe, ensure, probe, restart, ServerError, stop } from "../src/server/client.ts";
import { fileOf, uidGate } from "../src/server/record.ts";
import { ServerWorld } from "./server-world.ts";

// docs/specs/2026-10-26-sb-backend.md, The control socket: where there is no ACL, a state folder (and a record in it) that another uid owns is refused before the record is read, a hello is sent, or
// anything is written, with the text and the exit of the Windows owner gate. A stat is all it costs: no process. A fake stat stands in for another account, which a test cannot be.

let world: ServerWorld;
beforeEach(() => void (world = new ServerWorld()));
afterEach(() => world.close());

const ME = 501, THEM = 1002;
/** A stat that knows the owners of `known` and has nothing else (ENOENT); `seen` lists what was asked, in order. */
const statOf = (known: Record<string, number>, seen: string[] = []) => (path: string) => {
	seen.push(path);
	if (!(path in known)) throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${path}'`), { code: "ENOENT" });
	return { uid: known[path]! };
};

test("a folder and a record the current uid owns pass, and so does a folder that is not there: nothing is read, nothing is asked of a process", () => {
	const record = fileOf(world.slot, "record"), seen: string[] = [];
	assert.equal(uidGate(world.slot, statOf({ [world.stateDir]: ME, [record]: ME }, seen), ME), false);
	assert.deepEqual(seen, [world.stateDir, record], "the folder first, then the record in it");
	assert.equal(uidGate(world.slot, statOf({}), ME), false, "nothing there is nothing to refuse");
	assert.equal(uidGate(world.slot, statOf({ [world.stateDir]: THEM }), null), false, "no uid to compare with (no getuid)");
});

test("another uid's state folder is refused with the Windows text, before the record in it is looked at", () => {
	const record = fileOf(world.slot, "record"), seen: string[] = [];
	assert.throws(
		() => uidGate(world.slot, statOf({ [world.stateDir]: THEM, [record]: ME }, seen), ME),
		(e: unknown) => e instanceof Error && e.message.startsWith(`could not check ${world.stateDir} before trusting or writing to it: `) && e.message.includes(`the folder ${world.stateDir} belongs to another account (uid ${THEM}), not to uid ${ME}. Run pi as that account, or delete the folder ${world.stateDir}, then start again.`),
	);
	assert.deepEqual(seen, [world.stateDir], "refused at the folder: the record is not asked about");
});

test("a secondary slot's own folder is judged too, between the state folder and the record; a record another uid owns in a folder of mine is refused", () => {
	const slot = { ...world.slot, primary: false, dir: join(world.stateDir, "servers", "0123456789abcdef") }, record = fileOf(slot, "record"), seen: string[] = [];
	assert.equal(uidGate(slot, statOf({ [slot.stateDir]: ME, [slot.dir]: ME, [record]: ME }, seen), ME), false);
	assert.deepEqual(seen, [slot.stateDir, slot.dir, record]);
	assert.throws(() => uidGate(slot, statOf({ [slot.stateDir]: ME, [slot.dir]: THEM }), ME), /the folder .*0123456789abcdef belongs to another account \(uid 1002\), not to uid 501/);
	assert.throws(() => uidGate(slot, statOf({ [slot.stateDir]: ME, [slot.dir]: ME, [record]: THEM }), ME), (e: unknown) => e instanceof Error && e.message.includes(`the file ${record} belongs to another account (uid ${THEM}), not to uid ${ME}`));
});

test("a stat that fails for any reason but a missing file is a refusal that says so", () => {
	const stat = () => { throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }); };
	assert.throws(() => uidGate(world.slot, stat, ME), (e: unknown) => e instanceof Error && e.message.startsWith(`could not check ${world.stateDir} before trusting or writing to it: `) && e.message.includes("EACCES"));
});

/** An attacker's folder: a live-looking record (this very process as its pid) whose socket is a listener that counts the connections made to it. */
async function decoy(dir: string, socket: string) {
	mkdirSync(dir, { recursive: true });
	let connections = 0;
	const listener = createServer((conn) => (connections++, conn.destroy()));
	listener.unref();
	await new Promise<void>((resolve) => listener.listen(socket, resolve));
	const record = { pid: process.pid, version: "0.1.0", herdr: world.slot.herdr, mode: "detached", desk: false, intercom: { transport: "default" }, log: join(dir, "server.log"), socket, secret: "a".repeat(64), intercomId: "sb-server-x", stopped: false };
	writeFileSync(join(dir, "server.json"), JSON.stringify(record));
	return { connections: () => connections, close: () => new Promise<void>((resolve) => listener.close(() => resolve())) };
}
const tree = (dir: string) => readdirSync(dir, { recursive: true }).map(String).sort();
const bytes = (dir: string) => tree(dir).map((name) => `${name}:${statSync(join(dir, name)).isFile() ? readFileSync(join(dir, name), "utf8") : ""}`);

test("every request that looks at a server (a session's look, status, up, stop, restart) refuses another uid's folder BEFORE it talks to the record's pipe or writes anything", async () => {
	for (const what of ["probe", "describe", "ensure", "restart", "stop"] as const) {
		const w = new ServerWorld();
		try {
			const bait = await decoy(w.stateDir, join(w.root, "decoy.sock"));
			const before = bytes(w.stateDir), mtime = statSync(w.stateDir).mtimeMs;
			const asked: string[] = [];
			const ctx = w.ctx({ alive: () => true, gate: (slot) => uidGate(slot, statOf({ [slot.stateDir]: THEM }, asked), ME) });
			const go = what === "probe" ? () => probe(ctx) : what === "describe" ? () => describe(ctx) : what === "ensure" ? () => ensure(ctx, { boss: true }) : what === "restart" ? () => restart(ctx, { reason: "r", boss: true }) : () => stop(ctx);
			try {
				await assert.rejects(go(), (e: unknown) => e instanceof ServerError && e.code === "start-failed" && e.startError?.code === "acl" && /belongs to another account \(uid 1002\), not to uid 501/.test(e.message), what);
				assert.equal(bait.connections(), 0, `${what}: nothing was sent to the record's pipe, not even a hello`);
				assert.deepEqual(bytes(w.stateDir), before, `${what}: no file written or changed`);
				assert.equal(statSync(w.stateDir).mtimeMs, mtime);
				assert.equal(w.spawned.length, 0);
				assert.ok(asked.length >= 1);
			} finally {
				await bait.close();
			}
		} finally {
			await w.close();
		}
	}
});

test("a start in another uid's folder that has no record is refused too, with nothing created in it", async () => {
	mkdirSync(world.stateDir, { recursive: true });
	const ctx = world.ctx({ gate: (slot) => uidGate(slot, statOf({ [slot.stateDir]: THEM }), ME) });
	await assert.rejects(ensure(ctx, { boss: true }), (e: unknown) => e instanceof ServerError && e.startError?.code === "acl" && /belongs to another account/.test(e.message));
	assert.deepEqual(tree(world.stateDir), []);
	assert.equal(world.spawned.length, 0);
});

/** Another account, as far as the real stat is concerned: this process looks like another uid than the one that made the folder. */
async function asAnother<T>(body: () => Promise<T>): Promise<T> {
	const real = process.getuid!;
	process.getuid = () => real.call(process) + 1;
	try {
		return await body();
	} finally {
		process.getuid = real;
	}
}

test("the gate every context has by default (a platform with no ACL) is that check with the real stat: a folder made by another uid is refused by probe, status, up, stop and restart, with a decoy pipe left alone", { skip: process.getuid === undefined }, async () => {
	const bait = await decoy(world.stateDir, join(world.root, "decoy.sock"));
	const before = bytes(world.stateDir);
	try {
		await asAnother(async () => {
			const ctx = world.ctx({ alive: () => true });
			for (const [what, go] of [["probe", () => probe(ctx)], ["describe", () => describe(ctx)], ["ensure", () => ensure(ctx, { boss: true })], ["restart", () => restart(ctx, { reason: "r", boss: true })], ["stop", () => stop(ctx)]] as const) {
				await assert.rejects(go(), (e: unknown) => e instanceof ServerError && e.startError?.code === "acl" && /belongs to another account \(uid \d+\), not to uid \d+/.test(e.message), what);
			}
		});
		assert.equal(bait.connections(), 0);
		assert.deepEqual(bytes(world.stateDir), before);
		assert.equal(world.spawned.length, 0);
		// The same folder, the same uid as its maker: looked at as it always was.
		assert.equal((await probe(world.ctx({ alive: () => true }))).record?.pid, process.pid);
	} finally {
		await bait.close();
	}
});

async function cli(argv: string[]) {
	const version = "0.44.0", { by: _by, ...requester } = world.ctx({ version, alive: () => true });
	let out = "", err = "";
	const code = await run(argv, { env: world.env, stateDir: world.stateDir, version, cli: "/fake/cli.mjs", ctx: requester, herdrListens: async () => true, out: (t) => void (out += t), err: (t) => void (err += t) } satisfies CliDeps);
	return { code, out, err };
}

test("cli.mjs status, up and stop in another uid's folder exit 3 with the 'belongs to another account' text and write nothing", { skip: process.getuid === undefined }, async () => {
	const bait = await decoy(world.stateDir, join(world.root, "decoy.sock"));
	const before = bytes(world.stateDir);
	try {
		await asAnother(async () => {
			for (const argv of [["status"], ["up"], ["stop"]]) {
				const r = await cli(argv);
				assert.equal(r.code, 3, argv.join(" "));
				assert.match(r.err, /belongs to another account \(uid \d+\), not to uid \d+/, argv.join(" "));
				assert.equal(r.out, "", `${argv.join(" ")}: nothing on stdout`);
			}
		});
		assert.equal(bait.connections(), 0);
		assert.deepEqual(bytes(world.stateDir), before);
	} finally {
		await bait.close();
	}
});
