import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { createLanDevices, labelOf, SESSION_MS, type Event } from "../devices.ts";
import { createLanCodes } from "../paircode.ts";

// Who is let in over Wi-Fi access (docs/specs/2026-10-30-sb-gui-lan.md, "Pairing and identity on the LAN"), the LAN's half of `createAccess` (remote.ts). On the tailnet a Tailscale identity stands behind a request; here nothing does, so a
// device gets in only with a cookie of an allowed device, and becomes one only by a code this computer minted and then the boss's number: a redeemed code makes a pending device (in memory, a cookie scoped to the app entry alone, no token
// anywhere in what it is sent) that has no reach until the boss types, on this computer, the four digits the device itself shows. Every request also has to name a host from the listener's allow-list (the computer's name or the listener's
// address, with the port), checked before the token is looked at. The listener (listener.ts) hands each request its `At`; this file reads no socket, binds nothing, and holds no certificate.

export const APP = "/sb-app/";
/** The LAN cookie: `__Secure-` stops a plain-HTTP response on the same host from setting it, and no other network's cookie has this name. */
export const LAN_COOKIE = "__Secure-sb_lan";
const CODE_MS = 10 * 60_000, MAX_CODES = 16, PENDING_MS = 2 * 60_000, MAX_PENDING = 4, NOISE_MAX = 20, NOISE_MS = 10 * 60_000, OUTCOME_MS = 10 * 60_000, MAX_REMEMBERED = 64, MAX_PEERS = 2048;
const COOKIE = new RegExp(`(?:^|;\\s*)${LAN_COOKIE}=([0-9a-f]{64})(?:;|$)`);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const attributes = `Max-Age=${SESSION_MS / 1000}; HttpOnly; Secure; SameSite=Strict`;
/** The LAN cookie for the page: scoped to the token's path. */
export const lanCookieFor = (token: string, value: string) => `${LAN_COOKIE}=${value}; Path=/${token}/; ${attributes}`;
/** The same cookie for the fixed entry (`/sb-app/`), the only path a pending device is given. */
export const lanAppCookieFor = (value: string) => `${LAN_COOKIE}=${value}; Path=${APP}; ${attributes}`;

/** What the listener tells of the request's way in (listener.ts `At`). */
export interface LanAt { address: string; iface: string; port: number; name: string | null; host: string; origin: string; peer: string | undefined }
/** What the fixed entry says of a GET: `cookie` for an allowed device, `pending` for a device waiting for the boss, `unpaired` for any other, `status` for a refusal. */
export type LanEntry = { cookie: string } | { pending: true } | { unpaired: true } | { status: 403 | 429 };
/** What a posted code did: `cookie` and the `number` the device shows for a new pending device, `wrong` for a code that did not work, `busy` when no more requests are taken (the code is not used), `status` for a refusal. */
export type LanRedeemed = { cookie: string; number: string } | { wrong: true } | { busy: true } | { status: 403 | 429 };
/** What the waiting page shows: the number, an allowed device (on to `/sb-app/`), a device the boss denied or that was not answered in time, or none of these. */
export type LanWaiting = { state: "pending"; number: string } | { state: "allowed" } | { state: "denied" | "timeout" | "none" } | { status: 403 | 429 };
/** What the boss's computer is told, for its notices and log (never a code, a cookie, or a number). */
export type LanEvent =
	| { type: "pending"; id: string; label: string; peer: string; iface: string }
	| { type: "paired"; id: string; label: string; peer: string }
	| { type: "refused"; id: string; label: string; peer: string; why: "denied" | "timeout" }
	| { type: "wrong"; peer: string; count: number }
	| { type: "void"; peers: number };
/** A request waiting for the boss, as the computer lists it: no number (the device shows it, the boss types it). */
export interface LanPending { id: string; label: string; peer: string; iface: string; since: number }
interface Pending extends LanPending { hash: string; host: string; number: string; cancel: () => void }

export interface LanAccessDeps {
	token: string;
	/** Told when streams must end: one device's (its hash), or all of this network's. */
	ended: (device?: string) => void;
	/** lan.json, the allowed devices and the wish. */
	file?: string;
	notify?: (event: LanEvent) => void;
	log?: Event;
	now?: () => number;
	/** Runs `fn` once after `ms`; returns a cancel. Default an unref'd `setTimeout`. */
	after?: (fn: () => void, ms: number) => () => void;
}

