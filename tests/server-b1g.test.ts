import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { type CliDeps, run } from "../src/server/cli.ts";
import { describe, ServerError, trusted } from "../src/server/client.ts";
import { secretDir } from "../src/server/record.ts";
import { forgetSid, GateTimeout, OWNER_READ_RETRY_MS, ownerGate, protectFolder, setNote } from "../src/server/winprep.ts";
import { ServerWorld } from "./server-world.ts";

// Re-check of the b1f fixes (R2-F001 to R2-F004, F006's gap): the gate comes before every file of the slot is read, a Windows folder is remembered only when it is closed to others,
// a path that vanished during the owner read is a failed read, and a sudo message names only the folders pi's own.

let world: ServerWorld;
beforeEach(() => void (world = new ServerWorld()));
afterEach(() => world.close());

const OWNER = "S-1-5-21-1111111111-2222222222-3333333333-1001";
const GOOD = `D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;${OWNER})`;
const OPEN = `${GOOD}(A;OICI;FA;;;BU)`;

function cliWith(gate: () => boolean | Promise<boolean>) {
	return async (argv: string[], over: Partial<CliDeps> = {}) => {
		const version = "0.44.0", { by: _by, ...requester } = world.ctx({ version, gate });
		let out = "", err = "";
		const code = await run(argv, { env: world.env, stateDir: world.stateDir, version, cli: "/fake/cli.mjs", ctx: requester, herdrListens: async () => true, out: (t) => void (out += t), err: (t) => void (err += t), ...over } satisfies CliDeps);
		return { code, out, err };
	};
}
const refusing = (): boolean => { throw new Error("belongs to another account"); };

test("R2-F001: logs gates when the state folder exists, whether or not server.log does (a rotated log is a file of the folder)", async () => {
	mkdirSync(world.stateDir, { recursive: true });
	writeFileSync(join(world.stateDir, "server.log.1"), "ATTACKER LINE rotated\n");
	const logs = await cliWith(refusing)(["logs"]);
	assert.equal(logs.code, 3);
	assert.ok(!(logs.out + logs.err).includes("ATTACKER"));
});

test("R2-F001: logs --follow gates once, when the log first appears; a refusing gate prints nothing", async () => {
	mkdirSync(world.stateDir, { recursive: true });
	const file = join(world.stateDir, "server.log");
	// The steps run inside the follow's own sleeps: nothing is left pending when the test ends.
	const stepper = (steps: (() => void)[], abort: AbortController) => async () => {
		const step = steps.shift();
		if (step) step();
		else abort.abort();
	};
	let gates = 0;
	const abort = new AbortController();
	const followed = await cliWith(() => (gates++, false))(["logs", "--follow"], {
		signal: abort.signal,
		ctx: { sleep: stepper([() => {}, () => writeFileSync(file, "line one\n"), () => appendFileSync(file, "line two\n"), () => {}], abort), gate: () => (gates++, false) } as never,
	});
	assert.equal(followed.code, 0);
	assert.match(followed.out, /line one/);
	assert.match(followed.out, /line two/);
	assert.equal(gates, 1, "the gate ran once, when the folder was first seen");
});

test("R2-F001: logs --follow with a gate that refuses prints nothing of a log that appears later", async () => {
	const file = join(world.stateDir, "server.log");
	mkdirSync(world.stateDir, { recursive: true });
	const abort = new AbortController();
	let slept = 0;
	const refused = await cliWith(refusing)(["logs", "--follow"], {
		signal: abort.signal,
		ctx: { sleep: async () => { if (slept++ === 0) writeFileSync(file, "ATTACKER LINE follow\n"); else abort.abort(); }, gate: refusing } as never,
	});
	assert.equal(refused.code, 3);
	assert.ok(!(refused.out + refused.err).includes("ATTACKER"));
});

