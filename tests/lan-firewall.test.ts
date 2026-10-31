import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { execFileExe, searchPath } from "../src/exe.mjs";
import {
	allowCommand, comparable, disableCommand, entryCovers, macCoded, macNotes, windowsCoded, parseMacApp, parseMacBlockAll, parseMacState, parseWindows, psLiteral, readFirewall, SOCKETFILTERFW, windowsCommand, windowsNotes,
	windowsUnknown, WINDOWS_SCRIPT, type FirewallExec, type FirewallInput,
} from "../src/lan/firewall.ts";
import { asciiJson, CLM_WORD } from "../src/server/acl.ts";

// The firewall reads (docs/specs/2026-10-30-sb-gui-lan.md, "Firewalls", "Windows"; Steps L8). The parsers are fed recorded and synthetic outputs, the command runner is a stand-in, and the one real read (this Mac's
// socketfilterfw, read-only) runs only on macOS. Nothing here changes a firewall setting or runs anything elevated.

// --- macOS ---

test("macOS: the global state in the forms socketfilterfw prints", () => {
	assert.deepEqual(parseMacState("Firewall is disabled. (State = 0)\n"), { on: false, blockAll: false });
	assert.deepEqual(parseMacState("Firewall is enabled. (State = 1)\n"), { on: true, blockAll: false });
	assert.deepEqual(parseMacState("Firewall is enabled. (State = 2)\n"), { on: true, blockAll: true }, "older systems: state 2 is block all");
	assert.deepEqual(parseMacState("Firewall is enabled."), { on: true, blockAll: false }, "no state number");
	assert.deepEqual(parseMacState("Firewall is disabled."), { on: false, blockAll: false });
	assert.equal(parseMacState(""), undefined);
	assert.equal(parseMacState("socketfilterfw: usage"), undefined);
});

test("macOS: block all in the newer and the older wording", () => {
	assert.equal(parseMacBlockAll("Firewall has block all state set to enabled.\n"), true);
	assert.equal(parseMacBlockAll("Firewall has block all state set to disabled.\n"), false);
	assert.equal(parseMacBlockAll("Block all ENABLED!"), true);
	assert.equal(parseMacBlockAll("Block all DISABLED!"), false);
	assert.equal(parseMacBlockAll("something else"), undefined);
});

test("macOS: the program's state, read from the end of the line (a path may hold either word)", () => {
	assert.equal(parseMacApp("Incoming connection to /Users/me/.nvm/versions/node/v24.22.1/bin/node is permitted.\n"), "permitted");
	assert.equal(parseMacApp("Incoming connection to /usr/local/bin/node is blocked.\n"), "blocked");
	assert.equal(parseMacApp("Incoming connection to /usr/local/bin/node is blocked\n"), "blocked", "no final dot");
	assert.equal(parseMacApp("Incoming connections to /usr/local/bin/node is blocked.\n"), "blocked", "plural form");
	assert.equal(parseMacApp("Incoming connection to /opt/blocked/node is permitted.\n"), "permitted", "the word in the path is not the verdict");
	assert.equal(parseMacApp("Incoming connection to /opt/permitted/node is blocked.\n"), "blocked");
	assert.equal(parseMacApp("The application is not part of the firewall.\n"), "unlisted");
	assert.equal(parseMacApp("The path /x/blocked/node is not part of the firewall\n"), "unlisted");
	assert.equal(parseMacApp(""), undefined);
	assert.equal(parseMacApp("usage: socketfilterfw --getappblocked <app>"), undefined);
});

test("macOS: a note only when the firewall is on and blocks all or blocks node", () => {
	assert.deepEqual(macNotes({ on: false, blockAll: true, app: "blocked" }), [], "off: nothing blocks, whatever else is set");
	assert.deepEqual(macNotes({ on: true, blockAll: false, app: "permitted" }), []);
	assert.deepEqual(macNotes({ on: true, blockAll: false, app: "unlisted" }), [], "macOS asks the first time; no note");
	assert.deepEqual(macNotes({ on: true, blockAll: false, app: undefined }), []);
	assert.deepEqual(macNotes({ on: true, blockAll: false, app: "blocked" }), ["macOS firewall blocks node: allow it in System Settings, Network, Firewall, Options."]);
	const all = macNotes({ on: true, blockAll: true, app: "permitted" });
	assert.equal(all.length, 1);
	assert.match(all[0]!, /blocks all incoming connections.*System Settings, Network, Firewall, Options/);
	assert.equal(macNotes({ on: true, blockAll: true, app: "blocked" }).length, 2, "both fixes are told");
});

/** A runner that answers from a table by the flag and records every call. */
function macRunner(answers: Record<string, string | Error>) {
	const calls: { file: string; args: string[] }[] = [];
	const exec: FirewallExec = async (file, args) => {
		calls.push({ file, args });
		const answer = answers[args[0]!];
		if (answer === undefined) throw new Error(`unexpected ${args.join(" ")}`);
		if (answer instanceof Error) throw answer;
		return answer;
	};
	return { exec, calls };
}
const NODE = "/Users/me/.nvm/versions/node/v24.22.1/bin/node";
const PORT: FirewallInput = { port: 8445, served: [{ address: "192.168.1.5", iface: "en0" }] };

test("macOS: only the three read commands run, by the absolute path, the node binary as an argument and never through a shell or sudo", async () => {
	const r = macRunner({ "--getglobalstate": "Firewall is enabled. (State = 1)\n", "--getblockall": "Firewall has block all state set to disabled.\n", "--getappblocked": `Incoming connection to ${NODE} is blocked.\n` });
	const read = await readFirewall(PORT, { platform: "darwin", execPath: NODE, exec: r.exec });
	assert.deepEqual(read.notes, ["macOS firewall blocks node: allow it in System Settings, Network, Firewall, Options."]);
	assert.deepEqual(r.calls, [
		{ file: SOCKETFILTERFW, args: ["--getglobalstate"] },
		{ file: SOCKETFILTERFW, args: ["--getblockall"] },
		{ file: SOCKETFILTERFW, args: ["--getappblocked", NODE] },
	]);
	assert.equal(SOCKETFILTERFW, "/usr/libexec/ApplicationFirewall/socketfilterfw");
	for (const c of r.calls) assert.ok(c.args.every((a) => /^--get/.test(a) || a === NODE) && c.file !== "sudo", "read-only flags only");
});

