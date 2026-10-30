import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LAUNCH_SCRIPT } from "../src/server/breakaway.ts";
import { ACL_SCRIPT, ACL_TOKEN, aclCommand, ownerProblems, plainStderr, aclMarkerPath, AclError, aclProblems, applyAcl, asciiLine, awaitAclMarker, execFailure, messageLine, type Exec, fileProblems, folderProblems, parseAclOutput, parseSddl, readMarker, scriptWords, CLM_TEXT, SYSTEM_SID } from "../src/server/acl.ts";

// docs/specs/2026-10-26-sb-backend.md, The control socket: on Windows the state directory gets an owner-and-SYSTEM ACL, set and checked by SID in one PowerShell start.
// Windows is not run here: these pin the command and the SDDL reading.

const OWNER = "S-1-5-21-1111111111-2222222222-3333333333-1001";
const OTHER = "S-1-5-21-9-9-9-1002";
const ACE = (sid: string, flags = "OICI", type = "A") => `(${type};${flags};FA;;;${sid})`;
const good = `O:${OWNER}G:DUD:P${ACE(OWNER)}${ACE("SY")}`;

test("the command is one PowerShell start with the folder in the environment, never quoted into the script, and no console window", () => {
	const dir = "C:\\Users\\測試PM\\.pi\\agent\\straw-boss";
	const { file, args, options } = aclCommand(dir, { PATH: "p" });
	assert.equal(file, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
	assert.equal(options.cwd, "C:\\Windows\\System32");
	assert.deepEqual(args.slice(0, 5), ["-NoProfile", "-NonInteractive", "-OutputFormat", "Text", "-EncodedCommand"]);
	assert.equal(Buffer.from(args[5]!, "base64").toString("utf16le"), ACL_SCRIPT);
	assert.ok(!ACL_SCRIPT.includes("測試PM") && !ACL_SCRIPT.includes("straw-boss"));
	assert.equal(options.env.SB_ACL_DIR, dir);
	assert.equal(options.windowsHide, true);
	assert.ok(options.timeout >= 10_000);
});

test("N3: applyAcl tells a failed PowerShell by its stderr's last line and exit code, never by the message that begins with the command line", async () => {
	const failing = Object.assign(new Error("Command failed: C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -EncodedCommand " + "B".repeat(3000)), { code: 1 });
	const exec: Exec = (_f, _a, _o, done) => done(failing, "", "Get-Acl : Attempted to perform an unauthorized operation.\r\n");
	await assert.rejects(applyAcl("C:\\s", exec), (e: unknown) => e instanceof AclError && e.message === "could not set the ACL of C:\\s: Get-Acl : Attempted to perform an unauthorized operation., exit code 1");
	const killed = Object.assign(new Error("Command failed: x"), { code: "ENOENT" });
	await assert.rejects(applyAcl("C:\\s", (_f, _a, _o, done) => done(killed, "", "")), /: ENOENT$/);
});

test("the script reads the owner's SID, grants the owner and SYSTEM by SID, inherits nothing, and reads every SDDL back", () => {
	assert.match(ACL_SCRIPT, /WindowsIdentity\]::GetCurrent\(\)\.User\.Value/);
	assert.match(ACL_SCRIPT, /& \$icacls \$dir \/inheritance:r \/grant:r "\*\$\{sid\}:\(OI\)\(CI\)F" '\*S-1-5-18:\(OI\)\(CI\)F' \| Out-Null/);
	assert.match(ACL_SCRIPT, /Get-Acl -LiteralPath \$dir\)\.Sddl/);
	for (const name of ["server.json", "server.lock", "server.log", "gui.json", "paired.json", "gui-secrets.json", "lan-ca.json", "lan.json", "link"]) assert.ok(ACL_SCRIPT.includes(name), name);
	assert.match(ACL_SCRIPT, /ConvertTo-Json -Compress/);
	assert.ok(!/\$sid:/.test(ACL_SCRIPT), "$sid: would be read as a variable in a scope named sid");
});

