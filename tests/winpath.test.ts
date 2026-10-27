import assert from "node:assert/strict";
import { test } from "node:test";
import { win32 } from "node:path";
import { powershellPath, system32, system32Path, systemRoot } from "../src/winpath.ts";
import { startCommand } from "../src/startof.ts";
import { aclCommand } from "../src/server/acl.ts";
import { launchCommand } from "../src/server/breakaway.ts";
import { nativeCommand } from "../src/server/winprep.ts";
import { hiddenCommand } from "../src/hidden.ts";
import { browserCommand } from "../src/gui.ts";
import { clipboardCommand } from "../src/pairing.ts";

// A bare program name is searched in the current folder first on Windows (nodejs/node#46264), and a pi session's folder is a project: the system's programs are named by absolute path
// from %SystemRoot%\System32 and run from that folder.

test("SystemRoot comes from the environment (any case), then windir, and C:\\Windows only when none is set", () => {
	assert.equal(systemRoot({ SystemRoot: "D:\\WINNT" }), "D:\\WINNT");
	assert.equal(systemRoot({ SYSTEMROOT: "E:\\Win" }), "E:\\Win");
	assert.equal(systemRoot({ windir: "F:\\W" }), "F:\\W");
	assert.equal(systemRoot({ SystemRoot: "  ", windir: "F:\\W" }), "F:\\W");
	assert.equal(systemRoot({}), "C:\\Windows");
	assert.equal(system32({ SystemRoot: "D:\\WINNT" }), "D:\\WINNT\\System32");
	assert.equal(system32Path("icacls.exe", { SystemRoot: "D:\\WINNT" }), "D:\\WINNT\\System32\\icacls.exe");
	assert.equal(powershellPath({ SystemRoot: "D:\\WINNT" }), "D:\\WINNT\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
	assert.equal(powershellPath({}), "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
});

const ENV = { SystemRoot: "D:\\WINNT", PATH: "p" };
const ABS = /^D:\\WINNT\\System32\\/;

test("N5: a SystemRoot that is not a drive-letter absolute path is ignored (a relative one would put the program and its folder in the project), then windir, then C:\\Windows", () => {
	for (const bad of ["Windows", "..\\Windows", ".\\", "\\Windows", "\\\\server\\share", "/usr", "C:Windows", "  "]) {
		assert.equal(systemRoot({ SystemRoot: bad }), "C:\\Windows", JSON.stringify(bad));
		assert.equal(systemRoot({ SystemRoot: bad, windir: "E:\\W" }), "E:\\W", `${JSON.stringify(bad)} falls to a good windir`);
		assert.ok(system32Path("icacls.exe", { SystemRoot: bad }).startsWith("C:\\Windows\\System32\\"));
	}
	assert.equal(systemRoot({ SystemRoot: "d:\\winnt" }), "d:\\winnt");
});

test("every Windows call of the repo names its program by absolute path and runs from System32", () => {
	const ps = startCommand(4242, 15_000, ENV);
	assert.equal(ps.file, "D:\\WINNT\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
	assert.equal(ps.options.cwd, "D:\\WINNT\\System32");
	const acl = aclCommand("C:\\s", ENV);
	assert.equal(acl.file, "D:\\WINNT\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
	assert.equal(acl.options.cwd, "D:\\WINNT\\System32");
	const launch = launchCommand({ command: "node", args: [], env: {}, cwd: "C:\\s", options: { detached: true, stdio: "ignore", windowsHide: true } }, ENV);
	assert.equal(launch.file, "D:\\WINNT\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
	assert.equal(launch.options.cwd, "D:\\WINNT\\System32");
	for (const [name, args] of [["whoami.exe", ["/user"]], ["icacls.exe", ["C:\\s"]]] as const) {
		const native = nativeCommand(name, [...args], ENV);
		assert.match(native.file, ABS);
		assert.ok(native.file.endsWith(`\\${name}`));
		assert.equal(native.options.cwd, "D:\\WINNT\\System32");
	}
	const hidden = hiddenCommand("C:\\d", ENV);
	assert.equal(hidden.file, "D:\\WINNT\\System32\\cmd.exe");
	assert.equal(hidden.options.cwd, "D:\\WINNT\\System32");
	const [cmd, args, options] = browserCommand("https://x/", "win32", ENV);
	assert.equal(cmd, "D:\\WINNT\\System32\\cmd.exe");
	assert.deepEqual(args, ["/c", "start", "", "https://x/"]);
	assert.equal(options.cwd, "D:\\WINNT\\System32");
	assert.deepEqual(clipboardCommand("win32", ENV), ["D:\\WINNT\\System32\\clip.exe"]);
	// N6: not a scan of the source but of what every builder returns: an absolute program path, whatever the environment says.
	for (const env of [ENV, {}, { SystemRoot: "Windows" }, { SystemRoot: "..\\x" }]) {
		const files = [
			startCommand(1, 1, env).file, aclCommand("C:\\s", env).file, launchCommand({ command: "node", args: [], env: {}, cwd: "C:\\s", options: { detached: true, stdio: "ignore", windowsHide: true } }, env).file,
			nativeCommand("whoami.exe", [], env).file, nativeCommand("icacls.exe", [], env).file, hiddenCommand("C:\\d", env).file, browserCommand("https://x/", "win32", env)[0], clipboardCommand("win32", env)[0]!,
		];
		for (const file of files) assert.ok(win32.isAbsolute(file) && /^[A-Za-z]:\\/.test(file), `${file} (${JSON.stringify(env)})`);
		for (const cwd of [startCommand(1, 1, env).options.cwd, aclCommand("C:\\s", env).options.cwd, nativeCommand("whoami.exe", [], env).options.cwd, hiddenCommand("C:\\d", env).options.cwd]) assert.ok(win32.isAbsolute(cwd!), String(cwd));
	}
	assert.deepEqual(clipboardCommand("darwin", ENV), ["pbcopy"]);
});

test("the ACL script runs icacls from the system folder too (PowerShell never looks in the current folder, but the script does not rely on it)", async () => {
	const { ACL_SCRIPT } = await import("../src/server/acl.ts");
	assert.match(ACL_SCRIPT, /\$icacls = Join-Path \(\[Environment\]::SystemDirectory\) 'icacls\.exe'/);
	assert.ok(!/& icacls\.exe/.test(ACL_SCRIPT));
});
