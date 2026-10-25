import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { decide, filterListing, pathDenied, readTracked, resolveArg, type Scope, searchRoot } from "../src/link/allow.ts";

// The allowlist, the deny list, and the output filter of a remote turn at `reply` or `forward`
// (docs/specs/2026-10-25-straw-link.md, Remote turns), against a real git repository in a scratch folder.

let root = "", project = "", scope: Scope;
const sender = { id: "bbbbbbbbbbbbbbbbbbbbbbbbbb", short: "bbbbbb", label: "bob-mac" };
const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-C", project, ...args], { stdio: "ignore" });
const put = (rel: string, text = "x") => {
	mkdirSync(join(rel.startsWith("/") ? "" : project, rel.split("/").slice(0, -1).join("/")), { recursive: true });
	writeFileSync(rel.startsWith("/") ? rel : join(project, rel), text);
};

before(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "psb-link-allow-")));
	project = join(root, "project");
	mkdirSync(project);
	git("init", "-q");
	put(".gitignore", "ignored.log\nbuild/\n");
	put("src/a.ts", "export const a = 1;");
	put("src/deep/b.ts", "export const b = 2;");
	put("README.md", "# readme");
	put(".env.example", "TOKEN=1");
	put("keys/server.pem", "pem");
	put("keys/plain.txt", "plain");
	put("notes/secret.txt", "untracked");
	put("ignored.log", "ignored");
	put("build/out.js", "built");
	put("/" + join(root, "outside/x.txt"), "outside secret");
	symlinkSync(join(root, "outside/x.txt"), join(project, "escape.txt"));
	symlinkSync(join(root, "outside"), join(project, "escape-dir"));
	symlinkSync(join(project, "src/a.ts"), join(project, "inner-link.ts"));
	put("/" + join(root, "home/.ssh/id_rsa"), "private");
	put("/" + join(root, "home/.config/app/token"), "t");
	put("/" + join(root, "home/.pi/agent/auth.json"), "{}");
	symlinkSync(join(root, "home/.ssh/id_rsa"), join(project, "key-link"));
	git("add", "-f", ".gitignore", "src", "README.md", ".env.example", "keys", "escape.txt", "escape-dir", "inner-link.ts", "key-link");
	git("commit", "-q", "-m", "init");
	scope = {
		project, cwd: project, home: join(root, "home"), agentDir: join(root, "home/.pi/agent"), linkDir: join(root, "home/.pi/agent/straw-boss/link"),
		tracked: () => readTracked(project),
	};
});
after(() => rmSync(root, { recursive: true, force: true }));

const verdict = (tool: string, input: Record<string, unknown>) => decide(tool, input, [sender], scope).kind;

test("read: a tracked file inside the project is allowed, in any spelling pi's own read accepts", () => {
	assert.equal(verdict("read", { path: "src/a.ts" }), "allow");
	assert.equal(verdict("read", { path: join(project, "src/deep/b.ts") }), "allow");
	assert.equal(verdict("read", { path: "@src/a.ts" }), "allow", "pi drops a leading @");
	assert.equal(verdict("read", { path: "src/../README.md" }), "allow");
	assert.equal(verdict("read", { path: "inner-link.ts" }), "allow", "a tracked symlink to a tracked file inside the project");
});

test("read: an untracked, ignored, or missing file, and one outside the project, goes to the gate", () => {
	for (const path of ["notes/secret.txt", "ignored.log", "build/out.js", "src/missing.ts", "../outside/x.txt", join(root, "outside/x.txt"), "src", "/etc/hosts"]) assert.equal(verdict("read", { path }), "gate", path);
	assert.equal(verdict("read", {}), "gate");
	assert.equal(verdict("read", { path: 7 }), "gate");
});

test("read: a symlink that leads out of the project goes to the gate, though git tracks the link", () => {
	assert.equal(verdict("read", { path: "escape.txt" }), "gate");
	assert.equal(verdict("read", { path: "escape-dir/x.txt" }), "gate");
});