test("macOS: the firewall off needs no other read; block all is read; a path with odd characters is one argument", async () => {
	const off = macRunner({ "--getglobalstate": "Firewall is disabled. (State = 0)\n" });
	assert.deepEqual((await readFirewall(PORT, { platform: "darwin", execPath: NODE, exec: off.exec })).notes, []);
	assert.equal(off.calls.length, 1);
	const odd = "/Users/me/my node; rm -rf x/node";
	const blockAll = macRunner({ "--getglobalstate": "Firewall is enabled. (State = 1)\n", "--getblockall": "Firewall has block all state set to enabled.\n", "--getappblocked": `Incoming connection to ${odd} is permitted.\n` });
	const read = await readFirewall(PORT, { platform: "darwin", execPath: odd, exec: blockAll.exec });
	assert.equal(read.notes.length, 1);
	assert.match(read.notes[0]!, /blocks all incoming connections/);
	assert.deepEqual(blockAll.calls[2]!.args, ["--getappblocked", odd]);
});

test("macOS: a read that fails or answers text nobody knows gives no note and says why in the summary", async () => {
	const failing = macRunner({ "--getglobalstate": Object.assign(new Error("Command failed"), { code: 1, stderr: "socketfilterfw: not permitted" }) });
	const a = await readFirewall(PORT, { platform: "darwin", execPath: NODE, exec: failing.exec });
	assert.deepEqual(a.notes, []);
	assert.match(a.summary, /could not be read.*not permitted/);
	const odd = macRunner({ "--getglobalstate": "who knows\n" });
	const b = await readFirewall(PORT, { platform: "darwin", execPath: NODE, exec: odd.exec });
	assert.deepEqual(b.notes, []);
	assert.match(b.summary, /unexpected text/);
	const half = macRunner({ "--getglobalstate": "Firewall is enabled. (State = 1)\n", "--getblockall": "Firewall has block all state set to disabled.\n", "--getappblocked": new Error("gone") });
	assert.match((await readFirewall(PORT, { platform: "darwin", execPath: NODE, exec: half.exec })).summary, /could not be read/);
});

test("Linux and other systems: no check, nothing is run", async () => {
	const r = macRunner({});
	for (const platform of ["linux", "freebsd"] as const) assert.deepEqual((await readFirewall(PORT, { platform, execPath: "/usr/bin/node", exec: r.exec })).notes, []);
	assert.equal(r.calls.length, 0);
});

test("macOS, for real: the read-only commands run on this Mac and give a result of the known shape", { skip: process.platform !== "darwin" || !existsSync(SOCKETFILTERFW) ? "needs macOS and its socketfilterfw" : false }, async () => {
	const read = await readFirewall(PORT);
	assert.match(read.summary, /^macOS firewall: (off|on, block all (on|off), node (blocked|permitted|unlisted|unknown))$/, read.summary);
	for (const note of read.notes) assert.match(note, /^macOS firewall blocks (node|all incoming connections)/);
	if (/: off$/.test(read.summary)) assert.deepEqual(read.notes, []);
});

// --- Windows ---

const NODE_WIN = "C:\\Program Files\\nodejs\\node.exe";
type Raw = Record<string, unknown>;
const rule = (name: string, o: Raw = {}): Raw => ({ name, display: "Node.js JavaScript Runtime", action: "Block", direction: "Inbound", enabled: "True", profile: "Any", program: "Any", expanded: "Any", service: "Any", package: "Any", protocol: "Any", localPort: ["Any"], ...o });
const nodeRule = (name: string, program = NODE_WIN, o: Raw = {}) => rule(name, { program, expanded: program, ...o });
const portAllow = (name = "Straw Boss Wi-Fi (TCP 8445)", o: Raw = {}) => rule(name, { action: "Allow", protocol: "TCP", localPort: ["8445"], profile: "Private", ...o });
const win = (rules: Raw[], over: Raw = {}) => JSON.stringify({ networks: [{ alias: "Wi-Fi", category: "Private" }], profiles: [{ name: "Domain", enabled: "True" }, { name: "Private", enabled: "True" }, { name: "Public", enabled: "True" }], rules, ...over });
const WIFI: FirewallInput = { port: 8445, served: [{ address: "192.168.1.5", iface: "Wi-Fi" }] };
const notesOf = (json: string, input: FirewallInput = WIFI, execPath = NODE_WIN) => windowsNotes(parseWindows(json), input, execPath);

test("Windows: a port rule that allows the port on the Private network, and nothing blocks: no note", () => {
	assert.deepEqual(notesOf(win([portAllow()])), []);
	assert.deepEqual(notesOf(win([nodeRule("node-allow", NODE_WIN, { action: "Allow", profile: "Private" })])), [], "a program rule for this node.exe allows too");
	assert.deepEqual(notesOf(win([portAllow("range", { localPort: ["8000-9000"] })])), [], "a port range that holds the port");
	assert.deepEqual(notesOf(win([portAllow("many", { localPort: ["80", "8445"] })])), []);
	assert.deepEqual(notesOf(win([portAllow("any", { protocol: "TCP", localPort: ["Any"], profile: "Any" })])), [], "any port on TCP");
	assert.deepEqual(notesOf(win([portAllow("scalar", { localPort: "8445" })])), [], "PowerShell writes a one-item array as the item");
});

test("Windows: no allow rule gives the New-NetFirewallRule command with the port", () => {
	for (const rules of [[], [portAllow("other", { localPort: ["8446"] })], [portAllow("udp", { protocol: "UDP" })], [portAllow("public", { profile: "Public" })], [portAllow("range", { localPort: ["9000-9100"] })], [nodeRule("other-node", "C:\\Other\\node.exe", { action: "Allow", profile: "Private" })]]) {
		const notes = notesOf(win(rules));
		assert.equal(notes.length, 1, JSON.stringify(rules));
		assert.match(notes[0]!, /No Windows Firewall rule allows incoming connections to TCP port 8445/);
		assert.ok(notes[0]!.includes(`\`${allowCommand(8445)}\``));
	}
	assert.equal(allowCommand(8445), 'New-NetFirewallRule -DisplayName "Straw Boss Wi-Fi (TCP 8445)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8445 -RemoteAddress LocalSubnet -Profile Private');
	assert.match(allowCommand(9000), /-LocalPort 9000 /);
});

