import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
	CA_FILE, CA_WARN_DAYS, caDer, caStatus, caValidity, createCa, crt, fingerprints, issueLeafFor, leafNeedsRenewal, leafWindow, localName, mobileconfig, productionConstraints, readCa, timeMachineExclude, writeCa,
	type LanCa,
} from "../src/lan/ca.ts";

// The CA's policy and its storage (docs/specs/2026-10-30-sb-gui-lan.md, "The LAN CA", "Getting the phone to trust the CA", and Tests). The store cases are the spec's: missing, corrupt, foreign-owned, link, mode too open.
// Every file is made in a folder of this test process's temp root; tmutil is only ever run on a file there.

const root = mkdtempSync(join(tmpdir(), "lan-ca-"));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const folder = () => {
	const dir = join(root, `s${n++}`);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	return dir;
};
const posix = process.platform !== "win32";
const openssl = spawnSync("openssl", ["version"]).status === 0;
const HOUR = 3_600_000, DAY = 24 * HOUR;
const now = Date.UTC(2026, 9, 30, 12, 0, 0);
const ca = createCa("weis-mbp", now);

test("the name is read per platform, lowercased, and must be a DNS label; a failed read is told apart from a bad name", () => {
	const mac = (out: string | Error) => localName({ platform: "darwin", run: (program, args) => { assert.equal(program, "/usr/sbin/scutil", "by absolute path: a server's PATH may lack /usr/sbin"); assert.deepEqual(args, ["--get", "LocalHostName"]); if (out instanceof Error) throw out; return out; } });
	assert.deepEqual(mac("Weis-MBP\n"), { name: "weis-mbp" });
	assert.ok("unreadable" in mac(new Error("ENOENT")), "a program that cannot run is a hiccup, not a bad name");
	assert.ok("unreadable" in mac(Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" })));
	assert.ok("invalid" in mac(""));
	for (const bad of ["with space", "under_score", "-lead", "trail-", "a.b", "weis-mbp.local", "é", "x".repeat(64)]) assert.ok("invalid" in mac(bad), bad);
	assert.deepEqual(mac("x".repeat(63)), { name: "x".repeat(63) });
	assert.deepEqual(mac("a"), { name: "a" });
	assert.deepEqual(localName({ platform: "win32", hostname: () => "DESKTOP-4F2K" }), { name: "desktop-4f2k" });
	assert.ok("invalid" in localName({ platform: "linux", hostname: () => "box.example.com" }), "a dotted hostname is no mDNS label");
	assert.ok("unreadable" in localName({ platform: "linux", hostname: () => { throw new Error("no"); } }));
});

test("a CA is two years from one hour before creation, with the spec's subject and constraints", () => {
	assert.equal(ca.v, 1);
	assert.equal(ca.name, "weis-mbp");
	assert.equal(ca.created, "2026-10-30T12:00:00.000Z");
	assert.deepEqual(caValidity(ca), { notBefore: now - HOUR, notAfter: now - HOUR + 730 * DAY });
	const cert = new X509Certificate(ca.cert);
	assert.equal(cert.subject, "CN=Straw Boss LAN CA · weis-mbp\nO=pi-straw-boss");
	assert.ok(cert.ca);
	assert.deepEqual(productionConstraints("weis-mbp"), { dns: ["weis-mbp.local"], email: ["invalid"], uri: ["invalid"], ip: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"], excludedIp: ["::/0"] });
	assert.deepEqual(productionConstraints(undefined).dns, ["invalid"], "no name: the DNS name form is constrained to nothing, never left out");
	const bare = createCa(undefined, now);
	assert.equal(bare.name, null);
	assert.equal(new X509Certificate(bare.cert).subject, "CN=Straw Boss LAN CA\nO=pi-straw-boss");
	assert.throws(() => createCa("Not A Label", now), /not a usable name/);
	assert.notEqual(createCa("weis-mbp", now).key, ca.key, "a new key every time");
});

test("CA status: ok, ending in the last 60 days, ended", () => {
	const end = caValidity(ca).notAfter;
	assert.deepEqual(caStatus(ca, now), { state: "ok", daysLeft: 729 });
	assert.equal(caStatus(ca, end - (CA_WARN_DAYS + 1) * DAY).state, "ok");
	assert.deepEqual(caStatus(ca, end - CA_WARN_DAYS * DAY), { state: "ending", daysLeft: 60 });
	assert.deepEqual(caStatus(ca, end - 1), { state: "ending", daysLeft: 0 });
	assert.deepEqual(caStatus(ca, end), { state: "ended", daysLeft: 0 });
	assert.equal(caStatus(ca, end + DAY).state, "ended");
});

test("a leaf for a named CA: CN=<name>.local, SAN the name and its own address, 90 days from one hour before", () => {
	const leaf = issueLeafFor(ca, "192.168.1.5", now), cert = new X509Certificate(leaf.certPem);
	assert.equal(cert.subject, "CN=weis-mbp.local");
	assert.equal(cert.subjectAltName, "DNS:weis-mbp.local, IP Address:192.168.1.5");
	assert.deepEqual([leaf.notBefore, leaf.notAfter], [now - HOUR, now - HOUR + 90 * DAY]);
	assert.equal(Date.parse(cert.validTo), leaf.notAfter);
	assert.ok(cert.checkIssued(new X509Certificate(ca.cert)) && cert.verify(new X509Certificate(ca.cert).publicKey));
	assert.deepEqual([leaf.address, leaf.dns], ["192.168.1.5", ["weis-mbp.local"]]);
	assert.notEqual(issueLeafFor(ca, "192.168.1.5", now).keyPem, leaf.keyPem);
});

test("a leaf for a CA with no name: SAN only the address, and a subject that is no hostname", () => {
	const bare = createCa(undefined, now), cert = new X509Certificate(issueLeafFor(bare, "10.1.2.3", now).certPem);
	assert.equal(cert.subjectAltName, "IP Address:10.1.2.3");
	// Not `CN=10.1.2.3`: OpenSSL 3.x reads a dotted CN as a DNS name when there is no DNS SAN and checks it against the CA's permitted `invalid`.
	assert.equal(cert.subject, "CN=Straw Boss LAN (10.1.2.3)");
	assert.deepEqual(issueLeafFor(bare, "10.1.2.3", now).dns, []);
});

test("a leaf never ends after the CA and is not issued once the CA has ended", () => {
	const end = caValidity(ca).notAfter, late = end - 10 * DAY, leaf = issueLeafFor(ca, "192.168.1.5", late);
	assert.equal(leaf.notAfter, end, "clamped to the CA's end");
	assert.equal(leaf.notBefore, late - HOUR);
	// One hour before the CA began: the leaf does not begin before its issuer.
	assert.equal(leafWindow(ca, caValidity(ca).notBefore)?.notBefore, caValidity(ca).notBefore);
	assert.equal(leafWindow(ca, end), undefined);
	assert.throws(() => issueLeafFor(ca, "192.168.1.5", end), /has ended/);
	assert.throws(() => issueLeafFor(ca, "192.168.1.5", end + DAY), /has ended/);
});

test("a leaf is renewed under 30 days left only when the new one would end later", () => {
	const end = caValidity(ca).notAfter, leafEnd = (at: number) => issueLeafFor(ca, "192.168.1.5", at).notAfter;
	const issued = now, ends = leafEnd(issued);
	assert.equal(leafNeedsRenewal(ca, ends, issued), false, "fresh");
	assert.equal(leafNeedsRenewal(ca, ends, ends - 31 * DAY), false, "31 days left");
	assert.equal(leafNeedsRenewal(ca, ends, ends - 29 * DAY), true, "29 days left");
	assert.equal(leafNeedsRenewal(ca, ends, ends - 1), true);
	// In the CA's last 30 days every new leaf ends with the CA: issued once, then not again.
	const last = end - 20 * DAY, lastLeaf = leafEnd(last);
	assert.equal(lastLeaf, end);
	assert.equal(leafNeedsRenewal(ca, lastLeaf, last + HOUR), false);
	assert.equal(leafNeedsRenewal(ca, lastLeaf, end - DAY), false, "a renewal would end no later");
	// Once the CA has ended there is nothing to renew with.
	assert.equal(leafNeedsRenewal(ca, lastLeaf, end), false);
});

test("the fingerprint lines: the SHA-256's first 16 bytes as spaced uppercase pairs, the full SHA-1 in groups of eight", { skip: openssl ? false : "openssl is not on PATH" }, () => {
	const ssl = (algorithm: string) => /=(.*)\n/.exec(execFileSync("openssl", ["x509", "-noout", "-fingerprint", `-${algorithm}`], { input: ca.cert }).toString())![1]!.split(":");
	const f = fingerprints(ca);
	assert.match(f.sha256, /^([0-9A-F]{2} ){15}[0-9A-F]{2}$/);
	assert.equal(f.sha256, ssl("sha256").slice(0, 16).join(" "), "OpenSSL's SHA-256, first 16 bytes");
	assert.equal(f.sha1Hex, ssl("sha1").join(""));
	assert.equal(f.sha1, ssl("sha1").join("").match(/.{8}/g)!.join(" "));
	assert.match(f.sha1, /^([0-9A-F]{8} ){4}[0-9A-F]{8}$/);
});

test("the .crt is exactly one certificate, in DER", () => {
	const file = crt(ca), cert = new X509Certificate(file);
	assert.ok(cert.raw.equals(file), "nothing before or after the certificate");
	assert.ok(file.equals(caDer(ca)));
	assert.equal(cert.fingerprint256.replace(/:/g, "").slice(0, 32), fingerprints(ca).sha256.replace(/ /g, ""), "Node's own SHA-256 of the same bytes");
	if (openssl) assert.equal(spawnSync("openssl", ["x509", "-inform", "DER", "-noout", "-subject"], { input: file }).status, 0);
});

test("the .mobileconfig holds exactly one payload, com.apple.security.root with the CA's DER, and nothing else", () => {
	const profile = mobileconfig(ca);
	assert.equal([...profile.matchAll(/<key>PayloadType<\/key>\s*<string>([^<]*)<\/string>/g)].map((m) => m[1]).join(), "com.apple.security.root,Configuration");
	assert.equal([...profile.matchAll(/<data>/g)].length, 1, "one certificate");
	assert.equal([...profile.matchAll(/<array>/g)].length, 1);
	assert.equal([...profile.matchAll(/<key>PayloadContent<\/key>/g)].length, 2, "the outer content list and the one certificate's data");
	const data = /<data>([^<]*)<\/data>/.exec(profile)![1]!, der = Buffer.from(data, "base64");
	assert.ok(der.equals(caDer(ca)) && new X509Certificate(der).raw.equals(der));
	assert.doesNotMatch(profile, /dnsSettings|vpn|wifi|PayloadURL|PayloadCertificateUUID/i);
	assert.match(profile, /<key>PayloadDisplayName<\/key>\s*<string>Straw Boss LAN · weis-mbp<\/string>/);
	assert.match(profile, /<string>local\.straw-boss\.lan\.weis-mbp<\/string>/);
	assert.match(profile, /<string>local\.straw-boss\.lan\.weis-mbp\.ca<\/string>/);
	assert.match(profile, /<key>PayloadRemovalDisallowed<\/key>\s*<false\/>/);
	assert.equal(mobileconfig(ca), profile, "the same CA always gives the same profile");
	if (process.platform === "darwin") assert.equal(spawnSync("plutil", ["-lint", "-"], { input: profile }).status, 0, "a property list macOS parses");
});

test("a new CA's profile has fixed identifiers and new UUIDs, so it replaces the old one; the name-less profile names no computer", () => {
	const other = createCa("weis-mbp", now), uuids = (p: string) => [...p.matchAll(/<key>PayloadUUID<\/key>\s*<string>([^<]*)<\/string>/g)].map((m) => m[1]!);
	for (const id of uuids(mobileconfig(ca))) assert.match(id, /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/);
	assert.equal(new Set([...uuids(mobileconfig(ca)), ...uuids(mobileconfig(other))]).size, 4, "two UUIDs per profile, all different");
	const identifiers = (p: string) => [...p.matchAll(/<key>PayloadIdentifier<\/key>\s*<string>([^<]*)<\/string>/g)].map((m) => m[1]!).sort();
	assert.deepEqual(identifiers(mobileconfig(ca)), identifiers(mobileconfig(other)));
	const bare = mobileconfig(createCa(undefined, now));
	assert.deepEqual(identifiers(bare), ["local.straw-boss.lan", "local.straw-boss.lan.ca"]);
	assert.match(bare, /<string>Straw Boss LAN<\/string>/);
});

test("a stored CA reads back: written mode 600 through a new temporary file, none left behind", () => {
	const dir = folder();
	assert.deepEqual(readCa(dir), { lost: "missing" });
	writeCa(dir, ca, { exclude: () => {} });
	assert.deepEqual(readCa(dir), { ca });
	assert.deepEqual(readdirSync(dir), [CA_FILE]);
	if (posix) assert.equal(statSync(join(dir, CA_FILE)).mode & 0o777, 0o600);
	assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(dir, CA_FILE), "utf8"))), ["v", "name", "key", "cert", "created"]);
	const bare = createCa(undefined, now);
	writeCa(dir, bare, { exclude: () => {} });
	assert.deepEqual(readCa(dir), { ca: bare }, "a rewrite replaces the file, and a CA with no name is stored with name null");
	assert.deepEqual(readdirSync(dir), [CA_FILE]);
});

