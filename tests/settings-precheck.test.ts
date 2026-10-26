import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MAX_READ } from "../src/trust/found.ts";
import { assertSettingsSafe, type Ran, refusalText, runChild, type RunProbe, SettingsRefused, settingsRefusal } from "../src/trust/settings.ts";

// The check made before pi starts in a folder (trust/settings.ts): pi 1.4.0 reads <folder>/.pi/settings.json whole before any extension can stop it.
// The kernel resolves the path in a child process whose working directory is the folder, as it will for pi; most tests here run that real child.

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "psb-settings-")));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
let n = 0;
/** A folder whose .pi/settings.json is made by `make` (given the file's path). */
function folder(make?: (file: string) => void): string {
	const dir = join(scratch, `d${++n}`);
	mkdirSync(join(dir, ".pi"), { recursive: true });
	make?.(join(dir, ".pi", "settings.json"));
	return dir;
}
/** A probe runner that answers `ran`, counting its calls. */
const answering = (ran: Ran) => {
	const run: RunProbe & { calls: number } = Object.assign(async () => (run.calls++, ran), { calls: 0 });
	return run;
};
const says = (o: object): Ran => ({ out: `${JSON.stringify(o)}\n` });
const linux = process.platform === "linux", mac = process.platform === "darwin";

test("no .pi costs one lstat and no child", async () => {
	const run = answering({ failed: "crash" });
	assert.equal(await settingsRefusal(join(scratch, "nowhere"), run), undefined);
	const dir = join(scratch, "dotfile");
	mkdirSync(dir);
	writeFileSync(join(dir, ".pi"), "");
	const file = answering(says({ r: "absent" }));
	assert.equal(await settingsRefusal(dir, file), undefined, ".pi that is a file holds no settings");
	assert.equal(run.calls, 0);
	const empty = join(scratch, "empty");
	mkdirSync(empty);
	assert.equal(await settingsRefusal(empty, run), undefined);
	assert.equal(run.calls, 0, "a folder without .pi starts no child");
});

test("the child's answers, read as they come (fake outputs)", async () => {
	const dir = folder();
	const refusal = (ran: Ran) => settingsRefusal(dir, answering(ran));
	for (const r of [{ r: "ok" }, { r: "dir" }, { r: "absent" }, { r: "absent", code: "EACCES" }]) assert.equal(await refusal(says(r)), undefined, JSON.stringify(r));
	assert.equal((await refusal(says({ r: "special" })))?.why, "special");
	const large = (await refusal(says({ r: "large", size: MAX_READ + 5 })))!;
	assert.deepEqual([large.why, large.size, large.limit], ["large", MAX_READ + 5, MAX_READ]);
	assert.equal((await refusal(says({ r: "large" })))?.size, MAX_READ + 1, "no size given: the least it can be");
	const loop = (await refusal(says({ r: "unreadable", code: "ELOOP" })))!;
	assert.deepEqual([loop.why, loop.code], ["unreadable", "ELOOP"]);
	assert.equal((await refusal(says({ r: "unreadable", code: "EIO" })))?.code, "EIO");
	assert.match(refusalText(loop), /cannot be read \(ELOOP\)/);
});

test("a child that times out, crashes, or answers with rubbish refuses as unchecked", async () => {
	const dir = folder();
	for (const [name, ran] of [
		["timeout", { failed: "timeout" }], ["crash", { failed: "crash" }], ["too much output", { failed: "output" }],
		["empty", { out: "" }], ["garbage", { out: "not json\n" }], ["a number", { out: "7" }], ["null", { out: "null" }], ["no verdict", { out: '{"x":1}' }], ["unknown verdict", { out: '{"r":"fine"}' }], ["a verdict that is not a string", { out: '{"r":3}' }],
	] as [string, Ran][]) {
		const r = await settingsRefusal(dir, answering(ran));
		assert.equal(r?.why, "unchecked", name);
	}
	const timed = (await settingsRefusal(dir, answering({ failed: "timeout" })))!;
	assert.equal(timed.code, "ETIMEDOUT");
	assert.match(refusalText(timed), /could not be checked in time \(ETIMEDOUT\)/);
	for (const code of ["ENOENT", "EACCES", "ENOTDIR", "E2BIG"]) assert.deepEqual(await settingsRefusal(dir, answering({ failed: "crash", code })), { path: join(dir, ".pi", "settings.json"), why: "unchecked", code }, `spawn error ${code} fails closed`);
	const gone = (await settingsRefusal(dir, (d) => runChild(d, 5000, join(scratch, "no-such-node"))))!;
	assert.deepEqual([gone.why, gone.code], ["unchecked", "ENOENT"], "a missing execPath is unchecked, not absent");
});

test("the real runner: a hard timeout, a folder that is gone, and a clean run", async () => {
	assert.deepEqual(await runChild(folder(), 1), { failed: "timeout" });
	assert.deepEqual(await runChild(join(scratch, "gone")), { failed: "crash", code: "ENOENT" });
	const ran = await runChild(folder());
	assert.deepEqual(ran, { out: '{"r":"absent","code":"ENOENT"}\n' });
});