/** The text of every loop body in the script (`foreach (...) { ... }`, `ForEach-Object { ... }`, `while`, `for`), braces matched. */
function loopBodies(script: string): string[] {
	const bodies: string[] = [];
	for (const m of script.matchAll(/\b(?:foreach|for|while|ForEach-Object)\b[^{\n]*\{/g)) {
		let depth = 0, i = m.index! + m[0].length - 1;
		const start = i;
		for (; i < script.length; i++) {
			if (script[i] === "{") depth++;
			else if (script[i] === "}" && --depth === 0) break;
		}
		bodies.push(script.slice(start, i + 1));
	}
	return bodies;
}
const SPAWNS = /icacls|&\s|Start-Process|Invoke-Expression|Get-CimInstance|powershell|cmd(\.exe)?\b/i;

test("the folder is protected first and without /T, then everything already in it is reset to inherit from it in ONE icacls call (R-F001: no process per item; the VM found server.log and server.lock with an empty DACL)", () => {
	const lines = ACL_SCRIPT.split("\n");
	const folder = lines.findIndex((l) => l.includes("& $icacls $dir /inheritance:r"));
	assert.ok(folder > 0);
	assert.ok(!/icacls[^\n]*\/T\b/.test(lines[folder]!), "the folder step has no /T: that would strip the inherited ACEs of the files that are there, and an (OI)(CI) grant does not land on a file");
	// One call for every item below: reset to the default inherited ACL (the protected folder's owner and SYSTEM grant, which (OI)(CI) hands to files and folders alike), recursive, past an item that goes meanwhile, quiet.
	const reset = lines.filter((l) => l.includes("/reset"));
	assert.equal(reset.length, 1, "one reset call");
	assert.match(reset[0]!, /^& \$icacls "\$dir\\\*" \/reset \/T \/C \/L \/Q \| Out-Null$/);
	assert.ok(lines.indexOf(reset[0]!) > folder, "after the folder");
	assert.ok(lines.findIndex((l) => l.includes("(Sddl $p)")) > lines.indexOf(reset[0]!), "the SDDLs are read back after the repair");
	assert.equal(ACL_SCRIPT.match(/& \$icacls/g)!.length, 3, "icacls is started three times, whatever the number of items: the folder, the reset, and the owner of what is below (R7-F002)");
	assert.equal(ACL_SCRIPT.match(/icacls\.exe/g)!.length, 1, "named once, by the system folder's path");
	// The files the check reads include the ones that existed before the ACL: the lock the starter took and the log.
	assert.match(ACL_SCRIPT, /'server\.json', 'server\.lock', 'server\.log'/);
});

test("R-F001 timing guard: no process is started per item, so the script's cost does not grow with the number of files (a loop body runs in-process: Get-Acl, Test-Path, Join-Path)", () => {
	const bodies = loopBodies(ACL_SCRIPT);
	assert.ok(bodies.length >= 2, "the loops are found (the file list and the read-back)");
	for (const body of bodies) assert.ok(!SPAWNS.test(body), `a loop body spawns a process: ${body}`);
	// The matcher catches what it must: the old script's per-item call is a spawn in a loop.
	const old = 'foreach ($item in @(Get-ChildItem -LiteralPath $dir -Recurse -Force)) {\n  try { & icacls.exe $item.FullName /inheritance:e } catch { }\n}';
	assert.ok(loopBodies(old).some((body) => SPAWNS.test(body)));
});

test("R-F001: the read-back covers secondary slots' server.json (it holds that slot's secret), the files at the top, and link/ below", () => {
	assert.match(ACL_SCRIPT, /Join-Path \$dir 'servers'/);
	assert.match(ACL_SCRIPT, /\$tree\.files \| Where-Object \{ \$_\.StartsWith\(\$servers \+ '\\'\) -and \[IO\.Path\]::GetFileName\(\$_\) -eq 'server\.json' \}/);
	assert.match(ACL_SCRIPT, /\$tree\.files \| Where-Object \{ \$_\.StartsWith\(\$link \+ '\\'\) \}/);
});

test("a file that is gone while the script runs (a temp file renamed into place) is not a failure, any other read error is", () => {
	assert.match(ACL_SCRIPT, /catch \{ if \(Test-Path -LiteralPath \$p\) \{ throw \} \}/);
	// The reset's own exit code is not the check (an item gone meanwhile, an empty folder): the read-back is.
	assert.ok(!ACL_SCRIPT.split("\n").some((l, i, all) => all[i - 1]?.includes("/reset") && l.includes("$LASTEXITCODE")));
});

test("the same PowerShell start tells the server's start time (Win32_Process.CreationDate in the form startof.ts uses), from its pid in the environment, and a failure there leaves it null", () => {
	assert.match(ACL_SCRIPT, /Get-CimInstance Win32_Process -Filter "ProcessId=\$\(\$env:SB_ACL_PID -as \[int\]\)"\)\.CreationDate\.ToUniversalTime\(\)\.ToString\('yyyy-MM-ddTHH:mm:ss\.fffZ', \[cultureinfo\]::InvariantCulture\)/);
	assert.match(ACL_SCRIPT, /\$started = \$null\ntry \{ \$started = .*\} catch \{ \}/);
	assert.match(ACL_SCRIPT, /started = \$started/);
	assert.equal(aclCommand("C:\\s", { PATH: "p" }, 5000, 4321).options.env.SB_ACL_PID, "4321");
	assert.equal(aclCommand("C:\\s", { PATH: "p" }).options.env.SB_ACL_PID, String(process.pid));
});

test("sbr-F007: the script sets UTF-8 output on its first line and prints its answer as ASCII only, so no OEM code page can put a backslash inside a JSON string", () => {
	assert.equal(ACL_SCRIPT.split("\n")[0], "try { [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false) } catch { }");
	assert.match(ACL_SCRIPT, /\[regex\]::Replace\(\$json, '\[\^\\x00-\\x7F\]', \[System\.Text\.RegularExpressions\.MatchEvaluator\]\{ param\(\$m\) \('\\u\{0:x4\}' -f \[int\]\[char\]\$m\.Value\) \}\)$/);
	assert.ok(ACL_SCRIPT.trimEnd().endsWith(")"), "the escaped answer is the last output");
});

test("sbr-F007: an account whose profile path has Big5 characters ending in 0x5C (許, 功) gets its path through: the escaped answer parses, the raw OEM bytes would not", () => {
	const dir = "C:\\Users\\許功蓋\\.pi\\agent\\straw-boss";
	const answer = { sid: OWNER, dir: good, files: [{ path: `${dir}\\server.json`, sddl: good }] };
	// What the script prints: ConvertTo-Json's text with every character above 0x7F as \uXXXX.
	const escaped = JSON.stringify(answer).replace(/[^\x00-\x7f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
	assert.ok(/^[\x00-\x7f]*$/.test(escaped));
	assert.equal(parseAclOutput(`${escaped}\r\n`).files[0]?.path, `${dir}\\server.json`);
	// What a CP950 console wrote before: 許 is B3 5C and 功 is A5 5C, which Node decoded as UTF-8 gives a replacement character and a bare backslash that swallows the next character.
	const raw = Buffer.concat([Buffer.from('{"sid":"S-1-5-21-1-2-3-1001","dir":"O:SYG:SYD:PAI(A;;FA;;;SY)","files":[{"path":"C:\\\\Users\\\\', "latin1"), Buffer.from([0xb3, 0x5c, 0xa5, 0x5c]), Buffer.from('x","sddl":"y"}]}', "latin1")]);
	assert.throws(() => parseAclOutput(raw.toString("utf8")), /PowerShell answered/);
});

test("parseSddl reads owner, DACL flags, and ACEs; SYSTEM's alias and long SIDs both come through", () => {
	const parsed = parseSddl(good);
	assert.equal(parsed.owner, OWNER);
	assert.deepEqual(parsed.daclFlags, ["P"]);
	assert.deepEqual(parsed.aces.map((a) => [a.type, a.flags, a.sid]), [["A", ["OI", "CI"], OWNER], ["A", ["OI", "CI"], "SY"]]);
	assert.deepEqual(parseSddl(`O:SYG:SYD:PAI(A;ID;FA;;;BA)`).aces[0]?.flags, ["ID"]);
	assert.deepEqual(parseSddl(`O:SYG:SYD:PAI${ACE("SY")}S:AI(AU;FA;FA;;;WD)`).aces.length, 1, "the SACL is not the DACL");
	assert.throws(() => parseSddl("not sddl"));
	assert.throws(() => parseSddl(`O:${OWNER}G:DU`), /no DACL/);
	assert.throws(() => parseSddl(`O:${OWNER}D:P(A;OICI;FA)`), /fields/);
});

test("the folder is right with a protected DACL of exactly the owner and SYSTEM, none inherited", () => {
	assert.deepEqual(folderProblems(good, OWNER), []);
	assert.deepEqual(folderProblems(`O:${OWNER}G:DUD:PAI${ACE(OWNER)}${ACE("S-1-5-18")}`, OWNER), []);
});

test("the folder is refused when it inherits, has a third account, an inherited ACE, a deny ACE, a missing party, or text that is not SDDL", () => {
	const some = (sddl: string, part: RegExp) => assert.ok(folderProblems(sddl, OWNER).some((p) => part.test(p)), `${sddl} → ${folderProblems(sddl, OWNER).join(" | ")}`);
	some(`O:${OWNER}G:DUD:${ACE(OWNER)}${ACE("SY")}`, /not protected/);
	some(`O:${OWNER}G:DUD:P${ACE(OWNER)}${ACE("SY")}${ACE("BA")}`, /BA.*neither the owner nor SYSTEM/);
	some(`O:${OWNER}G:DUD:P${ACE(OWNER)}${ACE("SY")}${ACE("S-1-1-0")}`, /3 ACEs/);
	some(`O:${OWNER}G:DUD:P${ACE(OWNER, "OICIID")}${ACE("SY")}`, /inherited ACE/);
	some(`O:${OWNER}G:DUD:P${ACE(OWNER)}${ACE("SY", "OICI", "D")}`, /type D/);
	some(`O:${OWNER}G:DUD:P${ACE(OWNER)}`, /grants nothing to S-1-5-18/);
	some(`O:${OWNER}G:DUD:P${ACE("SY")}${ACE("SY")}`, new RegExp(`grants nothing to ${OWNER}`));
	some("garbage", /cannot be read/);
	some(`O:${OWNER}G:DUD:NO_ACCESS_CONTROL`, /null DACL/);
});

test("the built-in Administrator's SDDL alias counts as the owner when the owner's SID ends in 500", () => {
	const admin = "S-1-5-21-1-2-3-500";
	assert.deepEqual(folderProblems(`O:LAG:DUD:P${ACE("LA")}${ACE("SY")}`, admin), []);
	assert.ok(folderProblems(`O:LAG:DUD:P${ACE("LA")}${ACE("SY")}`, OWNER).length > 0, "LA is not an ordinary user's alias");
});

test("a secret file may hold the owner's and SYSTEM's allow ACEs explicit or inherited, and nothing else", () => {
	assert.deepEqual(fileProblems(`O:${OWNER}G:DUD:AI${ACE(OWNER, "ID")}${ACE("SY", "ID")}`, OWNER, "server.json"), []);
	assert.deepEqual(fileProblems(`O:${OWNER}G:DUD:P${ACE(OWNER, "")}${ACE("SY", "")}`, OWNER), []);
	assert.match(fileProblems(`O:${OWNER}G:DUD:AI${ACE(OWNER, "ID")}${ACE("SY", "ID")}${ACE("BU", "ID")}`, OWNER, "paired.json")[0]!, /paired\.json: grants BU/);
	assert.match(fileProblems(`O:${OWNER}G:DUD:AI${ACE(OWNER, "ID")}`, OWNER, "gui.json")[0]!, /gui\.json: grants nothing to S-1-5-18/);
	assert.match(fileProblems(`O:${OWNER}G:DUD:AI${ACE(OWNER, "ID")}${ACE("SY", "ID", "D")}`, OWNER)[0]!, /type D/);
});

test("the script's answer: one JSON line (the last line of the output), a one-item array flattened by PowerShell included", () => {
	const answer = { sid: OWNER, dir: good, files: [{ path: "C:\\s\\server.json", sddl: good }] };
	assert.deepEqual(parseAclOutput(`${JSON.stringify(answer)}\r\n`), { ...answer, folders: [] });
	assert.deepEqual(parseAclOutput(`warning text\n${JSON.stringify({ ...answer, files: answer.files[0] })}`), { ...answer, folders: [] });
	assert.deepEqual(parseAclOutput(JSON.stringify({ sid: OWNER, dir: good })).files, []);
	assert.throws(() => parseAclOutput(""), /answered nothing/);
	assert.throws(() => parseAclOutput("{not json"), /answered/);
	assert.throws(() => parseAclOutput(JSON.stringify({ sid: "x", dir: good })), /no SID/);
	assert.deepEqual(aclProblems(answer), []);
});

const exec = (error: Error | null, stdout: string): Exec => (_f, _a, _o, done) => void done(error, stdout);
const answer = (over: object = {}) => JSON.stringify({ sid: OWNER, dir: good, files: [{ path: "server.json", sddl: `O:${OWNER}D:AI${ACE(OWNER, "ID")}${ACE("SY", "ID")}` }], ...over });

test("the answer's start time is kept only in the form startof.ts writes", () => {
	const base = { sid: OWNER, dir: good, files: [] };
	assert.equal(parseAclOutput(JSON.stringify({ ...base, started: "2026-10-26T04:21:53.000Z" })).started, "2026-10-26T04:21:53.000Z");
	for (const bad of [null, "", "yesterday", "2026-10-26T04:21:53Z", 5]) assert.equal(parseAclOutput(JSON.stringify({ ...base, started: bad })).started, undefined, String(bad));
	assert.equal(parseAclOutput(JSON.stringify(base)).started, undefined);
});

test("applyAcl passes when the SDDL is right and fails the start, with the SDDL it read, when it is not", async () => {
	assert.deepEqual(await applyAcl("C:\\s", exec(null, answer())), { sid: OWNER });
	assert.deepEqual(await applyAcl("C:\\s", exec(null, answer({ started: "2026-10-26T04:21:53.000Z" }))), { sid: OWNER, started: "2026-10-26T04:21:53.000Z" });
	await assert.rejects(applyAcl("C:\\s", exec(new Error("Access is denied"), "")), (e: unknown) => e instanceof AclError && /Access is denied/.test(e.message) && e.sddl === undefined);
	await assert.rejects(applyAcl("C:\\s", exec(null, "oops")), /could not read the ACL/);
	await assert.rejects(applyAcl("C:\\s", exec(null, answer({ dir: `O:${OWNER}G:DUD:${ACE(OWNER)}${ACE("SY")}` }))), (e: unknown) => e instanceof AclError && /not protected/.test(e.message) && Boolean(e.sddl?.includes(OWNER)));
	await assert.rejects(applyAcl("C:\\s", exec(null, answer({ files: [{ path: "link\\team.key", sddl: `O:${OWNER}D:AI${ACE(OWNER, "ID")}${ACE("SY", "ID")}${ACE("WD", "ID")}` }] }))), /link\\team\.key: grants WD/);
	assert.equal(SYSTEM_SID, "S-1-5-18");
});

// --- the check made by the process that started the server (one PowerShell start on a cold start) ---

const marker = (over: Record<string, unknown> = {}) => JSON.stringify({ pid: 4321, sid: OWNER, started: "2026-10-26T08:00:00.000Z", dir: good, files: [{ path: "C:\\s\\server.json", sddl: `O:${OWNER}G:DUD:AI${ACE(OWNER, "ID")}${ACE("SY", "ID")}` }], ...over });
const tmp = () => mkdtempSync(join(tmpdir(), "psb-marker-"));

test("the marker path is in the state folder and named by the token; a token is 32 hex digits", () => {
	assert.equal(aclMarkerPath(join("C:", "s"), "a".repeat(32)), join("C:", "s", `acl.${"a".repeat(32)}.json`));
	assert.ok(ACL_TOKEN.test("0123456789abcdef0123456789abcdef"));
	for (const bad of ["", "abc", "g".repeat(32), "A".repeat(32), "a".repeat(33), "../x" + "a".repeat(29)]) assert.ok(!ACL_TOKEN.test(bad), bad);
});

test("a marker is checked here, by the server, before it writes its secret: the same SDDL rules as its own check, for this pid only", () => {
	assert.deepEqual(readMarker(marker(), "C:\\s", 4321), { sid: OWNER, started: "2026-10-26T08:00:00.000Z" });
	assert.throws(() => readMarker(marker({ pid: 99 }), "C:\\s", 4321), /made for pid 99, not for this server \(pid 4321\)/);
	assert.throws(() => readMarker(marker({ pid: undefined }), "C:\\s", 4321), /made for pid undefined/);
	assert.throws(() => readMarker(marker({ dir: `O:${OWNER}G:DUD:AI${ACE("BU", "ID")}` }), "C:\\s", 4321), (e: unknown) => e instanceof AclError && /not owner and SYSTEM only/.test((e as Error).message) && /BU/.test((e as AclError).sddl ?? ""));
	assert.throws(() => readMarker(marker({ files: [{ path: "C:\\s\\server.json", sddl: `O:${OWNER}G:DUD:AI${ACE("WD", "ID")}` }] }), "C:\\s", 4321), /server\.json.*WD|WD/);
	assert.throws(() => readMarker("not json", "C:\\s", 4321), /cannot be read/);
	assert.throws(() => readMarker(JSON.stringify({ pid: 4321, sid: "bad" }), "C:\\s", 4321), AclError);
});

test("an error marker (the starter could not make the check, or never finished it) is an AclError that says why, as printable ASCII, whatever pid it names", () => {
	assert.throws(() => readMarker(JSON.stringify({ error: "Cannot create type. Only core types are supported." }), "C:\\s", 4321), (e: unknown) => e instanceof AclError && (e as Error).message === "could not set the ACL of C:\\s: Cannot create type. Only core types are supported.");
	assert.throws(() => readMarker(JSON.stringify({ pid: 5, error: "\u5b58\u53d6 denied" }), "C:\\s", 4321), /: \? denied$/);
});

test("awaitAclMarker waits for the file, removes it, and checks it; one that does not come in time is an AclError", async () => {
	const dir = tmp(), token = "b".repeat(32), file = aclMarkerPath(dir, token);
	try {
		let t = 0;
		const slept: number[] = [];
		const sleep = async (ms: number) => { slept.push(ms); t += ms; if (t >= 150) writeFileSync(file, marker()); };
		assert.deepEqual(await awaitAclMarker(dir, token, 4321, { now: () => t, sleep, waitMs: 1000 }), { sid: OWNER, started: "2026-10-26T08:00:00.000Z" });
		assert.ok(slept.length >= 3 && slept.every((ms) => ms === 50), "polls");
		assert.equal(existsSync(file), false, "the marker is removed once it is read");
		t = 0;
		await assert.rejects(awaitAclMarker(dir, token, 4321, { now: () => t, sleep: async (ms) => void (t += ms), waitMs: 500 }), /did not arrive from the process that started this server within 1 s/);
		writeFileSync(file, JSON.stringify({ error: "WMI said no" }));
		await assert.rejects(awaitAclMarker(dir, token, 4321, { waitMs: 500 }), /WMI said no/);
		assert.equal(existsSync(file), false, "an error marker is removed too");
		await assert.rejects(awaitAclMarker(dir, "../../evil", 4321), /32 hex digits/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("asciiLine keeps the last non-empty line as printable ASCII, at most 120 characters", () => {
	assert.equal(asciiLine("first\r\n\r\n�s���Q�ڡC \r\n"), "?s?Q?C");
	assert.equal(asciiLine(undefined), "");
	assert.equal(asciiLine("x".repeat(500)).length, 120);
	assert.equal(execFailure(Object.assign(new Error("Command failed: x"), { status: 5 }), "�s���Q�ڡC"), "?s?Q?C, exit code 5");
});

test("N-F006: a PowerShell 5.1 error is told by its message (the first line before the 'At line' position and the '+' lines), not by its FullyQualifiedErrorId at the end", () => {
	const clm = [
		"Cannot index into a null array.",
		"At line:3 char:8",
		"+ $si = ([wmiclass]'Win32_ProcessStartup').CreateInstance()",
		"+        ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~",
		"    + CategoryInfo          : NotImplemented: (:) [], PSNotSupportedException",
		"    + FullyQualifiedErrorId : CannotCreateTypeConstrainedLanguage",
		"",
	].join("\r\n");
	const thrown = ["icacls failed with exit code 5", "At line:1 char:1", '+ throw "icacls failed with exit code 5"', "+ ~~~~~", "    + CategoryInfo          : OperationStopped: (icacls failed with exit code 5:String) [], RuntimeException", "    + FullyQualifiedErrorId : icacls failed with exit code 5", ""].join("\r\n");
	assert.equal(execFailure(Object.assign(new Error("Command failed: x"), { code: 1 }), clm), "Cannot index into a null array., exit code 1");
	assert.equal(execFailure(Object.assign(new Error("Command failed: x"), { code: 1 }), thrown), "icacls failed with exit code 5, exit code 1");
	assert.equal(messageLine("\r\n\r\nAt line:1\r\n+ x\r\n"), "+ x", "when nothing else is there, the last line stands");
	assert.equal(messageLine(["first", "second"].join("\n")), "first", "plain text: the first line");
});

// --- R6-F001: the exact owner, from the PowerShell read-back, before any secret is written ---

test("R6-F001: the folder's owner (O: of Get-Acl) must be the user; another account's folder is refused with `belongs to another account`, whatever its DACL says, and the SDDL is handed on", async () => {
	const foreign = `O:${OTHER}G:DUD:P${ACE(OWNER)}${ACE("SY")}`;
	assert.deepEqual(ownerProblems(good, OWNER), []);
	assert.deepEqual(ownerProblems(`O:LAG:DUD:P${ACE(OWNER)}${ACE("SY")}`, OWNER.replace(/-\d+$/, "-500")), [], "an alias of the owner's own built-in account");
	assert.match(ownerProblems(foreign, OWNER)[0]!, /belongs to another account \(S-1-5-21-9-9-9-1002\)/);
	assert.match(ownerProblems(`O:BUG:DUD:P${ACE(OWNER)}${ACE("SY")}`, OWNER)[0]!, /belongs to another account \(BU\)/);
	assert.deepEqual(ownerProblems(`O:SYG:DUD:P${ACE(OWNER)}${ACE("SY")}`, OWNER), [], "SYSTEM is an accepted owner (R11-F004: one rule in every check)");
	assert.match(ownerProblems(`D:P${ACE(OWNER)}${ACE("SY")}`, OWNER)[0]!, /names no owner/);
	assert.ok(aclProblems({ sid: OWNER, dir: foreign, files: [] }).some((p) => /belongs to another account/.test(p)));
	const exec: Exec = (_f, _a, _o, done) => done(null, JSON.stringify({ sid: OWNER, dir: foreign, files: [] }));
	await assert.rejects(applyAcl("C:\\s", exec), (e: unknown) => e instanceof AclError && /belongs to another account/.test((e as Error).message) && /S-1-5-21-9-9-9-1002/.test((e as AclError).sddl ?? ""));
	assert.throws(() => readMarker(marker({ dir: foreign }), "C:\\s", 4321), (e: unknown) => e instanceof AclError && /belongs to another account/.test((e as Error).message));
});

test("R6-F006: a CLIXML character reference past U+10FFFF is kept as written and the decode never throws", () => {
	const text = (ref: string) => `#< CLIXML\n<Objs xmlns="http://schemas.microsoft.com/powershell/2004/04"><S S="Error">a${ref}b</S></Objs>`;
	for (const ref of ["&#x110000;", "&#1114112;", "&#xFFFFFFFFFFFF;", "&#99999999999999999999;"]) assert.equal(plainStderr(text(ref)), `a${ref}b`);
	assert.equal(plainStderr(text("&#x41;&#128512;")), "aA\u{1F600}b");
	assert.doesNotThrow(() => execFailure(Object.assign(new Error("x"), { code: 1 }), text("&#x110000;")));
});

// --- R7-F002: the folders below are the user's too ---

test("R7-F002/R8-F001: both scripts make everything below the folder the user's in one call BEFORE the reset, and read back every folder below", () => {
	const lines = ACL_SCRIPT.split("\n");
	const reset = lines.findIndex((l) => /\/reset \/T \/C \/L \/Q/.test(l)), owner = lines.findIndex((l) => /\/setowner "\*\$\{sid\}" \/T \/C \/L \/Q/.test(l)), folders = lines.findIndex((l) => /foreach \(\$p in \$tree\.folders\)/.test(l));
	assert.ok(owner > 0 && reset > owner, `the owner is taken first (R8-F001): ${owner} ${reset}`);
	assert.ok(folders > reset, "read back after both");
	assert.equal(lines.filter((l) => /\/setowner/.test(l)).length, 1, "one call, not one per item");
	assert.match(ACL_SCRIPT, /folders = \$readFolders/);
	assert.ok(!/foreach[^\n]*icacls/.test(ACL_SCRIPT), "no per-item icacls");
	assert.ok(LAUNCH_SCRIPT.includes('/setowner "*${sid}" /T /C /L /Q'), "the launch script runs the same steps");
});

test("R7-F002: a folder below that another account owns is a problem (named by path), on the marker path and the own path; the user's, SYSTEM's alias and missing folders are not", async () => {
	const base = { sid: OWNER, dir: good, files: [] };
	const mine = { path: "C:\\s\\servers\\abcd", sddl: `O:${OWNER}G:DUD:AI${ACE(OWNER, "ID")}${ACE("SY", "ID")}` };
	const theirs = { path: "C:\\s\\servers\\ef01", sddl: `O:${OTHER}G:DUD:AI${ACE(OWNER, "ID")}${ACE("SY", "ID")}` };
	assert.deepEqual(aclProblems({ ...base, folders: [mine] }), []);
	assert.deepEqual(aclProblems(base), [], "an answer with no folders list");
	assert.deepEqual(aclProblems({ ...base, folders: [mine, theirs] }), ["the folder C:\\s\\servers\\ef01 belongs to another account (S-1-5-21-9-9-9-1002), not to " + OWNER]);
	const exec: Exec = (_f, _a, _o, done) => done(null, JSON.stringify({ ...base, folders: theirs }));
	await assert.rejects(applyAcl("C:\\s", exec), (e: unknown) => e instanceof AclError && /servers\\ef01 belongs to another account/.test((e as Error).message) && /servers\\ef01: O:/.test((e as AclError).sddl ?? ""));
	assert.throws(() => readMarker(marker({ folders: [theirs] }), "C:\\s", 4321), /belongs to another account/);
	assert.deepEqual(parseAclOutput(JSON.stringify({ ...base, folders: mine })).folders, [mine], "one folder is not turned into a list by PowerShell");
	assert.deepEqual(parseAclOutput(JSON.stringify(base)).folders, []);
});

test("F12: applyAcl under Constrained Language Mode fails with the sentence, not `?`s", async () => {
	const exec: Exec = (_f, _a, _o, done) => done(Object.assign(new Error("Command failed: x"), { code: 1 }), "", "sb-constrained-language\r\n");
	await assert.rejects(applyAcl("C:\\s", exec), (e: unknown) => e instanceof AclError && /Constrained Language Mode \(likely a policy\).*exit code 1/.test((e as Error).message));
});

// --- R8-F001, R8-F002, R8-F003 ---

test("R8-F003: the script lists what is below WITHOUT following links, refuses a reparse point before any icacls call below runs and again at the read-back, and never uses Get-ChildItem", () => {
	for (const script of [ACL_SCRIPT, LAUNCH_SCRIPT]) {
		assert.ok(!/Get-ChildItem/.test(script), "Windows PowerShell 5.1 follows junctions with it");
		assert.match(script, /\[IO\.Directory\]::GetFileSystemEntries\(\$here\)/);
		// R9: only a name-surrogate link (junction, symbolic link) is refused; a cloud placeholder (OneDrive) is a reparse point that is walked as an ordinary file or folder.
		assert.match(script, /if \(\(\$a -band \[IO\.FileAttributes\]::ReparsePoint\) -ne 0\) \{ \$kind = \$null; try \{ \$kind = \(Get-Item -LiteralPath \$e -Force -ErrorAction Stop\)\.LinkType \} catch \{ throw \('sb-reparse-point ' \+ \$e\) \}; if \(\$kind -eq 'Junction' -or \$kind -eq 'SymbolicLink'\) \{ throw \('sb-reparse-point ' \+ \$e\) \} \}/);
		// R9-F004: a folder that vanished is skipped, one that is there and cannot be listed is thrown.
		assert.match(script, /catch \{ if \(Test-Path -LiteralPath \$here\) \{ throw \}; continue \}/);
		const lines = script.split("\n").map((l) => l.trim());
		const walk = lines.findIndex((l) => l.startsWith("$tree = Walk $dir")), owner = lines.findIndex((l) => /\/setowner/.test(l)), reset = lines.findIndex((l) => /\/reset/.test(l));
		assert.ok(walk > 0 && walk < owner && owner < reset, `${walk} ${owner} ${reset}`);
		assert.ok(!/Descend|\$todo\.Push\(\$e\)[^}]*ReparsePoint/.test(script), "a reparse point is never pushed to the walk");
	}
	const err = Object.assign(new Error("Command failed: x"), { code: 1 });
	assert.equal(execFailure(err, "sb-reparse-point C:\\s\\link\\x\r\nAt line:1"), "a link or junction was found inside the state folder, which is refused (C:\\s\\link\\x), exit code 1");
});

test("R9-F003: the launch path (an error marker) tells the scripts' words as sentences too, through the same helper as execFailure", () => {
	assert.equal(scriptWords("sb-reparse-point C:\\s\\link\\x"), "a link or junction was found inside the state folder, which is refused (C:\\s\\link\\x)");
	assert.equal(scriptWords("sb-constrained-language"), CLM_TEXT);
	assert.equal(scriptWords("icacls failed"), "icacls failed");
	assert.throws(() => readMarker(JSON.stringify({ pid: 4321, error: "sb-reparse-point C:\\s\\link\\x" }), "C:\\s", 4321), (e: unknown) => e instanceof AclError && /could not set the ACL of C:\\s: a link or junction was found inside the state folder, which is refused \(C:\\s\\link\\x\)/.test((e as Error).message) && !/sb-reparse-point/.test((e as Error).message));
	assert.throws(() => readMarker(JSON.stringify({ pid: 4321, error: "sb-constrained-language" }), "C:\\s", 4321), (e: unknown) => e instanceof AclError && /Constrained Language Mode/.test((e as Error).message));
});

test("R9-F006: a refusal names the first five problems and how many more, and says how to put a foreign owner right, once", async () => {
	const files = Array.from({ length: 40 }, (_, i) => ({ path: `C:\\s\\link\\inbox\\m${i}.json`, sddl: `O:${OTHER}G:DUD:AI${ACE(OWNER, "ID")}${ACE("SY", "ID")}` }));
	const ok = `O:${OWNER}G:DUD:P${ACE(OWNER)}${ACE("SY")}`;
	const exec: Exec = (_f, _a, _o, done) => done(null, JSON.stringify({ sid: OWNER, dir: ok, files }));
	await assert.rejects(applyAcl("C:\\s", exec), (e: unknown) => {
		const text = (e as Error).message;
		return e instanceof AclError && text.includes("m4.json") && !text.includes("m5.json") && /and 35 more/.test(text) && text.length < 1200 && (text.match(/Run pi as that account/g) ?? []).length === 1 && /elevated shell/.test(text);
	});
});

test("R8-F001: a folder below with the right owner and a DACL that was not reset (a foreign ACE, an empty DACL) is a problem; inherited ACEs for the user and SYSTEM are not", () => {
	const inherited = `O:${OWNER}G:DUD:AI${ACE(OWNER, "ID")}${ACE("SY", "ID")}`;
	const folder = (sddl: string) => ({ sid: OWNER, dir: good, files: [], folders: [{ path: "C:\\s\\servers\\ab", sddl }] });
	assert.deepEqual(aclProblems(folder(inherited)), []);
	assert.match(aclProblems(folder(`O:${OWNER}G:DUD:P${ACE(OWNER)}${ACE("SY")}${ACE("BU")}`)).join(";"), /C:\\s\\servers\\ab: grants BU, who is neither the owner nor SYSTEM/);
	assert.match(aclProblems(folder(`O:${OWNER}G:DUD:AI${ACE(OWNER, "ID")}`)).join(";"), /grants nothing to S-1-5-18/);
	assert.match(aclProblems(folder(`O:${OWNER}G:DUD:AI`)).join(";"), /grants nothing to/);
});

test("R8-F002: a file below with another account's owner is a problem even when its DACL is right; the file's own path is named", () => {
	const mine = `O:${OWNER}G:DUD:AI${ACE(OWNER, "ID")}${ACE("SY", "ID")}`, theirs = `O:${OTHER}G:DUD:AI${ACE(OWNER, "ID")}${ACE("SY", "ID")}`;
	assert.deepEqual(aclProblems({ sid: OWNER, dir: good, files: [{ path: "C:\\s\\server.json", sddl: mine }] }), []);
	assert.deepEqual(aclProblems({ sid: OWNER, dir: good, files: [{ path: "C:\\s\\server.json", sddl: theirs }] }), [`the file C:\\s\\server.json belongs to another account (${OTHER}), not to ${OWNER}`]);
	assert.throws(() => readMarker(marker({ files: [{ path: "C:\\s\\server.json", sddl: theirs }] }), "C:\\s", 4321), /file C:\\s\\server\.json belongs to another account/);
});

test("VM pass 5b: BUILTIN\\Administrators owns an entry acceptably (an elevated token's default owner), as BA or S-1-5-32-544, for the folder, a folder below and a file; another standard SID is still refused; BA as an ACE is still refused", () => {
	for (const ba of ["BA", "S-1-5-32-544"]) {
		const owned = `O:${ba}G:DUD:AI${ACE(OWNER, "ID")}${ACE("SY", "ID")}`, top = `O:${ba}G:DUD:P${ACE(OWNER)}${ACE("SY")}`;
		assert.deepEqual(ownerProblems(top, OWNER), [], ba);
		assert.deepEqual(aclProblems({ sid: OWNER, dir: top, files: [{ path: "C:\\s\\servers\\ab\\server.json", sddl: owned }], folders: [{ path: "C:\\s\\servers\\ab", sddl: owned }] }), [], ba);
	}
	const owned = (who: string) => `O:${who}G:DUD:AI${ACE(OWNER, "ID")}${ACE("SY", "ID")}`;
	assert.match(aclProblems({ sid: OWNER, dir: good, files: [{ path: "C:\\s\\server.json", sddl: owned(OTHER) }] }).join(";"), /file C:\\s\\server\.json belongs to another account/);
	assert.match(aclProblems({ sid: OWNER, dir: good, files: [], folders: [{ path: "C:\\s\\link", sddl: owned("BU") }] }).join(";"), /folder C:\\s\\link belongs to another account \(BU\)/);
	// BA as an owner is fine, BA as an allow ACE is not: nothing about the DACL rule changed.
	assert.match(aclProblems({ sid: OWNER, dir: `O:BAG:DUD:P${ACE(OWNER)}${ACE("SY")}${ACE("BA")}`, files: [] }).join(";"), /grants BA, who is neither the owner nor SYSTEM/);
	assert.match(aclProblems({ sid: OWNER, dir: good, files: [{ path: "C:\\s\\server.json", sddl: `O:BAG:DUD:AI${ACE(OWNER, "ID")}${ACE("SY", "ID")}${ACE("BA", "ID")}` }] }).join(";"), /server\.json: grants BA, who is neither/);
});

test("R11-F001, R13: both ACL scripts check the folder's own owner before /inheritance:r, and ONE walk reads each entry's attributes, link type and owner before /setowner /T and /reset; a foreign owner is thrown with nothing changed", () => {
	for (const script of [ACL_SCRIPT, LAUNCH_SCRIPT]) {
		const lines = script.split("\n").map((l) => l.trim());
		const at = (re: RegExp) => lines.findIndex((l) => re.test(l));
		const dirCheck = at(/^CheckOwner \$dir$/), protect = at(/\$dir \/inheritance:r \/grant:r/), walk = at(/^\$tree = Walk \$dir/);
		const setowner = at(/\/setowner .*\/T \/C \/L \/Q/), reset = at(/\/reset \/T \/C \/L \/Q/);
		assert.ok(dirCheck > 0 && dirCheck < protect && protect < walk && walk < setowner && setowner < reset, `${dirCheck} ${protect} ${walk} ${setowner} ${reset}`);
		// R13: a single walk: one call, no second enumeration, and the read-back reuses its lists.
		assert.equal(lines.filter((l) => /^\$\w+ = Walk \$/.test(l)).length, 1, "one walk of the folder");
		assert.ok(!/Walk \$dir/.test(lines.slice(reset).join("\n")), "the read-back does not walk again");
		assert.ok(lines.slice(reset).some((l) => /\$tree\.files/.test(l)) && lines.slice(reset).some((l) => /\$tree\.folders/.test(l)), "it reuses the list");
		const fn = lines[at(/^function CheckOwner/)]!;
		assert.match(fn, /\$who -ne \$sid -and \$okOwners -notcontains \$who\) \{ throw /, "the user and the accepted owners pass; anything else is thrown");
		assert.ok(lines.some((l) => l === "$okOwners = @('S-1-5-18','S-1-5-32-544')"), "the accepted owners: SYSTEM and BUILTIN\\Administrators (the one list, shared with the launch script and ownerProblems)");
		const w = lines[at(/^function Walk/)]!;
		// The walk reads, once per entry: attributes, the link type (a junction or symbolic link is thrown), and the owner (a foreign one is thrown), for folders and files alike.
		assert.match(w, /\[IO\.File\]::GetAttributes\(\$e\)/);
		assert.match(w, /\.LinkType/);
		assert.match(w, /\[IO\.Directory\]::GetAccessControl\(\$e, \$own\)/);
		assert.match(w, /\[IO\.File\]::GetAccessControl\(\$e, \$own\)/);
		assert.match(w, /GetOwner\(\[Security\.Principal\.SecurityIdentifier\]\)\.Value/);
		assert.match(w, /\$who -ne \$sid -and \$okOwners -notcontains \$who\) \{ throw \('the ' \+ \$e \+ ' belongs to another account \(' \+ \$who \+ '\), not to ' \+ \$sid \+ ' \(nothing was changed\)'\)/);
		assert.match(w, /catch \{ if \(Test-Path -LiteralPath \$e\) \{ throw \}; continue \}/, "an entry that vanished is skipped");
		assert.ok(!/Get-Acl/.test(w), "no provider cmdlet per entry");
		assert.ok(lines.some((l) => /^function Sddl/.test(l) && /GetSecurityDescriptorSddlForm/.test(l)), "the read-back reads each SDDL through .NET, not Get-Acl per entry");
	}
	assert.equal((ACL_SCRIPT.match(/Get-Acl/g) ?? []).length, 1, "Get-Acl is left for the folder itself");
});
