import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { isIP } from "node:net";

// The two certificate shapes Wi-Fi access needs (docs/specs/2026-10-30-sb-gui-lan.md, "Building certificates"): the CA and a leaf, written as DER by hand and signed with `crypto.sign`, since Node can read a certificate and check
// one but cannot write one. No new dependency. The issuer takes the name-constraint set and the validity as parameters, so the release gate's test CAs and the unit tests' loopback CA are made by the same code as the real one;
// what a CA or a leaf is for (names, lifetimes, the 90 days) is `ca.ts`'s policy.
//
// DER rules, each because a strict verifier (Chrome's, Apple's) refuses the certificate otherwise: INTEGERs are minimal (the serial's first byte is forced into 0x01-0x7F, so it is positive and never starts with a redundant
// 0x00), times are UTCTime before 2050 and GeneralizedTime from then on, BOOLEAN TRUE is 0xFF and a field equal to its DEFAULT is left out, a Name is a SEQUENCE of SETs with one UTF8String attribute each, an `iPAddress`
// subtree is the address plus the mask and a SAN `iPAddress` is the bare address.

/** The CA's name constraints, as CIDR text (`10.0.0.0/8`, `::/0`) and DNS names: what it may sign, and what it may never sign. */
export interface Constraints { dns: string[]; ip: string[]; excludedIp: string[]; /** Permitted rfc822Name and URI bases; an empty list leaves that form unconstrained. */ email?: string[]; uri?: string[] }
export interface KeyPair { privateKey: KeyObject; publicKey: KeyObject }
/** A certificate and its key: the DER, the PEM, and the private key as PKCS #8 PEM text. */
export interface Issued { der: Buffer; pem: string; keyPem: string }
/** What signs a leaf: the CA certificate and its key, as PEM text. */
export interface Issuer { certPem: string; keyPem: string }
/** Milliseconds since the epoch; `notAfter` must be later than `notBefore`. */
export interface Validity { notBefore: number; notAfter: number }

const ECDSA_SHA256 = "1.2.840.10045.4.3.2", CN = "2.5.4.3", ORG = "2.5.4.10";
const BASIC = "2.5.29.19", KEY_USAGE = "2.5.29.15", EKU = "2.5.29.37", NAME_CONSTRAINTS = "2.5.29.30", SKI = "2.5.29.14", AKI = "2.5.29.35", SAN = "2.5.29.17", SERVER_AUTH = "1.3.6.1.5.5.7.3.1";
const EKUS = { serverAuth: SERVER_AUTH, emailProtection: "1.3.6.1.5.5.7.3.4", codeSigning: "1.3.6.1.5.5.7.3.3" } as const;

const lengthOf = (n: number) => {
	if (n < 0x80) return Buffer.from([n]);
	if (n < 0x100) return Buffer.from([0x81, n]);
	if (n < 0x10000) return Buffer.from([0x82, n >> 8, n & 0xff]);
	throw new Error("a certificate part longer than 65535 bytes");
};
const tlv = (tag: number, ...parts: Buffer[]) => {
	const body = Buffer.concat(parts);
	return Buffer.concat([Buffer.from([tag]), lengthOf(body.length), body]);
};
const seq = (...parts: Buffer[]) => tlv(0x30, ...parts);
const set = (...parts: Buffer[]) => tlv(0x31, ...parts);
const bool = () => tlv(0x01, Buffer.from([0xff]));
const octets = (bytes: Buffer) => tlv(0x04, bytes);
/** An INTEGER from big-endian bytes, as the shortest two's-complement form of a non-negative number. */
const integer = (bytes: Buffer) => {
	let at = 0;
	while (at < bytes.length - 1 && bytes[at] === 0 && bytes[at + 1]! < 0x80) at++;
	const body = bytes.subarray(at);
	return tlv(0x02, body[0]! >= 0x80 ? Buffer.concat([Buffer.from([0]), body]) : body);
};
const small = (n: number) => integer(Buffer.from([n]));
const bits = (unused: number, byte: number) => tlv(0x03, Buffer.from([unused, byte]));
const oid = (dotted: string) => {
	const [first, second, ...rest] = dotted.split(".").map(Number) as [number, number, ...number[]], out = [first * 40 + second];
	for (let n of rest) {
		const chunk = [n & 0x7f];
		for (n = Math.floor(n / 128); n > 0; n = Math.floor(n / 128)) chunk.unshift((n & 0x7f) | 0x80);
		out.push(...chunk);
	}
	return tlv(0x06, Buffer.from(out));
};
const two = (n: number) => String(n).padStart(2, "0");
const time = (ms: number) => {
	const d = new Date(Math.floor(ms / 1000) * 1000), y = d.getUTCFullYear();
	const rest = `${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}${two(d.getUTCHours())}${two(d.getUTCMinutes())}${two(d.getUTCSeconds())}Z`;
	return y >= 1950 && y < 2050 ? tlv(0x17, Buffer.from(`${two(y % 100)}${rest}`)) : tlv(0x18, Buffer.from(`${y}${rest}`));
};
const rdn = (type: string, value: string) => set(seq(oid(type), tlv(0x0c, Buffer.from(value, "utf8"))));
const name = (cn: string, org?: string) => seq(rdn(CN, cn), ...(org === undefined ? [] : [rdn(ORG, org)]));
const extension = (id: string, critical: boolean, value: Buffer) => seq(oid(id), ...(critical ? [bool()] : []), octets(value));