test("the deny list is refused outright, not put to the gate: home folders of secrets, the agent dir, the link dir, key file names", () => {
	for (const path of ["~/.ssh/id_rsa", join(root, "home/.config/app/token"), "~/.pi/agent/auth.json", join(scope.linkDir, "device.json"), "~/.aws/credentials", "~/.gnupg/x", ".env.example", "keys/server.pem", "foo/id_ed25519", "a/cert.p12", "b/app.key", ".env", ".env.local"]) {
		assert.equal(verdict("read", { path }), "refuse", path);
	}
	assert.equal(verdict("read", { path: "key-link" }), "refuse", "a tracked symlink to a denied file is denied by what it resolves to");
	assert.equal(verdict("write", { path: "~/.ssh/authorized_keys", content: "x" }), "refuse", "the deny list holds for any tool that names a path");
	assert.equal(verdict("edit", { file_path: ".env", edits: [] }), "refuse");
	assert.equal(verdict("bash", { command: "cat x", cwd: "~/.ssh" }), "refuse");
	assert.equal(verdict("grep", { pattern: "x", path: "~/.config" }), "refuse");
	assert.equal(verdict("read", { path: "keys/plain.txt" }), "allow", "a folder named keys is not on the deny list; only the names of key files are");
});

test("the deny list also matches the project's own folders when the project sits under a denied one", () => {
	assert.equal(pathDenied(join(root, "home/.config/x/y"), scope), true);
	assert.equal(pathDenied(join(project, "src/a.ts"), scope), false);
	assert.equal(pathDenied(join(root, "home/.configuration/y"), scope), false, "a sibling whose name only starts the same is not inside the denied folder");
});

test("grep, find, ls: every path argument has to resolve inside the project (symlinks resolved)", () => {
	for (const tool of ["grep", "find", "ls"]) {
		assert.equal(verdict(tool, { pattern: "x" }), "allow", `${tool} without a path searches the cwd`);
		assert.equal(verdict(tool, { pattern: "x", path: "src" }), "allow");
		assert.equal(verdict(tool, { pattern: "x", path: join(project, "src/deep") }), "allow");
		assert.equal(verdict(tool, { pattern: "x", path: ".." }), "gate");
		assert.equal(verdict(tool, { pattern: "x", path: join(root, "outside") }), "gate");
		assert.equal(verdict(tool, { pattern: "x", path: "/" }), "gate");
		assert.equal(verdict(tool, { pattern: "x", path: "escape-dir" }), "gate", "a symlinked folder that leads out");
		assert.equal(verdict(tool, { pattern: "x", path: "no-such-folder" }), "gate");
	}
	assert.equal(decide("ls", { path: "src" }, [sender], { ...scope, cwd: root }).kind, "gate", "a relative path resolves against the tool's cwd, which is outside the project here");
});

test("tower_list, boss_status, and todo are allowed whatever their arguments; tower_send only back to the sender", () => {
	for (const tool of ["tower_list", "boss_status", "todo"]) assert.equal(verdict(tool, {}), "allow");
	assert.equal(verdict("tower_send", { message: "hi", device: sender.short }), "allow");
	assert.equal(verdict("tower_send", { message: "hi", device: sender.id }), "allow");
	assert.equal(verdict("tower_send", { message: "hi", device: sender.label }), "allow");
	assert.equal(verdict("tower_send", { message: "hi", device: "carol-mac" }), "gate");
	assert.equal(verdict("tower_send", { message: "hi" }), "gate", "without device it goes to a local session");
	assert.equal(verdict("tower_send", { message: "hi", device: "" }), "gate");
});

test("every other tool, by exact name, goes to the gate; link_request is refused at once", () => {
	for (const tool of ["bash", "write", "edit", "call_tower", "boss_broadcast", "Read", "read ", "tower_list2", "mcp"]) assert.equal(verdict(tool, {}), "gate", tool);
	assert.equal(verdict("link_request", { action: "invite" }), "refuse");
	assert.deepEqual(decide("link_request", {}, [], scope).kind, "refuse");
});

test("resolveArg: the way pi resolves a path (@, ~, odd spaces, relative to the cwd)", () => {
	assert.equal(resolveArg("@a/b", "/c", "/h"), "/c/a/b");
	assert.equal(resolveArg("~/x", "/c", "/h"), "/h/x");
	assert.equal(resolveArg("~", "/c", "/h"), "/h");
	assert.equal(resolveArg("a b", "/c", "/h"), "/c/a b");
	assert.equal(resolveArg("/abs", "/c", "/h"), "/abs");
});

