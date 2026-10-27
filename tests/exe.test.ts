import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, test } from "node:test";
import { execFileExe, execFileSyncExe, ExeNotFound, forgetExe, resolveExe, searchPath } from "../src/exe.mjs";

// A bare program name is searched in the current folder first on Windows (nodejs/node#46264), and a pi session's folder is a project. Every program the package starts by name is
// found by a PATH search that never looks in the current folder, and spawned by the path it found.

afterEach(() => forgetExe());
const fakeFiles = (...files: string[]) => (path: string) => files.includes(path);

test("Windows: the first absolute PATH folder that holds the program wins; empty, '.', relative, and quoted entries are handled; the current folder is never searched", () => {
	const env = { Path: ';.;bin;..\\tools;"C:\\Quoted";C:\\Tools;C:\\Later', PATHEXT: ".COM;.EXE;.BAT;.CMD" };
	const seen: string[] = [];
	const isFile = (p: string) => (seen.push(p), p === "C:\\Tools\\git.exe" || p === "C:\\Later\\git.exe" || p === ".\\git.exe" || p === "git.exe" || p === "bin\\git.exe");
	assert.equal(searchPath("git", { env, platform: "win32", isFile }), "C:\\Tools\\git.exe");
	assert.ok(seen.every((p) => /^[A-Za-z]:\\/.test(p)), `only absolute candidates were looked at: ${seen.join(", ")}`);
	assert.ok(seen.includes("C:\\Quoted\\git.com"), "a quoted entry is unquoted");
	assert.ok(!seen.some((p) => p === "git.exe" || p.startsWith(".")), "nothing in the current folder");
});

test("Windows: PATHEXT's order decides between .com and .exe, .bat and .cmd are never chosen (they cannot start without a shell), and a name with an extension is taken as it is", () => {
	const env = { PATH: "C:\\A", PATHEXT: ".EXE;.CMD;.COM" };
	assert.equal(searchPath("tool", { env, platform: "win32", isFile: fakeFiles("C:\\A\\tool.com", "C:\\A\\tool.exe") }), "C:\\A\\tool.exe");
	assert.equal(searchPath("tool", { env: { ...env, PATHEXT: ".COM;.EXE" }, platform: "win32", isFile: fakeFiles("C:\\A\\tool.com", "C:\\A\\tool.exe") }), "C:\\A\\tool.com");
	assert.throws(() => searchPath("tool", { env, platform: "win32", isFile: fakeFiles("C:\\A\\tool.cmd", "C:\\A\\tool.bat") }), ExeNotFound);
	assert.equal(searchPath("tool.exe", { env, platform: "win32", isFile: fakeFiles("C:\\A\\tool.exe") }), "C:\\A\\tool.exe");
	assert.equal(searchPath("tool", { env: { PATH: "C:\\A" }, platform: "win32", isFile: fakeFiles("C:\\A\\tool.exe") }), "C:\\A\\tool.exe", "PATHEXT unset: .com and .exe");
});

test("Windows: a program given as a path must be absolute; a relative one is refused, not read against the current folder", () => {
	assert.equal(searchPath("C:\\Tools\\herdr.exe", { env: {}, platform: "win32" }), "C:\\Tools\\herdr.exe");
	for (const name of [".\\herdr.exe", "bin\\herdr", "..\\herdr.exe", "./herdr", "C:herdr.exe"]) assert.throws(() => searchPath(name, { env: { PATH: "C:\\A" }, platform: "win32" }), /absolute path/, name);
});