test("Windows: a rule that is not enabled, not inbound, or neither allow nor block is not read", () => {
	assert.equal(notesOf(win([portAllow("off", { enabled: "False" })])).length, 1);
	assert.equal(notesOf(win([portAllow("out", { direction: "Outbound" })])).length, 1);
	assert.equal(notesOf(win([portAllow("odd", { action: "NotConfigured" })])).length, 1);
	assert.deepEqual(notesOf(win([portAllow(), nodeRule("off", NODE_WIN, { enabled: "False" }), nodeRule("out", NODE_WIN, { direction: "Outbound" })])), []);
});

test("Windows: a block rule for node.exe beside an allow rule: it wins, and the note names it with the disable command", () => {
	const notes = notesOf(win([portAllow(), nodeRule("TCP Query User{ABC}C:\\program files\\nodejs\\node.exe")]));
	assert.deepEqual(notes, ["Windows Firewall has rules that block node.exe (TCP Query User{ABC}C:\\program files\\nodejs\\node.exe); they win over any allow rule. In an elevated PowerShell: `Disable-NetFirewallRule -Name 'TCP Query User{ABC}C:\\program files\\nodejs\\node.exe'`."]);
	const two = notesOf(win([portAllow(), nodeRule("{B1}"), nodeRule("{B2}", NODE_WIN.toLowerCase(), { protocol: "TCP" })]));
	assert.equal(two.length, 1);
	assert.match(two[0]!, /\(\{B1\}, \{B2\}\)/);
	assert.match(two[0]!, /`Disable-NetFirewallRule -Name '\{B1\}','\{B2\}'`/);
});

test("Windows: the program is matched after expansion, full-path normalisation, and case folding (RVLAN2-F015)", () => {
	const blocked = (stored: string, expanded = stored, o: Raw = {}) => notesOf(win([portAllow(), nodeRule("{R}", stored, { expanded, ...o })])).length === 1;
	assert.ok(blocked("%ProgramFiles%\\nodejs\\node.exe", "C:\\Program Files\\nodejs\\node.exe"), "a stored environment variable, expanded by the read");
	assert.ok(blocked("C:\\PROGRAM FILES\\NODEJS\\NODE.EXE"), "other case");
	assert.ok(blocked("c:\\program files\\nodejs\\node.exe"));
	assert.ok(blocked("%PROGRAMFILES%\\NodeJS\\Node.EXE", "C:\\Program Files\\NodeJS\\Node.EXE"));
	assert.ok(blocked("C:/Program Files/nodejs/node.exe"), "forward slashes");
	assert.ok(blocked("C:\\Program Files\\nodejs\\..\\nodejs\\.\\node.exe"), "dots");
	assert.ok(blocked("C:\\Program Files\\\\nodejs\\node.exe"), "a doubled separator");
	assert.ok(blocked("\\\\?\\C:\\Program Files\\nodejs\\node.exe"), "the long-path prefix");
	assert.ok(blocked('"C:\\Program Files\\nodejs\\node.exe"'), "quoted");
	assert.ok(!blocked("%ProgramFiles%\\nodejs\\node.exe", "%ProgramFiles%\\nodejs\\node.exe"), "a variable that stayed unexpanded matches nothing");
	assert.ok(!blocked("C:\\Program Files (x86)\\nodejs\\node.exe"), "another folder");
	assert.ok(!blocked("node.exe"), "a bare name is no full path");
	assert.ok(!blocked("C:\\Program Files\\nodejs\\node.exe.bak"));
	assert.ok(!blocked("C:\\Program Files\\nodejs\\node.exe", "C:\\Program Files\\nodejs\\node.exe", { service: "Dnscache" }), "a rule for a service is not a program rule");
	assert.ok(!blocked("C:\\Program Files\\nodejs\\node.exe", "C:\\Program Files\\nodejs\\node.exe", { package: "S-1-15-2-1" }));
	assert.ok(!blocked("System", "System"));
	// The execPath is compared in the same form, with a short drive letter case and so on.
	assert.equal(notesOf(win([portAllow(), nodeRule("{R}", "C:\\Users\\Me\\nvm\\node.exe")]), WIFI, "c:/users/me/nvm/node.exe").length, 1);
	assert.equal(comparable("C:\\Program Files\\"), "c:\\program files");
	assert.equal(comparable("\\\\SERVER\\Share\\Node.exe"), "\\\\server\\share\\node.exe");
	assert.equal(comparable("relative\\node.exe"), "");
});

test("Windows: a block rule counts only when it fits TCP, the port, and a profile of a served network", () => {
	const fires = (o: Raw) => notesOf(win([portAllow(), nodeRule("{R}", NODE_WIN, o)])).length === 1;
	assert.ok(fires({}));
	assert.ok(fires({ protocol: "TCP" }));
	assert.ok(fires({ protocol: "6" }), "the protocol number");
	assert.ok(fires({ protocol: "TCP", localPort: ["8445"] }));
	assert.ok(fires({ profile: "Private" }));
	assert.ok(fires({ profile: "Domain, Private" }));
	assert.ok(fires({ profile: 2 }), "the enum number: Private");
	assert.ok(fires({ profile: 0 }), "the enum number: any");
	assert.ok(!fires({ protocol: "UDP" }), "the UDP rule the prompt makes beside the TCP one");
	assert.ok(!fires({ protocol: "17" }));
	assert.ok(!fires({ localPort: ["8446"] }));
	assert.ok(!fires({ profile: "Public" }), "a Public rule does not reach a Private network");
	assert.ok(!fires({ profile: "Domain" }));
	assert.ok(!fires({ profile: 4 }));
	assert.ok(!fires({ enabled: "False" }));
});

test("Windows: a block rule on the port without a program counts; one with another program or another port does not; an Any-everything block rule is left to the firewall", () => {
	const blocks = (r: Raw) => notesOf(win([portAllow(), r]));
	const byPort = blocks(rule("{P}", { protocol: "TCP", localPort: ["8000-8999"] }));
	assert.equal(byPort.length, 1);
	assert.match(byPort[0]!, /block TCP port 8445 \(\{P\}\)/);
	assert.equal(blocks(nodeRule("{O}", "C:\\Other\\node.exe")).length, 0);
	assert.equal(blocks(rule("{P2}", { protocol: "TCP", localPort: ["9000"] })).length, 0);
	assert.equal(blocks(rule("{ALL}")).length, 0, "program, protocol, and ports all Any: not a rule for this server");
});