export function createLanAccess({ token, ended, file, notify = () => {}, log = () => {}, now = () => Date.now(), after }: LanAccessDeps) {
	const later = after ?? ((fn, ms) => {
		const timer = setTimeout(fn, ms);
		timer.unref();
		return () => clearTimeout(timer);
	});
	const store = createLanDevices(file, hash(token), log), codes = createLanCodes(CODE_MS, MAX_CODES, now);
	const pending = new Map<string, Pending>(), outcomes = new Map<string, { state: "denied" | "timeout"; until: number }>();
	const hits = new Map<string, number[]>(), limited = new Map<string, number>();
	let on = false;
	const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

	/** The hosts a request may name: the computer's name or the listener's address, each with the listener's port. The listener checks the same; this is not left to it. */
	const hostOk = (req: IncomingMessage, at: LanAt | undefined, port = at?.port): at is LanAt =>
		on && at !== undefined && port === at.port && ((at.name !== null && at.host === `${at.name}.local`) || at.host === at.address) && String(req.headers.host ?? "").toLowerCase() === `${at.host}:${at.port}`;
	/** Whose cookie a request carries: an allowed device, a pending one, or neither. */
	const who = (req: IncomingMessage): { cookie?: string; hash?: string; kind: "allowed" | "pending" | "none" } => {
		const cookie = COOKIE.exec(req.headers.cookie ?? "")?.[1];
		if (!cookie) return { kind: "none" };
		const h = hash(cookie);
		return { cookie, hash: h, kind: store.has(h) ? "allowed" : pending.has(h) ? "pending" : "none" };
	};

	// The noise limit: 20 refusals from one peer address within 10 minutes (an allowed device's requests never count) give its unpaired requests 429 for 10 minutes. It keeps logs and CPU quiet; a peer can change its address, so it is not the bound.
	const isLimited = (peer: string) => {
		const until = limited.get(peer);
		if (until === undefined) return false;
		if (until > now()) return true;
		limited.delete(peer);
		hits.delete(peer);
		return false;
	};
	const refused = <S extends 400 | 401 | 403>(peer: string, status: S): S => {
		const t = now(), list = (hits.get(peer) ?? []).filter((x) => x > t - NOISE_MS);
		list.push(t);
		hits.delete(peer);
		hits.set(peer, list);
		if (list.length >= NOISE_MAX) limited.set(peer, t + NOISE_MS);
		for (const old of hits.keys()) if (hits.size > MAX_PEERS) (hits.delete(old), limited.delete(old));
		return status;
	};
	/** The refusal a request that is not an allowed device's gets: 429 once its peer is limited, else `status`, counted. */
	const deny = <S extends 401 | 403>(peer: string, status: S): { status: S | 429 } => ({ status: isLimited(peer) ? 429 : refused(peer, status) });

	const remember = (hashed: string, state: "denied" | "timeout") => {
		outcomes.set(hashed, { state, until: now() + OUTCOME_MS });
		for (const old of outcomes.keys()) if (outcomes.size > MAX_REMEMBERED) outcomes.delete(old);
	};
	const drop = (p: Pending, why: "denied" | "timeout") => {
		p.cancel();
		pending.delete(p.hash);
		remember(p.hash, why);
		log("lan-pair-refused", { peer: p.peer, why });
		notify({ type: "refused", id: p.id, label: p.label, peer: p.peer, why });
	};

	return {
		get on() { return on; },
		/** Whether Wi-Fi access is wanted: set by turning it on, kept by a stop, cleared only by turning it off. */
		get wanted() { return store.wanted; },
		/** The port Wi-Fi access asks for, kept in lan.json (even while it is off). */
		get port() { return store.port; },
		get error() { return store.error; },
		store,
		enable() {
			on = true;
			store.set({ wanted: true });
		},
		/** Off: the codes and the pending devices are void and the network's streams end; the allowed devices stay. `stop` is the server going away, so the wish stays. */
		disable(stop = false) {
			on = false;
			codes.clear();
			for (const p of pending.values()) p.cancel();
			pending.clear();
			outcomes.clear();
			if (!stop) store.set({ wanted: false });
			ended();
		},
		setPort: (port: number) => store.set({ port }),
		/** A one-time QR code for `surface` (an overlay face or a tile), which voids that surface's earlier unredeemed code. */
		pair(surface: string): string | undefined {
			if (!surface) throw new Error("a LAN code belongs to the surface that shows it");
			return on ? codes.qr(surface) : undefined;
		},
		/** A typed code for `surface`, as `pair`; every peer's tries start over. */
		pairCode(surface: string): string | undefined {
			if (!surface) throw new Error("a LAN code belongs to the surface that shows it");
			return on ? codes.typed(surface) : undefined;
		},
		/** Whether a request carries an allowed device's cookie: the listener moves its connection to the paired pool then. */
		carries: (req: IncomingMessage) => who(req).kind === "allowed",
		/** Whether a request names an allowed host of this listener. */
		admits: (req: IncomingMessage, at: LanAt | undefined) => hostOk(req, at),

		/** `/<token>/<path>` on a LAN listener: the host, then the token, then the cookie of an allowed device. A document's subresource (`doc/<cap>/r/<ticket>/…`) comes through without one, to be judged by its ticket (docs.ts); a document load and `api/doc` need the cookie. */
		check(req: IncomingMessage, port: number, given: string | undefined, path: string[], at: LanAt | undefined) {
			const peer = at?.peer ?? "?", c = who(req);
			if (c.kind !== "allowed" && isLimited(peer)) return { status: 429 as const };
			const miss = (status: 403) => (c.kind === "allowed" ? { status } : deny(peer, status));
			if (!hostOk(req, at, port)) return miss(403);
			if (!same(given ?? "", token)) return miss(403);
			const used = c.kind === "allowed" ? store.use(c.hash!) : undefined;
			if (used) return { origin: at.origin, remote: true, net: "lan" as const, device: c.hash!, ...(used.renewed && { reissue: c.cookie! }) };
			if (path[0] === "doc" && path[2] === "r" && path.length >= 4) return { origin: at.origin, remote: true, net: "lan" as const };
			return deny(peer, 401);
		},
		entry(req: IncomingMessage, at: LanAt | undefined): LanEntry {
			const peer = at?.peer ?? "?", c = who(req);
			if (c.kind !== "allowed" && isLimited(peer)) return { status: 429 };
			if (!hostOk(req, at)) return c.kind === "allowed" ? { status: 403 } : deny(peer, 403);
			if (c.kind === "allowed" && store.use(c.hash!)) return { cookie: c.cookie! };
			return c.kind === "pending" ? { pending: true } : { unpaired: true };
		},
		/** The waiting page's state for the device that holds a cookie. */
		waiting(req: IncomingMessage, at: LanAt | undefined): LanWaiting {
			const peer = at?.peer ?? "?", c = who(req);
			if (c.kind !== "allowed" && isLimited(peer)) return { status: 429 };
			if (!hostOk(req, at)) return c.kind === "allowed" ? { status: 403 } : deny(peer, 403);
			if (c.kind === "allowed") return { state: "allowed" };
			const p = c.hash && pending.get(c.hash);
			if (p) return { state: "pending", number: p.number };
			const out = c.hash ? outcomes.get(c.hash) : undefined;
			return out && out.until > now() ? { state: out.state } : { state: "none" };
		},
		/**
		 * A code posted to the fixed entry (the QR's, whose page posted it so that a prefetcher cannot use it up, or one typed): a form post from the entry's own page, naming an allowed host. A valid code makes a pending device,
		 * and the response gives its cookie for the entry's path alone. With four requests waiting, or one from this peer already, the code is not looked at, so it stays unused.
		 */
		redeem(req: IncomingMessage, text: string, at: LanAt | undefined): LanRedeemed {
			const h = req.headers, peer = at?.peer, c = who(req);
			if (c.kind !== "allowed" && isLimited(peer ?? "?")) return { status: 429 };
			if (!peer || !hostOk(req, at) || req.method !== "POST" || h.origin !== at.origin || (h["sec-fetch-site"] ?? "same-origin") !== "same-origin" || !String(h["content-type"] ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded")) return deny(peer ?? "?", 403);
			if (pending.size >= MAX_PENDING || [...pending.values()].some((p) => p.peer === peer)) return { busy: true };
			const code = new URLSearchParams(text).get("code") ?? "";
			if (codes.kindOf(code) === "qr") {
				if (!codes.takeQr(code)) return (refused(peer, 403), { wrong: true });
			} else {
				const taken = codes.takeTyped(code, peer);
				if (taken.result === "locked") return { status: 429 };
				if (taken.result === "wrong") {
					notify({ type: "wrong", peer, count: taken.misses! });
					if (taken.voided) (log("lan-code-void", { peers: taken.voided }), notify({ type: "void", peers: taken.voided }));
					return { wrong: true };
				}
			}
			const cookie = randomBytes(32).toString("hex"), id = randomBytes(6).toString("hex"), label = labelOf(String(h["user-agent"] ?? ""));
			let number = "";
			do number = String(randomInt(10_000)).padStart(4, "0"); while ([...pending.values()].some((p) => p.number === number));
			const p: Pending = { id, hash: hash(cookie), label, peer, iface: at.iface, since: now(), host: at.host, number, cancel: () => {} };
			p.cancel = later(() => void (pending.get(p.hash) === p && drop(p, "timeout")), PENDING_MS);
			pending.set(p.hash, p);
			log("lan-pair-pending", { peer });
			notify({ type: "pending", id, label, peer, iface: at.iface });
			return { cookie, number };
		},

		/** The requests waiting for the boss, oldest first. */
		pending: (): LanPending[] => [...pending.values()].map(({ id, label, peer, iface, since }) => ({ id, label, peer, iface, since })),
		/** The boss typed `number` (what the device in their hand shows): the pending device with it is allowed and kept. */
		approve(number: string): { id: string; label: string; peer: string } | undefined {
			const p = /^\d{4}$/.test(number) ? [...pending.values()].find((x) => x.number === number) : undefined;
			if (!p) return undefined;
			p.cancel();
			pending.delete(p.hash);
			store.add(p.hash, p.label, p.host);
			log("lan-paired", { label: p.label, peer: p.peer });
			notify({ type: "paired", id: p.id, label: p.label, peer: p.peer });
			return { id: p.id, label: p.label, peer: p.peer };
		},
		/** Denies the pending device named `id`, or every one; how many were denied. */
		deny(id: string): number {
			const some = id === "all" ? [...pending.values()] : [...pending.values()].filter((p) => p.id === id);
			for (const p of some) drop(p, "denied");
			return some.length;
		},
	};
}
export type LanAccess = ReturnType<typeof createLanAccess>;
