import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { type CliDeps, run } from "../src/server/cli.ts";
import { describe, passGate, probe, ServerError } from "../src/server/client.ts";
import { fileOf, prepareSlot, readRecord, secretDir, uidGate } from "../src/server/record.ts";
import { execAsync, forgetSid, GateTimeout, ownerGate } from "../src/server/winprep.ts";
import { ServerWorld } from "./server-world.ts";

// Review of 873be01 (b1f-F001 to F009): the trust gate cannot be passed by a record that appears and disappears, the Windows read judges the slot's folder and the record in the same
// PowerShell, no file of a foreign folder is read, the POSIX gate judges links and accepts root, and a read that ran out of time is a wait.

let world: ServerWorld;
beforeEach(() => void (world = new ServerWorld()));
afterEach(() => world.close());

const ME = 501, THEM = 1002;
const OWNER = "S-1-5-21-1111111111-2222222222-3333333333-1001", FOREIGN = "S-1-5-21-1111111111-2222222222-3333333333-1999";
const FLICKER = (dir: string, ms: number) => `
const { renameSync, writeFileSync } = require("node:fs");
const dir = ${JSON.stringify(dir)};
writeFileSync(dir + "/server.json.off", JSON.stringify({ pid: process.pid, socket: dir + "/nowhere.sock", secret: "a".repeat(64), version: "0.1.0", herdr: "x", mode: "detached", desk: false, intercom: {}, log: "", intercomId: "x" }));
const end = Date.now() + ${ms};
while (Date.now() < end) {
	try { renameSync(dir + "/server.json.off", dir + "/server.json"); } catch {}
	try { renameSync(dir + "/server.json", dir + "/server.json.off"); } catch {}
}`;

test("F001: a record that appears and disappears by rename is never used by a look whose gate refuses the folder", async () => {
	mkdirSync(world.stateDir, { recursive: true });
	let gates = 0;
	const ctx = world.ctx({ alive: () => false, gate: () => { gates++; throw new Error("belongs to another account"); } });
	const child = spawn(process.execPath, ["-e", FLICKER(world.stateDir, 1500)], { stdio: "ignore" });
	const exited = new Promise((resolve) => child.on("exit", resolve));
	let used = 0, refused = 0;
	for (const end = Date.now() + 1300; Date.now() < end;) {
		try {
			const seen = await probe(ctx);
			if (seen.record) used++;
		} catch (error) {
			assert.ok(error instanceof ServerError && error.startError?.code === "acl");
			refused++;
		}
	}
	await exited;
	assert.ok(refused > 0 && gates > 0, "the record was there at times");
	assert.equal(used, 0, "a record from a folder that is refused was used");
});

test("F002: one PowerShell read judges the state folder, the slot's folder and the record; a foreign record in a folder of mine is refused, naming it; the read is not repeated", async () => {
	forgetSid();
	const slot = { ...world.slot, primary: false, dir: join(world.stateDir, "servers", "0123456789abcdef") };
	mkdirSync(slot.dir, { recursive: true });
	const record = fileOf(slot, "record");
	writeFileSync(record, "{}");
	const calls: { file: string; env?: Record<string, string> }[] = [];
	const answer = (owners: string[]) => async (file: string, args: string[], _ms?: number, env?: Record<string, string>) => {
		calls.push({ file, ...(env ? { env } : {}) });
		if (args.includes("/save")) writeFileSync(args[args.indexOf("/save") + 1]!, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`straw-boss\r\nD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;${OWNER})\r\n`, "utf16le")]));
		if (args.includes("/save")) return "";
		return file === "whoami.exe" ? `"PC\\me","${OWNER}"\r\n` : owners.map((o, i) => `${i}:${o}`).join("\r\n");
	};
	await assert.rejects(ownerGate(slot.stateDir, answer([OWNER, OWNER, FOREIGN]), undefined, undefined, [slot.dir, record]), (e: Error) => e.message.includes(`the folder ${record} belongs to another account (${FOREIGN})`));
	const read = calls.filter((c) => c.file.endsWith("powershell.exe"));
	assert.equal(read.length, 1, "one PowerShell for the three paths");
	assert.equal(read[0]!.env!.SB_OWNER_DIR, [slot.stateDir, slot.dir, record].join("|"));
	// A refusal is held; and a closed folder whose paths are all acceptable is remembered.
	forgetSid();
	assert.equal(await ownerGate(slot.stateDir, answer([OWNER, OWNER, OWNER]), undefined, undefined, [slot.dir, record]), true);
	assert.equal(await ownerGate(slot.stateDir, answer([FOREIGN]), undefined, undefined, [slot.dir, record]), false, "remembered: no second read");
});

