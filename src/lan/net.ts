import { createSocket } from "node:dgram";

// Which addresses of this computer Wi-Fi access serves, who may connect to them, and how a change is noticed (docs/specs/2026-10-30-sb-gui-lan.md, "Which addresses are served", "The connection gate", "IPv6", "Address changes").
// Everything here is a function of the interface list it is given (`os.networkInterfaces()` in production, a table in a test); nothing here binds a socket.

/** The part of `os.networkInterfaces()` an entry is judged by. `family` is the text `"IPv4"` or, on Node 18.0 to 18.3, the number 4. */
export interface InterfaceInfo { address: string; netmask?: string; family: string | number; mac: string; internal: boolean; cidr?: string | null }
export type Interfaces = Record<string, InterfaceInfo[] | undefined>;
/** One address Wi-Fi access serves: the address, the interface it is on, and its prefix length (the subnet a peer must be in). */
export interface Served { address: string; iface: string; prefix: number }

/** The private blocks and the shortest prefix an address in each may carry: a rogue DHCP server's wider netmask makes the subnet cover more than the block. */
const BLOCKS: readonly [base: number, blockPrefix: number][] = [[0x0a000000, 8], [0xac100000, 12], [0xc0a80000, 16]];
const OCTET = "(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const DOTTED = new RegExp(`^${OCTET}(\\.${OCTET}){3}$`);
const MAX_PREFIX = 30;

/** An IPv4 address in dotted decimal as a 32-bit number, or undefined for any other text (a leading zero, an IPv6 address, an IPv4-mapped one). */
const toInt = (text: string | undefined): number | undefined => (typeof text === "string" && DOTTED.test(text) ? text.split(".").reduce((n, part) => n * 256 + Number(part), 0) : undefined);
const maskOf = (prefix: number) => (prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0);
const sameSubnet = (a: number, b: number, prefix: number) => ((a ^ b) & maskOf(prefix)) >>> 0 === 0;
/** The private block an address lies in, or undefined. */
const blockOf = (address: number) => BLOCKS.find(([base, prefix]) => sameSubnet(address, base, prefix));

/** The prefix length of an entry: from its `cidr`, else from a contiguous `netmask`; undefined when neither says. */
function prefixOf(info: InterfaceInfo): number | undefined {
	const fromCidr = /^[^/]+\/(\d{1,2})$/.exec(info.cidr ?? "")?.[1];
	if (fromCidr !== undefined && Number(fromCidr) <= 32) return Number(fromCidr);
	const mask = toInt(info.netmask);
	if (mask === undefined) return undefined;
	for (let prefix = 0; prefix <= 32; prefix++) if (maskOf(prefix) === mask) return prefix;
	return undefined;
}
const isV4 = (info: InterfaceInfo) => info.family === "IPv4" || info.family === 4;

/** A tunnel interface: a hardware address of all zeros (`utun`, `tun`, `wg`, `ppp`, Wintun), or a point-to-point prefix (`/31`, `/32`). */
export function isTunnel(info: InterfaceInfo): boolean {
	const prefix = prefixOf(info);
	return /^[0:.-]*$/.test(info.mac) || (prefix !== undefined && prefix >= 31);
}

/**
 * The addresses to serve, one listener each: IPv4 in `10/8`, `172.16/12`, or `192.168/16`; on an interface that is neither internal nor a tunnel; with a prefix at least as long as its block's and at most `/30`.
 * Never loopback, `100.64.0.0/10` (Tailscale's), `169.254/16`, a public address, any IPv6 address, or a netmask made wider than the block. An address on two interfaces is served once, from the first by name.
 */
export function eligible(interfaces: Interfaces): Served[] {
	const out: Served[] = [], seen = new Set<string>();
	for (const iface of Object.keys(interfaces).sort()) {
		for (const info of interfaces[iface] ?? []) {
			const address = toInt(info.address), prefix = prefixOf(info), block = address === undefined ? undefined : blockOf(address);
			if (!isV4(info) || info.internal || address === undefined || !block || prefix === undefined || isTunnel(info) || prefix < block[1] || prefix > MAX_PREFIX || seen.has(info.address)) continue;
			seen.add(info.address);
			out.push({ address: info.address, iface, prefix });
		}
	}
	return out;
}

/** Whether a peer address is private IPv4 (the gate's first rule): a public, loopback, link-local, IPv6, or IPv4-mapped address is not. */
export const privatePeer = (peer: string | undefined): boolean => {
	const n = toInt(peer);
	return n !== undefined && blockOf(n) !== undefined;
};
/** The connection gate: the peer is private and on the served address's subnet. A routed peer is refused even when its address is in a private range. */
export function peerAllowed(peer: string | undefined, served: Pick<Served, "address" | "prefix">): boolean {
	const n = toInt(peer), own = toInt(served.address);
	return n !== undefined && own !== undefined && blockOf(n) !== undefined && sameSubnet(n, own, served.prefix);
}

/**
 * The source address of the default route: a UDP socket `connect`ed to a documentation address (no packet is sent) reports it. This only orders the address form (the one on the default route first) and tells
 * a tunnel from the default route (`lan_vpn`); it never decides what is served, since a full-tunnel VPN puts the tunnel there. Undefined when there is no route.
 */
