import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MAX_READ } from "../src/trust/found.ts";
import { assertSettingsSafe, refusalText, SettingsRefused, settingsRefusal } from "../src/trust/settings.ts";

// The check made before pi starts in a folder (trust/settings.ts): pi 1.4.0 reads <folder>/.pi/settings.json whole before any extension can stop it.

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

test("a missing file, a missing .pi, and a dangling or looping link are fine, and a missing file costs no read", () => {
	assert.equal(settingsRefusal(folder()), undefined);
	assert.equal(settingsRefusal(join(scratch, "nowhere")), undefined);
	assert.equal(settingsRefusal(folder((f) => symlinkSync(join(scratch, "gone.json"), f))), undefined, "pi's existsSync is false for a dangling link");
	assert.equal(settingsRefusal(folder((f) => (symlinkSync(f, `${f}2`), symlinkSync(`${f}2`, f)))), undefined, "a loop is no file either");
	const dir = join(scratch, "dotfile");
	mkdirSync(dir);
	writeFileSync(join(dir, ".pi"), "");
	assert.equal(settingsRefusal(dir), undefined, ".pi that is a file holds no settings");
});

test("a plain file under the cap is fine, and so is a link to one: pi follows links, and what it reads then is the same bounded file", () => {
	assert.equal(settingsRefusal(folder((f) => writeFileSync(f, "{}"))), undefined);
	assert.equal(settingsRefusal(folder((f) => writeFileSync(f, "x".repeat(MAX_READ)))), undefined, "exactly the cap");
	const small = join(scratch, "small.json");
	writeFileSync(small, '{"packages":[]}');
	assert.equal(settingsRefusal(folder((f) => symlinkSync(small, f))), undefined);
});

test("a link to a device, a pipe, or a file over the cap is refused, with where the link ends", () => {
	const zero = settingsRefusal(folder((f) => symlinkSync("/dev/zero", f)))!;
	assert.deepEqual([zero.why, zero.target], ["special", "/dev/zero"]);
	assert.equal(settingsRefusal(folder((f) => symlinkSync("/dev/stdin", f)))?.why, "special", "/dev/stdin would block pi");
	assert.equal(settingsRefusal(folder((f) => symlinkSync("/dev/null", f)))?.why, "special", "any device, empty or not");
	const pipe = join(scratch, "pipe");
	execFileSync("mkfifo", [pipe]);
	assert.equal(settingsRefusal(folder((f) => symlinkSync(pipe, f)))?.why, "special");
	const big = join(scratch, "big.json");
	writeFileSync(big, "x".repeat(MAX_READ + 1));
	const linked = settingsRefusal(folder((f) => symlinkSync(big, f)))!;
	assert.deepEqual([linked.why, linked.size, linked.limit, linked.target], ["large", MAX_READ + 1, MAX_READ, big]);
});

test("a FIFO, a file over the cap, and an unreadable file are refused in place", () => {
	const fifo = settingsRefusal(folder((f) => execFileSync("mkfifo", [f])))!;
	assert.deepEqual([fifo.why, fifo.target], ["special", undefined], "a FIFO is not opened, so it cannot block the check");
	const big = settingsRefusal(folder((f) => writeFileSync(f, "x".repeat(MAX_READ + 1))))!;
	assert.deepEqual([big.why, big.size], ["large", MAX_READ + 1]);
	if (process.getuid?.() !== 0) {
		const locked = settingsRefusal(folder((f) => (writeFileSync(f, "{}"), chmodSync(f, 0))))!;
		assert.deepEqual([locked.why, locked.code], ["unreadable", "EACCES"]);
	}
});

test("a refusal says the file, the reason, and what was not started, and the assert throws it for the first unsafe folder only", () => {
	const dir = folder((f) => symlinkSync("/dev/zero", f));
	const text = refusalText(settingsRefusal(dir)!);
	assert.match(text, /^pi was not started: .*\.pi\/settings\.json \(a link to \/dev\/zero\) is not a plain file/);
	assert.match(text, /256 KB/);
	assert.doesNotThrow(() => assertSettingsSafe([undefined, folder(), folder((f) => writeFileSync(f, "{}"))]));
	assert.throws(() => assertSettingsSafe([folder(), dir], "The stash"), (error) => error instanceof SettingsRefused && /^The stash was not started: /.test(error.message) && error.refusal.why === "special");
});

test("the size of a followed file is not trusted: more than the cap arriving through the descriptor refuses it", () => {
	const target = join(scratch, "liar.json");
	writeFileSync(target, "{}"); // stat says 2 bytes
	const endless = (_fd: number, buffer: Buffer) => buffer.length;
	const r = settingsRefusal(folder((f) => symlinkSync(target, f)), endless)!;
	assert.deepEqual([r.why, r.limit], ["large", MAX_READ]);
	assert.ok(r.size! > MAX_READ);
	assert.equal(settingsRefusal(folder((f) => symlinkSync(target, f)), () => 0), undefined);
});

test("a link into /proc is refused (Linux only)", { skip: process.platform !== "linux" }, () => {
	for (const t of ["/proc/self/pagemap", "/proc/self/mem", "/proc/self/status", "/sys/devices/system/cpu/online"]) assert.equal(settingsRefusal(folder((f) => symlinkSync(t, f)))?.why, "special", t);
});

test("a directory at the path, or a .pi that cannot be searched, is no file for pi either", () => {
	assert.equal(settingsRefusal(folder((f) => mkdirSync(f))), undefined, "pi catches EISDIR");
	const aDir = join(scratch, "adir");
	mkdirSync(aDir);
	assert.equal(settingsRefusal(folder((f) => symlinkSync(aDir, f))), undefined);
	if (process.getuid?.() !== 0) {
		const dir = folder((f) => writeFileSync(f, "{}"));
		chmodSync(join(dir, ".pi"), 0);
		try {
			assert.equal(settingsRefusal(dir), undefined, "pi's existsSync is false");
		} finally {
			chmodSync(join(dir, ".pi"), 0o755);
		}
	}
});

test("the refusal's words are cleaned of control and bidi characters", () => {
	const text = refusalText({ path: "/a/\u202eb\n.json", why: "special", target: "/t\u001b[3G" });
	assert.doesNotMatch(text, /[\u202e\u001b\n]/);
});
