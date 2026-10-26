import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cached, parseNames, type Hidden, HiddenError } from "../src/hidden.ts";
import { createSpawn, listDirs, makeDir, pickable } from "../src/spawn.ts";

// Windows marks a folder hidden with the Hidden or System attribute, not a dot (hidden.ts). The attribute reader is injected, so a macOS or Linux run drives
// the same code; tests/platform.test.ts runs it against a real Windows profile on the Windows job.

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "psb-hidden-test-")));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
const home = join(scratch, "home");
for (const dir of ["AppData/Roaming", "Cookies", "Desktop", "Documents/Hidden Inside/deep", "Documents/Work", "Downloads", "OneDrive", "Pictures", "sbd-playground", "中文專案", "「開始」功能表"])
	mkdirSync(join(home, dir), { recursive: true });
// What a Windows 11 profile has beside them: junctions of the old profile layout, all Hidden and System, leading to folders that stay visible.
symlinkSync(join(home, "AppData", "Roaming"), join(home, "Application Data"), "junction");
symlinkSync(join(home, "Documents"), join(home, "My Documents"), "junction");
symlinkSync(join(home, "Documents"), join(home, "Shortcut to Documents"), "junction"); // a link the user made: visible, so it stays

const marked: Record<string, string[]> = {
	[home]: ["AppData", "Application Data", "Cookies", "My Documents", "「開始」功能表"], // as the reader reports them: Hidden or System
	[join(home, "Documents")]: ["Hidden Inside"],
};
const hidden: Hidden = async (dir) => new Set((marked[dir] ?? []).map((name) => name.toLowerCase()));

test("a listing leaves out the entries Windows hides, whatever they are named, and keeps the folders a person made", async () => {
	const list = await listDirs(home, home, hidden);
	assert.deepEqual([...list.dirs].sort(), ["Desktop", "Documents", "Downloads", "OneDrive", "Pictures", "sbd-playground", "Shortcut to Documents", "中文專案"].sort(), "the order is the locale's");
	assert.deepEqual((await listDirs(join(home, "Documents"), home, hidden)).dirs, ["Work"], "also below home");
});

test("a hidden folder, one inside it, and a link that leads through one are not pickable, the folders around them are", async () => {
	for (const refused of ["AppData", "AppData/Roaming", "Application Data", "Application Data/x", "Cookies", "My Documents", "Documents/Hidden Inside", "Documents/Hidden Inside/deep", "「開始」功能表"])
		assert.equal(await pickable(join(home, refused), home, hidden), undefined, refused);
	for (const ok of ["Desktop", "Documents", "Documents/Work", "Downloads", "OneDrive", "Pictures", "sbd-playground", "中文專案", "Shortcut to Documents"])
		assert.ok(await pickable(join(home, ok), home, hidden), ok);
	assert.equal(await pickable(join(home, "DOCUMENTS", "hidden inside"), home, hidden), undefined, "Windows paths ignore case");
	assert.equal(await pickable(home, home, hidden), home, "home itself is the root");
});

// realpath rewrites a spelling of home such as an 8.3 short name (C:\Users\RUNNER~1, which the GitHub Windows runner's temp folder has), and a path given in the
// old spelling then lies outside the real root. A link stands for the alias here; either spelling reads the same folder, as cmd.exe does.
test("a path given through another spelling of home is still judged as given", async () => {
	const alias = join(scratch, "home-alias");
	symlinkSync(home, alias, "junction");
	const sameFolder: Hidden = (dir) => hidden(realpathSync(dir));
	for (const refused of ["My Documents", "My Documents/Work", "Documents/Hidden Inside", "AppData"])
		assert.equal(await pickable(join(alias, refused), alias, sameFolder), undefined, refused);
	for (const ok of ["Documents", "Documents/Work", "Shortcut to Documents"])
		assert.equal(await pickable(join(alias, ok), alias, sameFolder), join(home, ok.replace("Shortcut to ", "")), ok);
	assert.equal(await pickable(alias, alias, sameFolder), home, "home itself is the root");
});

test("nothing is made inside a hidden folder, nor under the name of an entry Windows hides", async () => {
	assert.equal((await makeDir(join(home, "AppData"), "x", home, hidden)).status, 400);
	assert.equal((await makeDir(join(home, "Documents", "Hidden Inside"), "x", home, hidden)).status, 400);
	assert.equal(((await makeDir(home, "Cookies", home, hidden)).body as { error: string }).error, "not_a_folder", "it exists, hidden, and is not selected");
	assert.equal((await makeDir(join(home, "Documents"), "Fresh", home, hidden)).status, 200);
});

test("the starting places leave out a Desktop or Documents that is hidden", async () => {
	const hide = (names: string[]): Hidden => async (dir) => new Set(dir === home ? names : []);
	const places = async (names: string[]) => (await createSpawn({ run: async () => "", sleep: async () => {}, live: async () => false, home, hidden: hide(names) })(["dirs", "places"], {})).body as { places: { name: string }[] };
	assert.deepEqual((await places([])).places.map((p) => p.name), ["Desktop", "Documents"]);
	assert.deepEqual((await places(["desktop"])).places.map((p) => p.name), ["Documents"]);
});

test("a reader that fails fails the request: nothing is listed or opened on a guess", async () => {
	const broken: Hidden = async (dir) => Promise.reject(new HiddenError(`Windows could not say which folders in ${dir} are hidden: boom`));
	await assert.rejects(listDirs(home, home, broken), HiddenError);
	await assert.rejects(pickable(join(home, "Desktop"), home, broken), HiddenError);
	const handle = createSpawn({ run: async () => "", sleep: async () => {}, live: async () => false, home, hidden: broken });
	const reply = await handle(["dirs"], { path: join(home, "Desktop") });
	assert.deepEqual([reply.status, (reply.body as { error: string }).error], [503, "unreadable"]);
	assert.match((reply.body as { reason: string }).reason, /boom/);
});

test("a platform without attributes lists as before: only a dot hides", async () => {
	mkdirSync(join(home, ".dot"), { recursive: true });
	assert.ok((await listDirs(home, home, undefined)).dirs.includes("Cookies"), "no reader, no attribute");
	assert.ok(!(await listDirs(home, home, undefined)).dirs.includes(".dot"));
});

test("cmd's names are UTF-16LE lines and compared in lower case; the answer for a folder is kept briefly and a failure is not", async () => {
	const out = Buffer.from("AppData\r\n「開始」功能表\r\nCookies\r\nappdata\r\n", "utf16le"); // a name that is both Hidden and System comes twice
	assert.deepEqual([...parseNames(out)], ["appdata", "「開始」功能表", "cookies"]);
	assert.deepEqual([...parseNames(Buffer.alloc(0))], []);
	let reads = 0, clock = 0, fail = false;
	const read = cached(async (dir) => (reads++, fail ? Promise.reject(new Error("no")) : new Set([dir])), 1000, () => clock);
	await read("C:\\Users\\x"); await read("c:\\users\\X");
	assert.equal(reads, 1, "asked once, whatever the case");
	clock = 1500;
	await read("C:\\Users\\x");
	assert.equal(reads, 2, "and again after the time");
	fail = true;
	await assert.rejects(read("C:\\other"));
	fail = false;
	await read("C:\\other");
	assert.equal(reads, 4, "a failure is asked again");
});