test("readTracked: tracked files and their folders; a folder that is no repository tracks nothing", () => {
	const t = readTracked(project);
	assert.ok(t.files.has("src/a.ts") && t.dirs.has("src") && t.dirs.has("src/deep") && t.dirs.has(""));
	assert.ok(!t.files.has("notes/secret.txt") && !t.files.has("ignored.log") && !t.dirs.has("notes"));
	const bare = mkdtempSync(join(tmpdir(), "psb-link-allow-bare-"));
	try {
		assert.equal(readTracked(bare).files.size, 0);
	} finally {
		rmSync(bare, { recursive: true, force: true });
	}
});

test("grep output: only the lines of tracked files outside the deny list survive; notices and context separators go", () => {
	const root1 = searchRoot({}, scope);
	const out = [
		"src/a.ts:1: export const a = 1;",
		"src/deep/b.ts:1: export const b = 2;",
		"src/deep/b.ts-2- context line",
		"notes/secret.txt:1: untracked",
		"ignored.log:1: ignored",
		"build/out.js:1: built",
		".env.example:1: TOKEN=1",
		"keys/server.pem:1: pem",
		"escape.txt:1: outside secret",
		"escape-dir/x.txt:1: outside secret",
		"key-link:1: private",
		"--",
		"a line nobody can attribute: with: colons 1: here",
		"",
		"[100 matches limit reached. Use limit=200 for more, or refine pattern]",
	].join("\n");
	assert.equal(filterListing("grep", root1, out, scope), ["src/a.ts:1: export const a = 1;", "src/deep/b.ts:1: export const b = 2;", "src/deep/b.ts-2- context line"].join("\n"));
});

test("grep output: a line from an untracked file cannot be dressed as a tracked one by its text, and a path with `..` is dropped", () => {
	const forged = ["notes/secret.txt:1: src/a.ts:2: x", "notes/secret.txt-1- src/a.ts-2- x", "../outside/x.txt:1: outside", "src/../notes/secret.txt:1: untracked"].join("\n");
	assert.equal(filterListing("grep", project, forged, scope), "");
});

test("grep of a single file: its lines carry the base name", () => {
	const file = join(project, "src/a.ts");
	assert.equal(filterListing("grep", file, "a.ts:1: export const a = 1;\nsecret.txt:1: nope", scope), "a.ts:1: export const a = 1;");
	assert.equal(filterListing("grep", join(project, "notes/secret.txt"), "secret.txt:1: untracked", scope), "");
});

test("find and ls output: tracked files, and the folders that hold tracked files; nothing else", () => {
	const listing = ["src/", "src/a.ts", "src/deep/", "src/deep/b.ts", "notes/", "notes/secret.txt", "ignored.log", "build/", ".env.example", "keys/", "keys/server.pem", "escape.txt", "escape-dir/", "README.md", "../outside/x.txt", "(empty directory)", "[500 results limit reached]"].join("\n");
	assert.equal(filterListing("find", project, listing, scope), ["src/", "src/a.ts", "src/deep/", "src/deep/b.ts", "keys/", "README.md"].join("\n"));
	assert.equal(filterListing("ls", join(project, "src"), "a.ts\ndeep/\nmissing.ts\n(empty directory)", scope), "a.ts\ndeep/");
	assert.equal(filterListing("ls", project, "src/\nnotes/\nREADME.md\nignored.log\nescape-dir/", scope), "src/\nREADME.md");
});

test("a result outside the project is filtered to nothing even when the search went there", () => {
	assert.equal(filterListing("grep", join(root, "outside"), "x.txt:1: outside secret", scope), "");
	assert.equal(filterListing("ls", join(root, "outside"), "x.txt", scope), "");
});

test("grep output: a line is kept only when the tracked file really has that text at that line (crafted names cannot leak untracked contents)", () => {
	// a file named `src/a.ts:1: z` (untracked) whose content is a secret prints as `src/a.ts:1: z:1: secret`; a directory `x\nsrc/a.ts` makes a line `src/a.ts:1: secret`
	const crafted = ["src/a.ts:1: z:1: secret", "src/a.ts:1: secret", "src/a.ts:9: export const a = 1;", "src/a.ts:1: export const a = 1;"].join("\n");
	assert.equal(filterListing("grep", project, crafted, scope), "src/a.ts:1: export const a = 1;");
	// pi cuts long lines and marks them: a prefix of the real line still counts
	assert.equal(filterListing("grep", project, "src/a.ts:1: export co... [truncated]", scope), "src/a.ts:1: export co... [truncated]");
});
