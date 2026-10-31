import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { createServer as createNetServer, type AddressInfo, type Server as NetServer, type Socket } from "node:net";
import { networkInterfaces } from "node:os";
import { createSecureContext, TLSSocket, type SecureContext } from "node:tls";
import { zhOf } from "../appentry.ts";
import { CA_FILES, CA_MIME, caStatus, crt, issueLeafFor, leafNeedsRenewal, mobileconfig, type LanCa, type Leaf } from "./ca.ts";
import { peerAllowed, watchAddresses, type Change, type Interfaces, type Served, type Snapshot, type Watcher } from "./net.ts";

// The LAN listeners (docs/specs/2026-10-30-sb-gui-lan.md, "The LAN listeners", "One port, two protocols", "Address changes", "Leaves", "The certificate page"): one `net.Server` per served address, each answering on one port in two
// protocols. A connection is judged by the gate before a byte is read, then by its first byte: 0x16 (a TLS handshake record) goes to TLS under that address's leaf and on to the GUI's handler, anything else goes to a plain HTTP side
// that answers the certificate pages and nothing else. This file speaks no pairing, holds no token, and reads no cookie: whoever uses it gives it the GUI's handler and, to sort the connection pools, a test of "this request carries an allowed device's cookie".
// It never changes a firewall and never binds an address it was not given by `interfaces` (`bindAddress` maps a served address to the address bound; a test maps every one to 127.0.0.1).

export const LIMITS: Readonly<{ unpairedPerPeer: number; unpairedAll: number; pairedPerPeer: number; pairedAll: number }> = { unpairedPerPeer: 8, unpairedAll: 64, pairedPerPeer: 32, pairedAll: 256 };
/** Timers, in milliseconds: the first byte, the TLS handshake, the request line and headers, the whole request, how often a refusal or a limit is logged, and how long a peer address that proved itself paired is remembered. */
export const TIMEOUTS: Readonly<{ firstByteMs: number; handshakeMs: number; headersMs: number; requestMs: number; logMs: number; pairedPeerMs: number }> = { firstByteMs: 10_000, handshakeMs: 10_000, headersMs: 10_000, requestMs: 30_000, logMs: 60_000, pairedPeerMs: 86_400_000 };
/** The most peer addresses remembered as paired; the oldest is forgotten past it. */
const PAIRED_PEERS_MAX = 1024;
export const BIND_WAIT_MS = 5000;
const TLS_HANDSHAKE = 0x16;

/** What the handler is told about the listener a request came in on. `host` is the allow-listed `Host` value without its port, `origin` the origin the page's writes must carry. */
export interface At { address: string; iface: string; port: number; name: string | null; host: string; origin: string; peer: string | undefined }
export type LanHandler = (req: IncomingMessage, res: ServerResponse, at: At) => void;
export type Log = (event: string, fields: Record<string, unknown>) => void;

export interface ListenerOptions {
	/** The CA whose leaves the listeners serve; `setCa` replaces it. */
	ca: LanCa;
	/** The port every listener binds. 0 lets the system pick one for the first listener and the others follow it. */
	port: number;
	/** The GUI's handler of kind `lan`, called for every TLS request whose `Host` is allow-listed and that is not a certificate page. */
	handler: LanHandler;
	/** Whether a request carries an allowed device's cookie: its connection then moves to the paired pool. Default: never. */
	isPaired?: (req: IncomingMessage, at: At) => boolean;
	/** The interface list; default `os.networkInterfaces()`. */
	interfaces?: () => Interfaces;
	/** The address a served address is bound on; default: itself. A test binds 127.0.0.1 whatever it serves. */
	bindAddress?: (served: Served) => string;
	/** The peer a connection counts as, for the gate and the pools; default `socket.remoteAddress`. */
	remoteOf?: (socket: Socket) => string | undefined;
	log?: Log;
	/** Called when the status changed (a listener opened or closed, a bind failed, the CA ended, the served list changed). */
	onStatus?: (status: ListenerStatus) => void;
	/** The default route's source address (`net.ts` `defaultRouteSource`). */
	probe?: () => Promise<string | undefined>;
	now?: () => number;
	/** Runs `tick` every `ms` until the returned function is called; default an unref'd `setInterval`. */
	every?: (tick: () => void, ms: number) => () => void;
	/** Runs `fn` once after `ms`; returns a cancel. Default an unref'd `setTimeout`. Every timer of a connection goes through it. */
	after?: (fn: () => void, ms: number) => () => void;
	/** Waits `ms` between bind retries. Default `after`. */
	sleep?: (ms: number) => Promise<void>;
	/** Binds `server` to `host:port` (the seam a test injects bind errors through). */
	listen?: (server: NetServer, port: number, host: string) => Promise<void>;
	/** Issues the leaf for an address; default `issueLeafFor`. */
	issue?: (ca: LanCa, address: string, now: number) => Leaf;
	/** How long a start retries a port that is taken before it gives that address up; default 5 s. */
	bindWaitMs?: number;
	intervalMs?: number;
	/** A wall-clock jump past this many ms between two watch ticks counts as a wake; default 30 s. */
	wakeMs?: number;
	timeouts?: Partial<typeof TIMEOUTS>;
	limits?: Partial<typeof LIMITS>;
}

