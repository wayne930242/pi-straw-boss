import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultRouteSource, eligible, isTunnel, peerAllowed, privatePeer, snapshotOf, watchAddresses, type Change, type InterfaceInfo, type Interfaces } from "../src/lan/net.ts";
import { fakeClock } from "./fake-clock.ts";

// Which addresses Wi-Fi access serves and who may connect (docs/specs/2026-10-30-sb-gui-lan.md, "Which addresses are served", "The connection gate", "IPv6", "Address changes"). Every case is a table of
// interfaces handed in; nothing here reads this computer's network or binds a socket.

const MAC = "02:00:00:00:00:00", ZERO = "00:00:00:00:00:00";
const v4 = (address: string, prefix: number, o: Partial<InterfaceInfo> = {}): InterfaceInfo => ({ address, netmask: "", family: "IPv4", mac: MAC, internal: false, cidr: `${address}/${prefix}`, ...o });
const served = (table: Interfaces) => eligible(table).map((s) => `${s.address}/${s.prefix}@${s.iface}`);

test("an RFC 1918 address on a normal interface is served, with its interface and prefix", () => {
	assert.deepEqual(served({ en0: [v4("192.168.1.5", 24)] }), ["192.168.1.5/24@en0"]);
	assert.deepEqual(served({ en0: [v4("10.1.2.3", 8)] }), ["10.1.2.3/8@en0"]);
	assert.deepEqual(served({ en0: [v4("172.16.5.5", 12)] }), ["172.16.5.5/12@en0"]);
	assert.deepEqual(served({ en0: [v4("172.31.255.1", 16)] }), ["172.31.255.1/16@en0"]);
	assert.deepEqual(served({ en0: [v4("172.20.10.2", 28)] }), ["172.20.10.2/28@en0"], "the iPhone hotspot's /28");
	assert.deepEqual(served({ en0: [v4("192.168.50.2", 30)] }), ["192.168.50.2/30@en0"], "/30 is the longest prefix served");
});

test("the prefix must lie inside the address's own block and be at most /30", () => {
	assert.deepEqual(served({ en0: [v4("192.168.1.5", 1)] }), [], "a rogue DHCP server's /1");
	assert.deepEqual(served({ en0: [v4("10.1.2.3", 7)] }), []);
	assert.deepEqual(served({ en0: [v4("192.168.1.5", 15)] }), [], "192.168/16 needs at least /16");
	assert.deepEqual(served({ en0: [v4("192.168.1.5", 16)] }), ["192.168.1.5/16@en0"]);
	assert.deepEqual(served({ en0: [v4("172.20.1.1", 11)] }), [], "172.16/12 needs at least /12");
	assert.deepEqual(served({ en0: [v4("172.20.1.1", 0)] }), []);
	assert.deepEqual(served({ en0: [v4("192.168.1.5", 31)] }), []);
	assert.deepEqual(served({ en0: [v4("192.168.1.5", 32)] }), []);
});

test("the prefix is read from the netmask when there is no cidr, and a netmask that is not a prefix is refused", () => {
	assert.deepEqual(served({ en0: [v4("192.168.1.5", 24, { cidr: null, netmask: "255.255.255.0" })] }), ["192.168.1.5/24@en0"]);
	assert.deepEqual(served({ en0: [v4("192.168.1.5", 24, { cidr: undefined, netmask: "255.255.255.0" })] }), ["192.168.1.5/24@en0"]);
	assert.deepEqual(served({ en0: [v4("192.168.1.5", 24, { cidr: null, netmask: "255.0.255.0" })] }), [], "not contiguous");
	assert.deepEqual(served({ en0: [v4("192.168.1.5", 24, { cidr: null, netmask: "" })] }), [], "no prefix at all");
	assert.deepEqual(served({ en0: [v4("192.168.1.5", 24, { cidr: "192.168.1.5/99", netmask: "" })] }), []);
});

