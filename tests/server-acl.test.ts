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
	assert.match(ACL_SCRIPT, /icacls\.exe \$dir \/inheritance:r \/grant:r "\*\$\{sid\}:\(OI\)\(CI\)F" '\*S-1-5-18:\(OI\)\(CI\)F' \/T/);
	assert.match(ACL_SCRIPT, /Get-Acl -LiteralPath \$dir\)\.Sddl/);
	for (const name of ["server.json", "gui.json", "paired.json", "link"]) assert.ok(ACL_SCRIPT.includes(name), name);
	assert.match(ACL_SCRIPT, /ConvertTo-Json -Compress/);
	assert.ok(!/\$sid:/.test(ACL_SCRIPT), "$sid: would be read as a variable in a scope named sid");
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

test("applyAcl passes when the SDDL is right and fails the start, with the SDDL it read, when it is not", async () => {
	assert.deepEqual(await applyAcl("C:\\s", exec(null, answer())), { sid: OWNER });
	await assert.rejects(applyAcl("C:\\s", exec(new Error("Access is denied"), "")), (e: unknown) => e instanceof AclError && /Access is denied/.test(e.message) && e.sddl === undefined);
	await assert.rejects(applyAcl("C:\\s", exec(null, "oops")), /could not read the ACL/);
	await assert.rejects(applyAcl("C:\\s", exec(null, answer({ dir: `O:${OWNER}G:DUD:${ACE(OWNER)}${ACE("SY")}` }))), (e: unknown) => e instanceof AclError && /not protected/.test(e.message) && Boolean(e.sddl?.includes(OWNER)));
	await assert.rejects(applyAcl("C:\\s", exec(null, answer({ files: [{ path: "link\\team.key", sddl: `O:${OWNER}D:AI${ACE(OWNER, "ID")}${ACE("SY", "ID")}${ACE("WD", "ID")}` }] }))), /link\\team\.key: grants WD/);
	assert.equal(SYSTEM_SID, "S-1-5-18");
});
