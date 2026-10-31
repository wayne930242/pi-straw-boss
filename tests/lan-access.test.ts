import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after as afterAll, afterEach, mock, test } from "node:test";
import { LAN_COOKIE, lanAppCookieFor, lanCookieFor, type LanAt, type LanEvent } from "../src/lan/access.ts";
import { createLanCodes, LAN_CODE_MISSES, LAN_PEER_MISSES } from "../src/paircode.ts";
import { createAccess, PORT } from "../src/remote.ts";
import { fakeClock } from "./fake-clock.ts";

// Who is let in over Wi-Fi access (docs/specs/2026-10-30-sb-gui-lan.md, "Pairing and identity on the LAN", "Codes and limits", "Devices"; Steps L4). No socket is opened: `check`, the entry, and the redemption are the functions the LAN listener's
// handler calls, given the `At` the listener builds, so a request here is a header object. Time is a clock the test moves (Date.now is patched to it, and the pending timeout is armed on it).

const scratch = mkdtempSync(join(tmpdir(), "psb-lan-access-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
afterEach(() => mock.restoreAll());

const T = "t".repeat(32), NAME = "weis-mbp", HOST_PORT = 8445, TS_HOST = `box.tail1.ts.net:${PORT}`, LOGIN = "me@example.com";
const AT: LanAt = { address: "192.168.1.5", iface: "en0", port: HOST_PORT, name: NAME, host: `${NAME}.local`, origin: `https://${NAME}.local:${HOST_PORT}`, peer: "192.168.1.23" };
const atOf = (o: Partial<LanAt> = {}): LanAt => ({ ...AT, ...o });
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1";
const req = (headers: Record<string, string> = {}, method = "GET", at: LanAt = AT) => ({ method, headers: { host: `${at.host}:${at.port}`, ...headers } }) as unknown as IncomingMessage;
const post = (headers: Record<string, string> = {}, at: LanAt = AT) => req({ origin: at.origin, "content-type": "application/x-www-form-urlencoded", "user-agent": IPHONE, ...headers }, "POST", at);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const jar = (cookie: string) => ({ cookie: `${LAN_COOKIE}=${cookie}` });

/** An access with Wi-Fi access on, a clock the test moves, and the events and log lines it raised. */
function world(name = "w") {
	const clock = fakeClock(Date.now());
	mock.method(Date, "now", clock.now);
	const dir = join(scratch, name);
	mkdirSync(dir, { recursive: true });
	const events: LanEvent[] = [], logs: [string, Record<string, unknown>][] = [], ended: [string | undefined, string | undefined][] = [];
	const file = join(dir, "paired.json"), lanFile = join(dir, "lan.json");
	const timers = (fn: () => void, ms: number) => {
		let live = true;
		clock.at(clock.elapsed() + ms, () => live && fn());
		return () => void (live = false);
	};
	const open = (token = T) => createAccess(token, (device, net) => ended.push([device, net]), file, { file: lanFile, notify: (e) => events.push(e), log: (event, fields) => logs.push([event, fields]), after: timers });
	const access = open();
	access.lan.enable();
	/** A redeemed code for a new pending device: its cookie and the number it shows. */
	const pend = (peer = "192.168.1.23", surface = "tile-1") => {
		const at = atOf({ peer }), r = access.lan.redeem(post({}, at), `code=${access.pair("lan", surface)}`, at);
		assert.ok("cookie" in r, JSON.stringify(r));
		return r;
	};
	/** A pending device the boss allowed. */
	const pair = (peer = "192.168.1.23") => {
		const r = pend(peer);
		assert.ok(access.lan.approve(r.number));
		return r.cookie;
	};
	const page = (cookie?: string, headers: Record<string, string> = {}, path = [""], at = AT) => access.check(req({ ...(cookie ? jar(cookie) : {}), ...headers }, "GET", at), "lan", at.port, T, path, at);
	return { access, clock, dir, file, lanFile, events, logs, ended, open, pend, pair, page, mock: clock };
}
const IN = (cookie: string, at = AT) => ({ origin: at.origin, remote: true, net: "lan", device: sha(cookie) });

test("a LAN cookie never works on the Tailscale side and a Tailscale cookie never on the LAN", () => {
	const w = world("sides");
	w.access.enable({ host: TS_HOST, login: LOGIN });
	const tail = (path: string, headers: Record<string, string>) => w.access.check({ method: "GET", headers: { host: TS_HOST, "tailscale-user-login": LOGIN, "x-forwarded-for": "100.1.2.3", ...headers } } as unknown as IncomingMessage, "remote", 1234, T, path.split("/"));
	const remoteCookie = (tail(`pair/${w.access.pair()}`, {}) as { cookie: string }).cookie;
	const lanCookie = w.pair();
	assert.deepEqual(tail("", { cookie: `sb_remote=${remoteCookie}` }), { origin: `https://${TS_HOST}`, remote: true, device: sha(remoteCookie) }, "the tailnet device is in on the tailnet");
	assert.deepEqual(w.page(lanCookie), IN(lanCookie), "the LAN device is in on the LAN");
	// Each cookie in the other side's name, and under its own name on the other side: nothing gets in.
	assert.deepEqual(tail("", { cookie: `sb_remote=${lanCookie}` }), { status: 401 });
	assert.deepEqual(tail("", { cookie: `${LAN_COOKIE}=${lanCookie}` }), { status: 401 }, "the remote listener does not read the LAN's cookie");
	assert.deepEqual(w.page(undefined, { cookie: `sb_remote=${remoteCookie}` }), { status: 401 }, "the LAN does not read the remote cookie");
	assert.deepEqual(w.page(remoteCookie), { status: 401 }, "and a Tailscale device's value under the LAN's name is no LAN device");
	assert.equal(w.access.lan.carries(req(jar(remoteCookie))), false);
	assert.equal(w.access.lan.carries(req({ cookie: `sb_remote=${lanCookie}` })), false);
	assert.equal(w.access.lan.carries(req(jar(lanCookie))), true);
	// Turning one network off ends only its streams and voids only its codes.
	const qr = w.access.pair("lan", "s");
	w.access.disable();
	assert.deepEqual(w.ended.at(-1), [undefined, "tailnet"]);
	assert.deepEqual(w.page(lanCookie), IN(lanCookie), "remote off leaves the LAN as it was");
	assert.ok(qr);
	w.access.lan.disable(true);
	assert.deepEqual(w.ended.at(-1), [undefined, "lan"]);
	assert.deepEqual(w.page(lanCookie), { status: 403 }, "Wi-Fi access off: nothing gets in");
});

test("LAN codes are the LAN's: a Tailscale code is not one here, and a LAN code is not one on the tailnet", () => {
	const w = world("codes-sides");
	w.access.enable({ host: TS_HOST, login: LOGIN });
	const tail = (path: string) => w.access.check({ method: "GET", headers: { host: TS_HOST, "tailscale-user-login": LOGIN, "x-forwarded-for": "100.1.2.3" } } as unknown as IncomingMessage, "remote", 1234, T, path.split("/"));
	const lanQr = w.access.pair("lan", "s1")!, tailQr = w.access.pair()!;
	assert.deepEqual(tail(`pair/${lanQr}`), { status: 403 }, "a LAN code does not pair a tailnet device");
	const as = atOf({ peer: "192.168.1.40" });
	assert.deepEqual(w.access.lan.redeem(post({}, as), `code=${tailQr}`, as), { wrong: true }, "and a tailnet code is wrong on the LAN");
	assert.ok("cookie" in w.access.lan.redeem(post(), `code=${lanQr}`, AT), "while the LAN code pairs");
	assert.equal(w.access.pair("lan", "s2") !== undefined && w.access.pairCode("lan", "s2") !== undefined, true);
	assert.throws(() => w.access.pair("lan"), /surface/, "a LAN code belongs to a surface");
	w.access.lan.disable(true);
	assert.equal(w.access.pair("lan", "s3"), undefined, "no LAN codes while Wi-Fi access is off");
	assert.equal(w.access.pairCode("lan", "s3"), undefined);
});

test("a redeemed code makes a pending device with no reach until the boss types its number; the file holds only allowed devices", () => {
	const w = world("pending");
	const r = w.pend();
	assert.match(r.number, /^\d{4}$/);
	assert.deepEqual(w.page(r.cookie), { status: 401 }, "the pending device gets nothing");
	assert.deepEqual(w.page(r.cookie, {}, ["api", "sessions"]), { status: 401 });
	assert.deepEqual(w.page(r.cookie, {}, ["doc", "a".repeat(32), ""]), { status: 401 }, "not a document either");
	assert.equal(w.access.lan.carries(req(jar(r.cookie))), false);
	assert.deepEqual(w.access.lan.entry(req(jar(r.cookie)), AT), { pending: true }, "the entry sends it to the waiting page");
	assert.deepEqual(w.access.lan.waiting(req(jar(r.cookie)), AT), { state: "pending", number: r.number }, "which shows it the number");
	assert.equal(existsSync(w.lanFile) && JSON.parse(readFileSync(w.lanFile, "utf8")).devices && Object.keys(JSON.parse(readFileSync(w.lanFile, "utf8")).devices).length, 0, "nothing is written for it");
	assert.deepEqual(w.access.devices.list(), []);
	const [row] = w.access.lan.pending();
	assert.deepEqual(Object.keys(row!).sort(), ["id", "iface", "label", "peer", "since"], "the computer's list carries no number");
	assert.deepEqual([row!.label, row!.peer, row!.iface], ["iPhone · Safari", AT.peer, "en0"]);
	// A number that matches none, a malformed one, or the id: nothing happens.
	for (const wrong of [String((Number(r.number) + 1) % 10000).padStart(4, "0"), "", "123", "12345", row!.id, "abcd", "٤٤٤٤"]) assert.equal(w.access.lan.approve(wrong), undefined, wrong);
	assert.deepEqual(w.page(r.cookie), { status: 401 });
	assert.equal(w.events.filter((e) => e.type === "pending").length, 1, "the computer was told once");
	// The number allows it.
	assert.deepEqual(w.access.lan.approve(r.number), { id: row!.id, label: "iPhone · Safari", peer: AT.peer });
	assert.deepEqual(w.page(r.cookie), IN(r.cookie));
	assert.equal(w.access.lan.carries(req(jar(r.cookie))), true);
	assert.deepEqual(w.access.lan.entry(req(jar(r.cookie)), AT), { cookie: r.cookie }, "and the entry now hands it on");
	assert.deepEqual(w.access.lan.waiting(req(jar(r.cookie)), AT), { state: "allowed" });
	assert.equal(w.access.lan.approve(r.number), undefined, "a number works once");
	assert.deepEqual(w.events.at(-1), { type: "paired", id: row!.id, label: "iPhone · Safari", peer: AT.peer });
	assert.ok(w.logs.some(([e, f]) => e === "lan-paired" && f.peer === AT.peer));
	// Only now is it written, as a hash.
	const saved = JSON.parse(readFileSync(w.lanFile, "utf8"));
	assert.deepEqual(Object.keys(saved.devices), [sha(r.cookie)]);
	assert.equal(saved.devices[sha(r.cookie)].host, AT.host);
});

test("the pending device waits two minutes, then is dropped and told; the boss can deny one or all; two numbers are distinct", () => {
	const w = world("timeout");
	const a = w.pend("192.168.1.23"), b = w.pend("192.168.1.24");
	assert.notEqual(a.number, b.number, "two pending devices never share a number");
	assert.equal(w.access.lan.approve(b.number)?.peer, "192.168.1.24", "each is allowed by its own number");
	assert.deepEqual(w.page(b.cookie), IN(b.cookie));
	assert.deepEqual(w.page(a.cookie), { status: 401 }, "and the other stays pending");
	w.clock.advance(2 * 60_000 - 1);
	assert.equal(w.access.lan.pending().length, 1);
	w.clock.advance(1);
	assert.equal(w.access.lan.pending().length, 0, "dropped at the timeout");
	assert.deepEqual(w.access.lan.waiting(req(jar(a.cookie)), AT), { state: "timeout" }, "the device is told it was too late");
	assert.equal(w.access.lan.approve(a.number), undefined, "and its number is dead");
	assert.deepEqual(w.page(a.cookie), { status: 401 });
	assert.deepEqual(w.events.at(-1), { type: "refused", id: (w.events.find((e) => e.type === "pending" && e.peer === "192.168.1.23") as { id: string }).id, label: "iPhone · Safari", peer: "192.168.1.23", why: "timeout" }, "the computer is told it was not answered in time");
	const c = w.pend("192.168.1.25"), d = w.pend("192.168.1.26");
	assert.equal(w.access.lan.deny(w.access.lan.pending()[0]!.id), 1, "deny one");
	assert.deepEqual(w.access.lan.waiting(req(jar(c.cookie)), AT), { state: "denied" });
	assert.equal(w.access.lan.deny("all"), 1, "deny all");
	assert.deepEqual(w.access.lan.waiting(req(jar(d.cookie)), AT), { state: "denied" });
	assert.equal(w.access.lan.deny("all"), 0);
	assert.equal(w.access.lan.approve(d.number), undefined);
	assert.deepEqual(w.page(d.cookie), { status: 401 });
	assert.deepEqual(w.access.devices.list().map((x) => x.net), ["lan"], "only the allowed one is a device");
	w.clock.advance(10 * 60_000 + 1);
	assert.deepEqual(w.access.lan.waiting(req(jar(d.cookie)), AT), { state: "none" }, "the outcome is not kept for ever");
});

test("one pending per peer address and four in all: the next is refused with its code unused", () => {
	const w = world("busy");
	const first = w.pend("192.168.1.30");
	const code = w.access.pair("lan", "tile-x")!, again = atOf({ peer: "192.168.1.30" });
	assert.deepEqual(w.access.lan.redeem(post({}, again), `code=${code}`, again), { busy: true }, "the same peer again");
	for (const peer of ["192.168.1.31", "192.168.1.32", "192.168.1.33"]) w.pend(peer);
	const other = atOf({ peer: "192.168.1.34" });
	assert.deepEqual(w.access.lan.redeem(post({}, other), `code=${code}`, other), { busy: true }, "the fifth in all");
	w.access.lan.approve(first.number);
	assert.ok("cookie" in w.access.lan.redeem(post({}, other), `code=${code}`, other), "the refused code was not used up");
	const typed = w.access.pairCode("lan", "tile-y")!;
	const busy = atOf({ peer: "192.168.1.35" });
	assert.deepEqual(w.access.lan.redeem(post({}, busy), `code=${typed}`, busy), { busy: true });
	w.access.lan.deny("all");
	assert.ok("cookie" in w.access.lan.redeem(post({}, busy), `code=${typed}`, busy), "nor was a typed one");
});

test("the Host allow-list refuses a rebinding host before the token is looked at", () => {
	const w = world("host");
	const cookie = w.pair();
	const at = (host: string) => ({ ...AT, host }), ask = (hostHeader: string | undefined, a: LanAt = AT, token: string = T) => w.access.check({ method: "GET", headers: { ...jar(cookie), ...(hostHeader ? { host: hostHeader } : {}) } } as unknown as IncomingMessage, "lan", a.port, token, [""], a);
	assert.deepEqual(ask(`${NAME}.local:${HOST_PORT}`), IN(cookie));
	assert.deepEqual(ask(`192.168.1.5:${HOST_PORT}`, at("192.168.1.5")), IN(cookie, at("192.168.1.5")), "the listener's own address is allowed too");
	assert.deepEqual(ask(`${NAME.toUpperCase()}.LOCAL:${HOST_PORT}`), IN(cookie), "case is not a way round it, nor a way out");
	for (const bad of ["evil.example:8445", "evil.example", `${NAME}.local`, `${NAME}.local:8446`, `other.local:${HOST_PORT}`, "192.168.1.6:8445", "192.168.1.5:8445", `${NAME}.local.evil.example:8445`, undefined, ""]) assert.deepEqual(ask(bad), { status: 403 }, `${bad}: refused even with the cookie`);
	assert.deepEqual(ask("192.168.1.5:8445", at("192.168.1.9")), { status: 403 }, "a listener that names another address than the Host");
	assert.deepEqual(ask(`evil.example:${HOST_PORT}`, at("evil.example")), { status: 403 }, "a host the listener never allow-listed, even if its own `At` claimed it");
	assert.deepEqual(ask(`${NAME}.local:${HOST_PORT}`, { ...AT, port: 9999 }), { status: 403 }, "the port the handler was told is the listener's");
	assert.deepEqual(w.access.check(req(jar(cookie)), "lan", 1234, T, [""], AT), { status: 403 }, "and so is the port the caller says");
	assert.deepEqual(ask(`${NAME}.local:${HOST_PORT}`, AT, "x".repeat(32)), { status: 403 }, "a wrong token is refused");
	assert.deepEqual(w.access.check(req(jar(cookie)), "lan", HOST_PORT, T, [""], undefined), { status: 403 }, "no `At`: refused");
	// A computer with no usable name is reached by its address alone.
	const bare = { ...AT, name: null as string | null, host: AT.address, origin: `https://${AT.address}:${HOST_PORT}` };
	assert.deepEqual(ask(`192.168.1.5:${HOST_PORT}`, bare), IN(cookie, bare));
	assert.deepEqual(ask(`${NAME}.local:${HOST_PORT}`, { ...bare, host: `${NAME}.local` }), { status: 403 }, "a name the CA never had");
	// The entry's pages and the redemption have the same list.
	assert.deepEqual(w.access.lan.entry(req({ host: "evil.example:8445" }), AT), { status: 403 });
	assert.deepEqual(w.access.lan.waiting(req({ host: "evil.example:8445" }), AT), { status: 403 });
	assert.equal(w.access.lan.admits(req({ host: "evil.example:8445" }), AT), false);
	assert.equal(w.access.lan.admits(req(), AT), true);
	assert.deepEqual(w.access.lan.redeem(post({ host: "evil.example:8445" }), `code=${w.access.pair("lan", "a")}`, AT), { status: 403 });
});

test("a redemption is the entry's own form post: method, Origin, Sec-Fetch-Site, and content type are checked, and none of it uses the code up", () => {
	const w = world("form");
	const code = w.access.pair("lan", "tile-1")!, body = `code=${code}`;
	for (const [what, r] of [
		["a GET", req({}, "GET")],
		["another Origin", post({ origin: "https://evil.example" })],
		["no Origin", post({ origin: "" })],
		["cross-site", post({ "sec-fetch-site": "cross-site" })],
		["json", post({ "content-type": "application/json" })],
	] as const) assert.deepEqual(w.access.lan.redeem(r, body, AT), { status: 403 }, what);
	assert.ok("cookie" in w.access.lan.redeem(post({ "sec-fetch-site": "same-origin" }), body, AT), "the code is still good");
	assert.deepEqual(w.access.lan.redeem(post(), body, undefined), { status: 403 }, "no `At`: refused");
	assert.deepEqual(w.access.lan.redeem(post(), body, atOf({ peer: undefined })), { status: 403 }, "a peer that is not known");
});

test("typed codes: five wrong tries lock one peer address only; 200 in all void the code; a new code clears the counts; the QR is never locked", () => {
	const w = world("typed");
	const typed = w.access.pairCode("lan", "tile-1")!, asA = atOf({ peer: "192.168.1.40" }), asB = atOf({ peer: "192.168.1.41" });
	const try_ = (as: LanAt, text: string) => w.access.lan.redeem(post({}, as), `code=${encodeURIComponent(text)}`, as);
	for (let i = 1; i <= LAN_PEER_MISSES; i++) assert.deepEqual(try_(asA, "ZZZZ-ZZZ" + i), { wrong: true }, `try ${i}`);
	assert.deepEqual(w.events.filter((e) => e.type === "wrong").map((e) => (e as { count: number }).count), [1, 2, 3, 4, 5], "the computer hears a count, not the codes");
	assert.deepEqual(try_(asA, typed), { status: 429 }, "locked out of the code: even the right one");
	assert.deepEqual(try_(asA, "ABCD EFGH"), { status: 429 });
	const b = try_(asB, typed.toLowerCase().replace("-", " "));
	assert.ok("cookie" in b, "another peer is not locked, and case, spaces, and the hyphen are forgiven");
	// A QR code is never locked.
	const qr = w.access.pair("lan", "tile-2")!;
	assert.ok("cookie" in try_(asA, qr), "the locked peer redeems a QR code");
	// A new code gives the tries back.
	w.access.lan.deny("all");
	const next = w.access.pairCode("lan", "tile-3")!;
	assert.ok("cookie" in try_(asA, next), "a new code clears the per-peer counts");
	// 200 wrong tries from all peers void the code; the count of addresses is announced.
	w.access.lan.deny("all");
	const last = w.access.pairCode("lan", "tile-4")!;
	for (let n = 0; n < LAN_CODE_MISSES; n++) try_(atOf({ peer: `192.168.${10 + Math.floor(n / LAN_PEER_MISSES / 200)}.${1 + Math.floor(n / LAN_PEER_MISSES)}` }), `ZZZZ-${String(n).padStart(4, "Z")}`);
	assert.deepEqual(w.events.at(-1), { type: "void", peers: LAN_CODE_MISSES / LAN_PEER_MISSES }, "200 tries from 40 addresses");
	assert.ok(w.logs.some(([e, f]) => e === "lan-code-void" && f.peers === 40));
	assert.deepEqual(try_(asB, last), { wrong: true }, "the real code is void for everyone: nothing is left to redeem");
	const fresh = w.access.pairCode("lan", "tile-5")!;
	assert.ok("cookie" in try_(asB, fresh), "a new code works again");
});

test("RVL4-F004: each typed code counts its own wrong tries; a mint elsewhere gives nothing back, and a peer's lock holds across codes", () => {
	const w = world("typed-own");
	const try_ = (as: LanAt, text: string) => w.access.lan.redeem(post({}, as), `code=${encodeURIComponent(text)}`, as);
	const asA = atOf({ peer: "192.168.1.40" }), asB = atOf({ peer: "192.168.1.41" });
	const first = w.access.pairCode("lan", "overlay-1")!;
	for (let i = 1; i < LAN_PEER_MISSES; i++) try_(asA, `ZZZZ-ZZZ${i}`);
	// The tile mints a code of its own: the overlay's code is still live and keeps A's four.
	const second = w.access.pairCode("lan", "tile-1")!;
	assert.deepEqual(try_(asA, "ZZZZ-ZZZ9"), { wrong: true }, "A's fifth wrong try");
	assert.deepEqual(try_(asA, first), { status: 429 }, "A is locked out of the first code: the mint on another surface did not give the tries back");
	assert.deepEqual(try_(asA, second), { status: 429 }, "and out of the second: the lock is per peer, not per code, so one guess is not five on each");
	assert.ok("cookie" in try_(asB, second), "another peer is not locked");
	// A mint on the surface that holds the code does clear that code's counts.
	w.access.lan.deny("all");
	const renewed = w.access.pairCode("lan", "overlay-1")!;
	assert.ok("cookie" in try_(asA, renewed), "the first code's counts went with the code; the second was spent by B, so nothing holds A's lock");
	// The ceiling is per code: 200 wrong tries void the codes that were live for all of them and not a code minted after.
	w.access.lan.deny("all");
	const old = w.access.pairCode("lan", "overlay-1")!;
	const wrong = (n: number) => try_(atOf({ peer: `192.168.${10 + Math.floor(n / 200)}.${1 + (Math.floor(n / LAN_PEER_MISSES) % 200)}` }), `ZZZZ-${String(n).padStart(4, "Z")}`);
	for (let n = 0; n < LAN_CODE_MISSES - 1; n++) wrong(n);
	const young = w.access.pairCode("lan", "tile-2")!;
	wrong(LAN_CODE_MISSES - 1);
	assert.equal(w.events.filter((e) => e.type === "void").length, 1, "the older code reached 200 and is void");
	assert.deepEqual(try_(atOf({ peer: "192.168.1.200" }), old), { wrong: true }, "it does not redeem");
	assert.ok("cookie" in try_(atOf({ peer: "192.168.1.201" }), young), "the code minted after 199 of them has seen one wrong try, not 200");
});

test("the typed-code store (createLanCodes): per-peer locks, the per-code ceiling, one live code per surface, expiry", () => {
	const clock = fakeClock(1_000_000);
	const codes = createLanCodes(10 * 60_000, 16, clock.now);
	const a = codes.qr("overlay-1"), b = codes.qr("overlay-1");
	assert.equal(codes.takeQr(a), false, "minting again on one surface voids the QR before it");
	assert.equal(codes.takeQr(b), true);
	assert.equal(codes.takeQr(b), false, "once");
	const q = codes.qr("overlay-1"), t = codes.typed("overlay-1");
	assert.equal(codes.takeQr(q), false, "a typed code voids the surface's QR");
	const other = codes.qr("tile-1");
	const t2 = codes.typed("overlay-1");
	assert.deepEqual(codes.takeTyped(t, "p"), { result: "wrong", misses: 1 }, "and a newer typed code voids the older one");
	assert.equal(codes.takeQr(other), true, "another surface's code is not voided");
	assert.equal(codes.takeTyped(t2, "p").result, "ok");
	assert.equal(codes.kindOf(codes.qr("s")), "qr");
	assert.equal(codes.kindOf("ABCD-EFGH"), "typed");
	assert.equal(codes.kindOf(" abcd efgh "), "typed");
	const old = codes.qr("s1"), oldTyped = codes.typed("s2");
	clock.advance(10 * 60_000 + 1);
	assert.equal(codes.takeQr(old), false, "ten minutes");
	assert.equal(codes.takeTyped(oldTyped, "p").result, "wrong");
	// At most `max` wait: the oldest goes first.
	const small = createLanCodes(60_000, 2, clock.now), s1 = small.qr("a"), s2 = small.qr("b"), s3 = small.qr("c");
	assert.deepEqual([small.takeQr(s1), small.takeQr(s2), small.takeQr(s3)], [false, true, true]);
	// Wrong tries are per peer; the ceiling is in all.
	const c = createLanCodes(60_000, 16, clock.now);
	const code = c.typed("s");
	for (let i = 0; i < LAN_PEER_MISSES; i++) assert.equal(c.takeTyped("ZZZZZZZZ", "p1").result, "wrong");
	assert.equal(c.takeTyped(code, "p1").result, "locked");
	assert.equal(c.takeTyped(code, "p2").result, "ok");
	assert.equal(c.takeTyped("0000 0000 0000", "p3").result, "wrong", "a wrong shape is a wrong try");
	c.clear();
	assert.equal(c.takeQr(c.qr("s")), true);
});

test("RVL4-F003: three wrong numbers deny every pending device; a typo costs a re-pair, an enumeration gets nothing", () => {
	const w = world("approve-budget");
	const a = w.pend("192.168.1.23"), b = w.pend("192.168.1.24");
	const wrong = (r: { number: string }) => String((Number(r.number) + 1) % 10000).padStart(4, "0");
	const miss = [wrong(a) === b.number ? String((Number(b.number) + 1) % 10000).padStart(4, "0") : wrong(a)];
	assert.equal(w.access.lan.approve(miss[0]!), undefined);
	assert.equal(w.access.lan.approve(miss[0]!), undefined);
	assert.equal(w.access.lan.pending().length, 2, "two wrong numbers: everyone still waits");
	assert.equal(w.access.lan.approve(miss[0]!), undefined);
	assert.deepEqual(w.access.lan.pending(), [], "the third wrong number denies every pending device");
	assert.deepEqual(w.events.filter((e) => e.type === "refused").map((e) => (e as { why: string }).why), ["denied", "denied"], "and the computer is told, as for any denial");
	assert.ok(w.logs.some(([event, fields]) => event === "lan-approve-wrong" && fields.denied === 2));
	assert.ok(!JSON.stringify(w.logs).includes(a.number) && !JSON.stringify(w.events).includes(a.number), "no number in a log or an event");
	assert.equal(w.access.lan.approve(a.number), undefined, "the right number is dead after");
	assert.deepEqual(w.access.lan.waiting(req(jar(a.cookie)), AT), { state: "denied" });
	// Nothing waiting, nothing to enumerate: a wrong number is not counted then, and the budget starts over with the next request.
	for (let i = 0; i < 10; i++) w.access.lan.approve("0000");
	const c = w.pend("192.168.1.25");
	const off = (x: string) => String((Number(x) + 1) % 10000).padStart(4, "0");
	w.access.lan.approve(off(c.number));
	w.access.lan.approve(off(c.number));
	assert.ok(w.access.lan.approve(c.number), "two wrong numbers and then the right one still allows");
	// The budget is not refilled by a right number: enumerating with a device of one's own does not extend it.
	const d = w.pend("192.168.1.26"), e = w.pend("192.168.1.27");
	w.access.lan.approve(off(d.number) === e.number ? off(e.number) : off(d.number));
	assert.ok(w.access.lan.approve(d.number));
	assert.equal(w.access.lan.pending().length, 1);
	w.access.lan.approve("9999" === e.number ? "9998" : "9999");
	assert.equal(w.access.lan.pending().length, 1, "that was the second wrong number since the set last emptied");
	w.access.lan.approve("9999" === e.number ? "9998" : "9999");
	assert.deepEqual(w.access.lan.pending(), [], "and the third");
});

test("the noise limit: 20 refusals from one peer in ten minutes give its unpaired requests 429 for ten minutes; an allowed device is never counted", () => {
	const w = world("noise");
	const cookie = w.pair("192.168.1.50"), noisy = atOf({ peer: "192.168.1.60" });
	const bad = () => w.page(undefined, {}, [""], noisy);
	for (let i = 0; i < 20; i++) assert.deepEqual(bad(), { status: 401 }, `refusal ${i + 1}`);
	assert.deepEqual(bad(), { status: 429 }, "the 21st");
	assert.deepEqual(w.access.lan.entry(req({}, "GET", noisy), noisy), { status: 429 });
	assert.deepEqual(w.access.lan.waiting(req({}, "GET", noisy), noisy), { status: 429 });
	assert.deepEqual(w.access.lan.redeem(post({}, noisy), "code=x", noisy), { status: 429 });
	assert.deepEqual(w.page(undefined, {}, [""], atOf({ peer: "192.168.1.61" })), { status: 401 }, "another peer is not limited");
	// An allowed device from the same address gets through, and is not counted.
	const same = atOf({ peer: "192.168.1.60" });
	assert.deepEqual(w.page(cookie, {}, [""], same), IN(cookie, same), "its cookie works from a limited address");
	w.clock.advance(10 * 60_000 - 1);
	assert.deepEqual(bad(), { status: 429 });
	w.clock.advance(2);
	assert.deepEqual(bad(), { status: 401 }, "after ten minutes it is judged again");
	// The paired device's requests do not count: a thousand of them, then a stranger's first is still a 401.
	const quiet = atOf({ peer: "192.168.1.70" }), c2 = w.pair("192.168.1.70");
	for (let i = 0; i < 100; i++) w.page(c2, { host: "evil.example:8445" }, [""], quiet);
	assert.deepEqual(w.page(c2, {}, [""], quiet), IN(c2, quiet), "an allowed device's refusals (a bad host) are not counted");
	// Refusals are spread over ten minutes: the window slides.
	const slow = atOf({ peer: "192.168.1.80" });
	for (let i = 0; i < 19; i++) w.page(undefined, {}, [""], slow);
	w.clock.advance(10 * 60_000 + 1);
	for (let i = 0; i < 19; i++) assert.deepEqual(w.page(undefined, {}, [""], slow), { status: 401 });
});

test("the LAN cookie is __Secure-sb_lan with the remote cookie's attributes, for the token's path and for the app entry, renewed by use at most hourly", () => {
	const w = world("cookie");
	const value = "a".repeat(64);
	assert.equal(lanCookieFor(T, value), `__Secure-sb_lan=${value}; Path=/${T}/; Max-Age=${90 * 24 * 3600}; HttpOnly; Secure; SameSite=Strict`);
	assert.equal(lanAppCookieFor(value), `__Secure-sb_lan=${value}; Path=/sb-app/; Max-Age=${90 * 24 * 3600}; HttpOnly; Secure; SameSite=Strict`);
	const cookie = w.pair(), at = (ms: number) => w.clock.advance(ms);
	assert.deepEqual(w.page(cookie), IN(cookie));
	at(30 * 60_000);
	assert.deepEqual(w.page(cookie), IN(cookie), "within the hour: no new cookie");
	at(31 * 60_000);
	assert.deepEqual(w.page(cookie), { ...IN(cookie), reissue: cookie }, "after an hour a use renews it and asks for the cookie again");
	assert.deepEqual(w.page(cookie), IN(cookie), "once");
	const seen = JSON.parse(readFileSync(w.lanFile, "utf8")).devices[sha(cookie)];
	assert.ok(seen.until > Date.now() + 89 * 24 * 3600_000, "and the expiry moved");
	at(91 * 24 * 3600_000);
	assert.deepEqual(w.page(cookie), { status: 401 }, "90 days unused ends it");
	assert.deepEqual(w.access.devices.list(), []);
});

test("the token is stored only hashed: lan.json holds the token's SHA-256 and the cookies' hashes, mode 600, and neither value", () => {
	const w = world("hashed");
	const cookie = w.pair();
	const text = readFileSync(w.lanFile, "utf8");
	assert.ok(!text.includes(T) && !text.includes(cookie), "neither the token nor the cookie is in the file");
	const saved = JSON.parse(text);
	assert.deepEqual(Object.keys(saved).sort(), ["devices", "port", "token", "v", "wanted"]);
	assert.deepEqual([saved.v, saved.token, saved.wanted, saved.port], [1, sha(T), true, 8445]);
	assert.deepEqual(Object.keys(saved.devices), [sha(cookie)]);
	assert.deepEqual(Object.keys(saved.devices[sha(cookie)]).sort(), ["host", "label", "paired", "seen", "until"]);
	assert.ok(!text.includes("Mozilla"), "no raw User-Agent");
	if (process.platform !== "win32") assert.equal(statSync(w.lanFile).mode & 0o777, 0o600);
	assert.equal(existsSync(w.file), false, "paired.json is not touched by a LAN pairing");
});

test("lan.json is bound to the token: a rotation, a lost store, or any start that does not keep it clears the LAN devices and keeps the wish, port, and CA-independent file", () => {
	const w = world("rotate");
	const cookie = w.pair();
	w.access.lan.setPort(8450);
	const same = w.open();
	assert.deepEqual([same.lan.wanted, same.lan.port, same.devices.list().length], [true, 8450, 1], "a restart under the same token keeps them");
	same.lan.enable();
	assert.deepEqual(same.check(req(jar(cookie)), "lan", HOST_PORT, T, [""], AT), IN(cookie));
	const other = w.open("u".repeat(32));
	assert.deepEqual(other.devices.list(), [], "another token's hash: no devices");
	assert.deepEqual([other.lan.wanted, other.lan.port], [true, 8450], "the wish and the port stay");
	assert.ok(w.logs.some(([e, f]) => e === "devices-cleared" && f.net === "lan"));
	assert.equal(JSON.parse(readFileSync(w.lanFile, "utf8")).token, sha("u".repeat(32)), "and the file is written again under the running token");
	other.lan.enable();
	assert.deepEqual(other.check(req(jar(cookie)), "lan", HOST_PORT, "u".repeat(32), [""], AT), { status: 401 });
	// The server's unpairAll (every start that does not keep the token) clears both stores.
	other.enable({ host: TS_HOST, login: LOGIN });
	const lanCookie = (() => {
		const at = atOf({ peer: "192.168.1.90" }), r = other.lan.redeem(post({}, at), `code=${other.pair("lan", "x")}`, at);
		assert.ok("cookie" in r);
		other.lan.approve(r.number);
		return r.cookie;
	})();
	const tailCookie = (other.check({ method: "GET", headers: { host: TS_HOST, "tailscale-user-login": LOGIN } } as unknown as IncomingMessage, "remote", 1234, "u".repeat(32), ["pair", other.pair()!]) as { cookie: string }).cookie;
	assert.deepEqual(other.devices.list().map((d) => d.net).sort(), ["lan", "tailnet"], "one list over both stores");
	const before = w.ended.length;
	assert.equal(other.devices.unpairAll(), 2);
	assert.deepEqual(w.ended.at(-1), [undefined, undefined], "every stream ends");
	assert.equal(w.ended.length, before + 1);
	assert.deepEqual(other.check(req(jar(lanCookie)), "lan", HOST_PORT, "u".repeat(32), [""], AT), { status: 401 });
	assert.deepEqual(w.open("u".repeat(32)).devices.list(), [], "and the file forgot them");
	assert.ok(tailCookie);
	// With no device left, no wish, and the default port, the file goes.
	other.lan.disable();
	other.lan.setPort(8445);
	assert.equal(existsSync(w.lanFile), false);
	other.lan.setPort(8450);
	assert.equal(existsSync(w.lanFile), true, "a port moved off the default is remembered even while off");
});

test("Wi-Fi access off voids its codes and pending devices, ends only its streams, and keeps the allowed devices and (on a stop) the wish", () => {
	const w = world("off");
	const cookie = w.pair(), p = w.pend("192.168.1.99"), qr = w.access.pair("lan", "x")!, typed = w.access.pairCode("lan", "x")!;
	w.access.lan.disable(true);
	assert.deepEqual(w.ended.at(-1), [undefined, "lan"], "its streams end");
	assert.equal(w.access.lan.pending().length, 0, "pending devices are void");
	assert.equal(w.access.lan.wanted, true, "a stop keeps the wish");
	w.access.lan.enable();
	assert.deepEqual(w.page(cookie), IN(cookie), "an allowed device is still paired");
	assert.deepEqual(w.page(p.cookie), { status: 401 });
	assert.equal(w.access.lan.approve(p.number), undefined);
	const as = atOf({ peer: "192.168.1.98" });
	assert.deepEqual(w.access.lan.redeem(post({}, as), `code=${qr}`, as), { wrong: true }, "the QR code is void");
	assert.deepEqual(w.access.lan.redeem(post({}, as), `code=${typed}`, as), { wrong: true }, "and so is the typed code");
	w.access.lan.disable();
	assert.equal(w.access.lan.wanted, false, "off forgets the wish");
	assert.equal(JSON.parse(readFileSync(w.lanFile, "utf8")).wanted, false);
	assert.equal(w.access.lan.pending().length, 0);
});

test("the device list spans both stores, newest use first; Unpair names a device of either, and the ids are prefixes of their hashes", () => {
	const w = world("list");
	w.access.enable({ host: TS_HOST, login: LOGIN });
	const tailCookie = (w.access.check({ method: "GET", headers: { host: TS_HOST, "tailscale-user-login": LOGIN, "user-agent": IPHONE } } as unknown as IncomingMessage, "remote", 1234, T, ["pair", w.access.pair()!]) as { cookie: string }).cookie;
	w.clock.advance(1000);
	const lanCookie = w.pair();
	w.clock.advance(1000);
	const list = w.access.devices.list();
	assert.deepEqual(list.map((d) => [d.net, d.host]), [["lan", AT.host], ["tailnet", undefined]], "newest use first, each with its network");
	assert.ok(list.every((d) => /^[0-9a-f]{16}$/.test(d.id)));
	assert.deepEqual([list[0]!.id, list[1]!.id], [sha(lanCookie).slice(0, 16), sha(tailCookie).slice(0, 16)]);
	assert.equal(w.access.devices.unpair(list[0]!.id.slice(0, 3)), false, "too short a prefix names nothing");
	assert.equal(w.access.devices.unpair("0".repeat(16)), false);
	assert.equal(w.access.devices.unpair(list[0]!.id), true);
	assert.deepEqual(w.ended.at(-1), [sha(lanCookie), "lan"], "that device's streams end, on its network");
	assert.deepEqual(w.page(lanCookie), { status: 401 });
	assert.equal(w.access.devices.unpair(list[1]!.id), true);
	assert.deepEqual(w.ended.at(-1), [sha(tailCookie), "tailnet"]);
	assert.deepEqual(w.access.devices.list(), []);
	assert.equal(w.access.unsaved(), undefined);
});

test("the LAN allows a document subresource through to its ticket, and nothing else without a cookie; the document load and api/doc need the cookie", () => {
	const w = world("docs-check");
	const cookie = w.pair(), cap = "c".repeat(32), ticket = "d".repeat(32);
	assert.deepEqual(w.page(undefined, {}, ["doc", cap, ""]), { status: 401 }, "the document load needs the cookie");
	assert.deepEqual(w.page(undefined, {}, ["doc", cap]), { status: 401 });
	assert.deepEqual(w.page(undefined, {}, ["api", "doc", cap]), { status: 401 }, "and so does api/doc");
	assert.deepEqual(w.page(undefined, {}, ["doc", cap, "style.css"]), { status: 401 }, "the ticketless form");
	assert.deepEqual(w.page(undefined, {}, ["doc", cap, "answer", "n".repeat(32)]), { status: 401 });
	assert.deepEqual(w.page(undefined, {}, ["doc", cap, "r", ticket, "style.css"]), { origin: AT.origin, remote: true, net: "lan" }, "a subresource under a ticket is the ticket's to judge");
	assert.deepEqual(w.page(undefined, {}, ["doc", cap, "r", ticket, ""]), { origin: AT.origin, remote: true, net: "lan" });
	assert.deepEqual(w.page(undefined, {}, ["doc", cap, "r"]), { status: 401 });
	assert.deepEqual(w.page(undefined, {}, ["w", cap, "r", ticket, "x"]), { status: 401 }, "only /doc/ has this way in");
	assert.deepEqual(w.page(undefined, {}, ["api", cap, "r", ticket, "x"]), { status: 401 });
	assert.deepEqual(w.page(undefined, {}, ["events"]), { status: 401 });
	assert.deepEqual(w.page(cookie, {}, ["doc", cap, ""]), IN(cookie));
	assert.deepEqual(w.page(cookie, {}, ["api", "doc", cap]), IN(cookie));
	assert.deepEqual(w.page(undefined, {}, ["pair", "x".repeat(22)]), { status: 401 }, "a token-bearing /pair/ link is no way in on the LAN");
});