test("Windows: the profile comes from the served address's network; Public gets its note, and a Private rule counts for it", () => {
	const publicNet = { networks: [{ alias: "Wi-Fi", category: "Public" }] };
	const notes = notesOf(win([portAllow()], publicNet));
	assert.equal(notes.length, 1);
	assert.match(notes[0]!, /Windows calls the network of 192\.168\.1\.5 \(Wi-Fi\) Public.*Settings, Network & internet, Wi-Fi, the network, Network profile type, Private\./);
	const none = notesOf(win([], publicNet));
	assert.equal(none.length, 2);
	assert.match(none[0]!, /^No Windows Firewall rule allows/);
	assert.match(none[1]!, /Public/, "the order: allow, then the Public network");
	assert.equal(notesOf(win([portAllow("p", { profile: "Public" })], publicNet)).length, 1, "a Public rule allows; the network note stays");
	const both = notesOf(win([portAllow(), nodeRule("{R}", NODE_WIN, { profile: "Public" })], publicNet));
	assert.equal(both.length, 2, "the block rule of the Public profile, then the Public network");
	assert.match(both[0]!, /block node\.exe/);
	// Domain-authenticated networks use the Domain profile.
	assert.equal(notesOf(win([portAllow()], { networks: [{ alias: "Wi-Fi", category: "DomainAuthenticated" }] })).length, 1, "the Private rule does not cover the Domain profile");
	assert.deepEqual(notesOf(win([portAllow("d", { profile: "Domain" })], { networks: [{ alias: "Wi-Fi", category: "DomainAuthenticated" }] })), []);
	// The interface's name is matched without regard to case.
	assert.deepEqual(notesOf(win([portAllow()]), { port: 8445, served: [{ address: "192.168.1.5", iface: "WI-FI" }] }), []);
});

test("Windows: a network whose category was not read is read strictly (every profile for blocks, any allow rule for the allow check)", () => {
	const unknown = { networks: [] };
	assert.equal(notesOf(win([portAllow(), nodeRule("{R}", NODE_WIN, { profile: "Public" })], unknown)).length, 1);
	assert.deepEqual(notesOf(win([portAllow("pub", { profile: "Public" })], unknown)), []);
	assert.equal(notesOf(win([], unknown)).length, 1);
	assert.deepEqual(notesOf(win([portAllow()], { networks: undefined })), [], "no networks field at all");
});

test("Windows: two networks are told apart; each address needs an allow rule for its own profile", () => {
	const input: FirewallInput = { port: 8445, served: [{ address: "192.168.1.5", iface: "Wi-Fi" }, { address: "10.0.0.5", iface: "Ethernet" }] };
	const networks = [{ alias: "Wi-Fi", category: "Private" }, { alias: "Ethernet", category: "DomainAuthenticated" }];
	assert.equal(notesOf(win([portAllow()], { networks }), input).length, 1, "Ethernet is on the Domain profile and has no rule");
	assert.deepEqual(notesOf(win([portAllow("any", { profile: "Any" })], { networks }), input), []);
	assert.deepEqual(notesOf(win([portAllow("two", { profile: "Domain, Private" })], { networks }), input), []);
});

test("Windows: a profile whose firewall is off has no rule that matters", () => {
	const off = { profiles: [{ name: "Private", enabled: "False" }, { name: "Public", enabled: "True" }, { name: "Domain", enabled: "True" }] };
	assert.deepEqual(notesOf(win([nodeRule("{R}")], off)), [], "no block, no allow, no Public note on a profile that is off");
	assert.deepEqual(notesOf(win([], { ...off, networks: [{ alias: "Wi-Fi", category: "Public" }], profiles: [{ name: "Public", enabled: "False" }] })), []);
	const unread = { profiles: [] };
	assert.equal(notesOf(win([], unread)).length, 1, "a firewall state that was not read counts as on");
});

test("Windows: the answer line is read as PowerShell writes it (other output before it, escaped non-ASCII, enum numbers, one-item values)", () => {
	const line = win([portAllow(), nodeRule("{B}", "%ProgramFiles%\\nodejs\\node.exe", { expanded: NODE_WIN })]).replace("Boss", "B\\u00f6ss");
	assert.ok(line.includes("B\\u00f6ss") && !/[^\x00-\x7F]/.test(line));
	const read = parseWindows(`WARNING: something\r\n\r\n${line}\r\n`);
	assert.equal(read.rules.length, 2);
	assert.equal(read.rules[0]!.name, "Straw B\u00f6ss Wi-Fi (TCP 8445)", "the escape is read back as the character");
	assert.equal(read.rules[0]!.ports.toString(), "8445,8445");
	const numeric = parseWindows(JSON.stringify({ networks: { alias: "Wi-Fi", category: 1 }, profiles: { name: "Private", enabled: 0 }, rules: [{ name: "{N}", action: 4, direction: 1, enabled: 1, profile: 2, program: NODE_WIN, expanded: NODE_WIN, protocol: 6, localPort: 8445 }] }));
	assert.deepEqual(numeric.networks, [{ alias: "Wi-Fi", category: "Private" }]);
	assert.equal(numeric.firewallOn.Private, false);
	assert.equal(numeric.rules[0]!.action, "block");
	assert.deepEqual(parseWindows(JSON.stringify({ rules: [] })), { networks: [], firewallOn: {}, rules: [] });
	assert.deepEqual(parseWindows(JSON.stringify({ rules: {} })).rules, []);
	for (const bad of ["", "not json", "[]", "null", JSON.stringify({ networks: [] }), JSON.stringify("x")]) assert.throws(() => parseWindows(bad), /PowerShell/, bad);
});

// --- the rule names, quoted (RVLAN3-F011) ---

/** What PowerShell's tokenizer reads from `-Name 'a','b'`: the literal strings (a quote character is any of ' ‘ ’ ‚ ‛; a doubled one inside stands for itself). */
function literals(command: string): string[] {
	const isQuote = (c: string | undefined) => c !== undefined && "'‘’‚‛".includes(c);
	const out: string[] = [];
	let i = command.indexOf(" -Name ") + 7;
	while (i < command.length) {
		assert.ok(isQuote(command[i]), `a literal starts at ${i}: ${command.slice(i)}`);
		let s = "";
		for (i++; ; i++) {
			assert.ok(i < command.length, "the literal is closed");
			const c = command[i]!;
			if (isQuote(c)) {
				if (!isQuote(command[i + 1])) break;
				i++;
				s += command[i];
			} else s += c;
		}
		out.push(s);
		i++;
		if (i < command.length) assert.equal(command[i++], ",", "literals are separated by commas only");
	}
	return out;
}
const TRICKY = ["TCP Query User{3F1A}C:\\users\\o'brien\\AppData\\node.exe", "it’s ‘curly’ ‚low‛ high", "$(calc.exe)", "a`b`n", "semi;colon & pipe | redirect > $env:USERNAME", 'dq"uote', "'", "''", "{GUID-WITH-BRACES}", "tab-free but long " + "x".repeat(300)];

