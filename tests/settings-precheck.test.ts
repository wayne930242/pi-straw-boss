import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MAX_READ } from "../src/trust/found.ts";
import { assertSettingsSafe, MAX_HOPS, refusalText, SettingsRefused, settingsRefusal } from "../src/trust/settings.ts";

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

test("a missing file, a missing .pi, and a dangling link are fine, and a missing file costs no read", () => {
	assert.equal(settingsRefusal(folder()), undefined);
	assert.equal(settingsRefusal(join(scratch, "nowhere")), undefined);
	assert.equal(settingsRefusal(folder((f) => symlinkSync(join(scratch, "gone.json"), f))), undefined, "pi's existsSync is false for a dangling link");
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

test("a link into /proc, /dev, or /sys is refused on every OS, by where it points and not by what is there", () => {
	for (const t of ["/proc/self/pagemap", "/proc/self/mem", "/proc/self/status", "/sys/devices/system/cpu/online", "/dev/fd/0", "/dev/fd/../zero", "/proc/self/cwd/settings.json"]) {
		const r = settingsRefusal(folder((f) => symlinkSync(t, f)));
		assert.equal(r?.why, "special", t);
		assert.match(r!.target!, /^\/(proc|dev|sys)(\/|$)/, t);
	}
	assert.equal(settingsRefusal(folder((f) => symlinkSync("/procedure/x", f))), undefined, "only the directories themselves, not names that start alike");
});

/** A readlink that knows `links` (path to target; null is a plain place, as readlink says EINVAL) and asks the real file system for the rest. */
const fake = (links: Record<string, string | null>) => (path: string) => {
	if (links[path] === null) throw Object.assign(new Error("EINVAL"), { code: "EINVAL" });
	return links[path] ?? readlinkSync(path);
};

test("the walk looks at .pi as well as settings.json: a link in any place of the path that leads into /proc, /dev, or /sys is refused (injected readlink)", () => {
	const dir = folder();
	const pi = join(dir, ".pi");
	const cases: Record<string, Record<string, string | null>> = {
		"a .pi linked to /proc/self/cwd": { [pi]: "/proc/self/cwd" },
		"... and /proc/thread-self/cwd": { [pi]: "/proc/thread-self/cwd" },
		"a chain .pi -> x -> /proc/self/cwd": { [pi]: join(dir, "x"), [join(dir, "x")]: "/proc/self/cwd" },
		"a chain of relative links": { [pi]: "x", [join(dir, "x")]: "../../../../../../../../proc/self/cwd" },
		".pi -> /dev/fd (macOS and Linux)": { [pi]: "/dev/fd" },
		"a link to a folder that holds a link": { [pi]: join(dir, "x"), [join(dir, "x")]: null, [join(dir, "x", "settings.json")]: "/dev/zero" },
		"a link in a part of dir itself": { [join(scratch)]: "/proc/self/root" },
	};
	for (const [name, links] of Object.entries(cases)) {
		const r = settingsRefusal(dir, undefined, fake(links));
		assert.ok(r, name);
		assert.equal(r.why, "special", name);
	}
	assert.deepEqual(
		(({ why, target }) => [why, target])(settingsRefusal(dir, undefined, fake({ [pi]: "x", [join(dir, "x")]: "../../../../../../../../proc/self/cwd" }))!),
		["special", "/proc/self/cwd"],
		"a relative target is read against the folder its link lies in",
	);
});

test("a place reached by .. after a link is judged where the walk really stands, not by the text of the target", () => {
	const dir = folder();
	// x leads to /a/b: x/../../proc is /proc, though its text, read from dir, is a folder beside dir
	const links = { [join(dir, ".pi")]: "x/../../proc/self/cwd", [join(dir, "x")]: "/a/b", "/a": null, "/a/b": null };
	assert.equal(settingsRefusal(dir, undefined, fake(links))?.why, "special");
	// the same text with x a plain folder is just a folder: the walk then ends in absent or in a file
	assert.equal(settingsRefusal(dir, undefined, fake({ [join(dir, ".pi")]: "x/../elsewhere" })), undefined);
});

test("the hop limit: 40 links are followed, the 41st refuses", () => {
	const dir = folder();
	const chain = (n: number) => {
		const links: Record<string, string> = {};
		for (let i = 0; i < n; i++) links[join(dir, i === 0 ? ".pi" : `h${i}`)] = join(dir, `h${i + 1}`);
		links[join(dir, `h${n}`)] = ".pi-end"; // not a link: a name that is not there
		return links;
	};
	assert.equal(MAX_HOPS, 40);
	const ok = chain(MAX_HOPS);
	delete ok[join(dir, `h${MAX_HOPS}`)];
	assert.equal(settingsRefusal(dir, undefined, fake(ok)), undefined, "the chain ends at a name that is not there");
	const r = settingsRefusal(dir, undefined, fake(chain(MAX_HOPS + 1)))!;
	assert.deepEqual([r.why, r.code], ["unreadable", "ELOOP"]);
	assert.match(refusalText(r), /cannot be read \(ELOOP\)/);
});

test("a loop of links is refused, not followed", () => {
	const r = settingsRefusal(folder((f) => (symlinkSync(f, `${f}2`), symlinkSync(`${f}2`, f))))!;
	assert.deepEqual([r.why, r.code], ["unreadable", "ELOOP"]);
});

test("real links in .pi and along the way: a .pi that is a link to a folder with a plain file, to a dangling target, or relative", () => {
	const real = join(scratch, "realpi");
	mkdirSync(real);
	writeFileSync(join(real, "settings.json"), "{}");
	const dir = join(scratch, `d${++n}`);
	mkdirSync(dir);
	symlinkSync(real, join(dir, ".pi"));
	assert.equal(settingsRefusal(dir), undefined);
	writeFileSync(join(real, "settings.json"), "x".repeat(MAX_READ + 1));
	const big = settingsRefusal(dir)!;
	assert.deepEqual([big.why, big.target], ["large", join(real, "settings.json")]);
	const rel = join(scratch, `d${++n}`);
	mkdirSync(rel);
	symlinkSync(join("..", "realpi"), join(rel, ".pi")); // a relative target
	assert.equal(settingsRefusal(rel)?.why, "large");
	const dangling = join(scratch, `d${++n}`);
	mkdirSync(dangling);
	symlinkSync(join(scratch, "nowhere"), join(dangling, ".pi"));
	assert.equal(settingsRefusal(dangling), undefined);
	// a link in dir's own path, with .. in a target below it: the folder the link lies in is the physical one
	const via = join(scratch, "via");
	symlinkSync(realpathSync(rel), via);
	assert.equal(settingsRefusal(via)?.why, "large");
});

test("a .pi linked to /proc/self/cwd is refused even when the checker's cwd is elsewhere (Linux only)", { skip: process.platform !== "linux" }, () => {
	for (const t of ["/proc/self/cwd", "/proc/thread-self/cwd"]) {
		const dir = folder();
		rmSync(join(dir, ".pi"), { recursive: true });
		symlinkSync(t, join(dir, ".pi"));
		symlinkSync("/dev/zero", join(dir, "z"));
		// pi resolves /proc/self/cwd against its own cwd, which is dir: .pi/settings.json is then dir/settings.json
		symlinkSync("/dev/zero", join(dir, "settings.json"));
		assert.equal(settingsRefusal(dir)?.why, "special", t);
		const chained = folder();
		rmSync(join(chained, ".pi"), { recursive: true });
		symlinkSync(join(chained, "x"), join(chained, ".pi"));
		symlinkSync(t, join(chained, "x"));
		assert.equal(settingsRefusal(chained)?.why, "special", `${t} through a chain`);
	}
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