test("a tunnel is never served: an all-zero hardware address, or a /31 or /32 point-to-point prefix", () => {
	assert.deepEqual(served({ utun4: [v4("172.16.0.2", 32, { mac: ZERO })] }), []);
	assert.deepEqual(served({ utun4: [v4("172.16.0.2", 24, { mac: ZERO })] }), [], "zero hardware address alone");
	assert.deepEqual(served({ wg0: [v4("10.8.0.2", 24, { mac: "00:00:00:00:00:00" })] }), []);
	assert.deepEqual(served({ ppp0: [v4("192.168.7.2", 32)] }), [], "/32 on a normal hardware address");
	assert.deepEqual(served({ tun0: [v4("10.8.0.2", 31)] }), [], "/31");
	assert.ok(isTunnel(v4("172.16.0.2", 32, { mac: ZERO })) && isTunnel(v4("10.0.0.2", 31)) && !isTunnel(v4("192.168.1.5", 24)));
	assert.ok(!isTunnel(v4("192.168.1.5", 24, { mac: "aa:bb:cc:00:00:01" })), "a real hardware address with zero bytes in it is no tunnel");
	assert.ok(isTunnel(v4("10.0.0.2", 24, { mac: "" })), "no hardware address at all is not trusted");
});

test("not served: loopback, internal, Tailscale's 100.64/10, link-local, public, and every IPv6 address", () => {
	assert.deepEqual(served({ lo0: [v4("127.0.0.1", 8, { internal: true })] }), []);
	assert.deepEqual(served({ en0: [v4("192.168.1.5", 24, { internal: true })] }), [], "an internal interface is not served even at a private address");
	assert.deepEqual(served({ utun3: [v4("100.101.102.103", 32, { mac: ZERO })], en1: [v4("100.64.0.1", 10)] }), [], "100.64.0.0/10 is not RFC 1918");
	assert.deepEqual(served({ en0: [v4("169.254.7.7", 16)] }), []);
	assert.deepEqual(served({ en0: [v4("8.8.8.8", 24), v4("172.15.255.1", 24), v4("172.32.0.1", 24), v4("11.0.0.1", 8), v4("192.167.1.1", 24), v4("192.169.1.1", 24)] }), []);
	for (const address of ["fd00::1", "fe80::1", "2001:db8::1", "::1", "::ffff:192.168.1.5"]) {
		assert.deepEqual(served({ en0: [{ address, netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", mac: MAC, internal: false, cidr: `${address}/64` }] }), [], address);
	}
	assert.deepEqual(served({ en0: [{ ...v4("192.168.1.5", 24), family: "IPv6" }] }), [], "the family says IPv6");
});

test("Node 18.0 to 18.3 reported the family as a number; it still counts as IPv4", () => {
	assert.deepEqual(served({ en0: [v4("192.168.1.5", 24, { family: 4 })] }), ["192.168.1.5/24@en0"]);
	assert.deepEqual(served({ en0: [v4("192.168.1.5", 24, { family: 6 })] }), []);
});

test("addresses that are not plain dotted decimal are refused", () => {
	for (const address of ["192.168.001.005", "192.168.1", "192.168.1.5.1", "192.168.1.256", "0xc0.168.1.5", " 192.168.1.5", ""]) assert.deepEqual(served({ en0: [v4(address, 24)] }), [], address);
});

test("several interfaces: a VM bridge beside the Wi-Fi is served too, in a stable order, and an address on two interfaces is served once", () => {
	const table: Interfaces = {
		utun4: [v4("172.16.0.2", 32, { mac: ZERO })], lo0: [v4("127.0.0.1", 8, { internal: true })],
		en0: [v4("192.168.1.5", 24), { address: "fe80::1", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", mac: MAC, internal: false, cidr: "fe80::1/64" }],
		bridge100: [v4("192.168.64.1", 24)], en5: [v4("10.0.5.9", 16), v4("192.168.1.5", 24)],
	};
	assert.deepEqual(served(table), ["192.168.64.1/24@bridge100", "192.168.1.5/24@en0", "10.0.5.9/16@en5"], "by interface name; 192.168.1.5 once, from en0");
	assert.deepEqual(served({ en0: undefined, en1: [] }), []);
});

test("the connection gate: a peer must be private IPv4 and on the listener's subnet", () => {
	const own = { address: "192.168.1.5", prefix: 24 };
	assert.ok(peerAllowed("192.168.1.77", own));
	assert.ok(peerAllowed("192.168.1.1", own) && peerAllowed("192.168.1.254", own));
	assert.ok(peerAllowed("192.168.1.5", own), "this computer's own address");
	assert.ok(!peerAllowed("192.168.2.77", own), "private, routed from another subnet");
	assert.ok(!peerAllowed("192.168.0.77", own));
	assert.ok(!peerAllowed("10.1.1.1", own), "another private block");
	assert.ok(!peerAllowed("8.8.8.8", own) && !peerAllowed("100.64.1.1", own) && !peerAllowed("169.254.1.1", own) && !peerAllowed("127.0.0.1", own));
	assert.ok(!peerAllowed("::ffff:192.168.1.77", own), "an IPv4-mapped IPv6 peer is not IPv4");
	assert.ok(!peerAllowed("fd00::1", own) && !peerAllowed("fe80::1", own));
	assert.ok(!peerAllowed(undefined, own) && !peerAllowed("", own) && !peerAllowed("192.168.1.077", own) && !peerAllowed("192.168.1.256", own));
	// The subnet is the prefix, whatever its length.
	const hotspot = { address: "172.20.10.2", prefix: 28 };
	assert.ok(peerAllowed("172.20.10.14", hotspot) && peerAllowed("172.20.10.1", hotspot));
	assert.ok(!peerAllowed("172.20.10.17", hotspot) && !peerAllowed("172.20.11.2", hotspot));
	const big = { address: "10.9.8.7", prefix: 8 };
	assert.ok(peerAllowed("10.200.0.1", big) && !peerAllowed("11.0.0.1", big));
	const wide = { address: "192.168.1.5", prefix: 16 };
	assert.ok(peerAllowed("192.168.200.1", wide) && !peerAllowed("192.169.0.1", wide));
});

test("a peer is private when it lies in 10/8, 172.16/12, or 192.168/16", () => {
	for (const peer of ["10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.255", "192.168.0.1", "192.168.255.255"]) assert.ok(privatePeer(peer), peer);
	for (const peer of ["9.255.255.255", "11.0.0.0", "172.15.255.255", "172.32.0.0", "192.167.255.255", "192.169.0.0", "127.0.0.1", "0.0.0.0", "255.255.255.255", "::1", "", undefined]) assert.ok(!privatePeer(peer), String(peer));
});

test("the default-route probe: a UDP socket is connected to a documentation address and reports its source; it sends nothing", async () => {
	// The loopback as the 'documentation address' makes the answer known; no packet is sent either way (connect on UDP only picks a route).
	assert.equal(await defaultRouteSource("127.0.0.1"), "127.0.0.1");
	assert.equal(await defaultRouteSource("999.1.1.1"), undefined, "an address that is no address: no route, no throw");
	assert.equal(await defaultRouteSource("not a host name at all, really"), undefined);
});

test("the default route's address is listed first, only for ordering: it never adds or removes an address", () => {
	const table: Interfaces = { en0: [v4("192.168.1.5", 24)], bridge100: [v4("192.168.64.1", 24)], en5: [v4("10.0.5.9", 16)] };
	const order = (source: string | undefined) => snapshotOf(table, source).served.map((s) => s.address);
	assert.deepEqual(order(undefined), ["192.168.64.1", "192.168.1.5", "10.0.5.9"]);
	assert.deepEqual(order("10.0.5.9"), ["10.0.5.9", "192.168.64.1", "192.168.1.5"]);
	assert.deepEqual(order("192.168.1.5"), ["192.168.1.5", "192.168.64.1", "10.0.5.9"]);
	assert.deepEqual(order("203.0.113.9"), order(undefined), "a source that is not served changes nothing");
	assert.deepEqual([...order("10.0.5.9")].sort(), [...order(undefined)].sort());
});

test("a full-tunnel VPN: the default route on a tunnel is told (lan_vpn), and the Wi-Fi address is still served", () => {
	const table: Interfaces = { utun4: [v4("172.16.0.2", 32, { mac: ZERO })], en0: [v4("192.168.50.197", 24)] };
	const vpn = snapshotOf(table, "172.16.0.2");
	assert.equal(vpn.vpn, true);
	assert.deepEqual(vpn.served.map((s) => s.address), ["192.168.50.197"], "the default-route rule that would serve nothing here was rejected");
	assert.equal(snapshotOf(table, "192.168.50.197").vpn, false);
	assert.equal(snapshotOf(table, undefined).vpn, false);
	assert.equal(snapshotOf({ lo0: [v4("127.0.0.1", 8, { internal: true })] }, "127.0.0.1").vpn, false, "loopback is not a tunnel");
	assert.equal(snapshotOf(table, "203.0.113.9").vpn, false, "a source that is on no interface");
});

// The 5 s watch ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

function world(table: Interfaces, probe: string | undefined = undefined) {
	const clock = fakeClock(1_000_000), changes: Change[] = [], errors: unknown[] = [];
	const state = { table, probe, failing: false, reads: 0, ticks: undefined as (() => void) | undefined, every: [] as number[], stopped: 0 };
	const watcher = watchAddresses({
		interfaces: () => {
			state.reads++;
			if (state.failing) throw new Error("uv_interface_addresses failed");
			return state.table;
		},
		probe: async () => state.probe,
		now: clock.now,
		every: (tick, ms) => {
			state.ticks = tick;
			state.every.push(ms);
			return () => state.stopped++;
		},
		onChange: (change) => changes.push(change),
		onError: (error) => errors.push(error),
	});
	/** One 5 s step: the clock moves and the tick runs. */
	const step = async (ms = 5000) => {
		clock.advance(ms);
		await watcher.tick();
	};
	return { state, watcher, changes, errors, clock, step };
}
const addresses = (list: { address: string }[]) => list.map((s) => s.address);

test("the watch reads a baseline at start without a callback, then ticks every 5 s", async () => {
	const w = world({ en0: [v4("192.168.1.5", 24)] });
	const first = await w.watcher.start();
	assert.deepEqual(addresses(first.served), ["192.168.1.5"]);
	assert.deepEqual(w.state.every, [5000]);
	assert.equal(w.changes.length, 0, "the baseline is not a change");
	assert.deepEqual(addresses(w.watcher.snapshot().served), ["192.168.1.5"]);
	await w.step();
	await w.step();
	assert.equal(w.changes.length, 0, "an unchanged network is silent");
	assert.equal(w.state.reads, 3);
});

test("a new address, a gone address, and a changed subnet are each one change that says which", async () => {
	const w = world({ en0: [v4("192.168.1.5", 24)] });
	await w.watcher.start();
	w.state.table = { en0: [v4("192.168.1.5", 24)], bridge100: [v4("192.168.64.1", 24)] };
	await w.step();
	assert.equal(w.changes.length, 1);
	assert.deepEqual([addresses(w.changes[0]!.added), addresses(w.changes[0]!.removed), addresses(w.changes[0]!.resized), w.changes[0]!.woke], [["192.168.64.1"], [], [], false]);
	assert.deepEqual(addresses(w.changes[0]!.snapshot.served), ["192.168.64.1", "192.168.1.5"]);
	assert.deepEqual(addresses(w.changes[0]!.previous.served), ["192.168.1.5"]);

	w.state.table = { en0: [v4("192.168.1.5", 16)], bridge100: [v4("192.168.64.1", 24)] };
	await w.step();
	assert.deepEqual([addresses(w.changes[1]!.added), addresses(w.changes[1]!.removed), addresses(w.changes[1]!.resized)], [[], [], ["192.168.1.5"]], "the same address with a new prefix: its gate is updated");
	assert.equal(w.changes[1]!.resized[0]!.prefix, 16);

	w.state.table = { en0: [v4("192.168.1.9", 24)] };
	await w.step();
	assert.deepEqual([addresses(w.changes[2]!.added), addresses(w.changes[2]!.removed)], [["192.168.1.9"], ["192.168.64.1", "192.168.1.5"]]);

	w.state.table = { en0: [] };
	await w.step();
	assert.deepEqual([addresses(w.changes[3]!.snapshot.served), addresses(w.changes[3]!.removed)], [[], ["192.168.1.9"]], "no private address left: nothing is served");
	assert.equal(w.changes.length, 4);
});

test("the same address moving to another interface is a change of that address, not of the list", async () => {
	const w = world({ en0: [v4("192.168.1.5", 24)] });
	await w.watcher.start();
	w.state.table = { en1: [v4("192.168.1.5", 24)] };
	await w.step();
	assert.deepEqual([addresses(w.changes[0]!.added), addresses(w.changes[0]!.removed), addresses(w.changes[0]!.resized)], [[], [], ["192.168.1.5"]]);
	assert.equal(w.changes[0]!.resized[0]!.iface, "en1");
});

test("the default route moving reorders the list and is a change; the vpn fact flips with it", async () => {
	const w = world({ en0: [v4("192.168.1.5", 24)], en5: [v4("10.0.5.9", 16)], utun4: [v4("172.16.0.2", 32, { mac: ZERO })] }, "192.168.1.5");
	await w.watcher.start();
	assert.deepEqual(addresses(w.watcher.snapshot().served), ["192.168.1.5", "10.0.5.9"]);
	w.state.probe = "10.0.5.9";
	await w.step();
	assert.deepEqual(addresses(w.changes[0]!.snapshot.served), ["10.0.5.9", "192.168.1.5"]);
	assert.deepEqual([addresses(w.changes[0]!.added), addresses(w.changes[0]!.removed), w.changes[0]!.snapshot.vpn], [[], [], false]);
	w.state.probe = "172.16.0.2";
	await w.step();
	assert.equal(w.changes[1]!.snapshot.vpn, true, "a full-tunnel VPN came up");
	assert.deepEqual(addresses(w.changes[1]!.snapshot.served), ["192.168.1.5", "10.0.5.9"], "the tunnel is not served; by name again, since the source is not a served address");
	await w.step();
	assert.equal(w.changes.length, 2, "steady again");
	w.state.probe = undefined;
	await w.step();
	assert.equal(w.changes[2]!.snapshot.vpn, false);
});

test("a probe that fails is no route, not an error", async () => {
	const clock = fakeClock(), changes: Change[] = [], errors: unknown[] = [];
	const w = watchAddresses({ interfaces: () => ({ en0: [v4("192.168.1.5", 24)] }), probe: () => Promise.reject(new Error("ENETUNREACH")), now: clock.now, every: () => () => {}, onChange: (c) => changes.push(c), onError: (e) => errors.push(e) });
	assert.deepEqual(addresses((await w.start()).served), ["192.168.1.5"]);
	await w.tick();
	assert.deepEqual([changes.length, errors.length], [0, 0]);
});

test("a wall clock that jumps more than 30 s is a wake, reported even when nothing changed", async () => {
	const w = world({ en0: [v4("192.168.1.5", 24)] });
	await w.watcher.start();
	await w.step(5000);
	await w.step(29_000);
	assert.equal(w.changes.length, 0, "29 s is not a wake");
	await w.step(31_000);
	assert.equal(w.changes.length, 1);
	assert.equal(w.changes[0]!.woke, true);
	assert.deepEqual([w.changes[0]!.added, w.changes[0]!.removed, w.changes[0]!.resized], [[], [], []]);
	assert.deepEqual(addresses(w.changes[0]!.snapshot.served), ["192.168.1.5"], "the same addresses: the caller closes and binds every listener again");
	await w.step(5000);
	assert.equal(w.changes.length, 1, "and it is over");
	// A wake with a change reports both.
	w.state.table = { en0: [v4("192.168.1.9", 24)] };
	await w.step(3_600_000);
	assert.deepEqual([w.changes[1]!.woke, addresses(w.changes[1]!.added)], [true, ["192.168.1.9"]]);
});

test("the first tick after start measures from the start, not from construction", async () => {
	const w = world({ en0: [v4("192.168.1.5", 24)] });
	w.clock.advance(10 * 60_000);
	await w.watcher.start();
	await w.step(5000);
	assert.equal(w.changes.length, 0);
});

test("a read that throws keeps the last snapshot and is reported, and the next good read carries on", async () => {
	const w = world({ en0: [v4("192.168.1.5", 24)] });
	await w.watcher.start();
	w.state.failing = true;
	await w.step();
	assert.equal(w.errors.length, 1);
	assert.match((w.errors[0] as Error).message, /uv_interface_addresses/);
	assert.deepEqual(addresses(w.watcher.snapshot().served), ["192.168.1.5"], "listeners keep serving what was served");
	assert.equal(w.changes.length, 0);
	w.state.failing = false;
	w.state.table = { en0: [v4("192.168.1.5", 24)], en1: [v4("10.0.0.7", 24)] };
	await w.step();
	assert.deepEqual(addresses(w.changes[0]!.added), ["10.0.0.7"]);
});

test("a callback that throws is reported and does not stop the watch", async () => {
	const clock = fakeClock(), errors: unknown[] = [];
	let table: Interfaces = { en0: [v4("192.168.1.5", 24)] };
	const w = watchAddresses({ interfaces: () => table, probe: async () => undefined, now: clock.now, every: () => () => {}, onChange: () => { throw new Error("listener bind failed"); }, onError: (e) => errors.push(e) });
	await w.start();
	table = { en0: [v4("192.168.1.9", 24)] };
	await w.tick();
	assert.equal(errors.length, 1);
	assert.deepEqual(addresses(w.snapshot().served), ["192.168.1.9"], "the snapshot moved on, so the same change is not reported every 5 s");
	await w.tick();
	assert.equal(errors.length, 1);
});

test("ticks are single-flight: a tick that is still reading is the one a second call gets", async () => {
	const clock = fakeClock(), changes: Change[] = [];
	let release!: () => void, probes = 0;
	const w = watchAddresses({
		interfaces: () => ({ en0: [v4("192.168.1.5", 24)], bridge100: [v4("192.168.64.1", 24)] }), now: clock.now, every: () => () => {}, onChange: (c) => changes.push(c),
		probe: () => (++probes === 1 ? Promise.resolve(undefined) : new Promise((resolve) => (release = () => resolve("192.168.1.5")))),
	});
	await w.start();
	const a = w.tick(), b = w.tick();
	assert.equal(a, b);
	await new Promise((resolve) => setImmediate(resolve));
	release();
	await a;
	assert.equal(probes, 2, "one probe for two calls");
	assert.equal(changes.length, 1, "the default source appeared and moved its address first");
});

test("stop ends the timer and a tick that was in flight reports nothing", async () => {
	const w = world({ en0: [v4("192.168.1.5", 24)] });
	await w.watcher.start();
	w.state.table = { en0: [v4("192.168.1.9", 24)] };
	const pending = w.watcher.tick();
	w.watcher.stop();
	await pending;
	assert.equal(w.state.stopped, 1);
	assert.equal(w.changes.length, 0);
});

test("the default timer is unref'd, so the watch alone never keeps a process alive", async () => {
	const w = watchAddresses({ interfaces: () => ({}), probe: async () => undefined, intervalMs: 3_600_000, onChange: () => {} });
	await w.start();
	w.stop();
	assert.deepEqual(w.snapshot().served, []);
});
