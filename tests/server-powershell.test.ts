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
const ERROR = `#< CLIXML\r\n<Objs Version="1.1.0.1" ${NS}><S S="Error">Cannot index into a null array._x000D__x000A_</S><S S="Error">At line:3 char:8_x000D__x000A_</S><S S="Error">+ $si = ([wmiclass]'Win32_ProcessStartup').CreateInstance()_x000D__x000A_</S><S S="Error">+        ~~~~~~~~_x000D__x000A_</S><S S="Error">    + CategoryInfo          : NotImplemented: (:) [], PSNotSupportedException_x000D__x000A_</S><S S="Error">    + FullyQualifiedErrorId : CannotCreateTypeConstrainedLanguage_x000D__x000A_</S></Objs>`;
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
	assert.ok(decoded.startsWith("Cannot index into a null array.\r\nAt line:3 char:8\r\n"), decoded);
	assert.ok(!/CLIXML|<S |_x000D_/.test(decoded));
	assert.equal(messageLine(ERROR), "Cannot index into a null array.");
	assert.equal(messageLine(BOTH), "Cannot index into a null array.", "progress and an error in one stream");
	assert.equal(plainStderr("plain text\r\nnot xml"), "plain text\r\nnot xml", "text that is not CLIXML is left as it is");
	assert.equal(plainStderr(undefined), "");
});

test("CLIXML strings are XML-unescaped, including entities and the _xHHHH_ escape of a literal underscore", () => {
	const text = `#< CLIXML\n<Objs ${NS}><S S="Error">a &lt;b&gt; &amp; &quot;c&quot; &apos;d&apos; &#65;&#x42; x_x005F_y_x000A_z</S></Objs>`;
	assert.equal(plainStderr(text), `a <b> & "c" 'd' AB x_y\nz`);
});

test("a failure is never told by CLIXML: the message line when there is an error record, else stdout, and always the exit code; ASCII only", () => {
	const err = Object.assign(new Error("Command failed: powershell.exe -EncodedCommand AAAA"), { code: 1 });
	assert.equal(execFailure(err, ERROR), "Cannot index into a null array., exit code 1");
	assert.equal(execFailure(err, PROGRESS, "sb-line\r\nPreparing something went wrong\r\n"), "Preparing something went wrong, exit code 1", "progress only: stdout's last line");
	assert.equal(execFailure(err, PROGRESS), "exit code 1", "progress only and no stdout: the exit code alone");
	assert.equal(execFailure(err, PROGRESS, ""), "exit code 1");
	for (const text of [execFailure(err, PROGRESS, "\u5b58\u53d6"), execFailure(err, ERROR.replace("Cannot create type", "\u5b58\u53d6"))]) {
		assert.ok(/^[\x20-\x7E]*$/.test(text), text);
		assert.ok(!/CLIXML|Objs/.test(text), text);
	}
	assert.equal(BEFORE_CREATE, "sb-before-create");
});

// --- VM pass 4, F2: a cold start makes one PowerShell start, the launch script's: nobody else asks for the starter's or the server's start time ---

import { createStartOf } from "../src/startof.ts";
import { launch } from "../src/server/client.ts";
import { runsAs } from "../src/server/client.ts";
import { parseLaunchOutput } from "../src/server/breakaway.ts";
import { fileOf, takeLock } from "../src/server/record.ts";
import { ServerWorld, sleep, until } from "./server-world.ts";
import { readFileSync } from "node:fs";

const T = "2026-10-26T08:00:00.000Z";

test("F2: startedOrWait takes a start time that is remembered meanwhile without a PowerShell start of its own, and asks for it only when nothing tells it within the grace", async () => {
	let launched = 0;
	const { startedOrWait, remember } = createStartOf({ platform: "win32", launch: (_f, _a, _o, done) => (launched++, queueMicrotask(() => done(null, `${T}\r\n`))) });
	const told = startedOrWait(77, 60_000);
	remember(77, T);
	assert.equal(await told, T);
	assert.equal(launched, 0, "no PowerShell start: the launch PowerShell told it");
	assert.equal(await startedOrWait(77, 60_000), T, "known now: at once");
	assert.equal(launched, 0);
	// Nothing tells it: after the grace it is asked for, once.
	const slow = startedOrWait(78, 20);
	assert.equal(launched, 0, "not at once");
	assert.equal(await slow, T);
	assert.equal(launched, 1);
});

test("F2: off Windows startedOrWait is `ps` at once, as before", async () => {
	const { startedOrWait } = createStartOf({ platform: "linux", ps: () => "Mon Oct 26 08:00:00 2026" });
	assert.equal(await startedOrWait(5, 60_000), "Mon Oct 26 08:00:00 2026");
});

