import assert from "node:assert/strict";
import { test } from "node:test";
import { ACL_SCRIPT, aclCommand, execFailure, messageLine, plainStderr, POWERSHELL_FLAGS, PROGRESS_OFF } from "../src/server/acl.ts";
import { BEFORE_CREATE, LAUNCH_SCRIPT, launchCommand } from "../src/server/breakaway.ts";
import { startCommand } from "../src/startof.ts";

// VM pass 3 (Windows 11 ARM64, zh-TW): Windows PowerShell 5.1 started with -EncodedCommand and stderr redirected writes CLIXML (`#< CLIXML` + `<Objs …>`) to stderr even when it succeeds
// (progress records of the first module preparation), so a failure text read from stderr must never be that XML, and progress alone is not an error.

const NS = 'xmlns="http://schemas.microsoft.com/powershell/2004/04"';
/** What PowerShell 5.1 writes on a SUCCESSFUL run that prepared its modules: a progress record only. */
const PROGRESS = `#< CLIXML\r\n<Objs Version="1.1.0.1" ${NS}><Obj S="progress" RefId="0"><TN RefId="0"><T>System.Management.Automation.PSCustomObject</T><T>System.Object</T></TN><MS><I64 N="SourceId">1</I64><PR N="Record"><AV>Preparing modules for first use.</AV><AI>0</AI><Nil /><PI>-1</PI><PC>-1</PC><T>Completed</T><SR>-1</SR><SD> </SD></PR></MS></Obj></Objs>`;
/** An error record as 5.1 writes it: the message, then the position, the source lines, and the CategoryInfo and FullyQualifiedErrorId lines, one <S S="Error"> each. */
const ERROR = `#< CLIXML\r\n<Objs Version="1.1.0.1" ${NS}><S S="Error">Cannot create type. Only core types are supported in this language mode._x000D__x000A_</S><S S="Error">At line:3 char:8_x000D__x000A_</S><S S="Error">+ $si = ([wmiclass]'Win32_ProcessStartup').CreateInstance()_x000D__x000A_</S><S S="Error">+        ~~~~~~~~_x000D__x000A_</S><S S="Error">    + CategoryInfo          : NotImplemented: (:) [], PSNotSupportedException_x000D__x000A_</S><S S="Error">    + FullyQualifiedErrorId : CannotCreateTypeConstrainedLanguage_x000D__x000A_</S></Objs>`;
const BOTH = PROGRESS.replace("</Objs>", "") + ERROR.replace(/^#< CLIXML\r\n<Objs[^>]*>/, "");

test("every PowerShell call is started with -OutputFormat Text, and its script turns the progress stream off first", () => {
	assert.deepEqual(POWERSHELL_FLAGS, ["-NoProfile", "-NonInteractive", "-OutputFormat", "Text"]);
	assert.equal(PROGRESS_OFF, "$ProgressPreference = 'SilentlyContinue'");
	const env = { SystemRoot: "C:\\Windows" };
	const calls = [
		aclCommand("C:\\s", env).args,
		launchCommand({ command: "node", args: [], env: {}, cwd: "C:\\s", options: { detached: true, stdio: "ignore", windowsHide: true } }, env).args,
		startCommand(7, 1000, env).args,
	];
	for (const args of calls) {
		assert.deepEqual(args.slice(0, 4), POWERSHELL_FLAGS, args[4]);
		assert.ok(args[4] === "-EncodedCommand" || args[4] === "-Command");
	}
	for (const script of [ACL_SCRIPT, LAUNCH_SCRIPT]) assert.ok(script.split("\n").slice(0, 3).includes(PROGRESS_OFF), "within the first lines, before any step that can print progress");
	assert.match(calls[2]![5]!, /^\$ProgressPreference = 'SilentlyContinue'; \$ErrorActionPreference='Stop'; /);
});

test("CLIXML on stderr: progress alone is no error; an error record gives its strings, decoded (_x000D__x000A_ is a newline), and the message line is the first one", () => {
	assert.equal(plainStderr(PROGRESS).trim(), "", "progress records only: nothing to say");
	assert.equal(messageLine(PROGRESS), "");
	const decoded = plainStderr(ERROR);
	assert.ok(decoded.startsWith("Cannot create type. Only core types are supported in this language mode.\r\nAt line:3 char:8\r\n"), decoded);
	assert.ok(!/CLIXML|<S |_x000D_/.test(decoded));
	assert.equal(messageLine(ERROR), "Cannot create type. Only core types are supported in this language mode.");
	assert.equal(messageLine(BOTH), "Cannot create type. Only core types are supported in this language mode.", "progress and an error in one stream");
	assert.equal(plainStderr("plain text\r\nnot xml"), "plain text\r\nnot xml", "text that is not CLIXML is left as it is");
	assert.equal(plainStderr(undefined), "");
});

test("CLIXML strings are XML-unescaped, including entities and the _xHHHH_ escape of a literal underscore", () => {
	const text = `#< CLIXML\n<Objs ${NS}><S S="Error">a &lt;b&gt; &amp; &quot;c&quot; &apos;d&apos; &#65;&#x42; x_x005F_y_x000A_z</S></Objs>`;
	assert.equal(plainStderr(text), `a <b> & "c" 'd' AB x_y\nz`);
});

test("a failure is never told by CLIXML: the message line when there is an error record, else stdout, and always the exit code; ASCII only", () => {
	const err = Object.assign(new Error("Command failed: powershell.exe -EncodedCommand AAAA"), { code: 1 });
	assert.equal(execFailure(err, ERROR), "Cannot create type. Only core types are supported in this language mode., exit code 1");
	assert.equal(execFailure(err, PROGRESS, "sb-line\r\nPreparing something went wrong\r\n"), "Preparing something went wrong, exit code 1", "progress only: stdout's last line");
	assert.equal(execFailure(err, PROGRESS), "exit code 1", "progress only and no stdout: the exit code alone");
	assert.equal(execFailure(err, PROGRESS, ""), "exit code 1");
	for (const text of [execFailure(err, PROGRESS, "\u5b58\u53d6"), execFailure(err, ERROR.replace("Cannot create type", "\u5b58\u53d6"))]) {
		assert.ok(/^[\x20-\x7E]*$/.test(text), text);
		assert.ok(!/CLIXML|Objs/.test(text), text);
	}
	assert.equal(BEFORE_CREATE, "sb-before-create");
});