export function defaultRouteSource(target = "192.0.2.1"): Promise<string | undefined> {
	return new Promise((resolve) => {
		let socket: ReturnType<typeof createSocket> | undefined;
		const done = (value?: string) => {
			try { socket?.close(); } catch {} // already closed
			resolve(value && value !== "0.0.0.0" ? value : undefined);
		};
		try {
			socket = createSocket("udp4");
			socket.once("error", () => done());
			socket.connect(9, target, () => {
				try { done(socket!.address().address); } catch { done(); }
			});
		} catch {
			done();
		}
	});
}

export interface Snapshot {
	/** The addresses served, the one on the default route first (when it is served), then by interface name and address. */
	served: Served[];
	/** The default route's source address, when the probe found one. */
	defaultSource: string | undefined;
	/** The default route is on a tunnel interface: a VPN carries this computer's traffic, and may block the local network (`lan_vpn`). */
	vpn: boolean;
}
export function snapshotOf(interfaces: Interfaces, defaultSource: string | undefined): Snapshot {
	const served = eligible(interfaces).sort((a, b) => Number(b.address === defaultSource) - Number(a.address === defaultSource));
	const vpn = defaultSource !== undefined && Object.values(interfaces).some((list) => list?.some((info) => info.address === defaultSource && !info.internal && isTunnel(info)));
	return { served, defaultSource, vpn };
}

export interface Change {
	snapshot: Snapshot;
	previous: Snapshot;
	/** Addresses new to the served list. */
	added: Served[];
	/** Addresses gone from it. */
	removed: Served[];
	/** Addresses still served whose subnet (prefix) or interface changed: the listener's gate is updated. */
	resized: Served[];
	/** The wall clock moved more than `wakeMs` since the last tick (a sleep and wake): every listener is closed and bound again. */
	woke: boolean;
}
export interface WatchDeps {
	interfaces: () => Interfaces;
	/** The default route's source address; defaults to `defaultRouteSource`. A rejection counts as no route. */
	probe?: () => Promise<string | undefined>;
	now?: () => number;
	/** Runs `tick` every `ms` until the returned function is called. Default: an unref'd `setInterval`. */
	every?: (tick: () => void, ms: number) => () => void;
	intervalMs?: number;
	wakeMs?: number;
	/** Called when the served list, its order, a subnet, or the `vpn` fact changed, or on a wake. */
	onChange: (change: Change) => void;
	/** A failed read of the interfaces, or an error thrown by `onChange`; the last snapshot stands. */
	onError?: (error: unknown) => void;
}
export interface Watcher {
	/** Reads once (the baseline, with no callback), then ticks every interval. */
	start(): Promise<Snapshot>;
	/** One tick now (single-flight: a tick that is still running is the one returned). The timer calls this. */
	tick(): Promise<void>;
	snapshot(): Snapshot;
	stop(): void;
}
const keyOf = (s: Snapshot) => JSON.stringify([s.served, s.vpn]);

/** The 5 s watch: reads the interfaces, tells what changed, and notices a wake by the wall clock. Nothing is bound or closed here; the caller acts on the change. */
export function watchAddresses(deps: WatchDeps): Watcher {
	const now = deps.now ?? Date.now, probe = deps.probe ?? (() => defaultRouteSource()), intervalMs = deps.intervalMs ?? 5000, wakeMs = deps.wakeMs ?? 30_000;
	let current: Snapshot = { served: [], defaultSource: undefined, vpn: false }, last = now(), stopTimer: (() => void) | undefined, running: Promise<void> | undefined, stopped = false;
	const read = async (): Promise<Snapshot> => snapshotOf(deps.interfaces(), await probe().catch(() => undefined));
	const run = async () => {
		const woke = now() - last > wakeMs;
		last = now();
		let next: Snapshot;
		try {
			next = await read();
		} catch (error) {
			deps.onError?.(error);
			return;
		}
		if (stopped) return;
		const previous = current, at = new Map(previous.served.map((s) => [s.address, s]));
		const added = next.served.filter((s) => !at.has(s.address)), removed = previous.served.filter((s) => !next.served.some((n) => n.address === s.address));
		const resized = next.served.filter((s) => {
			const was = at.get(s.address);
			return was !== undefined && (was.prefix !== s.prefix || was.iface !== s.iface);
		});
		current = next;
		if (woke || keyOf(previous) !== keyOf(next)) {
			try { deps.onChange({ snapshot: next, previous, added, removed, resized, woke }); } catch (error) { deps.onError?.(error); }
		}
	};
	return {
		async start() {
			current = await read();
			last = now();
			stopTimer = (deps.every ?? ((tick, ms) => {
				const timer = setInterval(tick, ms);
				timer.unref();
				return () => clearInterval(timer);
			}))(() => void this.tick(), intervalMs);
			return current;
		},
		tick() {
			running ??= run().finally(() => (running = undefined));
			return running;
		},
		snapshot: () => current,
		stop() {
			stopped = true;
			stopTimer?.();
		},
	};
}