test("F2: the launch script reads the starter's start time in its one PowerShell start (SB_STARTER_PID, after the marker), the answer carries it, and the server never sees the variable", () => {
	const lines = LAUNCH_SCRIPT.split("\n");
	const marker = lines.findIndex((l) => /Move\(\$env:SB_ACL_MARKER/.test(l)), starter = lines.findIndex((l) => /\$env:SB_STARTER_PID/.test(l) && /Get-CimInstance Win32_Process/.test(l));
	assert.ok(marker > 0 && starter > marker, "after the marker, so the server is not kept waiting for it");
	assert.match(LAUNCH_SCRIPT, /\$k -ne 'SB_STARTER_PID'/);
	assert.match(LAUNCH_SCRIPT, /starterStarted = \$starterStarted/);
	assert.equal(LAUNCH_SCRIPT.match(/powershell/gi)?.length ?? 0, 0);
	const { options } = launchCommand({ command: "node", args: [], env: {}, cwd: "C:\\s", options: { detached: true, stdio: "ignore", windowsHide: true }, starterPid: 4242 }, { SystemRoot: "C:\\Windows" });
	assert.equal(options.env.SB_STARTER_PID, "4242");
	assert.ok(!("SB_STARTER_PID" in launchCommand({ command: "node", args: [], env: {}, cwd: "C:\\s", options: { detached: true, stdio: "ignore", windowsHide: true } }, {}).options.env));
	assert.equal(parseLaunchOutput(`{"rc":0,"pid":9,"starterStarted":"${T}"}`).starterStarted, T);
	assert.equal(parseLaunchOutput('{"rc":0,"pid":9,"starterStarted":"later"}').starterStarted, undefined);
});

test("F2: runsAs does not ask for the record's start time while a start through the launch PowerShell is under way (its pid is not told yet)", () => {
	const asked: number[] = [];
	const ctx = { alive: () => true, startOf: (pid: number) => (asked.push(pid), "some other time") };
	assert.equal(runsAs(ctx, { pid: 5, started: T }), false, "asked: another start time");
	assert.deepEqual(asked, [5]);
	assert.equal(runsAs(ctx, { pid: 5, started: T }, true), true, "not asked");
	assert.deepEqual(asked, [5]);
	assert.equal(runsAs({ alive: () => false, startOf: ctx.startOf }, { pid: 5, started: T }, true), false, "a pid that is gone is gone");
});

test("F2: launch asks nobody for the server's start time, with a pid told late (WMI) or known at once", async () => {
	for (const late of [true, false]) {
		const w = new ServerWorld();
		try {
			const asked: number[] = [];
			const ctx = w.ctx({
				startOf: (pid) => (asked.push(pid), T),
				spawn: (spec) => {
					const running = w.start({ env: spec.env, started: async () => T });
					const exited = running.then((r) => r.handle.done);
					return late
						? { pid: undefined, exited, started: running.then(async (r) => (await sleep(250), { pid: r.pid, ms: 250, via: "wmi" as const })) }
						: { pid: 4242, exited };
				},
			});
			const record = await launch(ctx, {});
			assert.ok(record.pid > 0);
			// The hello that answers with the secret and the pid is the proof of the server (VM pass 5, F13): no start time is asked for in either case.
			assert.deepEqual(asked, [], late ? "not asked while the pid was unknown" : "not asked for a pid known at once either");
		} finally {
			await w.close();
		}
	}
});

test("F2: the starter's own start time, told by the launch answer, completes the lock without a PowerShell start of its own", async () => {
	let launched = 0;
	const own = createStartOf({ platform: "win32", launch: (_f, _a, _o, done) => (launched++, queueMicrotask(() => done(null, `${T}\r\n`))) });
	const w = new ServerWorld();
	try {
		const lock = await takeLock(w.slot, "cli up", { ...w.ctx().lock, self: { pid: process.pid, started: () => own.startedOrWait(process.pid, 60_000) } }, 0);
		assert.equal(JSON.parse(readFileSync(fileOf(w.slot, "lock"), "utf8")).started, undefined, "taken without it");
		own.remember(process.pid, T);
		await until(() => JSON.parse(readFileSync(fileOf(w.slot, "lock"), "utf8")).started === T, "the lock is written again with it");
		assert.equal(launched, 0);
		lock.release();
	} finally {
		await w.close();
	}
});

// --- VM pass 5, F12: Constrained Language Mode is told in one clear sentence, not as `?`s ---

import { CLM_CHECK, CLM_TEXT, CLM_WORD } from "../src/server/acl.ts";

test("F12: both scripts check the language mode first (before any .NET call) and throw a fixed ASCII word", () => {
	for (const script of [ACL_SCRIPT, LAUNCH_SCRIPT]) {
		const lines = script.split("\n");
		const check = lines.indexOf(CLM_CHECK), net = lines.findIndex((l) => /\[(?:regex|Text\.|System\.|wmiclass|Diagnostics)/.test(l) && !l.startsWith("try { [Console]"));
		assert.ok(check > 0 && check < net, `${check} before ${net}`);
		assert.ok(lines.indexOf(PROGRESS_OFF) < check);
	}
	assert.equal(CLM_CHECK, "if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { throw 'sb-constrained-language' }");
	assert.ok(/^[\x20-\x7E]+$/.test(CLM_WORD + CLM_TEXT));
});

test("F12: the word, and the engine's English refusals, become the Constrained Language Mode sentence with the exit code, whatever else the localized text says", () => {
	const err = Object.assign(new Error("Command failed: x"), { code: 1 });
	const expected = `${CLM_TEXT}, exit code 1`;
	assert.match(expected, /^PowerShell runs in Constrained Language Mode \(likely a policy\); pi-straw-boss needs FullLanguage for its permission check, exit code 1$/);
	assert.equal(execFailure(err, `${CLM_WORD}\r\nAt line:1 char:1\r\n`), expected);
	assert.equal(execFailure(err, "Cannot create type. Only core types are supported in this language mode.\r\nAt line:3"), expected);
	assert.equal(execFailure(err, "Cannot invoke method. Method invocation is supported only on core types in this language mode."), expected);
	assert.equal(execFailure(err, `#< CLIXML\r\n<Objs xmlns="http://schemas.microsoft.com/powershell/2004/04"><S S="Error">${CLM_WORD}_x000D__x000A_</S></Objs>`), expected);
	assert.equal(execFailure(err, "?L?k?N?O MatchEvaluator?C"), "?L?k?N?O MatchEvaluator?C, exit code 1", "an unrelated failure keeps its own words");
});
