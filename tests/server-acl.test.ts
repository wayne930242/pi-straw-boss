import assert from "node:assert/strict";
import { test } from "node:test";
import { ACL_SCRIPT, aclCommand, AclError, aclProblems, applyAcl, type Exec, fileProblems, folderProblems, parseAclOutput, parseSddl, SYSTEM_SID } from "../src/server/acl.ts";

// docs/specs/2026-10-26-sb-backend.md, The control socket: on Windows the state directory gets an owner-and-SYSTEM ACL, set and checked by SID in one PowerShell start.
// Windows is not run here: these pin the command and the SDDL reading.

const OWNER = "S-1-5-21-1111111111-2222222222-3333333333-1001";
const ACE = (sid: string, flags = "OICI", type = "A") => `(${type};${flags};FA;;;${sid})`;
const good = `O:${OWNER}G:DUD:P${ACE(OWNER)}${ACE("SY")}`;

test("the command is one PowerShell start with the folder in the environment, never quoted into the script, and no console window", () => {
	const dir = "C:\\Users\\測試PM\\.pi\\agent\\straw-boss";
	const { file, args, options } = aclCommand(dir, { PATH: "p" });
	assert.equal(file, "powershell.exe");
	assert.deepEqual(args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
	assert.equal(Buffer.from(args[3]!, "base64").toString("utf16le"), ACL_SCRIPT);
	assert.ok(!ACL_SCRIPT.includes("測試PM") && !ACL_SCRIPT.includes("straw-boss"));
	assert.equal(options.env.SB_ACL_DIR, dir);
	assert.equal(options.windowsHide, true);
	assert.ok(options.timeout >= 10_000);
});

test("the script reads the owner's SID, grants the owner and SYSTEM by SID, inherits nothing, and reads every SDDL back", () => {
	assert.match(ACL_SCRIPT, /WindowsIdentity\]::GetCurrent\(\)\.User\.Value/);
	assert.match(ACL_SCRIPT, /& icacls\.exe \$dir \/inheritance:r \/grant:r "\*\$\{sid\}:\(OI\)\(CI\)F" '\*S-1-5-18:\(OI\)\(CI\)F' \| Out-Null/);
	assert.match(ACL_SCRIPT, /Get-Acl -LiteralPath \$dir\)\.Sddl/);
	for (const name of ["server.json", "server.lock", "server.log", "gui.json", "paired.json", "link"]) assert.ok(ACL_SCRIPT.includes(name), name);
	assert.match(ACL_SCRIPT, /ConvertTo-Json -Compress/);
	assert.ok(!/\$sid:/.test(ACL_SCRIPT), "$sid: would be read as a variable in a scope named sid");
});

test("the folder is protected first and without /T, then each file that is already in it is made to inherit again and is granted the owner and SYSTEM itself (the VM found server.log and server.lock with an empty DACL)", () => {
	const lines = ACL_SCRIPT.split("\n");
	const folder = lines.findIndex((l) => l.includes("icacls.exe $dir /inheritance:r"));
	assert.ok(folder > 0);
	assert.ok(!/\/T\b/.test(ACL_SCRIPT), "icacls /T strips the inherited ACEs of the files that are there, and an (OI)(CI) grant does not land on a file");
	// The files come after the folder, one icacls call each: inheritance back on, and an explicit grant of full control to the owner and SYSTEM by SID, without the container flags.
	const files = lines.findIndex((l) => l.includes("icacls.exe $item.FullName /inheritance:e"));
	assert.ok(files > folder, "after the folder");
	assert.match(lines[files]!, /\/inheritance:e \/grant:r "\*\$\{sid\}:\$grant" "\*S-1-5-18:\$grant"/);
	assert.ok(lines.some((l) => l.includes("$grant = if ($item.PSIsContainer) { '(OI)(CI)F' } else { 'F' }")), "a file gets F, a folder (OI)(CI)F");
	assert.ok(lines.findIndex((l) => l.includes("Get-Acl -LiteralPath $p")) > files, "the SDDLs are read back after the repair");
	// The files the check reads include the ones that existed before the ACL: the lock the starter took and the log.
	assert.match(ACL_SCRIPT, /'server\.json', 'server\.lock', 'server\.log'/);
});

test("a file that is gone while the script runs (a temp file renamed into place) is not a failure, any other read error is", () => {
	assert.match(ACL_SCRIPT, /try \{ & icacls\.exe \$item\.FullName[^\n]*\} catch \{ \}/);
	assert.match(ACL_SCRIPT, /catch \{ if \(Test-Path -LiteralPath \$p\) \{ throw \} \}/);
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
	assert.deepEqual(parseAclOutput(`${JSON.stringify(answer)}\r\n`), answer);
	assert.deepEqual(parseAclOutput(`warning text\n${JSON.stringify({ ...answer, files: answer.files[0] })}`), answer);
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