export type AddressState = "open" | "taken" | "retry" | "error";
export interface ListenerStatus {
	/** Listeners exist: Wi-Fi access is serving, and not ended with the CA. */
	on: boolean;
	/** The CA's time has passed: nothing is bound until `setCa` gives a new one. */
	caEnded: boolean;
	/** The port the listeners bind, once known. */
	port: number | undefined;
	/** One row per served address: `open` (listening), `taken` (EADDRINUSE after the wait), `retry` (not bound yet, tried again at the next watch), `error` (another bind error, `code`). */
	addresses: { address: string; iface: string; prefix: number; state: AddressState; code?: string }[];
	/** The interfaces have no address to serve. */
	noAddress: boolean;
	/** The default route is on a tunnel: a VPN may block the local network. */
	vpn: boolean;
}
export interface LanListener {
	/** Reads the interfaces once, issues a leaf per served address, binds them (retrying a taken port), and starts the watch. */
	start(): Promise<ListenerStatus>;
	/** One watch tick now: reads the interfaces, applies the change, reissues a leaf that is ending. The timer calls this. */
	tick(): Promise<void>;
	/** Replaces the CA (a renewal or a reset): every connection ends and every leaf is reissued on the same port. A CA that has ended keeps nothing bound. */
	setCa(ca: LanCa): Promise<void>;
	status(): ListenerStatus;
	/** The actual bound port of an address, when it is listening. */
	portOf(address: string): number | undefined;
	stop(): Promise<void>;
}

/** A connection in a pool. `paired` is the pool it is counted in; `proven` says one of its requests carried an allowed device's cookie (a connection of a remembered peer address is counted paired before it has proven anything). `requests` counts the requests it has made. */
interface Conn { peer: string; paired: boolean; proven: boolean; requests: number; at: number; kill: () => void }
interface Entry {
	served: Served;
	leaf: Leaf;
	context: SecureContext;
	https: HttpServer;
	plain: HttpServer;
	server?: NetServer;
	port?: number;
	/** Every socket (raw and TLS) of this listener, to end with it. */
	sockets: Set<Socket>;
	state: AddressState;
	code?: string;
}

const errorCode = (error: unknown) => String((error as NodeJS.ErrnoException)?.code ?? "unknown");