test("F006: a read that ran out of time is a wait (exit 1), says so, and is read again by the next request; a death by another signal is not 'ETIMEDOUT'", async () => {
	forgetSid();
	mkdirSync(world.stateDir, { recursive: true });
	let reads = 0;
	const slow = async (file: string) => {
		if (file === "whoami.exe") return `"PC\\me","${OWNER}"\r\n`;
		reads++;
		throw Object.assign(new Error("spawnSync powershell.exe ETIMEDOUT"), { code: "ETIMEDOUT", syscall: "spawnSync powershell.exe", status: null });
	};
	for (let i = 0; i < 2; i++) await assert.rejects(ownerGate(world.stateDir, slow, 500), GateTimeout);
	assert.equal(reads, 2, "a timeout is not remembered as a refusal");
	writeFileSync(fileOf(world.slot, "record"), "{}");
	const ctx = world.ctx({ gate: () => ownerGate(world.stateDir, slow, 500) });
	await assert.rejects(passGate(ctx), (e: unknown) => e instanceof ServerError && e.wait === "start" && e.startError === undefined && !/^acl:/.test(e.message));
	const dir = join(world.root, "k");
	mkdirSync(dir);
	const timed = execAsync(process.execPath, ["-e", "setTimeout(()=>{},60000)"], { timeout: 100, cwd: dir });
	await assert.rejects(timed, (e: { code?: string }) => e.code === "ETIMEDOUT");
});
test("F006: a signal that is not our timer's is not a timeout", async () => {
	await assert.rejects(execAsync(process.execPath, ["-e", "process.kill(process.pid, 'SIGKILL')"], { timeout: 20_000 }), (e: { code?: unknown; signal?: string }) => e.code !== "ETIMEDOUT" && e.signal === "SIGKILL");
});

async function decoy(dir: string) {
	mkdirSync(dir, { recursive: true });
	let connections = 0;
	const socket = join(world.root, "decoy.sock"), listener = createServer((c) => (connections++, c.destroy()));
	listener.unref();
	await new Promise<void>((resolve) => listener.listen(socket, resolve));
	writeFileSync(join(dir, "server.log"), "ATTACKER LOG LINE\n");
	writeFileSync(join(dir, "start-error.json"), JSON.stringify({ at: new Date().toISOString(), code: "start", text: "ATTACKER START ERROR" }));
	return { connections: () => connections, close: () => new Promise<void>((resolve) => listener.close(() => resolve())) };
}
const refusing = (slot: { stateDir: string }) => { throw new Error(`could not check ${slot.stateDir} before trusting or writing to it: the folder ${slot.stateDir} belongs to another account (uid ${THEM}), not to uid ${ME}.`); };