/** The 4 or 16 bytes of an IP address; an address in any other spelling (a zone, an embedded IPv4) is refused, since a constraint or a SAN must say exactly what it covers. */
export function ipBytes(text: string): Buffer {
	const family = isIP(text);
	if (family === 4) return Buffer.from(text.split(".").map(Number));
	if (family === 6 && !text.includes("%") && !text.includes(".")) {
		const [head = "", tail, extra] = text.split("::"), side = (s: string) => (s === "" ? [] : s.split(":"));
		if (extra === undefined && (tail !== undefined || side(head).length === 8)) {
			const a = side(head), b = tail === undefined ? [] : side(tail), groups = [...a, ...Array(8 - a.length - b.length).fill("0"), ...b];
			return Buffer.concat(groups.map((g) => Buffer.from(g.padStart(4, "0"), "hex")));
		}
	}
	throw new Error(`not an address a certificate can hold: ${text}`);
}
/** An `iPAddress` subtree: the address then the mask, 8 bytes for IPv4 and 32 for IPv6. The address must be the subnet's own (no host bits set). */
export function cidrBytes(cidr: string): Buffer {
	const [address, prefixText, extra] = cidr.split("/");
	if (address === undefined || prefixText === undefined || extra !== undefined || !/^\d{1,3}$/.test(prefixText)) throw new Error(`not a CIDR block: ${cidr}`);
	const bytes = ipBytes(address), prefix = Number(prefixText), mask = Buffer.alloc(bytes.length);
	if (prefix > bytes.length * 8) throw new Error(`prefix too long: ${cidr}`);
	for (let i = 0; i < prefix; i++) mask[i >> 3]! |= 0x80 >> (i & 7);
	for (let i = 0; i < bytes.length; i++) if ((bytes[i]! & ~mask[i]!) !== 0) throw new Error(`host bits set in ${cidr}`);
	return Buffer.concat([bytes, mask]);
}

export const newKeyPair = (): KeyPair => generateKeyPairSync("ec", { namedCurve: "prime256v1" });

/** The SubjectPublicKeyInfo's key bits (the BIT STRING without its unused-bits byte) hashed with SHA-1, RFC 5280's first method of a key identifier. */
function keyId(publicKey: KeyObject): Buffer {
	const spki = publicKey.export({ type: "spki", format: "der" });
	const [, keyBits] = children(spki.subarray(headerOf(spki, 0).bodyAt));
	return createHash("sha1").update(keyBits!.subarray(headerOf(keyBits!, 0).bodyAt + 1)).digest();
}
/** The tag, where the body starts, and where it ends for the TLV at `at`. */
function headerOf(buf: Buffer, at: number) {
	const first = buf[at + 1]!;
	if (first < 0x80) return { tag: buf[at]!, bodyAt: at + 2, end: at + 2 + first };
	const count = first & 0x7f;
	if (count < 1 || count > 2) throw new Error("a length this writer never makes");
	const size = count === 1 ? buf[at + 2]! : buf.readUInt16BE(at + 2);
	return { tag: buf[at]!, bodyAt: at + 2 + count, end: at + 2 + count + size };
}
/** The TLVs one after another in `body`, each whole. */
function children(body: Buffer): Buffer[] {
	const out: Buffer[] = [];
	for (let at = 0; at < body.length;) {
		const { end } = headerOf(body, at);
		out.push(body.subarray(at, end));
		at = end;
	}
	return out;
}
/** The issuer's Name as the CA certificate wrote it, copied into a leaf's issuer byte for byte so the chain links. */
function subjectOf(certDer: Buffer): Buffer {
	const tbs = children(certDer.subarray(headerOf(certDer, 0).bodyAt))[0]!, fields = children(tbs.subarray(headerOf(tbs, 0).bodyAt));
	// [0] version, serial, signature, issuer, validity, subject
	return fields[fields[0]!.readUInt8(0) === 0xa0 ? 5 : 4]!;
}

const serial = () => {
	const bytes = randomBytes(16);
	bytes[0] = (bytes[0]! % 0x7f) + 1;
	return integer(bytes);
};