export function createLanListener(options: ListenerOptions): LanListener {
	const log: Log = options.log ?? (() => {}), now = options.now ?? Date.now, limits = { ...LIMITS, ...options.limits }, timeouts = { ...TIMEOUTS, ...options.timeouts };
	const after = options.after ?? ((fn, ms) => {
		const timer = setTimeout(fn, ms);
		timer.unref();
		return () => clearTimeout(timer);
	});
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => void after(done, ms)));
	const bindAddress = options.bindAddress ?? ((served: Served) => served.address), remoteOf = options.remoteOf ?? ((socket: Socket) => socket.remoteAddress), isPaired = options.isPaired ?? (() => false);
	const issue = options.issue ?? issueLeafFor, bindWaitMs = options.bindWaitMs ?? BIND_WAIT_MS;
	const listen = options.listen ?? ((server: NetServer, port: number, host: string) => new Promise<void>((done, fail) => {
		server.once("error", fail);
		server.listen(port, host, () => (server.off("error", fail), done()));
	}));
	let ca = options.ca, port = options.port, ended = caStatus(ca, now()).state === "ended", stopped = false, started = false, wakePending = false, lastKey = "";
	const entries = new Map<string, Entry>(), pool = new Set<Conn>(), connOf = new WeakMap<Socket, Conn>();
	const watcher: Watcher = watchAddresses({
		interfaces: options.interfaces ?? (() => networkInterfaces() as Interfaces),
		probe: options.probe,
		now,
		every: () => () => {}, // the listener ticks itself: a tick also reissues leaves and rebinds
		intervalMs: options.intervalMs,
		wakeMs: options.wakeMs,
		onChange: (change) => {
			if (change.woke) wakePending = true;
			logAddresses(change);
		},
		onError: (error) => log("lan-addresses", { error: error instanceof Error ? error.message : String(error) }),
	});

	// Rate-limited log lines: one a minute, with the counts (a flood must not fill the log).
	let refused = 0, cancelRefused: (() => void) | undefined, closed = 0, limitedPeers = new Set<string>(), cancelLimited: (() => void) | undefined;
	const flushRefused = () => {
		cancelRefused?.();
		cancelRefused = undefined;
		if (refused) log("lan-refused", { n: refused });
		refused = 0;
	};
	const flushLimited = () => {
		cancelLimited?.();
		cancelLimited = undefined;
		if (closed) log("lan-limited", { closed, peers: limitedPeers.size });
		closed = 0;
		limitedPeers = new Set();
	};
	const noteRefused = () => {
		refused++;
		cancelRefused ??= after(flushRefused, timeouts.logMs);
	};
	let acceptErrors = 0, acceptCodes = new Set<string>(), cancelAccept: (() => void) | undefined;
	const flushAccept = () => {
		cancelAccept?.();
		cancelAccept = undefined;
		if (acceptErrors) log("lan-accept-error", { n: acceptErrors, codes: [...acceptCodes] });
		acceptErrors = 0;
		acceptCodes = new Set();
	};
	function noteAcceptError(error: unknown) {
		acceptErrors++;
		acceptCodes.add(errorCode(error));
		if (!stopped) cancelAccept ??= after(flushAccept, timeouts.logMs);
	}
	const noteLimited = (peer: string) => {
		closed++;
		limitedPeers.add(peer);
		cancelLimited ??= after(flushLimited, timeouts.logMs);
	};

	const describe = (s: Served) => `${s.address} (${s.iface})`;
	function logAddresses(change?: Pick<Change, "snapshot">) {
		const snapshot: Snapshot = change?.snapshot ?? watcher.snapshot();
		log("lan-addresses", { count: snapshot.served.length, addresses: snapshot.served.map(describe) });
	}

	function status(): ListenerStatus {
		const snapshot = watcher.snapshot();
		return {
			on: started && !stopped && !ended && [...entries.values()].some((e) => e.server),
			caEnded: ended,
			port: port || undefined,
			addresses: snapshot.served.map((s) => {
				const e = entries.get(s.address);
				return { address: s.address, iface: s.iface, prefix: s.prefix, state: e?.state ?? "retry", ...(e?.code ? { code: e.code } : {}) };
			}),
			noAddress: snapshot.served.length === 0,
			vpn: snapshot.vpn,
		};
	}
	function publish() {
		const current = status(), key = JSON.stringify(current);
		if (key === lastKey) return;
		lastKey = key;
		options.onStatus?.(current);
	}

	// Connections -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

	const countOf = (paired: boolean, peer?: string) => {
		let n = 0;
		for (const c of pool) if (c.paired === paired && (peer === undefined || c.peer === peer)) n++;
		return n;
	};
	const hasRoomPaired = (peer: string) => countOf(true, peer) < limits.pairedPerPeer && countOf(true) < limits.pairedAll;

	// Peer addresses that proved themselves paired lately, with the time each is remembered until. A new connection from one is counted in the paired pool at accept, before its cookie can be read: the paired phone must get through an unpaired flood.
	// An address someone else takes over gets no more than the paired limits of its own, and is judged as any other peer from its first byte (plain) or request without the cookie (TLS).
	const pairedPeers = new Map<string, number>();
	const remembered = (peer: string) => {
		const until = pairedPeers.get(peer);
		if (until === undefined) return false;
		if (until <= now()) return !pairedPeers.delete(peer);
		return true;
	};
	function remember(peer: string) {
		pairedPeers.delete(peer);
		pairedPeers.set(peer, now() + timeouts.pairedPeerMs);
		for (const [other, until] of pairedPeers) if (until <= now()) pairedPeers.delete(other);
		for (const other of pairedPeers.keys()) if (pairedPeers.size > PAIRED_PEERS_MAX) pairedPeers.delete(other);
	}

	/**
	 * Counts `conn` in the unpaired pool if it fits: not past its peer's own limit, and, when the pool is full, only by evicting. A full pool gives a place to a peer that holds fewer connections than the peer holding the most, taking
	 * that peer's oldest request-less connection past the handshake time (else its oldest), so a flood churns among itself and cannot hold every slot for as long as it likes. A peer that holds as many as the heaviest is closed.
	 * `conn` itself is not in the unpaired count while this runs.
	 */
	function place(conn: Conn): boolean {
		const own = countOf(false, conn.peer);
		if (own >= limits.unpairedPerPeer) return false;
		if (countOf(false) >= limits.unpairedAll && !evict(own)) return false;
		conn.paired = false;
		return true;
	}
	function evict(own: number): boolean {
		const held = new Map<string, number>();
		for (const c of pool) if (!c.paired) held.set(c.peer, (held.get(c.peer) ?? 0) + 1);
		const heaviest = Math.max(0, ...held.values());
		if (heaviest <= own) return false;
		// The oldest connection of a heaviest peer that made no request and is past the handshake time; a younger one may be a phone mid-handshake. Else the oldest of them.
		let victim: Conn | undefined, oldest: Conn | undefined;
		for (const c of pool) {
			if (c.paired || held.get(c.peer) !== heaviest) continue;
			oldest ??= c;
			if (c.requests === 0 && now() - c.at >= timeouts.handshakeMs) {
				victim = c;
				break;
			}
		}
		victim ??= oldest;
		if (!victim) return false;
		pool.delete(victim);
		noteLimited(victim.peer);
		victim.kill();
		return true;
	}
	/** A request or a first byte that shows a connection is not the paired phone's: it leaves the paired pool for the unpaired one, or is closed when that has no place for it. */
	function demote(conn: Conn): boolean {
		if (!conn.paired || conn.proven) return true;
		if (place(conn)) return true;
		noteLimited(conn.peer);
		conn.kill();
		return false;
	}

	/** The hosts a request may name: the computer's name and this listener's address, each with the port actually bound. Returns the host part to echo, never the raw header. */
	function hostOf(entry: Entry, header: string | undefined): string | undefined {
		if (!header || entry.port === undefined) return undefined;
		const value = header.toLowerCase(), name = ca.name ? `${ca.name}.local` : undefined;
		return [name, entry.served.address].find((h) => h !== undefined && value === `${h}:${entry.port}`);
	}
	const atOf = (entry: Entry, host: string, peer: string | undefined): At => ({ address: entry.served.address, iface: entry.served.iface, port: entry.port!, name: ca.name, host, origin: `https://${host}:${entry.port}`, peer });

	function accept(entry: Entry, socket: Socket) {
		// A reset or an abort at any point is a closed socket, not an unhandled `error`: this listener stays on the raw socket for its whole life.
		socket.on("error", () => socket.destroy());
		const peer = remoteOf(socket);
		if (peer === undefined || !peerAllowed(peer, entry.served)) {
			noteRefused();
			socket.destroy();
			return;
		}
		let tls: TLSSocket | undefined;
		const conn: Conn = { peer, paired: true, proven: false, requests: 0, at: now(), kill: () => (tls?.destroy(), socket.destroy()) }, cancels: (() => void)[] = [];
		if (!(remembered(peer) && hasRoomPaired(peer)) && !place(conn)) {
			noteLimited(peer);
			socket.destroy();
			return;
		}
		pool.add(conn);
		connOf.set(socket, conn);
		entry.sockets.add(socket);
		socket.once("close", () => {
			pool.delete(conn);
			entry.sockets.delete(socket);
			for (const cancel of cancels) cancel();
		});
		// A connection that sends no byte is closed.
		const cancelFirst = after(() => socket.destroy(), timeouts.firstByteMs);
		cancels.push(cancelFirst);
		socket.once("readable", () => {
			cancelFirst();
			const first = socket.read(1) as Buffer | null;
			if (!first) return void socket.destroy();
			socket.unshift(first);
			// A plain connection never carries a cookie: a remembered peer's is an unpaired one from here on.
			if (first[0] !== TLS_HANDSHAKE) return demote(conn) ? void entry.plain.emit("connection", socket) : undefined;
			const secure = tls = new TLSSocket(socket, { isServer: true, secureContext: entry.context, ALPNProtocols: ["http/1.1"] });
			entry.sockets.add(secure);
			connOf.set(secure, conn);
			// What `tls.Server` does for its sockets and a bare `TLSSocket` does not: its own error listener and a handshake timer.
			secure.on("error", () => secure.destroy());
			const cancel = after(() => secure.destroy(), timeouts.handshakeMs);
			cancels.push(cancel);
			secure.once("secure", cancel);
			secure.once("close", () => {
				entry.sockets.delete(secure);
				cancel();
			});
			entry.https.emit("connection", secure);
		});
	}

	// Pages and the handlers around the GUI's -------------------------------------------------------------------------------------------------------------------------------------------------------------------

	const common = { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "cross-origin-opener-policy": "same-origin" };
	const send = (res: ServerResponse, status: number, type: string, body: string | Buffer, extra: Record<string, string> = {}) => void res.writeHead(status, { ...common, "content-type": type, ...extra }).end(body);

	function plainRequest(entry: Entry, req: IncomingMessage, res: ServerResponse) {
		const conn = connOf.get(req.socket);
		if (conn) conn.requests++;
		const host = hostOf(entry, req.headers.host), bad = () => send(res, 400, "text/plain; charset=utf-8", "bad request");
		if (!host || req.method !== "GET") return bad();
		const url = new URL(req.url ?? "/", "http://x"), csp = `default-src 'none'; style-src 'unsafe-inline'; img-src https://${host}:${entry.port}; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`;
		const html = (body: string) => send(res, 200, "text/html; charset=utf-8", body, { "content-security-policy": csp });
		const zh = zhOf(req), file = (type: string, body: Buffer | string, name: string) => send(res, 200, type, body, { "content-security-policy": csp, "content-disposition": `attachment; filename="${name}"` });
		switch (url.pathname) {
			case "/sb-ca/": return html(certificatePage(ca, zh, req.headers["user-agent"] ?? "", url.searchParams.get("p")));
			case `/sb-ca/${CA_FILES.profile}`: return file(CA_MIME.profile, mobileconfig(ca), CA_FILES.profile);
			case `/sb-ca/${CA_FILES.crt}`: return file(CA_MIME.crt, crt(ca), CA_FILES.crt);
			case "/sb-ca/check": return html(checkPage(ca, zh, host, entry.port!));
			default: return bad();
		}
	}

	function httpsRequest(entry: Entry, req: IncomingMessage, res: ServerResponse) {
		const host = hostOf(entry, req.headers.host), conn = connOf.get(req.socket);
		// An unlisted `Host` counts as a request without the cookie (so a remembered address's connection cannot stay paired on it), is refused before the token is looked at, and without a word about what this is.
		if (!host) {
			if (conn) {
				conn.requests++;
				if (!demote(conn)) return;
			}
			return send(res, 403, "text/plain; charset=utf-8", "forbidden");
		}
		const at = atOf(entry, host, conn?.peer);
		if (conn) {
			conn.requests++;
			const carries = isPaired(req, at);
			if (carries) remember(conn.peer);
			if (carries && conn.paired) conn.proven = true;
			else if (carries && hasRoomPaired(conn.peer)) conn.paired = conn.proven = true;
			else if (!carries && !demote(conn)) return;
		}
		if (req.method === "GET") {
			const path = (req.url ?? "").split("?")[0];
			if (path === "/sb-ca/ok.svg") return send(res, 200, "image/svg+xml", trustedSvg(zhOf(req)), { "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" });
			if (path === "/sb-ca/") return send(res, 200, "text/html; charset=utf-8", trustedPage(zhOf(req)), { "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'" });
		}
		options.handler(req, res, at);
	}

	// Listeners -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

	function makeEntry(served: Served): Entry {
		const leaf = issue(ca, served.address, now());
		log("lan-leaf", { address: served.address, why: "start", san: [...leaf.dns.map((d) => `DNS:${d}`), `IP:${served.address}`] });
		const entry: Entry = { served, leaf, context: contextOf(leaf), sockets: new Set(), state: "retry", https: undefined as never, plain: undefined as never };
		const web = () => {
			const server = createHttpServer({ headersTimeout: timeouts.headersMs, requestTimeout: timeouts.requestMs, connectionsCheckingInterval: Math.max(100, Math.min(1000, timeouts.headersMs)) });
			// The header and request timeouts run off an interval Node starts when the server listens; these servers never listen, they are handed sockets, so it is started by the event that starts it.
			server.emit("listening");
			return server;
		};
		entry.https = web().on("request", (req, res) => httpsRequest(entry, req, res));
		entry.plain = web().on("request", (req, res) => plainRequest(entry, req, res));
		return entry;
	}
	const contextOf = (leaf: Leaf) => createSecureContext({ cert: leaf.certPem, key: leaf.keyPem, minVersion: "TLSv1.2" });

	async function closeServer(entry: Entry) {
		const server = entry.server;
		entry.server = undefined;
		entry.port = undefined;
		for (const socket of [...entry.sockets]) socket.destroy();
		entry.sockets.clear();
		if (server) await new Promise<void>((done) => void server.close(() => done()));
	}
	async function dropEntry(entry: Entry) {
		await closeServer(entry);
		for (const web of [entry.https, entry.plain]) web.close(() => {}); // clears the interval; they never listened
		entries.delete(entry.served.address);
	}

	/** Binds an entry's address on the port. EADDRINUSE is retried for `wait` ms; EADDRNOTAVAIL is retried at the next watch without a word; any other error is logged and retried at the next watch. */
	async function bind(entry: Entry, wait: number) {
		const host = bindAddress(entry.served);
		for (const end = now() + wait; ; ) {
			const server = createNetServer({ pauseOnConnect: true }, (socket) => accept(entry, socket));
			try {
				await listen(server, port, host);
			} catch (error) {
				const code = errorCode(error);
				if (code === "EADDRINUSE" && now() < end) {
					await sleep(100);
					continue;
				}
				entry.state = code === "EADDRINUSE" ? "taken" : code === "EADDRNOTAVAIL" ? "retry" : "error";
				entry.code = code;
				if (entry.state === "error") log("lan-leaf", { address: entry.served.address, why: "bind", code });
				return;
			}
			entry.server = server;
			entry.port = (server.address() as AddressInfo).port;
			entry.state = "open";
			delete entry.code;
			if (!port) port = entry.port;
			// A close nobody asked for (a sleep, a lease that dropped and came back) leaves a dead listener, already closed: rebind its address at once.
			const dead = () => {
				if (entry.server !== server || stopped) return;
				entry.server = undefined;
				entry.port = undefined;
				entry.state = "retry";
				for (const socket of [...entry.sockets]) socket.destroy();
				entry.sockets.clear();
				publish();
				void reconcile().catch((error) => log("lan-leaf", { address: entry.served.address, why: "bind", code: errorCode(error) }));
			};
			server.once("close", dead);
			// An `error` on a server that is listening is one accept that failed (EMFILE, ENFILE): `net.Server` emits it and goes on listening, so it is counted and the listener stays. Without a listener it would be uncaught.
			server.on("error", noteAcceptError);
			return;
		}
	}

	function end() {
		if (ended) return;
		ended = true;
		log("lan-off", { why: "ca-ended" });
	}
	async function closeAll() {
		for (const entry of [...entries.values()]) await dropEntry(entry);
	}

	let first = true;
	async function pass() {
		if (stopped) return;
		if (caStatus(ca, now()).state === "ended") {
			end();
			await closeAll();
			return;
		}
		ended = false;
		const served = watcher.snapshot().served;
		for (const entry of [...entries.values()]) if (!served.some((s) => s.address === entry.served.address)) await dropEntry(entry);
		if (wakePending) {
			wakePending = false;
			for (const entry of entries.values()) await closeServer(entry);
		}
		const wait = first ? bindWaitMs : 0;
		first = false;
		for (const s of served) {
			let entry = entries.get(s.address);
			if (entry) entry.served = s;
			else {
				// The leaf comes before the listener: no connection can arrive for an address the leaf does not name.
				try {
					entry = makeEntry(s);
				} catch (error) {
					if (caStatus(ca, now()).state === "ended") return void (end(), await closeAll());
					throw error;
				}
				entries.set(s.address, entry);
			}
			if (!entry.server) await bind(entry, wait);
		}
		for (const entry of entries.values()) {
			if (!leafNeedsRenewal(ca, entry.leaf.notAfter, now())) continue;
			entry.leaf = issue(ca, entry.served.address, now());
			entry.context = contextOf(entry.leaf);
			log("lan-leaf", { address: entry.served.address, why: "renew", san: [...entry.leaf.dns.map((d) => `DNS:${d}`), `IP:${entry.served.address}`] });
		}
	}

	// One pass at a time: a renewal and an address change at once, or a listener's death during a tick, make one leaf and one bind per address.
	let running: Promise<void> | undefined, again = false;
	function reconcile(): Promise<void> {
		if (running) {
			again = true;
			return running;
		}
		running = (async () => {
			try {
				do {
					again = false;
					await pass();
				} while (again && !stopped);
			} finally {
				running = undefined;
				publish();
			}
		})();
		return running;
	}

	let stopTimer: (() => void) | undefined, ticking: Promise<void> | undefined;
	const listener: LanListener = {
		async start() {
			started = true;
			await watcher.start();
			logAddresses();
			await reconcile();
			stopTimer = (options.every ?? ((tick, ms) => {
				const timer = setInterval(tick, ms);
				timer.unref();
				return () => clearInterval(timer);
			}))(() => void listener.tick().catch((error) => log("lan-addresses", { error: error instanceof Error ? error.message : String(error) })), options.intervalMs ?? 5000);
			return status();
		},
		tick() {
			ticking ??= (async () => {
				await watcher.tick();
				await reconcile();
			})().finally(() => (ticking = undefined));
			return ticking;
		},
		async setCa(next) {
			ca = next;
			await running;
			await closeAll();
			ended = caStatus(ca, now()).state === "ended";
			if (!ended) await reconcile();
			else publish();
		},
		status,
		portOf: (address) => entries.get(address)?.port,
		async stop() {
			stopped = true;
			stopTimer?.();
			watcher.stop();
			await running;
			await closeAll();
			flushRefused();
			flushLimited();
			flushAccept();
			publish();
		},
	};
	return listener;
}