test("POSIX: relative and empty PATH entries are skipped too (an empty one means the current folder), the first executable wins", () => {
	const env = { PATH: ":.:bin:../x:/usr/local/bin::/usr/bin" };
	const seen: string[] = [];
	const isFile = (p: string) => (seen.push(p), ["/usr/bin/git", "bin/git", "git", "./git"].includes(p) || p === "/usr/local/bin/git");
	assert.equal(searchPath("git", { env, platform: "linux", isFile }), "/usr/local/bin/git");
	assert.deepEqual(seen, ["/usr/local/bin/git"]);
	assert.throws(() => searchPath("sh", { env, platform: "linux", isFile: () => false }), (e: unknown) => e instanceof ExeNotFound && (e as ExeNotFound).code === "ENOENT" && /2 absolute PATH folders/.test((e as Error).message));
	assert.throws(() => searchPath("x", { env: { PATH: "" }, platform: "linux", isFile: () => true }), ExeNotFound);
	assert.throws(() => searchPath("./herdr", { env, platform: "linux" }), /absolute path/);
	assert.equal(searchPath("/opt/herdr", { env, platform: "linux" }), "/opt/herdr");
});

test("a real folder: an executable planted in the current folder is ignored, the one on PATH is found, and a file that is not executable is skipped (POSIX)", { skip: process.platform === "win32" }, () => {
	const root = mkdtempSync(join(tmpdir(), "psb-exe-")), project = join(root, "project"), bin = join(root, "bin"), other = join(root, "other");
	for (const dir of [project, bin, other]) mkdirSync(dir);
	const original = process.cwd();
	try {
		writeFileSync(join(project, "mytool"), "#!/bin/sh\n", { mode: 0o755 });
		writeFileSync(join(bin, "mytool"), "#!/bin/sh\n", { mode: 0o644 });
		writeFileSync(join(other, "mytool"), "#!/bin/sh\n", { mode: 0o755 });
		process.chdir(project);
		const env = { PATH: `.::${relative(project, bin)}:${bin}:${other}` };
		assert.equal(searchPath("mytool", { env }), join(other, "mytool"), "not the planted one, not the one without the execute bit");
		assert.throws(() => searchPath("mytool", { env: { PATH: `.:${relative(project, other)}` } }), ExeNotFound);
	} finally {
		process.chdir(original);
		rmSync(root, { recursive: true, force: true });
	}
});