test("R2-F002: describe never returns a start error it read before the folder was judged (a file that comes and goes by rename)", async () => {
	mkdirSync(world.stateDir, { recursive: true });
	const script = `const { renameSync, writeFileSync } = require("node:fs"); const d = ${JSON.stringify(world.stateDir)};
writeFileSync(d + "/start-error.json.off", JSON.stringify({ at: new Date().toISOString(), code: "start", text: "ATTACKER START ERROR" }));
const end = Date.now() + 1500;
while (Date.now() < end) { try { renameSync(d + "/start-error.json.off", d + "/start-error.json"); } catch {} try { renameSync(d + "/start-error.json", d + "/start-error.json.off"); } catch {} }`;
	const child = spawn(process.execPath, ["-e", script], { stdio: "ignore" });
	const exited = new Promise((resolve) => child.on("exit", resolve));
	const ctx = world.ctx({ alive: () => false, gate: refusing });
	let leaked = 0, calls = 0;
	for (const end = Date.now() + 1300; Date.now() < end;) {
		calls++;
		try {
			const out = await describe(ctx);
			if (out.startError) leaked++;
		} catch { /* refused */ }
	}
	await exited;
	assert.ok(calls > 50);
	assert.equal(leaked, 0);
});

test("R2-F004: the sudo message names a root-owned folder only when it is pi's own", { skip: !process.getuid || process.getuid() === 0 || !existsSync("/var/root") }, () => {
	assert.throws(() => secretDir("/var/root/straw-boss-test", "/var/root"), /belongs to root; it was made by a sudo run/);
	assert.throws(() => secretDir("/var/root/straw-boss-test", world.stateDir), (e: Error) => !/belongs to root/.test(e.message));
	assert.throws(() => secretDir("/var/root/straw-boss-test"), (e: Error) => !/belongs to root/.test(e.message));
});

// --- Windows (a fake for the native calls) ---

interface Fake { owners: string[]; dacl?: string; whoamiCalls?: number }
function fake(over: Fake) {
	const calls = { ps: 0, icacls: 0, scripts: [] as string[] };
	const run = async (file: string, args: string[], _ms?: number, _env?: Record<string, string>) => {
		if (file === "whoami.exe") return `"PC\\me","${OWNER}"\r\n`;
		if (file.endsWith("powershell.exe")) {
			calls.ps++;
			calls.scripts.push(Buffer.from(args[args.indexOf("-EncodedCommand") + 1]!, "base64").toString("utf16le"));
			return over.owners.map((o, i) => `${i}:${o}`).join("\r\n");
		}
		calls.icacls++;
		if (args.includes("/save")) writeFileSync(args[args.indexOf("/save") + 1]!, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`straw-boss\r\n${over.dacl ?? GOOD}\r\n`, "utf16le")]));
		return "";
	};
	return { calls, run };
}

test("R2-F003: a folder is remembered as verified only when its DACL lets no other account create entries", async () => {
	forgetSid();
	mkdirSync(world.stateDir, { recursive: true });
	// A folder that stays open (the protect has no effect) is held for OWNER_READ_RETRY_MS, then read again.
	let t = 1_000;
	const open = fake({ owners: [OWNER], dacl: OPEN });
	await ownerGate(world.stateDir, open.run, undefined, () => t);
	t += OWNER_READ_RETRY_MS + 1;
	await ownerGate(world.stateDir, open.run, undefined, () => t);
	assert.equal(open.calls.ps, 2, "an open folder is read again after the window");
	forgetSid();
	const closed = fake({ owners: [OWNER], dacl: GOOD });
	await ownerGate(world.stateDir, closed.run);
	await ownerGate(world.stateDir, closed.run);
	assert.equal(closed.calls.ps, 1, "a closed folder is read once");
});

test("R2-F003: a path that was there before the read and reads '-' is a failed read, and nothing is remembered", async () => {
	forgetSid();
	mkdirSync(world.stateDir, { recursive: true });
	const record = join(world.stateDir, "server.json");
	writeFileSync(record, "{}");
	const gone = fake({ owners: [OWNER, "-"] });
	await assert.rejects(ownerGate(world.stateDir, gone.run, undefined, undefined, [record]), GateTimeout);
	await assert.rejects(ownerGate(world.stateDir, gone.run, undefined, undefined, [record]), GateTimeout);
	assert.equal(gone.calls.ps, 2, "read again, not remembered");
});

test("R2-F003: the owner script stops at its first error", async () => {
	forgetSid();
	mkdirSync(world.stateDir, { recursive: true });
	const f = fake({ owners: [OWNER] });
	await ownerGate(world.stateDir, f.run);
	assert.match(f.calls.scripts[0]!, /\$ErrorActionPreference = 'Stop'/);
});