// The certificate pages ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
type Platform = "ios" | "android" | "desktop";
const platformOf = (ua: string, asked: string | null): Platform => (asked === "ios" || asked === "android" || asked === "desktop" ? asked : /iPhone|iPad|iPod/.test(ua) ? "ios" : /Android/.test(ua) ? "android" : "desktop");
const notSafari = (ua: string) => !/Safari\//.test(ua) || /CriOS|FxiOS|EdgiOS|OPiOS|GSA\/|DuckDuckGo/.test(ua);
const notChrome = (ua: string) => /Firefox\/|SamsungBrowser|OPR\/|DuckDuckGo/.test(ua) || !/Chrome\//.test(ua);

const TEXT = {
	en: {
		title: "Trust this computer's certificate",
		lead: (name: string | null) => `Straw Boss on ${name ?? "this computer"} made its own certificate so this phone can open its page over this network with HTTPS. Install it once. It is meant to cover only ${name ? `${name}.local and ` : ""}private network addresses (10.x, 172.16–31.x, 192.168.x).`,
		unverified: "Not verified yet: whether this phone limits the certificate to those names has not been checked. Until it has, assume that a copy of its key could pose as any website to this phone, until you remove the certificate. Use Tailscale instead if you can.",
		check: "Nothing on this page can prove the certificate is real. The computer's screen tells you where to check it on this phone, and that it must be exactly one certificate. A certificate sent from the computer by AirDrop or Quick Share needs no check, unless the phone asked you to accept it from an unknown sender.",
		platforms: { ios: "iPhone", android: "Android", desktop: "Computer" },
		downloadProfile: "Download profile", downloadCert: "Download certificate",
		ios: ["Tap Download profile, then Allow.", "Open Settings, Profile Downloaded (or General, VPN & Device Management), tap the Straw Boss profile, check it as the computer's screen says, and Install. iOS says \"Not Verified\": that is expected.", "Settings, General, About, Certificate Trust Settings: turn on Straw Boss LAN CA."],
		iosSafari: "Open this page in Safari: other browsers cannot install a profile.",
		android: ["Tap Download certificate.", "Open Settings, Security & privacy, More security settings, Encryption & credentials, Install a certificate, CA certificate; tap Install anyway and pick straw-boss-lan-ca.crt. Menu names differ by maker: search Settings for \"CA certificate\".", "Then check it as the computer's screen says. Android says the network may be monitored: that notice is about this certificate."],
		androidChrome: "Chrome may say the download is not secure: tap Keep, then check the certificate as the computer's screen says.",
		androidBrowser: "Use Chrome: it trusts certificates you install. Firefox does not by default.",
		desktop: ["Download certificate, then open it.", "macOS: add it to the login keychain, open Keychain Access, check that exactly one Straw Boss LAN CA was added, and set Trust to Always Trust. Windows: Install Certificate, Current User, Trusted Root Certification Authorities; exactly one Security Warning must appear. Linux: add it to Chrome's certificate authorities (Settings, Privacy and security, Manage certificates).", "Check it as the computer's screen says before you trust it."],
		checkLink: "Is a Straw Boss certificate installed?",
		checkNote: "This only shows whether this phone trusts a certificate for this computer. It cannot tell this computer's certificate from one someone else put on the network; only the check on the computer's screen can.",
		trusted: "Trusted", notYet: "Not trusted yet",
		remove: "To remove it later:",
		removal: { ios: "iPhone: Settings, General, VPN & Device Management, Straw Boss LAN, Remove Profile.", android: "Android: Settings, search \"Trusted credentials\", User, Straw Boss LAN CA, Remove.", desktop: "Mac: Keychain Access, login, Straw Boss LAN CA, Delete. Windows: certmgr.msc, Trusted Root, Straw Boss LAN CA, Delete." },
		doneTitle: "This phone trusts the certificate", open: "Open Straw Boss", back: "Back to the instructions",
	},
	zh: {
		title: "信任這台電腦的憑證",
		lead: (name: string | null) => `${name ?? "這台電腦"} 上的 Straw Boss 自建了一張憑證，讓這支手機能在這個網路上用 HTTPS 開啟它的頁面。只要安裝一次。它原本只應涵蓋 ${name ? `${name}.local 和` : ""}私人網路位址（10.x、172.16–31.x、192.168.x）。`,
		unverified: "尚未驗證：這支手機會不會把憑證限制在這些名稱上，目前還沒有查證過。在查證之前，請當作金鑰一旦被複製，就可能被用來向這支手機冒充任何網站，直到你移除這張憑證。可以的話，請改用 Tailscale。",
		check: "這個頁面上的任何內容都無法證明憑證是真的。電腦螢幕會告訴你要在手機的哪裡核對，而且必須剛好只有一張憑證。從電腦用 AirDrop 或快速分享傳來的憑證不必核對，除非手機要你接受來自不明傳送者的檔案。",
		platforms: { ios: "iPhone", android: "Android", desktop: "電腦" },
		downloadProfile: "下載描述檔", downloadCert: "下載憑證",
		ios: ["點「下載描述檔」，再點「允許」。", "打開「設定」>「已下載描述檔」（或「一般」>「VPN 與裝置管理」），點 Straw Boss 描述檔，依電腦螢幕的說明核對後再點「安裝」。iOS 會顯示「未驗證」，這是正常的。", "「設定」>「一般」>「關於本機」>「憑證信任設定」：開啟 Straw Boss LAN CA。"],
		iosSafari: "請用 Safari 開這個頁面：其他瀏覽器無法安裝描述檔。",
		android: ["點「下載憑證」。", "打開「設定」>「安全性與隱私權」>「更多安全性設定」>「加密和憑證」>「安裝憑證」>「CA 憑證」，點「仍要安裝」，選擇 straw-boss-lan-ca.crt。各廠牌的選單名稱不同，可以在設定裡搜尋「CA 憑證」。", "接著依電腦螢幕的說明核對。Android 會提示「網路可能受到監控」：指的就是這張憑證。"],
		androidChrome: "Chrome 可能會說這個下載不安全：點「保留」，再依電腦螢幕的說明核對憑證。",
		androidBrowser: "請用 Chrome：它信任你安裝的憑證，Firefox 預設不信任。",
		desktop: ["下載憑證，然後打開它。", "macOS：加入「登入」鑰匙圈，打開「鑰匙圈存取」，確認剛好新增了一張 Straw Boss LAN CA，並把信任設為「永遠信任」。Windows：安裝憑證，選「目前使用者」，放進「受信任的根憑證授權單位」；必須剛好出現一個安全性警告。Linux：加入 Chrome 的憑證授權單位（設定、隱私權和安全性、管理憑證）。", "信任之前，先依電腦螢幕的說明核對。"],
		checkLink: "這支手機裝了 Straw Boss 憑證嗎？",
		checkNote: "這裡只能看出這支手機是否信任這台電腦的某張憑證，無法分辨那是這台電腦的，還是別人放到網路上的；只有依電腦螢幕的說明核對才能分辨。",
		trusted: "已信任", notYet: "尚未信任",
		remove: "之後要移除：",
		removal: { ios: "iPhone：設定、一般、VPN 與裝置管理、Straw Boss LAN、移除描述檔。", android: "Android：設定、搜尋「信任的憑證」、使用者、Straw Boss LAN CA、移除。", desktop: "Mac：鑰匙圈存取、登入、Straw Boss LAN CA、刪除。Windows：certmgr.msc、受信任的根憑證、Straw Boss LAN CA、刪除。" },
		doneTitle: "這支手機已信任這張憑證", open: "開啟 Straw Boss", back: "回到說明",
	},
} as const;