test("a missing file and a plain file under the cap are fine; a dangling link is refused", async () => {
	assert.equal(await settingsRefusal(folder()), undefined);
	// pi itself would skip a dangling link, but a link the child cannot follow may be one only pi can (/proc/self/fd/N), so any such link is refused
	const dangling = (await settingsRefusal(folder((f) => symlinkSync(join(scratch, "gone.json"), f))))!;
	assert.deepEqual([dangling.why, dangling.code], ["unreadable", "ENOENT"]);
	assert.equal(await settingsRefusal(folder((f) => writeFileSync(f, "{}"))), undefined);
	assert.equal(await settingsRefusal(folder((f) => writeFileSync(f, "x".repeat(MAX_READ)))), undefined, "exactly the cap");
	assert.equal(await settingsRefusal(folder((f) => writeFileSync(f, ""))), undefined, "an empty file");
});

test("a link to a small file is fine, and to a file over the cap is refused", async () => {
	const small = join(scratch, "small.json");
	writeFileSync(small, '{"packages":[]}');
	assert.equal(await settingsRefusal(folder((f) => symlinkSync(small, f))), undefined);
	const big = join(scratch, "big.json");
	writeFileSync(big, "x".repeat(MAX_READ + 1));
	const r = (await settingsRefusal(folder((f) => symlinkSync(big, f))))!;
	assert.deepEqual([r.why, r.size, r.limit], ["large", MAX_READ + 1, MAX_READ]);
	assert.equal((await settingsRefusal(folder((f) => writeFileSync(f, "x".repeat(MAX_READ + 1)))))?.why, "large");
});

test("devices and pipes are refused: /dev/zero, /dev/null, /dev/stdin, a FIFO, a link to a FIFO", async () => {
	for (const t of ["/dev/zero", "/dev/null", "/dev/stdin", "/dev/fd/0"]) assert.equal((await settingsRefusal(folder((f) => symlinkSync(t, f))))?.why, "special", t);
	// the child's stdout is a pipe or socket: stat before open says special, and it is never opened
	assert.equal((await settingsRefusal(folder((f) => symlinkSync("/dev/fd/1", f))))?.why, "special");
	assert.equal((await settingsRefusal(folder((f) => execFileSync("mkfifo", [f]))))?.why, "special", "a FIFO is no plain file and is never opened");
	const pipe = join(scratch, "pipe");
	execFileSync("mkfifo", [pipe]);
	assert.equal((await settingsRefusal(folder((f) => symlinkSync(pipe, f))))?.why, "special");
});

test("per-process magic links the child cannot open are refused (Linux only)", { skip: !linux }, async () => {
	// how many descriptors the child holds depends on the node build (Node 24 on CI has one at 17): one it lacks is unreadable, one it holds is
	// a pipe, socket, or device and so special; either way refused, never absent
	for (const t of ["/proc/self/fd/40", "/dev/fd/40", "/proc/self/fd/17", "/dev/fd/19"]) {
		assert.ok(["unreadable", "special"].includes((await settingsRefusal(folder((f) => symlinkSync(t, f))))?.why ?? ""), t);
		const d = join(scratch, `d${++n}`);
		mkdirSync(d);
		symlinkSync(t.replace(/\/fd\/\d+$/, "/fd/40"), join(d, ".pi"));
		assert.ok(["unreadable", "special"].includes((await settingsRefusal(d))?.why ?? ""), `.pi -> ${t}`);
	}
});

test("a directory at the path, or a .pi that cannot be searched, is no file for pi either", async () => {
	assert.equal(await settingsRefusal(folder((f) => mkdirSync(f))), undefined, "pi catches EISDIR");
	const aDir = join(scratch, "adir");
	mkdirSync(aDir);
	assert.equal(await settingsRefusal(folder((f) => symlinkSync(aDir, f))), undefined);
	if (process.getuid?.() !== 0) {
		const dir = folder((f) => writeFileSync(f, "{}"));
		chmodSync(join(dir, ".pi"), 0);
		try {
			assert.equal(await settingsRefusal(dir), undefined, "pi's existsSync is false");
		} finally {
			chmodSync(join(dir, ".pi"), 0o755);
		}
		const locked = folder((f) => (writeFileSync(f, "{}"), chmodSync(f, 0)));
		assert.equal(await settingsRefusal(locked), undefined, "pi's read throws EACCES and it carries on");
	}
});

test("a loop of links is refused", async () => {
	const r = (await settingsRefusal(folder((f) => (symlinkSync(f, `${f}2`), symlinkSync(`${f}2`, f)))))!;
	assert.deepEqual([r.why, r.code], ["unreadable", "ELOOP"]);
});