test("rule names are single-quoted PowerShell literals: a quote of any kind is doubled, and $, a backtick, and a semicolon stay as they are", () => {
	assert.equal(psLiteral("o'brien"), "'o''brien'");
	assert.equal(psLiteral("it’s"), "'it’’s'");
	assert.equal(psLiteral("‘a‚b‛"), "'‘‘a‚‚b‛‛'");
	assert.equal(psLiteral("$(calc);`x"), "'$(calc);`x'");
	const { command, left } = disableCommand(TRICKY);
	assert.deepEqual(left, []);
	assert.ok(command!.startsWith("Disable-NetFirewallRule -Name '"));
	assert.deepEqual(literals(command!), TRICKY, "exactly those names come back as the literal strings");
	assert.equal(disableCommand([]).command, undefined);
});

test("a name with a control character or a wildcard is not put in the command; the note names it and says to use wf.msc", () => {
	const bad = ["new\nline", "tab\there", "esc\u001b[0m", "nul\u0000x", "c1\u0085", "sep\u2028x", "star*", "ques?", "C:\\tools\\[dev]\\node.exe", "close]", "evil\u202Eexe.dlr", "zw\u200Bsp", "bom\uFEFFx", "iso\u2066x\u2069"];
	const { command, left } = disableCommand(["good'one", ...bad, "{ok}"]);
	assert.deepEqual(left, bad);
	assert.deepEqual(literals(command!), ["good'one", "{ok}"]);
	const notes = notesOf(win([portAllow(), nodeRule("good'one"), nodeRule("new\nline"), nodeRule("tab\there")]));
	assert.equal(notes.length, 1);
	assert.ok(notes[0]!.includes("`Disable-NetFirewallRule -Name 'good''one'`"));
	assert.ok(notes[0]!.includes("new\\u000aline") && notes[0]!.includes("tab\\u0009here"), "named, with the character shown");
	assert.ok(!/[\u0000-\u001f]/.test(notes[0]!), "no control character reaches the note");
	const bidi = notesOf(win([portAllow(), nodeRule("evil\u202Eexe.dlr")]))[0]!;
	assert.ok(!/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/.test(bidi) && bidi.includes("evil\\u202eexe.dlr"), "a direction override is shown as an escape and is not in a command");
	assert.ok(!bidi.includes("Disable-NetFirewallRule"));
	assert.match(notes[0]!, /wf\.msc \(Inbound Rules, the rule, Disable Rule\)/);
	// When no name is left, only the wf.msc text is shown.
	const only = notesOf(win([portAllow(), nodeRule("new\nline")]));
	assert.equal(only.length, 1);
	assert.ok(!only[0]!.includes("Disable-NetFirewallRule") && !only[0]!.includes("elevated PowerShell"));
	assert.match(only[0]!, /new\\u000aline.*wf\.msc \(Inbound Rules, the rule, Disable Rule\)/);
});

// PowerShell's own parser: the command must be one command whose arguments are exactly the names as single-quoted literals. Windows PowerShell 5.1 on Windows; PowerShell 7 elsewhere when it is installed.
const pwsh = (() => {
	if (process.platform === "win32") return windowsCommand().file;
	try {
		return searchPath("pwsh");
	} catch {
		return undefined;
	}
})();
const PARSE = [
	"$errs = $null; $tokens = $null",
	"$ast = [System.Management.Automation.Language.Parser]::ParseInput($env:SB_CMD, [ref]$tokens, [ref]$errs)",
	"$cmds = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $true))",
	"$strs = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.StringConstantExpressionAst] -and $n.StringConstantType -eq 'SingleQuoted' }, $true) | ForEach-Object { $_.Value })",
	"$json = [ordered]@{ errors = $errs.Count; commands = $cmds.Count; name = $cmds[0].CommandElements[0].Value; strings = $strs } | ConvertTo-Json -Compress",
	asciiJson("$json"),
].join("\n");
function parsed(command: string): { errors: number; commands: number; name: string; strings: string | string[] } {
	const out = execFileSync(pwsh!, ["-NoProfile", "-NonInteractive", "-Command", PARSE], { encoding: "utf8", env: { ...process.env, SB_CMD: command }, windowsHide: true, timeout: 60_000 });
	return JSON.parse(out.trim().split(/\r?\n/).at(-1)!);
}
const noPowerShell = pwsh ? false : "no PowerShell on this machine (the Windows workflow runs it)";

test("PowerShell's parser reads the disable command as one command with exactly the names as literal strings", { skip: noPowerShell }, () => {
	const { command } = disableCommand(TRICKY);
	const result = parsed(command!);
	assert.equal(result.errors, 0);
	assert.equal(result.commands, 1);
	assert.equal(result.name, "Disable-NetFirewallRule");
	assert.deepEqual([result.strings].flat(), TRICKY);
	const one = parsed(disableCommand(["it’s ‘x’"]).command!);
	assert.deepEqual([one.strings].flat(), ["it’s ‘x’"]);
});

test("PowerShell's parser accepts the read script and the allow command", { skip: noPowerShell }, () => {
	const script = execFileSync(pwsh!, ["-NoProfile", "-NonInteractive", "-Command", "$e = $null; [void][System.Management.Automation.Language.Parser]::ParseInput($env:SB_CMD, [ref]$null, [ref]$e); $e.Count"], { encoding: "utf8", env: { ...process.env, SB_CMD: WINDOWS_SCRIPT }, windowsHide: true, timeout: 60_000 });
	assert.equal(script.trim(), "0", "the read script has no syntax error");
	const allow = parsed(allowCommand(8445));
	assert.equal(allow.errors, 0);
	assert.equal(allow.commands, 1);
	assert.equal(allow.name, "New-NetFirewallRule");
});

// --- the Windows read end to end, with a stand-in for PowerShell ---

const env = { SystemRoot: "C:\\Windows" };
function winRunner(answer: string | Error) {
	const calls: { file: string; args: string[]; options: Parameters<FirewallExec>[2] }[] = [];
	const exec: FirewallExec = async (file, args, options) => {
		calls.push({ file, args, options });
		if (answer instanceof Error) throw answer;
		return answer;
	};
	return { exec, calls };
}