test("F006 gap: protectFolder keeps a GateTimeout of its owner read", () => {
	forgetSid();
	mkdirSync(world.stateDir, { recursive: true });
	const run = (file: string, args: string[]) => {
		if (file === "whoami.exe") return `"PC\\me","${OWNER}"\r\n`;
		if (file.endsWith("powershell.exe")) throw Object.assign(new Error("spawnSync powershell.exe ETIMEDOUT"), { code: "ETIMEDOUT", syscall: "spawnSync powershell.exe", status: null });
		if (args.includes("/save")) writeFileSync(args[args.indexOf("/save") + 1]!, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`straw-boss\r\n${OPEN}\r\n`, "utf16le")]));
		return "";
	};
	assert.throws(() => protectFolder(world.stateDir, run), GateTimeout);
});

// --- re-check 3 ---

function savable(file: string, sddl: string) {
	writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`straw-boss\r\n${sddl}\r\n`, "utf16le")]));
}

test("R3-F001: a folder swapped in during the DACL read is not remembered as verified", async () => {
	forgetSid();
	const dir = world.stateDir, attacker = join(world.root, "evil"), record = join(dir, "server.json");
	mkdirSync(dir, { recursive: true });
	mkdirSync(attacker);
	let ps = 0, saves = 0;
	const run = async (file: string, args: string[], _ms?: number, env?: Record<string, string>) => {
		if (file === "whoami.exe") return `"PC\\me","${OWNER}"\r\n`;
		if (file.endsWith("powershell.exe")) { ps++; return env!.SB_OWNER_DIR.split("|").map((_p, i) => `${i}:${OWNER}`).join("\r\n"); }
		if (args.includes("/save")) {
			if (++saves === 1) { renameSync(dir, join(world.root, "orig")); renameSync(attacker, dir); }
			savable(args[args.indexOf("/save") + 1]!, GOOD);
		}
		return "";
	};
	await ownerGate(dir, run, undefined, undefined, [record]);
	await ownerGate(dir, run, undefined, undefined, [record]);
	assert.equal(ps, 2, "the folder now at the name was never read: it is read by the next request");
});

test("R3-F002: an open folder is protected where the gate passes it, then remembered: later looks cost no PowerShell", async () => {
	forgetSid();
	mkdirSync(world.stateDir, { recursive: true });
	let ps = 0, protects = 0, dacl = OPEN;
	const run = async (file: string, args: string[], _ms?: number, env?: Record<string, string>) => {
		if (file === "whoami.exe") return `"PC\\me","${OWNER}"\r\n`;
		if (file.endsWith("powershell.exe")) { ps++; return env!.SB_OWNER_DIR.split("|").map((_p, i) => `${i}:${OWNER}`).join("\r\n"); }
		if (args.includes("/inheritance:r")) { protects++; dacl = GOOD; }
		if (args.includes("/save")) savable(args[args.indexOf("/save") + 1]!, dacl);
		return "";
	};
	await ownerGate(world.stateDir, run);
	await ownerGate(world.stateDir, run);
	await ownerGate(world.stateDir, run);
	assert.equal(protects, 1);
	assert.equal(ps, 1);
});

test("R3-F002: when the protect fails, the open folder is re-read no more than every OWNER_READ_RETRY_MS, and at once when the record changed", async () => {
	forgetSid();
	mkdirSync(world.stateDir, { recursive: true });
	const record = join(world.stateDir, "server.json");
	writeFileSync(record, "{}");
	let ps = 0, t = 1_000;
	const run = async (file: string, args: string[], _ms?: number, env?: Record<string, string>) => {
		if (file === "whoami.exe") return `"PC\\me","${OWNER}"\r\n`;
		if (file.endsWith("powershell.exe")) { ps++; return env!.SB_OWNER_DIR.split("|").map((_p, i) => `${i}:${OWNER}`).join("\r\n"); }
		if (args.includes("/inheritance:r")) throw Object.assign(new Error("denied"), { status: 5 });
		if (args.includes("/save")) savable(args[args.indexOf("/save") + 1]!, OPEN);
		return "";
	};
	const gate = () => ownerGate(world.stateDir, run, undefined, () => t, [record]);
	await gate();
	await gate();
	assert.equal(ps, 1, "no second read inside the retry window");
	writeFileSync(record + ".new", "{}");
	renameSync(record + ".new", record);
	await gate();
	assert.equal(ps, 2, "a record that changed identity is judged");
	t += OWNER_READ_RETRY_MS + 1;
	await gate();
	assert.equal(ps, 3, "read again after the window");
});