const STYLE = "body{font:16px system-ui,sans-serif;background:#16161e;color:#c0caf5;margin:0;padding:1.5rem 1.25rem;max-width:34rem}a{color:#7aa2f7}a.button{display:inline-block;background:#7aa2f7;color:#16161e;padding:.6rem 1rem;border-radius:.4rem;text-decoration:none}nav a{margin-right:1rem}li{margin:.5rem 0}.note{color:#9aa5ce;font-size:.9rem}";
const shell = (zh: boolean, title: string, body: string) => `<!doctype html><html lang="${zh ? "zh-Hant" : "en"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>${esc(title)}</title><style>${STYLE}</style></head><body>${body}</body></html>`;

/** The instructions page for the phone's platform, in the browser's language. It carries no fingerprint and no value to compare, and no script: the computer's screen is the only place to check the certificate. */
export function certificatePage(ca: Pick<LanCa, "name">, zh: boolean, userAgent: string, asked: string | null = null): string {
	const t = TEXT[zh ? "zh" : "en"], platform = platformOf(userAgent, asked), steps = t[platform];
	const file = platform === "ios" ? `<a class="button" href="/sb-ca/${CA_FILES.profile}">${t.downloadProfile}</a>` : `<a class="button" href="/sb-ca/${CA_FILES.crt}">${t.downloadCert}</a>`;
	const notes = [platform === "ios" && notSafari(userAgent) ? t.iosSafari : "", platform === "android" ? t.androidChrome : "", platform === "android" && notChrome(userAgent) ? t.androidBrowser : ""].filter(Boolean);
	const nav = (["ios", "android", "desktop"] as const).map((p) => (p === platform ? `<strong>${t.platforms[p]}</strong>` : `<a href="/sb-ca/?p=${p}">${t.platforms[p]}</a>`)).join(" ");
	return shell(zh, t.title, `<h1>${t.title}</h1><p>${esc(t.lead(ca.name))}</p><p><strong>${esc(t.unverified)}</strong></p><p>${t.check}</p><nav>${nav}</nav>${notes.map((n) => `<p><strong>${esc(n)}</strong></p>`).join("")}<p>${file}</p><ol>${steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol><p>${t.remove} ${esc(t.removal[platform])}</p><p><a href="/sb-ca/check">${t.checkLink}</a></p>`);
}
/** `/sb-ca/check`: an image from the HTTPS side of this listener. It draws "Trusted" when the phone trusts a certificate for the host; when TLS fails the browser shows the alt text. */
export function checkPage(ca: Pick<LanCa, "name">, zh: boolean, host: string, port: number): string {
	const t = TEXT[zh ? "zh" : "en"];
	return shell(zh, t.checkLink, `<h1>${t.checkLink}</h1><p><img src="https://${esc(host)}:${port}/sb-ca/ok.svg" alt="${t.notYet}"></p><p class="note">${t.checkNote}</p><p><a href="/sb-ca/">${t.back}</a></p>`);
}
const trustedPage = (zh: boolean) => shell(zh, TEXT[zh ? "zh" : "en"].doneTitle, `<h1>${TEXT[zh ? "zh" : "en"].doneTitle}</h1><p><a class="button" href="/sb-app/">${TEXT[zh ? "zh" : "en"].open}</a></p>`);
const trustedSvg = (zh: boolean) => `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="40" viewBox="0 0 160 40"><rect width="160" height="40" rx="6" fill="#1f7a3d"/><text x="80" y="26" text-anchor="middle" fill="#ffffff" font-family="system-ui,sans-serif" font-size="18">${TEXT[zh ? "zh" : "en"].trusted}</text></svg>`;