test("real links in .pi: to a folder with a plain file, a large one, a dangling target, a relative target", async () => {
	const real = join(scratch, "realpi");
	mkdirSync(real);
	writeFileSync(join(real, "settings.json"), "{}");
	const dir = join(scratch, `d${++n}`);
	mkdirSync(dir);
	symlinkSync(real, join(dir, ".pi"));
	assert.equal(await settingsRefusal(dir), undefined);
	writeFileSync(join(real, "settings.json"), "x".repeat(MAX_READ + 1));
	assert.equal((await settingsRefusal(dir))?.why, "large");
	const rel = join(scratch, `d${++n}`);
	mkdirSync(rel);
	symlinkSync(join("..", "realpi"), join(rel, ".pi"));
	assert.equal((await settingsRefusal(rel))?.why, "large");
	const dangling = join(scratch, `d${++n}`);
	mkdirSync(dangling);
	symlinkSync(join(scratch, "nowhere"), join(dangling, ".pi"));
	assert.equal((await settingsRefusal(dangling))?.why, "unreadable", "a .pi link that leads nowhere is refused");
	const via = join(scratch, "via");
	symlinkSync(realpathSync(rel), via);
	assert.equal((await settingsRefusal(via))?.why, "large", "a link in the folder's own path");
});

test(".pi linked to /proc/self/cwd resolves against the folder, as for pi (Linux only)", { skip: !linux }, async () => {
	for (const t of ["/proc/self/cwd", "/proc/thread-self/cwd"]) {
		const dir = folder();
		rmSync(join(dir, ".pi"), { recursive: true });
		symlinkSync(t, join(dir, ".pi"));
		// .pi/settings.json is then dir/settings.json
		assert.equal(await settingsRefusal(dir), undefined, `${t}: nothing there`);
		symlinkSync("/dev/zero", join(dir, "settings.json"));
		assert.equal((await settingsRefusal(dir))?.why, "special", t);
		const chained = folder();
		rmSync(join(chained, ".pi"), { recursive: true });
		symlinkSync(join(chained, "x"), join(chained, ".pi"));
		symlinkSync(t, join(chained, "x"));
		symlinkSync("/dev/zero", join(chained, "settings.json"));
		assert.equal((await settingsRefusal(chained))?.why, "special", `${t} through a chain`);
	}
	assert.equal((await settingsRefusal(folder((f) => symlinkSync("/proc/self/pagemap", f))))?.why, "large", "size 0 and never ends: the read through the descriptor stops it");
});

test("a link target that is not UTF-8 is followed as the kernel reads it (Linux only)", { skip: !linux }, async () => {
	const odd = Buffer.concat([Buffer.from(`${scratch}/`), Buffer.from([0xff, 0xfe]), Buffer.from(`-${++n}`)]);
	symlinkSync("/dev/zero", odd);
	const r = await settingsRefusal(folder((f) => symlinkSync(odd, f)));
	assert.equal(r?.why, "special");
	const oddDir = Buffer.concat([Buffer.from(`${scratch}/`), Buffer.from([0xc3, 0x28]), Buffer.from(`-${++n}`)]);
	mkdirSync(oddDir);
	writeFileSync(Buffer.concat([oddDir, Buffer.from("/settings.json")]), "{}");
	const dir = join(scratch, `d${++n}`);
	mkdirSync(dir);
	symlinkSync(oddDir, join(dir, ".pi"));
	assert.equal(await settingsRefusal(dir), undefined, "a .pi that leads into a non-UTF-8 folder with a small file");
});

test("/DEV/zero and /DEV/fd/N reach the device on a case-insensitive disk (macOS only)", { skip: !mac }, async () => {
	assert.equal((await settingsRefusal(folder((f) => symlinkSync("/DEV/zero", f))))?.why, "special");
	assert.equal((await settingsRefusal(folder((f) => symlinkSync("/DEV/fd/0", f))))?.why, "special");
	assert.equal((await settingsRefusal(folder((f) => symlinkSync("/Dev/stdin", f))))?.why, "special");
});

test("a refusal says the file, the reason, and what was not started, and the assert throws it for the first unsafe folder only", async () => {
	const dir = folder((f) => symlinkSync("/dev/zero", f));
	const text = refusalText((await settingsRefusal(dir))!);
	assert.match(text, /^pi was not started: .*\.pi\/settings\.json is not a plain file/);
	assert.match(text, /256 KB/);
	await assertSettingsSafe([undefined, folder(), folder((f) => writeFileSync(f, "{}"))]);
	await assert.rejects(assertSettingsSafe([folder(), dir], "The stash"), (error) => error instanceof SettingsRefused && /^The stash was not started: /.test(error.message) && error.refusal.why === "special");
});

test("the refusal's words are cleaned of control and bidi characters", () => {
	const text = refusalText({ path: "/a/\u202eb\n.json", why: "special" });
	assert.doesNotMatch(text, /[\u202e\u001b\n]/);
	assert.doesNotMatch(refusalText({ path: "/a", why: "unreadable", code: "E\u001b[3G" }), /\u001b/);
});