test("the answer is kept per process while PATH is the same; a different PATH searches again; forgetExe forgets", () => {
	const root = mkdtempSync(join(tmpdir(), "psb-exe-"));
	try {
		const a = join(root, "a"), b = join(root, "b");
		mkdirSync(a);
		mkdirSync(b);
		for (const dir of [a, b]) writeFileSync(join(dir, "kept-tool"), "", { mode: 0o755 });
		assert.equal(resolveExe("kept-tool", { env: { PATH: a } }), join(a, "kept-tool"));
		rmSync(join(a, "kept-tool"));
		assert.equal(resolveExe("kept-tool", { env: { PATH: a } }), join(a, "kept-tool"), "kept: no second search");
		assert.equal(resolveExe("kept-tool", { env: { PATH: `${b}:${a}` } }), join(b, "kept-tool"), "another PATH");
		forgetExe("kept-tool");
		assert.throws(() => resolveExe("kept-tool", { env: { PATH: a } }), ExeNotFound);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a program gone since the search (ENOENT) is searched for again once, and started from where it is now", async () => {
	const root = mkdtempSync(join(tmpdir(), "psb-exe-"));
	try {
		const a = join(root, "a"), b = join(root, "b");
		mkdirSync(a);
		mkdirSync(b);
		const script = "#!/bin/sh\necho moved\n";
		writeFileSync(join(a, "mover"), script, { mode: 0o755 });
		const env = { PATH: `${a}:${b}` };
		assert.equal(resolveExe("mover", { env }), join(a, "mover"));
		rmSync(join(a, "mover"));
		writeFileSync(join(b, "mover"), script, { mode: 0o755 });
		chmodSync(join(b, "mover"), 0o755);
		const out = await new Promise<string>((resolve, reject) => execFileExe("mover", [], { env }, (error, stdout) => (error ? reject(error) : resolve(stdout))));
		assert.equal(out.trim(), "moved");
		forgetExe();
		rmSync(join(b, "mover"));
		writeFileSync(join(a, "mover"), script, { mode: 0o755 });
		assert.equal(resolveExe("mover", { env }), join(a, "mover"));
		rmSync(join(a, "mover"));
		writeFileSync(join(b, "mover"), script, { mode: 0o755 });
		assert.equal(String(execFileSyncExe("mover", [], { env, encoding: "utf8" })).trim(), "moved");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a program that is not found at all is an ExeNotFound with code ENOENT and a message that says where it looked, from the async and the sync call", async () => {
	const env = { PATH: "/definitely/not/here" };
	const error = await new Promise<Error & { code?: unknown }>((resolve) => execFileExe("psb-no-such-program", [], { env }, (e) => resolve(e!)));
	assert.ok(error instanceof ExeNotFound);
	assert.equal(error.code, "ENOENT");
	assert.match(error.message, /psb-no-such-program was not found: no psb-no-such-program in the 1 absolute PATH folder/);
	assert.throws(() => execFileSyncExe("psb-no-such-program", [], { env }), ExeNotFound);
});

// --- the call sites ---

test("no source file starts a program by a bare name: every child_process call in src takes a path from the resolver, a literal absolute path, or process.execPath", () => {
	const root = new URL("..", import.meta.url).pathname, files: string[] = [];
	const walk = (dir: string) => { for (const e of readdirSync(join(root, dir), { withFileTypes: true })) e.isDirectory() ? walk(join(dir, e.name)) : /\.(ts|mjs)$/.test(e.name) && files.push(join(dir, e.name)); };
	walk("src");
	const allowed = new Set(["src/exe.mjs"]);
	const offenders: string[] = [];
	for (const file of files) {
		if (allowed.has(file)) continue;
		const text = readFileSync(join(root, file), "utf8");
		for (const m of text.matchAll(/(?<![.\w])(execFile|execFileSync|spawn|spawnSync|execSync|exec|fork)\(\s*([^,)]*)/g)) {
			const first = m[2]!.trim();
			if (/^(spec: SpawnSpec|spec\.command|file|cmd!?|cmd|process\.execPath|node|bin|herdr|command)$/.test(first) || /^["'`]\//.test(first)) continue;
			if (/\bchild_process\b|\bimport\b/.test(text) && /from "node:child_process"/.test(text)) offenders.push(`${file}: ${m[0]}`);
		}
		if (/from "node:child_process"/.test(text)) {
			for (const m of text.matchAll(/\b(?:execFile|execFileSync|spawn)\(\s*["'`]([^"'`]+)["'`]/g)) offenders.push(`${file}: a literal program name ${m[1]}`);
		}
	}
	assert.deepEqual(offenders, []);
	for (const [file, name] of [["src/herdr.ts", "herdr"], ["src/balance.mjs", "herdr"], ["src/remote.ts", "tailscale"], ["src/link/allow.ts", "git"], ["src/startof.ts", "ps"]] as const) {
		const text = readFileSync(join(root, file), "utf8");
		assert.match(text, new RegExp(`execFile(Sync)?Exe\\(\\s*(process\\.env\\.HERDR_BIN_PATH \\|\\| )?"${name}"`), `${file} starts ${name} through the resolver`);
		assert.doesNotMatch(text, /from "node:child_process"[^\n]*\n[^]*\bexecFile(Sync)?\("(herdr|tailscale|git|ps)"/, file);
	}
	for (const file of ["src/closing.ts"]) assert.match(readFileSync(join(root, file), "utf8"), /resolveExe\(process\.env\.HERDR_BIN_PATH \|\| "herdr"\)[^]*resolveExe\("sh"\)/);
	for (const file of ["src/gui.ts", "src/pairing.ts"]) assert.match(readFileSync(join(root, file), "utf8"), /execFileExe\(/);
});