test("Windows: one PowerShell start, by absolute path, from System32, encoded, with no port or path in the script", async () => {
	const r = winRunner(win([portAllow(), nodeRule("{B}")]));
	const read = await readFirewall(WIFI, { platform: "win32", execPath: NODE_WIN, exec: r.exec, env });
	assert.equal(read.notes.length, 1);
	assert.match(read.notes[0]!, /block node\.exe \(\{B\}\).*Disable-NetFirewallRule -Name '\{B\}'/);
	assert.equal(r.calls.length, 1);
	const call = r.calls[0]!;
	assert.equal(call.file, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
	assert.equal(call.options.cwd, "C:\\Windows\\System32");
	assert.equal(call.options.env.SB_FW_NODE, "node.exe", "the file name of node reaches the script by the environment");
	assert.deepEqual(call.args.slice(0, 4), ["-NoProfile", "-NonInteractive", "-OutputFormat", "Text"]);
	assert.equal(call.args[4], "-EncodedCommand");
	assert.equal(Buffer.from(call.args[5]!, "base64").toString("utf16le"), WINDOWS_SCRIPT);
	assert.ok(!/[^\x00-\x7F]/.test(WINDOWS_SCRIPT), "ASCII only");
	assert.ok(!WINDOWS_SCRIPT.includes("8445") && !WINDOWS_SCRIPT.includes("nodejs"), "nothing of the port or the path is quoted into the script");
	assert.ok(!/Get-NetFirewallApplicationFilter\s+-Program|\bSet-|\bNew-|\bRemove-|\bEnable-|\bDisable-|Start-Process|RunAs/.test(WINDOWS_SCRIPT), "read-only, no elevation, and no per-path filter (RVLAN2-F015)");
	assert.match(WINDOWS_SCRIPT, /ExpandEnvironmentVariables/);
});

test("Windows: a read that fails says the state is unknown and gives both commands", async () => {
	for (const failure of [Object.assign(new Error("Command failed: powershell"), { code: 1, stderr: "Get-NetFirewallRule : Access is denied" }), Object.assign(new Error("timed out"), { code: null, killed: true, signal: "SIGTERM" })]) {
		const read = await readFirewall(WIFI, { platform: "win32", execPath: NODE_WIN, exec: winRunner(failure).exec, env });
		assert.equal(read.notes.length, 1);
		assert.match(read.notes[0]!, /^Windows Firewall could not be read \(/);
		assert.ok(read.notes[0]!.includes(allowCommand(8445)) && read.notes[0]!.includes("Disable-NetFirewallRule -Name '<InstanceID>'") && read.notes[0]!.includes("Get-NetFirewallRule -Direction Inbound -Action Block"));
		assert.match(read.summary, /could not be read/);
	}
	const clm = await readFirewall(WIFI, { platform: "win32", execPath: NODE_WIN, exec: winRunner(Object.assign(new Error("x"), { code: 1, stderr: `${CLM_WORD}\n` })).exec, env });
	assert.match(clm.notes[0]!, /Constrained Language Mode/);
	const junk = await readFirewall(WIFI, { platform: "win32", execPath: NODE_WIN, exec: winRunner("not json at all").exec, env });
	assert.match(junk.notes[0]!, /could not be read \(PowerShell answered not json at all\)/);
	assert.equal(windowsUnknown(8445, "x").includes("(x)"), true);
});

test("Windows: a port that is not one is refused before anything runs", async () => {
	const r = winRunner(win([]));
	for (const port of [0, 70000, 1.5, Number.NaN]) await assert.rejects(readFirewall({ port, served: [] }, { platform: "win32", execPath: NODE_WIN, exec: r.exec, env }), /not a port/);
	assert.equal(r.calls.length, 0);
});

// --- RVL8 fixes ---

test("Windows: node started through a link matches a rule that holds the link's target (and the other way round)", () => {
	const target = "C:\\Users\\me\\AppData\\Roaming\\nvm\\v24.22.1\\node.exe", link = "C:\\Program Files\\nodejs\\node.exe";
	const json = win([portAllow(), nodeRule("{nvm}", target)]);
	assert.deepEqual(windowsNotes(parseWindows(json), WIFI, link), [], "no real path given: the rule is not seen (the old reading)");
	const notes = windowsNotes(parseWindows(json), WIFI, link, target.toUpperCase().replace(/\//g, "/"));
	assert.equal(notes.length, 1);
	assert.match(notes[0]!, /block node\.exe \(\{nvm\}\)/);
	assert.equal(windowsNotes(parseWindows(win([portAllow(), nodeRule("{link}", link)])), WIFI, link, target).length, 1, "the link itself still matches");
});
test("Windows: readFirewall resolves the node path (injected) and a path that cannot be resolved is compared as it is", async () => {
	const target = "C:\\nvm\\v1\\node.exe", answer = win([portAllow(), nodeRule("{t}", target)]);
	const seen = await readFirewall(WIFI, { platform: "win32", execPath: NODE_WIN, exec: winRunner(answer).exec, env, realpath: () => target });
	assert.match(seen.notes[0]!, /block node\.exe \(\{t\}\)/);
	const broken = await readFirewall(WIFI, { platform: "win32", execPath: NODE_WIN, exec: winRunner(answer).exec, env, realpath: () => { throw new Error("ENOENT"); } });
	assert.deepEqual(broken.notes, []);
});

test("a read killed by its timeout says it timed out, with a real slow child", { skip: process.platform === "win32" ? "needs /bin/sleep" : false }, async () => {
	const slow: FirewallExec = (file, args, options) =>
		new Promise((resolve, reject) => {
			execFileExe("/bin/sleep", ["30"], { timeout: 200, env: options.env }, (error, stdout, stderr) => (error ? reject(Object.assign(error, { stdout, stderr })) : resolve(stdout)));
		});
	const mac = await readFirewall(PORT, { platform: "darwin", execPath: "/x/node", exec: slow, env: process.env });
	assert.match(mac.summary, /could not be read \(timed out after 10 s\)/);
	const w = await readFirewall(WIFI, { platform: "win32", execPath: NODE_WIN, exec: slow, env });
	assert.match(w.notes[0]!, /could not be read \(timed out after 60 s\)/);
	assert.ok(!/\(it failed\)/.test(w.notes[0]!));
});

test("address and interface filters: a block rule scoped away from the served address is ignored, an allow rule counts only where it covers it", () => {
	const scope = (o: Raw) => ({ remote: ["Any"], local: ["Any"], ifType: ["Any"], ...o });
	const blocks = (o: Raw) => notesOf(win([portAllow(), nodeRule("{b}", NODE_WIN, scope(o))])).length;
	assert.equal(blocks({}), 1, "unscoped: counts");
	assert.equal(blocks({ remote: ["8.8.8.8"] }), 0, "remote elsewhere: ignored");
	assert.equal(blocks({ remote: ["10.0.0.0/8"] }), 0);
	assert.equal(blocks({ remote: ["192.168.0.0/16"] }), 1);
	assert.equal(blocks({ remote: ["LocalSubnet"] }), 1);
	assert.equal(blocks({ remote: ["10.0.0.1", "192.168.1.1-192.168.1.9"] }), 1, "a range that holds it");
	assert.equal(blocks({ local: ["10.1.1.1"] }), 0, "local address elsewhere: ignored");
	assert.equal(blocks({ ifType: ["Wired"] }), 1, "type of the adapter unknown: read strictly, counts");
	const typed = (o: Raw, type: string) => notesOf(win([portAllow(), nodeRule("{b}", NODE_WIN, scope(o))], { networks: [{ alias: "Wi-Fi", category: "Private", type }] })).length;
	assert.equal(typed({ ifType: ["Wired"] }, "71"), 0, "a wired-only block does not reach Wi-Fi");
	assert.equal(typed({ ifType: ["Wireless", "RemoteAccess"] }, "71"), 1);
	assert.equal(typed({ ifType: ["Wired"] }, "6"), 1);
	const allowed = (o: Raw, over: Raw = {}) => notesOf(win([portAllow("a", scope(o))], over)).length;
	assert.equal(allowed({}), 0);
	assert.equal(allowed({ remote: ["10.0.0.0/8"] }), 1, "an allow limited to 10/8 does not allow 192.168.1.5");
	assert.equal(allowed({ remote: ["LocalSubnet"] }), 0);
	assert.equal(allowed({ remote: ["192.168.1.0/255.255.255.0"] }), 0, "mask form");
	assert.equal(allowed({ ifType: ["Wired"] }, { networks: [{ alias: "Wi-Fi", category: "Private", type: "71" }] }), 1, "an allow for Wired does not allow Wi-Fi");
	assert.equal(allowed({ ifType: ["Wireless"] }, { networks: [{ alias: "Wi-Fi", category: "Private", type: "71" }] }), 0);
	assert.equal(allowed({ ifType: ["Wired"] }), 1, "unknown type: an allow does not count");
	assert.match(WINDOWS_SCRIPT, /Get-NetFirewallAddressFilter/);
	assert.match(WINDOWS_SCRIPT, /Get-NetFirewallInterfaceTypeFilter/);
});

// --- The recheck of the Windows VM (build 26300, a filtered token; ~/.local/share/sbd-review/lan/vm.md): F1, F2, and the empty words ---

test("VM F1: the port, address, and interface-type filters are read through the enabled inbound rules (the bare call is refused for a filtered token), and only then", () => {
	for (const kind of ["Port", "Address", "InterfaceType"]) {
		const calls = WINDOWS_SCRIPT.match(new RegExp(`.{0,12}Get-NetFirewall${kind}Filter`, "g")) ?? [];
		assert.equal(calls.length, 1, kind);
		assert.match(calls[0]!, /\$fr \| Get-/, `${kind} is piped the rules`);
	}
	assert.match(WINDOWS_SCRIPT, /\$fr = @\(Get-NetFirewallRule -Direction Inbound -Enabled True \| Where-Object \{/, "the rules are asked for once, enabled and inbound, and cut down before any is piped");
	assert.match(WINDOWS_SCRIPT, /\$_\.Owner -or \$_\.PackageFamilyName/, "a packaged app's rules are not piped");
	assert.match(WINDOWS_SCRIPT, /\$leaves -contains/, "nor are rules for another program");
	assert.match(WINDOWS_SCRIPT, /foreach \(\$r in \$fr\)/, "and the same rules are walked");
	assert.equal((WINDOWS_SCRIPT.match(/\$fr\.Count -gt 0/g) ?? []).length, 3, "no rule: no pipeline (the bare call would be the refusal)");
	assert.match(WINDOWS_SCRIPT, /owner = \[string\]\$r\.Owner/);
	assert.match(WINDOWS_SCRIPT, /family = \[string\]\$r\.PackageFamilyName/);
});

/** The shape of the VM's read: a stock Windows 11 with a packaged app's `…-In-Allow-ServerCapability` rules (Program Any, TCP, ports Any, Service and Package empty, tied by Owner and PackageFamilyName) and the two block rules the prompt made. */
const SID = "S-1-5-21-1441927103-2923024089-3870737035-1001";
const capability = (app: string, o: Raw = {}) => rule(`${app}_8wekyb3d8bbweS-1-5-18-In-Allow-ServerCapability`, { action: "Allow", profile: "Domain, Private, Public", protocol: "Any", localPort: [""], service: "", package: "", family: `${app}_8wekyb3d8bbwe`, owner: "", ...o });
const STOCK = ["Microsoft.AAD.BrokerPlugin", "Microsoft.LockApp", "Microsoft.Win32WebViewHost", "Microsoft.Windows.CloudExperienceHost", "Microsoft.Windows.ShellExperienceHost"].map((a) => capability(a));
const promptBlocks = (): Raw[] => ["TCP", "UDP"].map((p) => rule(`${p} Query User{3D0A1F2E-6A5B-4D0E-9F61-0C2A8E7B1D44}C:\\users\\\u6e2c\u8a66pm\\appdata\\local\\straw-boss-desk\\node\\node.exe`, { display: "node.exe", profile: "Public", program: "c:\\users\\x\\node.exe", expanded: "c:\\users\\x\\node.exe", protocol: p, localPort: [""], service: "", package: "", owner: "", family: "" }));
const VM_WIFI: FirewallInput = { port: 8445, served: [{ address: "192.168.64.2", iface: "Ethernet" }] };
const VM_NODE = "C:\\Users\\x\\node.exe";
const vmNotes = (rules: Raw[], category = "Public") => windowsCoded(parseWindows(win(rules, { networks: [{ alias: "Ethernet", category }] })), VM_WIFI, VM_NODE).map((n) => n.code);

test("VM F1: the file names of node go to the script by the environment, not into its text", () => {
	const none = windowsCommand({ SystemRoot: "C:\\Windows" }), some = windowsCommand({ SystemRoot: "C:\\Windows" }, ["C:\\Users\\Me\\nvm\\v22\\Node.exe", "C:/Program Files/nodejs/node.exe", "D:\\tools\\node-real.exe"]);
	assert.equal(none.options.env.SB_FW_NODE, "");
	assert.equal(some.options.env.SB_FW_NODE, "node.exe|node-real.exe", "file names, lower case, once each");
	assert.equal(some.options.env.SystemRoot, "C:\\Windows");
	assert.deepEqual(some.args, none.args, "the script is the same");
});

test("VM F2: a packaged app's rule (Owner or PackageFamilyName, Program Any, ports Any) is no allow rule for node; a plain Any rule still is", () => {
	assert.deepEqual(vmNotes(STOCK, "Private"), ["fw_win_noallow"], "22 of them on a stock machine hid the note");
	assert.deepEqual(vmNotes([...STOCK, capability("X", { family: "", owner: SID })], "Private"), ["fw_win_noallow"], "an Owner alone ties a rule to a user, not to every program");
	assert.deepEqual(vmNotes([...STOCK, portAllow("mine")], "Private"), [], "the note's own allow rule");
	assert.deepEqual(vmNotes([...STOCK, capability("Y", { family: "", owner: "" })], "Private"), [], "no Owner and no family: a plain allow-any rule");
	assert.deepEqual(vmNotes([capability("Z", { family: "", owner: "", service: "", package: "" })], "Private"), [], "empty Service and Package read as Any");
	assert.deepEqual(vmNotes([...STOCK, { ...portAllow("svc"), service: "Dnscache" }], "Private"), ["fw_win_noallow"], "a service rule is still no program rule");
});

test("VM F2: a packaged app's block rule does not count either; the prompt's own block rules do, and the Public network is told", () => {
	const blockCapability = capability("Microsoft.Block", { action: "Block" });
	assert.deepEqual(vmNotes([...STOCK, blockCapability, portAllow("mine")], "Private"), [], "an app's block rule with every filter Any is not about node");
	assert.deepEqual(vmNotes([...STOCK, blockCapability, rule("app-port", { protocol: "TCP", localPort: ["8445"], family: "Microsoft.X_8wekyb3d8bbwe" }), portAllow("mine")], "Private"), [], "nor is one that names the port, when it is tied to a package");
	assert.deepEqual(vmNotes([...STOCK, ...promptBlocks()]), ["fw_win_block", "fw_win_noallow", "fw_win_public"], "before the allow rule: the blocks, no allow rule, Public");
	assert.deepEqual(vmNotes([...STOCK, ...promptBlocks(), portAllow("mine")]), ["fw_win_block", "fw_win_public"], "after it: no-allow is gone");
	const blocks = windowsCoded(parseWindows(win([...STOCK, ...promptBlocks()], { networks: [{ alias: "Ethernet", category: "Public" }] })), VM_WIFI, VM_NODE).find((n) => n.code === "fw_win_block")!;
	assert.match(String(blocks.params?.names), /^TCP Query User\{3D0A1F2E-/, "the TCP rule only: the UDP one is not about TCP");
});

test("VM: Profile, Service, Package, ports, and protocol that print empty are Any", () => {
	const empty = parseWindows(win([{ name: "r", display: "d", action: "Allow", direction: "Inbound", enabled: "True", profile: "", program: "", expanded: "", service: "", package: "", owner: "", family: "", protocol: "", localPort: [""], remote: [""], local: [""], ifType: [""] }])).rules[0]!;
	assert.deepEqual([empty.program, empty.tcp, empty.ports, empty.remote, empty.local, empty.ifTypes, [...empty.profiles].length], ["any", true, "any", [], [], [], 3]);
});

test("entryCovers: addresses, prefixes, masks, ranges, keywords, and IPv6", () => {
	const yes = [["10.0.0.0/8", "10.9.9.9"], ["10.0.0.5", "10.0.0.5"], ["10.0.0.1-10.0.0.9", "10.0.0.5"], ["10.0.0.0/255.0.0.0", "10.1.2.3"], ["LocalSubnet", "10.0.0.5"], ["fe80::/10", "fe80::1%en0"], ["2001:db8::1-2001:db8::9", "2001:db8::5"]];
	const no = [["10.0.0.0/8", "11.0.0.1"], ["10.0.0.6", "10.0.0.5"], ["Internet", "10.0.0.5"], ["10.0.0.0/33", "10.0.0.5"], ["fe80::/10", "10.0.0.5"], ["junk", "10.0.0.5"], ["10.0.0.0/8", "not an address"]];
	for (const [e, a] of yes) assert.equal(entryCovers(e!, a!), true, `${e} ${a}`);
	for (const [e, a] of no) assert.equal(entryCovers(e!, a!), false, `${e} ${a}`);
});

test("the notes carry a code and the params the page words them with, and the English text is the one the TUI shows", () => {
	assert.deepEqual(macCoded({ on: true, blockAll: true, app: "blocked" }).map((n) => n.code), ["fw_block_all", "fw_block_node"]);
	assert.deepEqual(macCoded({ on: true, blockAll: true, app: "blocked" }).map((n) => n.text), macNotes({ on: true, blockAll: true, app: "blocked" }));
	const none = windowsCoded(parseWindows(win([])), WIFI, NODE_WIN);
	assert.deepEqual(none.map((n) => n.code), ["fw_win_noallow"]);
	assert.deepEqual(none[0]!.params, { port: WIFI.port, command: allowCommand(WIFI.port) });
	assert.deepEqual(none.map((n) => n.text), notesOf(win([])));
	const blocked = windowsCoded(parseWindows(win([rule("{b}", { program: NODE_WIN, expanded: NODE_WIN })])), WIFI, NODE_WIN)[0]!;
	assert.equal(blocked.code, "fw_win_block");
	assert.equal(blocked.params?.what, "node.exe");
	const pub = windowsCoded(parseWindows(win([portAllow()], { networks: [{ alias: "Wi-Fi", category: "Public" }] })), WIFI, NODE_WIN);
	assert.ok(pub.some((n) => n.code === "fw_win_public" && String(n.params?.where).includes("Wi-Fi")));
});