test("the exclusion hook runs on the temporary file after it exists and before a byte of the key is written, at every write", () => {
	const dir = folder(), seen: { path: string; size: number; mode: number; exists: boolean; final: boolean }[] = [];
	const exclude = (path: string) => {
		const info = statSync(path);
		seen.push({ path, size: info.size, mode: info.mode & 0o777, exists: true, final: existsSync(join(dir, CA_FILE)) });
	};
	writeCa(dir, ca, { exclude });
	const renewed = createCa("weis-mbp", now + DAY);
	writeCa(dir, renewed, { exclude });
	assert.equal(seen.length, 2, "create and renew each exclude");
	assert.notEqual(seen[0]!.path, seen[1]!.path, "every write is a new file");
	for (const s of seen) {
		assert.match(s.path, /lan-ca\.json\..*\.tmp$/);
		assert.equal(s.size, 0, "empty when excluded: no key bytes yet");
		if (posix) assert.equal(s.mode, 0o600);
	}
	assert.equal(seen[0]!.final, false);
	assert.equal(seen[1]!.final, true, "the old file is still the one in place while the new one is excluded");
	assert.deepEqual(readCa(dir), { ca: renewed });
	assert.ok(!readFileSync(join(dir, CA_FILE), "utf8").includes(ca.key.slice(40, 90)));
});