function certificate(tbsParts: { issuer: Buffer; subject: Buffer; validity: Validity; spki: Buffer; extensions: Buffer[] }, signer: KeyObject, keyPem: string): Issued {
	const { validity } = tbsParts;
	if (!(validity.notAfter > validity.notBefore)) throw new Error("a certificate must end after it begins");
	const algorithm = seq(oid(ECDSA_SHA256));
	const tbs = seq(
		tlv(0xa0, small(2)), serial(), algorithm, tbsParts.issuer, seq(time(validity.notBefore), time(validity.notAfter)), tbsParts.subject, tbsParts.spki,
		tlv(0xa3, seq(...tbsParts.extensions)),
	);
	const der = seq(tbs, algorithm, tlv(0x03, Buffer.from([0]), sign("sha256", tbs, signer)));
	return { der, pem: pemOf(der), keyPem };
}
const pemOf = (der: Buffer) => `-----BEGIN CERTIFICATE-----\n${der.toString("base64").replace(/.{1,64}/g, "$&\n")}-----END CERTIFICATE-----\n`;
const keyPemOf = (key: KeyObject) => key.export({ type: "pkcs8", format: "pem" }).toString();

const dnsName = (dns: string) => tlv(0x82, Buffer.from(dns, "ascii"));
const emailName = (email: string) => tlv(0x81, Buffer.from(email, "ascii"));
const uriName = (uri: string) => tlv(0x86, Buffer.from(uri, "ascii"));
const subtree = (base: Buffer) => seq(base);

/**
 * The CA: `CN=<subject.cn>, O=<subject.org>`, self-signed, ECDSA P-256 with SHA-256. `basicConstraints` critical `CA:TRUE, pathlen:0`, `keyUsage` critical `keyCertSign, cRLSign`, `extendedKeyUsage` serverAuth,
 * `nameConstraints` critical (permitted DNS names and IP blocks, excluded IP blocks), `subjectKeyIdentifier`. `key` is a key pair the caller already made.
 */
export function issueCa(options: { subject: { cn: string; org?: string }; validity: Validity; constraints: Constraints; key?: KeyPair }): Issued {
	const { constraints } = options, key = options.key ?? newKeyPair(), subject = name(options.subject.cn, options.subject.org);
	const permitted = [...constraints.dns.map((dns) => subtree(dnsName(dns))), ...(constraints.email ?? []).map((email) => subtree(emailName(email))), ...(constraints.uri ?? []).map((uri) => subtree(uriName(uri))), ...constraints.ip.map((cidr) => subtree(tlv(0x87, cidrBytes(cidr))))];
	const excluded = constraints.excludedIp.map((cidr) => subtree(tlv(0x87, cidrBytes(cidr))));
	return certificate({
		issuer: subject, subject, validity: options.validity, spki: key.publicKey.export({ type: "spki", format: "der" }),
		extensions: [
			extension(BASIC, true, seq(bool(), small(0))),
			extension(KEY_USAGE, true, bits(1, 0x06)),
			extension(EKU, false, seq(oid(SERVER_AUTH))),
			extension(NAME_CONSTRAINTS, true, seq(...(permitted.length ? [tlv(0xa0, ...permitted)] : []), ...(excluded.length ? [tlv(0xa1, ...excluded)] : []))),
			extension(SKI, false, octets(keyId(key.publicKey))),
		],
	}, key.privateKey, keyPemOf(key.privateKey));
}

/**
 * A leaf signed by `issuer`: `basicConstraints` critical `CA:FALSE`, `keyUsage` critical `digitalSignature`, `extendedKeyUsage` serverAuth, a `subjectAltName` of exactly `dns` and `ip` (nothing else),
 * the authority and subject key identifiers. It has a key of its own, new with every call.
 */
export function issueLeaf(options: { issuer: Issuer; cn: string; dns: string[]; ip: string[]; validity: Validity; /** Only the tests and the release gate's probe leaves set these: a leaf of a form the CA must refuse. */ email?: string[]; uri?: string[]; eku?: keyof typeof EKUS }): Issued {
	const caKey = createPrivateKey(options.issuer.keyPem), caPublic = createPublicKey(options.issuer.certPem), key = newKeyPair();
	const caDer = Buffer.from(options.issuer.certPem.replace(/-----[A-Z ]+-----|\s/g, ""), "base64");
	const names = [...options.dns.map(dnsName), ...options.ip.map((ip) => tlv(0x87, ipBytes(ip))), ...(options.email ?? []).map(emailName), ...(options.uri ?? []).map(uriName)];
	if (names.length === 0) throw new Error("a leaf needs at least one name or address");
	return certificate({
		issuer: subjectOf(caDer), subject: name(options.cn), validity: options.validity, spki: key.publicKey.export({ type: "spki", format: "der" }),
		extensions: [
			extension(BASIC, true, seq()),
			extension(KEY_USAGE, true, bits(7, 0x80)),
			extension(EKU, false, seq(oid(EKUS[options.eku ?? "serverAuth"]))),
			extension(SAN, false, seq(...names)),
			extension(AKI, false, seq(tlv(0x80, keyId(caPublic)))),
			extension(SKI, false, octets(keyId(key.publicKey))),
		],
	}, caKey, keyPemOf(key.privateKey));
}
