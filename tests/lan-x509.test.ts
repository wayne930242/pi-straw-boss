import assert from "node:assert/strict";
import { createHash, createPublicKey, X509Certificate } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import tls from "node:tls";
import { productionConstraints } from "../src/lan/ca.ts";
import { cidrBytes, ipBytes, issueCa, issueLeaf, type Constraints, type Issued } from "../src/lan/x509.ts";

// The certificate writer (docs/specs/2026-10-30-sb-gui-lan.md, "Building certificates" and Tests): what Node can read is read with Node, and what it cannot (key usage bits, criticality, pathlen, name constraints, key ids, the DER
// itself) is read by OpenSSL, a decoder that is not the writer. Keys stay in memory; the only files are public certificates in a folder of this process's temp root.

const openssl = spawnSync("openssl", ["version"]).status === 0;
// A skip says why in the test output; in CI (the Windows job has no openssl) a missing decoder fails instead, so the check cannot vanish without anyone seeing it.
const skip = openssl ? false : process.env.CI ? undefined : "openssl is not on PATH (these tests read the certificates with OpenSSL; they run where it is installed)";
if (!openssl && process.env.CI && process.platform !== "win32") test("openssl is on PATH in CI", () => assert.fail("openssl is not on PATH, so every OpenSSL check was skipped"));
const text = (pem: string) => execFileSync("openssl", ["x509", "-noout", "-text"], { input: pem }).toString();
const dir = mkdtempSync(join(tmpdir(), "lan-x509-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const HOUR = 3_600_000, DAY = 24 * HOUR;
const now = Date.now();
const span = (days: number, from = now - HOUR) => ({ notBefore: from, notAfter: from + days * DAY });
const production = productionConstraints("weis-mbp");
const makeCa = (constraints: Constraints = production, validity = span(730)) => issueCa({ subject: { cn: "Straw Boss LAN CA · weis-mbp", org: "pi-straw-boss" }, validity, constraints });
const leafOf = (ca: Issued, o: { cn?: string; dns?: string[]; ip?: string[]; email?: string[]; uri?: string[]; eku?: "serverAuth" | "emailProtection" | "codeSigning"; validity?: { notBefore: number; notAfter: number } } = {}) =>
	issueLeaf({ issuer: { certPem: ca.pem, keyPem: ca.keyPem }, cn: o.cn ?? "weis-mbp.local", dns: o.dns ?? ["weis-mbp.local"], ip: o.ip ?? ["192.168.1.5"], email: o.email, uri: o.uri, eku: o.eku, validity: o.validity ?? span(90) });

let files = 0;
/** `openssl verify` of a leaf against the CA as the only trust anchor; the CA goes in a `.crt` file (a public certificate). Returns whether it verified and what OpenSSL said. */
function verify(ca: Issued, leaves: Issued[], extra: string[] = ["-x509_strict"]) {
	const caFile = join(dir, `ca-${files++}.crt`), names = leaves.map((leaf) => {
		const file = join(dir, `leaf-${files++}.crt`);
		writeFileSync(file, leaf.pem);
		return file;
	});
	writeFileSync(caFile, ca.pem);
	const run = spawnSync("openssl", ["verify", ...extra, "-CAfile", caFile, ...names], { encoding: "utf8" });
	return { ok: run.status === 0, said: run.stdout + run.stderr };
}

/** A TLS handshake on the loopback with `leaf` served and `ca` trusted; `identity` is the name the client checks the certificate for (none: only the chain, including its name constraints, is judged). */
async function handshake(leaf: Issued, ca: Issued, identity?: string): Promise<{ ok: true } | { ok: false; error: Error }> {
	const server = tls.createServer({ key: leaf.keyPem, cert: leaf.pem }, (socket) => socket.end());
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		return await new Promise((resolve) => {
			const socket = tls.connect({
				host: "127.0.0.1", port: (server.address() as { port: number }).port, ca: ca.pem, minVersion: "TLSv1.2",
				checkServerIdentity: (_, cert) => (identity === undefined ? undefined : tls.checkServerIdentity(identity, cert)),
			}, () => (socket.destroy(), resolve({ ok: true })));
			socket.once("error", (error) => resolve({ ok: false, error }));
		});
	} finally {
		server.close();
	}
}

test("a CA and a leaf: what Node can read about them", () => {
	const ca = makeCa(), leaf = leafOf(ca), c = new X509Certificate(ca.pem), l = new X509Certificate(leaf.pem);
	assert.equal(c.ca, true);
	assert.equal(l.ca, false);
	assert.equal(c.subject, "CN=Straw Boss LAN CA · weis-mbp\nO=pi-straw-boss");
	assert.equal(c.issuer, c.subject, "self-signed");
	assert.equal(l.issuer, c.subject);
	assert.equal(l.subject, "CN=weis-mbp.local");
	assert.equal(l.subjectAltName, "DNS:weis-mbp.local, IP Address:192.168.1.5", "the SAN holds the name and that address, nothing else");
	assert.deepEqual(l.keyUsage, ["1.3.6.1.5.5.7.3.1"], "serverAuth is the extended key usage");
	assert.ok(l.checkHost("weis-mbp.local") && l.checkIP("192.168.1.5"));
	assert.ok(!l.checkIP("192.168.1.6") && l.checkHost("other.local") === undefined);
	assert.ok(l.verify(c.publicKey) && l.checkIssued(c) && c.verify(c.publicKey));
	assert.ok(!c.verify(l.publicKey), "a leaf's key is no CA's key");
	assert.equal(c.publicKey.asymmetricKeyDetails?.namedCurve, "prime256v1");
	assert.equal(l.publicKey.asymmetricKeyDetails?.namedCurve, "prime256v1");
	assert.equal(c.validFromDate.getTime(), Math.floor((now - HOUR) / 1000) * 1000);
	assert.equal(Date.parse(c.validTo) - Date.parse(c.validFrom), 730 * DAY);
	assert.equal(Date.parse(l.validTo) - Date.parse(l.validFrom), 90 * DAY);
	assert.notEqual(leaf.keyPem, leafOf(ca).keyPem, "a new key with every leaf");
});

test("the serial is positive, 16 bytes, with a first byte in 0x01-0x7F, and never carries a redundant 0x00", () => {
	for (let i = 0; i < 300; i++) {
		const serial = new X509Certificate(i % 2 ? makeCa().pem : leafOf(makeCa()).pem).serialNumber;
		assert.equal(serial.length, 32, `a 16-byte serial, no leading 00: ${serial}`);
		const first = parseInt(serial.slice(0, 2), 16);
		assert.ok(first >= 1 && first <= 0x7f, serial);
	}
});

test("OpenSSL reads the CA's extensions: critical CA:TRUE pathlen 0, key usage, name constraints with the excluded ::/0, key id", { skip }, () => {
	const t = text(makeCa().pem);
	assert.match(t, /X509v3 Basic Constraints: critical\s+CA:TRUE, pathlen:0/);
	assert.match(t, /X509v3 Key Usage: critical\s+Certificate Sign, CRL Sign\n/);
	assert.match(t, /X509v3 Extended Key Usage:\s+TLS Web Server Authentication/);
	assert.match(t, /X509v3 Name Constraints: critical\s+Permitted:\s+DNS:weis-mbp\.local\s+email:invalid\s+URI:invalid\s+IP:10\.0\.0\.0\/255\.0\.0\.0\s+IP:172\.16\.0\.0\/255\.240\.0\.0\s+IP:192\.168\.0\.0\/255\.255\.0\.0\s+Excluded:\s+IP:0:0:0:0:0:0:0:0\/0:0:0:0:0:0:0:0/);
	assert.match(t, /X509v3 Subject Key Identifier:\s+[0-9A-F:]{59}\n/);
	assert.match(t, /Signature Algorithm: ecdsa-with-SHA256/);
	assert.doesNotMatch(t, /Authority Key Identifier/);
});

test("OpenSSL reads the leaf's extensions: critical CA:FALSE, digitalSignature, serverAuth, the SAN, and the key ids that link it to the CA", { skip }, () => {
	const ca = makeCa(), t = text(leafOf(ca).pem), caText = text(ca.pem);
	assert.match(t, /X509v3 Basic Constraints: critical\s+CA:FALSE/);
	assert.match(t, /X509v3 Key Usage: critical\s+Digital Signature\n/);
	assert.match(t, /X509v3 Extended Key Usage:\s+TLS Web Server Authentication/);
	assert.match(t, /X509v3 Subject Alternative Name:\s+DNS:weis-mbp\.local, IP Address:192\.168\.1\.5\n/);
	assert.doesNotMatch(t, /Name Constraints/);
	const ski = /Subject Key Identifier:\s+([0-9A-F:]+)/.exec(caText)![1], aki = /Authority Key Identifier:\s+([0-9A-F:]+)/.exec(t)![1];
	assert.equal(aki, ski, "the leaf's authority key id is the CA's subject key id");
	// The key id is the SHA-1 of the key bits (RFC 5280, method 1), read here from the SPKI by Node and not by the writer.
	const spki = createPublicKey(ca.pem).export({ type: "spki", format: "der" }), bitsAt = spki.length - 65;
	assert.equal(ski, createHash("sha1").update(spki.subarray(bitsAt)).digest("hex").toUpperCase().match(/../g)!.join(":"));
});

test("a leaf for a CA with no name: SAN only IP:<address>, a CN that is no hostname", { skip }, () => {
	const ca = makeCa(productionConstraints(undefined)), leaf = leafOf(ca, { cn: "Straw Boss LAN (192.168.1.5)", dns: [] });
	const t = text(leaf.pem);
	assert.match(t, /Subject: CN=Straw Boss LAN \(192\.168\.1\.5\)\n/);
	assert.match(t, /X509v3 Subject Alternative Name:\s+IP Address:192\.168\.1\.5\n/);
	assert.doesNotMatch(t, /DNS:/);
	assert.match(text(ca.pem), /Permitted:\s+DNS:invalid\s+email:invalid\s+URI:invalid\s+IP:10\.0\.0\.0/);
	assert.ok(verify(ca, [leaf]).ok, verify(ca, [leaf]).said);
});

test("times are UTCTime before 2050 and GeneralizedTime from then on", { skip }, () => {
	const der = (cert: Issued) => execFileSync("openssl", ["asn1parse", "-inform", "DER"], { input: cert.der }).toString();
	const before = der(makeCa(production, { notBefore: Date.UTC(2049, 0, 1), notAfter: Date.UTC(2049, 11, 31) })), after2050 = der(makeCa(production, { notBefore: Date.UTC(2049, 0, 1), notAfter: Date.UTC(2051, 0, 1, 12, 30, 15) }));
	assert.equal([...before.matchAll(/UTCTIME/g)].length, 2);
	assert.equal([...after2050.matchAll(/UTCTIME/g)].length, 1);
	assert.match(after2050, /GENERALIZEDTIME\s+:20510101123015Z/);
	assert.throws(() => makeCa(production, { notBefore: now, notAfter: now }), /end after it begins/);
});

test("1000 leaves, with and without a name and on every private block, all pass OpenSSL's strict verification", { skip, timeout: 120_000 }, () => {
	const ca = makeCa(), bare = makeCa(productionConstraints(undefined));
	const addresses = () => {
		const n = () => Math.floor(Math.random() * 254) + 1;
		return [`10.${n()}.${n()}.${n()}`, `172.${16 + (n() % 16)}.${n()}.${n()}`, `192.168.${n()}.${n()}`][Math.floor(Math.random() * 3)]!;
	};
	const named: Issued[] = [], unnamed: Issued[] = [];
	for (let i = 0; i < 500; i++) named.push(leafOf(ca, { ip: [addresses()] }));
	for (let i = 0; i < 500; i++) { const ip = addresses(); unnamed.push(leafOf(bare, { cn: `Straw Boss LAN (${ip})`, dns: [], ip: [ip] })); }
	for (const [issuer, leaves] of [[ca, named], [bare, unnamed]] as const) {
		const result = verify(issuer, leaves, ["-x509_strict", "-purpose", "sslserver"]);
		assert.ok(result.ok, result.said.split("\n").filter((line) => !/: OK$/.test(line)).slice(0, 8).join("\n"));
		assert.equal(result.said.split("\n").filter((line) => /: OK$/.test(line)).length, 500);
	}
});

test("name constraints are enforced by OpenSSL: a leaf outside them fails openssl verify, one inside passes", { skip }, () => {
	const ca = makeCa(), bare = makeCa(productionConstraints(undefined));
	assert.ok(verify(ca, [leafOf(ca)]).ok);
	assert.ok(verify(ca, [leafOf(ca, { ip: ["10.200.1.9"] })]).ok && verify(ca, [leafOf(ca, { ip: ["172.31.255.254"] })]).ok);
	for (const [label, leaf] of [
		["another DNS name", leafOf(ca, { cn: "example.com", dns: ["example.com"], ip: [] })],
		["another .local name", leafOf(ca, { cn: "other.local", dns: ["other.local"], ip: [] })],
		["a public address", leafOf(ca, { cn: "8.8.8.8", dns: [], ip: ["8.8.8.8"] })],
		["172.32, just past 172.16/12", leafOf(ca, { cn: "172.32.0.1", dns: [], ip: ["172.32.0.1"] })],
		["an IPv6 address", leafOf(ca, { cn: "weis-mbp.local", dns: ["weis-mbp.local"], ip: ["fd00::1"] })],
		["the name plus a public address", leafOf(ca, { ip: ["192.168.1.5", "1.1.1.1"] })],
	] as const) {
		const result = verify(ca, [leaf]);
		assert.ok(!result.ok, `${label} must fail`);
		assert.match(result.said, /permitted subtree violation|excluded subtree violation/, label);
	}
	// A CA with no usable name (permitted dNSName `invalid`) signs no DNS name at all, and still signs its addresses.
	const nameless = verify(bare, [leafOf(bare, { cn: "example.com", dns: ["example.com"], ip: [] })]);
	assert.ok(!nameless.ok && /permitted subtree violation/.test(nameless.said), nameless.said);
	assert.ok(!verify(bare, [leafOf(bare, { cn: "weis-mbp.local", dns: ["weis-mbp.local"], ip: [] })]).ok);
	assert.ok(verify(bare, [leafOf(bare, { cn: "Straw Boss LAN (192.168.1.5)", dns: [], ip: ["192.168.1.5"] })]).ok);
});

test("the constraint set is a parameter: the release gate's test CA (10/8 only) refuses 192.168 and IPv6, passes its own name", { skip }, () => {
	const gate = makeCa({ dns: ["nc-ok.local"], ip: ["10.0.0.0/8"], excludedIp: ["::/0"] });
	const attempt = (o: Parameters<typeof leafOf>[1]) => verify(gate, [leafOf(gate, o)]).ok;
	assert.equal(attempt({ cn: "192.168.1.9", dns: [], ip: ["192.168.1.9"] }), false, "(a) outside 10/8");
	assert.equal(attempt({ cn: "nc-bad.local", dns: ["nc-bad.local"], ip: [] }), false, "(b) another name");
	assert.equal(attempt({ cn: "nc-ok.local", dns: ["nc-ok.local"], ip: [] }), true, "(c) its own name");
	assert.equal(attempt({ cn: "nc-ok.local", dns: ["nc-ok.local"], ip: ["fd00::1"] }), false, "(d1) the name with an excluded IPv6 address");
});

test("a CA whose own validity has ended fails, and so does a leaf past the CA", { skip }, () => {
	const old = makeCa(production, span(730, now - 800 * DAY));
	assert.ok(!verify(old, [leafOf(old)]).ok, "a current leaf under an ended CA (release gate leaf e)");
	assert.match(verify(old, [leafOf(old)]).said, /expired/);
});

test("Node's TLS client enforces the constraints too: an allowed name and address pass, others are refused", async () => {
	const ca = makeCa();
	// The connection goes to the loopback and only the chain is judged: name constraints bind the certificate's own names.
	assert.deepEqual(await handshake(leafOf(ca), ca), { ok: true });
	for (const leaf of [leafOf(ca, { cn: "example.com", dns: ["example.com"], ip: [] }), leafOf(ca, { cn: "other.local", dns: ["other.local"], ip: [] }), leafOf(ca, { cn: "8.8.8.8", dns: [], ip: ["8.8.8.8"] }), leafOf(ca, { dns: ["weis-mbp.local"], ip: ["fd00::1"] })]) {
		const result = await handshake(leaf, ca);
		assert.equal(result.ok, false);
		assert.match((result as { error: Error }).error.message, /subtree violation|certificate/i);
	}
	// A leaf from another CA with the same name is no leaf of this one.
	const other = makeCa();
	assert.equal((await handshake(leafOf(other), ca)).ok, false);
	// The name-less CA's real leaf is accepted by a client that connects by that address (RVLAN3-F009): the identity check is the address's.
	const bare = makeCa(productionConstraints(undefined)), alone = leafOf(bare, { cn: "Straw Boss LAN (192.168.1.5)", dns: [], ip: ["192.168.1.5"] });
	assert.deepEqual(await handshake(alone, bare, "192.168.1.5"), { ok: true });
	assert.equal((await handshake(alone, bare, "192.168.1.6")).ok, false);
});

test("a loopback CA: the same issuer, with its own constraint set, serves a handshake that checks the host", async () => {
	const loop = makeCa({ dns: ["localhost"], ip: ["127.0.0.0/8"], excludedIp: ["::/0"] });
	assert.deepEqual(await handshake(leafOf(loop, { cn: "Straw Boss LAN (127.0.0.1)", dns: [], ip: ["127.0.0.1"] }), loop, "127.0.0.1"), { ok: true });
});

test("the writer refuses what a certificate cannot hold", () => {
	const ca = makeCa();
	assert.throws(() => leafOf(ca, { dns: [], ip: [] }), /at least one name/);
	assert.throws(() => leafOf(ca, { ip: ["192.168.1.5%en0"] }), /not an address/);
	assert.throws(() => leafOf(ca, { ip: ["not-an-address"] }), /not an address/);
	assert.throws(() => cidrBytes("10.0.0.1/8"), /host bits/);
	assert.throws(() => cidrBytes("10.0.0.0/33"), /prefix too long/);
	assert.throws(() => cidrBytes("10.0.0.0"), /not a CIDR/);
});

test("addresses and blocks become the bytes a SAN and a subtree hold", () => {
	assert.deepEqual([...ipBytes("192.168.1.5")], [192, 168, 1, 5]);
	assert.equal(ipBytes("::").length, 16);
	assert.deepEqual([...ipBytes("fd00::1")], [0xfd, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
	assert.deepEqual([...ipBytes("1:2:3:4:5:6:7:8")], [0, 1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 0, 7, 0, 8]);
	assert.deepEqual([...cidrBytes("172.16.0.0/12")], [172, 16, 0, 0, 255, 240, 0, 0]);
	assert.equal(cidrBytes("::/0").length, 32);
	assert.ok(cidrBytes("::/0").every((b) => b === 0));
	assert.deepEqual([...cidrBytes("10.0.0.0/8").subarray(4)], [255, 0, 0, 0]);
});

test("the CA signs no email address and no URI: an S/MIME or code-signing leaf is refused by OpenSSL and by a Node TLS client, and a CA that leaves those forms free accepts it (RVL12-F001)", { skip }, async () => {
	const ca = makeCa(), loose = makeCa({ ...production, email: undefined, uri: undefined });
	type Form = { cn: string; dns: string[]; ip: string[]; email?: string[]; uri?: string[]; eku?: "emailProtection" | "codeSigning" };
	const forms: [string, Form, string[]][] = [
		["an email address, S/MIME", { cn: "ceo", dns: [], ip: [], email: ["ceo@example.com"], eku: "emailProtection" }, []],
		["a URI, code signing", { cn: "app", dns: [], ip: [], uri: ["https://example.com/app"], eku: "codeSigning" }, []],
		["an email address under the TLS purpose", { cn: "ceo", dns: [], ip: [], email: ["ceo@example.com"] }, []],
		["a URI under the TLS purpose", { cn: "app", dns: [], ip: [], uri: ["https://example.com/app"] }, []],
	];
	for (const [label, form, purpose] of forms) {
		const refused = verify(ca, [leafOf(ca, form)], ["-x509_strict", ...purpose]);
		assert.ok(!refused.ok && /permitted subtree violation/.test(refused.said), `${label} must fail the name constraints: ${refused.said}`);
		assert.ok(verify(loose, [leafOf(loose, form)], ["-x509_strict", ...purpose]).ok, `${label}: without the constraint the same leaf passes, so the test sees the constraint`);
	}
	for (const form of [{ cn: "ceo", dns: [], ip: [], email: ["ceo@example.com"] }, { cn: "app", dns: [], ip: [], uri: ["https://example.com/app"] }]) {
		const refused = await handshake(leafOf(ca, form), ca);
		assert.ok(!refused.ok && /permitted|constraint/i.test(refused.error.message), `Node refuses it: ${refused.ok ? "accepted" : refused.error.message}`);
		assert.ok((await handshake(leafOf(loose, form), loose)).ok, "Node accepts it from a CA without the constraint");
	}
	const dump = text(ca.pem);
	assert.match(dump, /email:invalid/);
	assert.match(dump, /URI:invalid/);
});