test("Windows item 2: a path that is gone is 'not there' by the walk's pattern: catch { if (Test-Path -LiteralPath $p) { throw } }", async () => {
	forgetSid();
	mkdirSync(world.stateDir, { recursive: true });
	const f = fake({ owners: [OWNER] });
	await ownerGate(world.stateDir, f.run);
	assert.match(f.calls.scripts[0]!, /catch \{ if \(Test-Path -LiteralPath \$p\) \{ throw \} \}/);
	assert.ok(!/FileNotFoundException/.test(f.calls.scripts[0]!));
});

test("P2: the record's content is bound to the file the gate judged: a file renamed over it during the owner read is a wait, and its content is not returned", async () => {
	forgetSid();
	const dir = world.stateDir, rec = join(dir, "server.json"), log = join(dir, "server.log");
	mkdirSync(dir, { recursive: true });
	writeFileSync(rec, JSON.stringify({ pid: 4242, socket: "ATTACKER", secret: "ATTACKER-SECRET" }));
	writeFileSync(log, "own log\n");
	const run = async (file: string, args: string[], _ms?: number, env?: Record<string, string>) => {
		if (file === "whoami.exe") return `"PC\\me","${OWNER}"\r\n`;
		if (file.endsWith("powershell.exe")) { renameSync(log, rec); return env!.SB_OWNER_DIR.split("|").map((_p, i) => `${i}:${OWNER}`).join("\r\n"); }
		if (args.includes("/save")) savable(args[args.indexOf("/save") + 1]!, GOOD);
		return "";
	};
	const ctx = world.ctx({ platform: "win32", gate: (slot: { stateDir: string }, ms?: number) => ownerGate(slot.stateDir, run, ms, undefined, [rec]) });
	await assert.rejects(trusted(ctx), (e: unknown) => e instanceof ServerError && e.wait === "start" && e.startError === undefined);
});

test("R4-F001: secure does not protect a folder other than the one whose owner it read", () => {
	forgetSid();
	const dir = world.stateDir, other = join(world.root, "other");
	mkdirSync(dir, { recursive: true });
	mkdirSync(other);
	const protects: string[] = [];
	const run = (file: string, args: string[]) => {
		if (file === "whoami.exe") return `"PC\\me","${OWNER}"\r\n`;
		if (file.endsWith("powershell.exe")) { renameSync(dir, join(world.root, "aside")); renameSync(other, dir); return `0:${OWNER}\r\n`; }
		if (args.includes("/inheritance:r")) protects.push(args[0]!);
		if (args.includes("/save")) savable(args[args.indexOf("/save") + 1]!, OPEN);
		return "";
	};
	assert.throws(() => protectFolder(dir, run), /replaced/);
	assert.deepEqual(protects, []);
});

test("R4-F003: a folder that stayed open is told through the note hook, once", async () => {
	forgetSid();
	mkdirSync(world.stateDir, { recursive: true });
	const notes: string[] = [];
	setNote((text) => void notes.push(text));
	try {
		let t = 1_000;
		const run = async (file: string, args: string[], _ms?: number, env?: Record<string, string>) => {
			if (file === "whoami.exe") return `"PC\\me","${OWNER}"\r\n`;
			if (file.endsWith("powershell.exe")) return env!.SB_OWNER_DIR.split("|").map((_p, i) => `${i}:${OWNER}`).join("\r\n");
			if (args.includes("/inheritance:r")) throw Object.assign(new Error("denied"), { status: 5 });
			if (args.includes("/save")) savable(args[args.indexOf("/save") + 1]!, OPEN);
			return "";
		};
		await ownerGate(world.stateDir, run, undefined, () => t);
		t += OWNER_READ_RETRY_MS + 1;
		await ownerGate(world.stateDir, run, undefined, () => t);
		assert.equal(notes.length, 1);
		assert.match(notes[0]!, /could not protect/);
	} finally {
		setNote(undefined);
	}
});