test("a failing exclusion is logged with its code and the file is still written; nothing else is swallowed", () => {
	const dir = folder(), logs: [string, Record<string, unknown>][] = [];
	writeCa(dir, ca, { exclude: () => { throw Object.assign(new Error("tmutil"), { status: 71 }); }, log: (event, fields) => logs.push([event, fields]) });
	assert.deepEqual(logs, [["lan-ca-exclude", { code: 71 }]]);
	assert.deepEqual(readCa(dir), { ca });
	writeCa(dir, ca, { exclude: () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); }, log: (event, fields) => logs.push([event, fields]) });
	assert.deepEqual(logs[1], ["lan-ca-exclude", { code: "ENOENT" }]);
	// The key is the thing being written: a rename that fails leaves neither a temporary file nor a replaced store.
	const blocked = folder();
	mkdirSync(join(blocked, CA_FILE));
	assert.throws(() => writeCa(blocked, ca, { exclude: () => {} }));
	assert.deepEqual(readdirSync(blocked), [CA_FILE], "no .tmp left");
});

test("the corrupt cases: a store that is present but not what this code wrote leaves Wi-Fi access off", () => {
	const put = (text: string, mode = 0o600) => {
		const dir = folder();
		writeFileSync(join(dir, CA_FILE), text, { mode });
		if (posix) chmodSync(join(dir, CA_FILE), mode);
		return dir;
	};
	const good = JSON.parse(JSON.stringify(ca)) as Record<string, unknown>;
	const with_ = (change: Record<string, unknown>) => JSON.stringify({ ...good, ...change });
	assert.deepEqual(readCa(put(JSON.stringify(good))), { ca }, "the control: the same bytes are fine");
	const cases: [string, string][] = [
		["bad JSON", "{not json"], ["empty file", ""], ["an array", "[]"], ["null", "null"],
		["version 2", with_({ v: 2 })], ["a missing name key", JSON.stringify({ v: 1, key: good.key, cert: good.cert, created: good.created })],
		["an extra key", with_({ extra: 1 })], ["a name that is no label", with_({ name: "Not A Label" })], ["a non-string created", with_({ created: 5 })], ["created not a date", with_({ created: "yesterday" })],
		["a key that is no key", with_({ key: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n" })],
		["a certificate that is no certificate", with_({ cert: "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n" })],
		["a key that is not the certificate's", with_({ key: createCa("weis-mbp", now).key })],
		["two certificates", with_({ cert: `${ca.cert}${createCa("weis-mbp", now).cert}` })],
		["a leaf in place of a CA", with_({ cert: issueLeafFor(ca, "192.168.1.5", now).certPem })],
	];
	for (const [label, text] of cases) assert.deepEqual(readCa(put(text)), { lost: "corrupt" }, label);
	// Present but not a file at all.
	const asDir = folder();
	mkdirSync(join(asDir, CA_FILE));
	assert.deepEqual(readCa(asDir), { lost: "corrupt" }, "a folder where the file belongs");
});

test("a link is corrupt, a dangling link too, and nothing is read through it", { skip: posix ? false : "symbolic links need privileges on Windows" }, () => {
	const dir = folder(), elsewhere = folder();
	writeCa(elsewhere, ca, { exclude: () => {} });
	symlinkSync(join(elsewhere, CA_FILE), join(dir, CA_FILE));
	assert.ok(lstatSync(join(dir, CA_FILE)).isSymbolicLink());
	assert.deepEqual(readCa(dir), { lost: "corrupt" });
	const dangling = folder();
	symlinkSync(join(elsewhere, "nothing"), join(dangling, CA_FILE));
	assert.deepEqual(readCa(dangling), { lost: "corrupt" }, "something is there, so it is not a clean 'missing'");
});

test("a file another account owns is corrupt", { skip: posix ? false : "no uid on Windows" }, () => {
	const dir = folder();
	writeCa(dir, ca, { exclude: () => {} });
	assert.deepEqual(readCa(dir, { uid: process.getuid!() }), { ca });
	assert.deepEqual(readCa(dir, { uid: process.getuid!() + 1 }), { lost: "corrupt" }, "owned by a uid that is not this account's");
	assert.deepEqual(readCa(dir, { uid: 0 }), { lost: "corrupt" }, "even when this account is not root and root is asked");
});

test("a file with any group or other permission bit is corrupt (a backup restored it as 644)", { skip: posix ? false : "the mode check does not apply on Windows" }, () => {
	for (const mode of [0o644, 0o640, 0o604, 0o660, 0o606, 0o666, 0o700 | 0o001]) {
		const dir = folder();
		writeCa(dir, ca, { exclude: () => {} });
		chmodSync(join(dir, CA_FILE), mode);
		assert.deepEqual(readCa(dir), { lost: "corrupt" }, mode.toString(8));
	}
	const ok = folder();
	writeCa(ok, ca, { exclude: () => {} });
	for (const mode of [0o600, 0o400]) {
		chmodSync(join(ok, CA_FILE), mode);
		assert.deepEqual(readCa(ok), { ca }, mode.toString(8));
	}
	// On Windows the ACL stands in for the mode.
	chmodSync(join(ok, CA_FILE), 0o644);
	assert.deepEqual(readCa(ok, { platform: "win32" }), { ca });
});

test("the exclusion keeps the CA out of Time Machine: on macOS tmutil says so after a create and after a renew", { skip: process.platform === "darwin" ? false : "Time Machine is macOS only" }, (t) => {
	const dir = folder(), file = join(dir, CA_FILE), excluded = () => /\[Excluded\]/.test(spawnSync("/usr/bin/tmutil", ["isexcluded", file], { encoding: "utf8" }).stdout);
	// A file of this test's own folder: the one place tmutil is run here. Where tmutil cannot mark even a probe file (a sandbox), the test says so and stops.
	const probe = join(dir, "probe.tmp");
	writeFileSync(probe, "");
	try {
		timeMachineExclude(probe, "darwin");
	} catch (error) {
		return t.skip(`tmutil addexclusion does not work here: ${(error as Error).message.split("\n")[0]}`);
	}
	rmSync(probe);
	writeCa(dir, ca);
	assert.ok(excluded(), "excluded after the create");
	assert.deepEqual(readCa(dir), { ca });
	writeCa(dir, createCa("weis-mbp", now + DAY));
	assert.ok(excluded(), "excluded after the renew: the new file got it too");
	assert.deepEqual(readdirSync(dir), [CA_FILE]);
});

test("timeMachineExclude does nothing off macOS and fails loudly on macOS when tmutil cannot mark the file", () => {
	assert.doesNotThrow(() => timeMachineExclude(join(root, "never-made"), "linux"));
	assert.doesNotThrow(() => timeMachineExclude(join(root, "never-made"), "win32"));
	if (process.platform === "darwin") assert.throws(() => timeMachineExclude(join(root, "no", "such", "file"), "darwin"));
});

test("the name in the file must be the certificate's own: the leaves are named from it, and the CA only signs that name", () => {
	for (const edited of [{ ...ca, name: "other-mac" }, { ...ca, name: null }, { ...createCa(undefined, now), name: "weis-mbp" }] as LanCa[]) {
		const dir = folder();
		writeFileSync(join(dir, CA_FILE), JSON.stringify(edited), { mode: 0o600 });
		assert.deepEqual(readCa(dir), { lost: "corrupt" }, String(edited.name));
	}
});