test("F004: no file of a foreign folder is read: logs, status and the start error of up are refused or left out", async () => {
	const bait = await decoy(world.stateDir);
	try {
		const cli = async (argv: string[]) => {
			const version = "0.44.0", { by: _by, ...requester } = world.ctx({ version, gate: refusing });
			let out = "", err = "";
			const code = await run(argv, { env: world.env, stateDir: world.stateDir, version, cli: "/fake/cli.mjs", ctx: requester, herdrListens: async () => true, out: (t) => void (out += t), err: (t) => void (err += t) } satisfies CliDeps);
			return { code, out, err };
		};
		const logs = await cli(["logs"]);
		assert.equal(logs.code, 3);
		assert.equal(logs.out, "");
		assert.ok(!logs.err.includes("ATTACKER"));
		const status = await cli(["status"]);
		assert.equal(status.code, 3);
		assert.ok(!(status.out + status.err).includes("ATTACKER"));
		await assert.rejects(describe(world.ctx({ gate: refusing })), (e: unknown) => e instanceof ServerError && e.startError?.code === "acl");
		const up = await cli(["up"]);
		assert.equal(up.code, 3);
		assert.ok(!up.err.includes("ATTACKER"), "up's error JSON keeps the refusal, not the folder's start-error.json");
		assert.match(up.err, /belongs to another account/);
		assert.equal(bait.connections(), 0);
	} finally {
		await bait.close();
	}
});

test("F005a: a link another uid made is refused whatever it points to; a link of mine to a folder of another uid is refused by its target; uid 0 is accepted", () => {
	const known = (owners: Record<string, number>, links: string[] = []) => (path: string) => {
		if (!(path in owners)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
		return { uid: owners[path]!, isSymbolicLink: () => links.includes(path) };
	};
	const s = world.stateDir;
	assert.throws(() => uidGate(world.slot, known({ [s]: THEM }, [s]), ME), /the folder .* \(a link\) belongs to another account \(uid 1002\)/);
	const lstat = known({ [s]: ME }, [s]), stat = known({ [s]: THEM });
	assert.throws(() => uidGate(world.slot, stat, ME, lstat), /belongs to another account \(uid 1002\)/);
	assert.equal(uidGate(world.slot, known({ [s]: 0 }), ME), false, "root's folder is accepted");
	assert.equal(uidGate(world.slot, known({ [s]: ME, [fileOf(world.slot, "record")]: 0 }), ME), false);
});

test("F005a/c: a real symlink as the record is neither followed nor read; a real symlinked state folder is judged at the link and its target", () => {
	mkdirSync(world.stateDir, { recursive: true });
	const real = join(world.root, "elsewhere.json");
	writeFileSync(real, JSON.stringify({ pid: 1, socket: "/x", secret: "s" }));
	symlinkSync(real, fileOf(world.slot, "record"));
	assert.equal(readRecord(world.slot), undefined, "O_NOFOLLOW: a link is no record");
	rmSync(fileOf(world.slot, "record"));
	writeFileSync(fileOf(world.slot, "record"), JSON.stringify({ pid: 1, socket: "/x", secret: "s" }));
	assert.equal(readRecord(world.slot)?.pid, 1);
	const link = join(world.root, "agent2");
	symlinkSync(world.stateDir, link);
	assert.equal(lstatSync(link).isSymbolicLink(), true);
	assert.equal(uidGate({ ...world.slot, stateDir: link, dir: link }, undefined, process.getuid?.() ?? null), false, "mine, to mine");
});

test("F005b: prepareSlot waits for the gate before it makes the folder on POSIX, and a refusal leaves nothing", async () => {
	const dir = join(world.root, "fresh", "straw-boss");
	const slot = { ...world.slot, stateDir: dir, dir };
	await assert.rejects(Promise.resolve().then(() => prepareSlot(slot, "linux", undefined, undefined, () => { throw new Error("foreign"); })), /foreign/);
	assert.equal(existsSync(dir), false);
	await prepareSlot(slot, "linux", undefined, undefined, async () => {});
	assert.equal(existsSync(dir), true);
});

test("root: a folder a sudo run made is told with what to do", { skip: !process.getuid || process.getuid() === 0 || !existsSync("/var/root") }, () => {
	assert.throws(() => secretDir("/var/root/straw-boss-test", "/var/root"), /belongs to root; it was made by a sudo run: sudo chown -R it/);
});
