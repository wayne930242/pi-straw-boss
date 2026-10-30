import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LanPanel, Reply } from "../control.ts";
import type { Gui } from "../gui.ts";
import type { LanEvent, LanPending } from "../lan/access.ts";
import { CA_FILES, CA_MIME, caStatus, caValidity, createCa, crt, fingerprints, type LanCa, localName as readLocalName, type LocalName, mobileconfig, readCa, writeCa, type WriteDeps } from "../lan/ca.ts";
import { createFaces } from "../lan/faces.ts";
import { type FirewallInput, type FirewallRead, readFirewall } from "../lan/firewall.ts";
import { createLanListener, type ListenerOptions, type ListenerStatus, type LanListener } from "../lan/listener.ts";
import { qr } from "../qr.ts";
import { LAN_PORT } from "../devices.ts";
import type { Log } from "./log.ts";
import type { Reply as SocketReply } from "./socket.ts";
import { inTestRun } from "./testguard.ts";

// Wi-Fi access inside the sb server (docs/specs/2026-10-30-sb-gui-lan.md, "Commands and what the boss sees", "How it fits the rest"; Steps L5): the LAN listeners (lan/listener.ts) wired to the GUI's handler of kind "lan", the CA the boss
// accepted the risk for, the switches (`gui-lan`), the pairing codes and the approval by number (`gui-lan-pair`, `gui-lan-pending`, `gui-lan-approve`), the reset (`gui-lan-reset`), the public certificate files (`gui-lan-files`), and the
// overlay-open marks (`gui-lan-face`, lan/faces.ts). guihost.ts builds one of these for each GUI it starts and routes the control requests here; the page's `lan/*` routes reach the same functions through `panel`.
// Everything runs one at a time (`serial`): a switch, a reset, and a resume never overlap. Nothing binds unless the boss turned Wi-Fi access on and accepted the risk, and a secondary slot never serves it.

/**
 * A note or an event as the page gets it: the English `text` the session and the overlay show, and a machine `code` with its `params` (and, for a note that holds others, `of`) the page words in its own language
 * (gui/lan.ts; a code it does not know shows the text). Ages are not words here: a pending row carries `ageMs`.
 */
export interface Coded { text: string; code: string; params?: Record<string, string | number>; of?: Coded[] }
const coded = (text: string, code: string, params?: Coded["params"], of?: Coded[]): Coded => ({ text, code, ...(params ? { params } : {}), ...(of ? { of } : {}) });
const SECONDARY = coded("Wi-Fi access is served by the default Herdr's sb server", "secondary");
const CORRUPT = coded("Wi-Fi access stays off: lan-ca.json is unreadable or readable by other accounts; /boss gui lan reset makes a new certificate, and each phone installs it again", "ca_corrupt");
const MISSING = coded("Wi-Fi access stays off: this computer's Wi-Fi certificate is missing; run /boss gui lan to make a new one (each phone installs it again)", "ca_missing");
const ENDED = coded("This computer's Wi-Fi certificate has ended; run /boss gui lan reset in a pi session and choose renew, and each phone installs the new one.", "ca_ended");
const NO_ADDRESS = coded("This computer has no private network address Wi-Fi access can serve now (a VPN tunnel is not served)", "no_address");
const VPN = coded("A VPN carries this computer's traffic; if the phone cannot connect, allow local network access in the VPN's settings.", "vpn");
const RISK = "Wi-Fi access needs a certificate this computer makes for itself, which each phone then trusts; read the risk and confirm before it is made.";
/** How long a tile that polled `lan/pending` counts as open, and how many events and notices are kept. */
const TILE_MS = 5000, EVENTS = 5, NOTICES = 8;
const MAX_MOVES = 5;

/** The test seams: what the listener reads and binds, and the clock and timers it runs on. */
export interface LanSeams extends Pick<ListenerOptions, "interfaces" | "bindAddress" | "remoteOf" | "probe" | "now" | "every" | "after" | "sleep" | "listen" | "bindWaitMs" | "intervalMs" | "wakeMs"> {
	/** This computer's name for the CA; default `localName()`. */
	localName?: () => LocalName;
	/** The write hook of `lan-ca.json` (Time Machine's exclusion); default `tmutil` on macOS. */
	exclude?: WriteDeps["exclude"];
	/** The firewall read (lan/firewall.ts); a test run does none unless it hands one in. */
	firewall?: (input: FirewallInput) => Promise<FirewallRead>;
}
export interface LanHostOptions {
	/** The primary slot's folder: `lan-ca.json`, `lan-ca-files/`. */
	dir: string;
	primary: boolean;
	log: Log;
	seams?: LanSeams;
	/** The pairing requests nobody has an overlay or tile open for: told to the sessions (server.json `lanNotice`). */
	notice?: (waiting: { id: string; peer: string }[]) => void;
}

const flat = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v === undefined || ["string", "number", "boolean"].includes(typeof v) ? v : Array.isArray(v) ? v.join(", ") : JSON.stringify(v)])) as Record<string, string | number | boolean | undefined>;
const reply = (status: number, body: unknown): Reply => ({ status, body });
const bad = (error: string, reason: string, status = 400): Reply => reply(status, { error, reason });
const age = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60_000)} min`);

export function createLanHost(o: LanHostOptions) {
	const seams = o.seams ?? {}, now = seams.now ?? Date.now, faces = createFaces(now);
	const name = () => (seams.localName ?? readLocalName)();
	let gui: Gui | undefined, ca: LanCa | undefined, listener: LanListener | undefined, status: ListenerStatus | undefined;
	/** Why Wi-Fi access is off though it is wanted, or what the move of the port was; kept until the next success. */
	let held: Coded | undefined, moved: Coded | undefined;
	/** What the firewall read found (lan/firewall.ts), once it is done; cleared when the listeners close. */
	let fire: Coded[] = [];
	/** Counts the reads: a read answers only while it is the latest; closing the listeners counts one too. `fireFor` is what the latest read was started for (the served addresses), to see a change. */
	let fireSeq = 0, fireFor: string | undefined;
	let tileAt = -Infinity, nameAt = -Infinity, nameNow: LocalName | undefined;
	const events: ({ at: number } & Coded)[] = [], notices = new Map<string, string>();
	let chain: Promise<unknown> = Promise.resolve();
	/** One job at a time. A rejected job is its caller's to see; the next one runs regardless. */
	const serial = <T>(job: () => Promise<T>): Promise<T> => {
		const run = chain.then(job, job);
		chain = run.catch(() => {});
		return run;
	};
	const lan = () => gui!.access.lan;

	// What the computer is told ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------

	const note = (c: Coded) => void (events.push({ at: now(), ...c }), events.length > EVENTS && events.shift());
	const told = () => o.notice?.([...notices].map(([id, peer]) => ({ id, peer })));
	/** A request waits and nobody has this computer's overlay or tile open: every session shows a notice (the server record carries it). */
	const open = () => faces.any() || now() - tileAt < TILE_MS;
	function onEvent(event: LanEvent) {
		if (event.type === "pending") {
			if (!open()) (notices.set(event.id, event.peer), notices.size > NOTICES && notices.delete(notices.keys().next().value!), told());
		} else if (event.type === "paired") {
			note(coded(`Paired over Wi-Fi: ${event.label} (${event.peer})`, "paired", { label: event.label, peer: event.peer }));
			if (notices.delete(event.id)) told();
		} else if (event.type === "refused") {
			note(coded(`A Wi-Fi pairing code was used from ${event.peer} and not allowed. If that was not your phone, someone saw the code.`, "refused", { peer: event.peer }));
			if (notices.delete(event.id)) told();
		} else if (event.type === "wrong") {
			note(coded(`${event.count} wrong codes from ${event.peer}`, "wrong", { count: event.count, peer: event.peer }));
		} else {
			note(coded(`Too many wrong codes from ${event.peers} addresses; this code is void. Press c for a new one (the QR still works). Someone on this network is guessing codes. Pair on your phone's hotspot instead.`, "void", { peers: event.peers }));
		}
	}
	/** The notices of requests that are no longer waiting go (a timeout has its own event; this is the sweep after any change). */
	const sweep = () => {
		const waiting = new Set(lan().pending().map((p) => p.id));
		let changed = false;
		for (const id of notices.keys()) if (!waiting.has(id)) (notices.delete(id), (changed = true));
		if (changed) told();
	};

	// The notes: what keeps Wi-Fi access from being what the boss asked for ---------------------------------------------------------------------------------------------------------------------------------

	const currentName = (): LocalName => {
		if (nameNow && now() - nameAt <= 60_000) return nameNow;
		const read = name();
		// Only a readable answer is kept: "try again in a moment" must find a fresh read.
		if ("unreadable" in read) return read;
		return (nameNow = read, (nameAt = now()), read);
	};
	function renamed(): Coded | undefined {
		if (!ca?.name) return undefined;
		const current = currentName();
		if (!("name" in current) || current.name === ca.name) return undefined;
		if (new RegExp(`^${ca.name}-\\d+$`).test(current.name)) return coded(`Another device on this network answers to ${ca.name}.local, so macOS renamed this computer ${current.name}. Use the address form here (press i), and set the name back in System Settings, General, Sharing, Local hostname.`, "renamed_n", { caName: ca.name, name: current.name });
		return coded(`This computer is now called ${current.name}; the certificate is for ${ca.name}.local. /boss gui lan reset makes a new certificate (each phone installs it again).`, "renamed", { caName: ca.name, name: current.name });
	}
	const notes = (): Coded[] => {
		const out: Coded[] = [];
		if (held) out.push(held);
		if (moved) out.push(moved);
		if (status && listener) {
			const taken = status.addresses.filter((a) => a.state === "taken");
			for (const a of taken) out.push(coded(`Port ${status.port ?? lan().port} is taken on ${a.address} by another program; Wi-Fi access does not serve that address. Run /boss gui lan to move to a free port (installed apps then need to be added again).`, "taken", { port: status.port ?? lan().port, address: a.address }));
			if (status.noAddress) out.push(NO_ADDRESS);
			if (status.vpn && !status.noAddress) out.push(VPN);
			out.push(...fire);
		}
		if (ca) {
			const state = caStatus(ca, now());
			if (state.state === "ending") out.push(coded(`This computer's Wi-Fi certificate ends in ${state.daysLeft} days. Run /boss gui lan reset in a pi session and choose renew; each phone installs the new one.`, "ca_ending", { days: state.daysLeft, until: caValidity(ca).notAfter }));
			const gone = renamed();
			if (gone) out.push(gone);
		}
		return out;
	};
	const lanNote = () => notes().map((n) => n.text).join(" ") || undefined;

	// What the phone is pointed at ------------------------------------------------------------------------------------------------------------------------------------------------------------------------

	const served = () => (status?.addresses ?? []).filter((a) => a.state === "open");
	/** The name form works while the CA names the computer and the computer still has that name. */
	const nameUsable = () => Boolean(ca?.name) && (() => { const c = currentName(); return "name" in c ? c.name === ca!.name : true; })();
	const hostFor = (form: "name" | "address", address?: string): { host: string; form: "name" | "address" } | undefined => {
		if (form === "name" && nameUsable()) return { host: `${ca!.name}.local`, form: "name" };
		const open = served(), chosen = address ? open.find((a) => a.address === address) : open[0];
		return chosen ? { host: chosen.address, form: "address" } : undefined;
	};
	const urlOf = (): string | undefined => {
		const port = status?.port, at = hostFor("name");
		return listener && port && at ? `https://${at.host}:${port}/sb-app/` : undefined;
	};

	// The listeners ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

	function make(port: number, bindWaitMs?: number): LanListener {
		const { localName: _name, exclude: _exclude, firewall: _firewall, ...options } = seams;
		return createLanListener({
			...options,
			ca: ca!, port,
			...(bindWaitMs !== undefined ? { bindWaitMs } : {}),
			handler: (req, res, at) => gui!.lan(req, res, at),
			isPaired: (req) => lan().carries(req),
			log: (event, fields) => o.log.line(event, flat(fields)),
			onStatus: (next) => {
				status = next;
				// The port or the served addresses changed (another network, a new adapter): the firewall is read again for them.
				if (listener && fireFor !== undefined && fireFor !== JSON.stringify({ port: next.port, served: served().map((a) => ({ address: a.address, iface: a.iface })) })) watchFirewall();
				if (next.caEnded && listener) void serial(async () => (next.caEnded && listener && (await down(false), (held = ENDED))));
			},
		});
	}
	const hasTaken = (s: ListenerStatus) => s.addresses.some((a) => a.state === "taken");
	/** Binds the listeners on the remembered port. The boss's own command moves the port when it is taken on an address: the system picks one for the first, the others follow (up to five tries). Returns whether anything is left serving. */
	async function bringUp(boss: boolean): Promise<boolean> {
		const wanted = lan().port;
		listener = make(wanted);
		status = await listener.start();
		let tries = 0;
		while (boss && hasTaken(status) && tries++ < MAX_MOVES) {
			await listener.stop();
			listener = make(0, 0);
			status = await listener.start();
		}
		if (boss && status.port && status.port !== wanted) moved = coded(`Port ${wanted} was taken on this computer; Wi-Fi access moved to ${status.port}. An app installed from the old address needs adding again.`, "moved", { from: wanted, to: status.port });
		else if (status.port === wanted) moved = undefined;
		const some = status.addresses.some((a) => a.state === "open");
		// Every address refused for a port that is taken: off, with the note; the next start tries again. Anything else (no address yet, one not ready) is the watch's to settle.
		if (!some && status.addresses.length && status.addresses.every((a) => a.state === "taken")) {
			const why = notes();
			await down(false);
			held = coded(`Wi-Fi access stays off: ${why.map((n) => n.text).join(" ")}`, "stays_off", undefined, why);
			return false;
		}
		if (status.port && status.port !== lan().port) lan().setPort(status.port);
		watchFirewall();
		o.log.line("lan-on", flat({ port: status.port, addresses: status.addresses.filter((a) => a.state === "open").map((a) => `${a.address} (${a.iface})`) }));
		return true;
	}
	/** The firewall read runs after the listeners are up (PowerShell takes seconds) and its notes arrive when it is done; it never holds a switch, and a read of listeners that are gone is dropped. */
	function watchFirewall() {
		const port = status?.port, read = seams.firewall ?? (inTestRun() ? undefined : readFirewall);
		if (!listener || !port || !read) return;
		const input = { port, served: served().map((a) => ({ address: a.address, iface: a.iface })) }, seq = ++fireSeq;
		fireFor = JSON.stringify(input);
		void read(input).then((found) => {
			o.log.line("lan-firewall", { summary: found.summary });
			if (seq === fireSeq) fire = found.coded?.map((n) => coded(n.text, n.code, n.params)) ?? found.notes.map((t) => coded(t, "fw_other"));
		}, (error: Error) => o.log.line("lan-firewall", { summary: `the read failed: ${String(error.message).slice(0, 160)}` }));
	}
	/** Closes the listeners and voids what belongs to them. `wish` forgets the wish (Wi-Fi access off); the allowed devices stay either way. */
	async function down(wish: boolean, why = wish ? "off" : "stop") {
		const was = listener;
		listener = undefined;
		await was?.stop();
		status = undefined;
		fire = [];
		fireSeq++;
		fireFor = undefined;
		if (gui) lan().disable(!wish);
		notices.clear();
		told();
		if (was) o.log.line("lan-off", { why });
	}

	// The CA ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

	const fp8 = (c: LanCa) => fingerprints(c).sha1Hex.slice(0, 8).toLowerCase();
	const write = (c: LanCa) => writeCa(o.dir, c, { ...(seams.exclude ? { exclude: seams.exclude } : {}), log: (event, fields) => o.log.line(event, flat(fields)) });
	const names = (n: LocalName): string | undefined | "unreadable" => ("name" in n ? n.name : "invalid" in n ? undefined : "unreadable");

	/** The stored CA, or the reply that says why Wi-Fi access cannot use one. */
	function stored(): { ca: LanCa } | { lost: "missing" | "corrupt" } | { ended: true } {
		const read = readCa(o.dir);
		if ("lost" in read) return read;
		return caStatus(read.ca, now()).state === "ended" ? (ca = read.ca, { ended: true }) : (ca = read.ca, { ca: read.ca });
	}
	const factsOf = (): Record<string, unknown> => {
		const addresses = served().map((a) => ({ address: a.address, interface: a.iface })), g = gui;
		return {
			wanted: g ? lan().wanted : false, on: Boolean(g && listener && lan().on), port: status?.port ?? (g ? lan().port : LAN_PORT), ...(urlOf() ? { url: urlOf() } : {}),
			addresses, pending: g && o.primary ? lan().pending().length : 0, ...(!o.primary ? { note: SECONDARY.text } : lanNote() ? { note: lanNote() } : {}),
		};
	};
	const pendingBody = () => ({
		...factsOf(),
		pending: lan().pending().map(({ id, label, peer, iface, since }: LanPending) => ({ id, label, peer, iface, since, age: age(now() - since), ageMs: now() - since })),
		events: events.map((e) => e.text),
		// The same, with the codes the page words in its own language (gui/lan.ts); `events` and `note` stay the English the overlay shows.
		noteList: notes(),
		eventList: events,
	});

	// The switches ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

	/** A bring-up that threw leaves nothing serving: the listener is dropped, the switch is off, and a note says why; the next start tries again. */
	async function failed(error: unknown) {
		await down(false).catch(() => {});
		held = coded(`Wi-Fi access stays off: ${(error as Error).message}; it is tried again when the server next starts`, "stays_off_error", { message: (error as Error).message });
		o.log.line("lan-off", { why: String((error as Error).message).slice(0, 200) });
	}

	async function turnOn(acceptRisk: boolean): Promise<Reply> {
		if (!o.primary) return bad("secondary", SECONDARY.text, 409);
		const found = stored();
		if ("lost" in found && found.lost === "corrupt") return (held = CORRUPT, bad("lan_ca_corrupt", CORRUPT.text, 409));
		if ("ended" in found) return bad("lan_ca_ended", ENDED.text, 409);
		if ("lost" in found) {
			// No certificate yet: it is made only after the boss read the warning, and never by a resume.
			const current = currentName(), now_ = names(current);
			if (!acceptRisk) return reply(409, { error: "lan_risk", reason: RISK, name: now_ && now_ !== "unreadable" ? now_ : null });
			if (now_ === "unreadable") return bad("lan_name_unreadable", "This computer's name could not be read just now, so no certificate was made; try again in a moment.", 409);
			ca = createCa(now_, now());
			write(ca);
			o.log.line("lan-ca-created", { fp8: fp8(ca) });
		}
		held = undefined;
		// Already serving: the paired phone's connections stay. Only a port that is taken on an address is worth a restart (it moves, as the boss's command does).
		if (listener && lan().on && status && !hasTaken(status)) {
			// The boss ran the command again, often after following a note: read the firewall as it is now.
			watchFirewall();
			return reply(200, { ...factsOf(), text: `Wi-Fi access is on: ${urlOf() ?? "no address is served yet"}` });
		}
		await down(false, "restart").catch(() => {});
		lan().enable();
		let serving: boolean;
		try {
			serving = await bringUp(true);
		} catch (error) {
			await failed(error);
			return bad("lan_start_failed", (error as Error).message, 500);
		}
		if (!serving) return bad("lan_taken", lanNote() ?? "Wi-Fi access could not be turned on.", 409);
		return reply(200, { ...factsOf(), text: `Wi-Fi access is on: ${urlOf() ?? "no address is served yet"}` });
	}
	async function turnOff(): Promise<Reply> {
		if (!gui) return bad("stopped", "The GUI is not running.", 409);
		if (!o.primary) return bad("secondary", SECONDARY.text, 409);
		held = moved = undefined;
		await down(true);
		return reply(200, { ...factsOf(), text: "Wi-Fi access is off; the devices you allowed stay paired" });
	}

	// The control requests and the page's panel -------------------------------------------------------------------------------------------------------------------------------------------------------

	/** Whether a face may answer: it is live and no paired device typed into its pane as it opened. */
	const faceOk = (face: unknown): Reply | undefined => {
		const v = faces.accepts(face);
		return v.ok ? undefined : bad(v.error, v.error === "typed_into" ? "A paired device typed into this session as this screen opened; press Esc and run /boss gui lan again." : "This screen is no longer live; press Esc and run /boss gui lan again.", 409);
	};
	function pairing(surface: string, json: Record<string, unknown>): Reply {
		if (!gui || !lan().on || !listener) return bad("lan_off", "Wi-Fi access is off.", 409);
		const { form, address } = json;
		if (form !== "name" && form !== "address" && form !== "typed") return bad("bad_request", "form is name, address, or typed.");
		if (address !== undefined && (typeof address !== "string" || address.length > 45)) return bad("bad_request", "address is one of the served addresses.");
		const at = hostFor(form === "typed" ? "name" : form, address as string | undefined), port = status?.port;
		if (!at || !port) return bad("lan_no_address", NO_ADDRESS.text, 409);
		if (form === "typed") {
			const code = lan().pairCode(surface);
			return code ? reply(200, { form: at.form, host: at.host, port, code, entry: `https://${at.host}:${port}/sb-app/` }) : bad("lan_off", "Wi-Fi access is off.", 409);
		}
		const code = lan().pair(surface);
		if (!code) return bad("lan_off", "Wi-Fi access is off.", 409);
		const url = `https://${at.host}:${port}/sb-app/pair/${code}`;
		return reply(200, { form: at.form, host: at.host, port, url, rows: qr(url).map((row) => row.map(Number).join("")) });
	}
	function deciding(json: Record<string, unknown>): Reply {
		const keys = Object.keys(json);
		if (keys.length === 1 && typeof json.number === "string" && /^\d{4}$/.test(json.number)) {
			const before = lan().pending().length, done = lan().approve(json.number);
			sweep();
			// A third wrong number denies every request (access.ts): `denied` says so, so the page can tell the boss plainly.
			const left = lan().pending().length;
			return done ? reply(200, { paired: { id: done.id, label: done.label, peer: done.peer } }) : reply(404, { error: "no_match", reason: "No request has that number.", ...(before > 0 && left === 0 ? { denied: before } : {}) });
		}
		if (keys.length === 1 && typeof json.deny === "string" && (json.deny === "all" || /^[0-9a-f]{12}$/.test(json.deny))) {
			const n = lan().deny(json.deny);
			sweep();
			return reply(200, { denied: n });
		}
		return bad("bad_request", "Type the number the phone shows, or deny a request by its id (or all); nothing else decides.");
	}
	function certificate(): Reply {
		if (!o.primary) return bad("secondary", SECONDARY.text, 409);
		const found = stored();
		if ("lost" in found) {
			// The name rides on the answer, so the page can word the risk without a write to find it out (RVL7-F001).
			const mine = names(currentName());
			return reply(409, { error: "no_ca", reason: "There is no Wi-Fi certificate yet; turn Wi-Fi access on first.", name: mine && mine !== "unreadable" ? mine : null });
		}
		const c = ca!, f = fingerprints(c), port = status?.port, at = listener ? hostFor("name") : undefined;
		const page = at && port ? `http://${at.host}:${port}/sb-ca/` : undefined;
		return reply(200, { name: c.name, sha256: f.sha256, sha1: f.sha1, ...(page ? { url: page, rows: qr(page).map((row) => row.map(Number).join("")) } : {}), files: Object.values(CA_FILES), ended: "ended" in found });
	}

	const panel: LanPanel = {
		on: (json) => serial(async () => (gui ? turnOn(json.accept_risk === true) : bad("stopped", "The GUI is not running.", 409))),
		off: () => serial(turnOff),
		pair(json) {
			const surface = json.surface;
			if (typeof surface !== "string" || !/^[A-Za-z0-9_-]{4,64}$/.test(surface)) return bad("bad_request", "Name the tile's surface.");
			return pairing(`tile:${surface}`, json);
		},
		approve: (json) => (gui && o.primary ? deciding(json) : bad("secondary", SECONDARY.text, 409)),
		ca: () => certificate(),
		pending(peek) {
			if (!peek) tileAt = now();
			return gui && o.primary ? reply(200, pendingBody()) : reply(200, { pending: [], events: [], wanted: false, on: false, addresses: [], ...(o.primary ? {} : { note: SECONDARY.text, noteList: [SECONDARY] }) });
		},
		file(file) {
			if (!o.primary || !gui) return undefined;
			const found = stored();
			if ("lost" in found) return undefined;
			return file === CA_FILES.profile ? { type: CA_MIME.profile, bytes: Buffer.from(mobileconfig(ca!)) } : file === CA_FILES.crt ? { type: CA_MIME.crt, bytes: crt(ca!) } : undefined;
		},
	};

	/** A control request of the `gui-lan*` family; the caller (guihost.ts) has found the GUI running. */
	async function handle(request: { cmd: string } & Record<string, unknown>): Promise<SocketReply> {
		const asHttp = (r: Reply): SocketReply => {
			const body = (r.body ?? {}) as Record<string, unknown>;
			return r.status < 300 ? { ok: true, ...body } : { ok: false, ...body, error: typeof body.error === "string" ? body.error : "refused" };
		};
		if (!o.primary) return { ok: false, error: SECONDARY.text };
		switch (request.cmd) {
			case "gui-lan-face": {
				if (request.open === true) {
					const face = faces.open("pane" in request ? request.pane : undefined);
					return face ? { ok: true, face } : { ok: false, error: "bad_request" };
				}
				if (request.open === false) return { ok: true, closed: faces.close(request.face) };
				return { ok: false, error: "bad_request" };
			}
			case "gui-lan-pending": {
				if (!faces.renew(request.face)) return { ok: false, error: "unknown_face" };
				return asHttp(reply(200, pendingBody()));
			}
			case "gui-lan": {
				if (request.on === false) return asHttp(await panel.off());
				if (request.on !== true) return { ok: false, error: "bad_request" };
				const accept = request.accept_risk === true;
				if (accept) {
					const refused = faceOk(request.face);
					if (refused) return asHttp(refused);
				}
				return asHttp(await panel.on({ accept_risk: accept }));
			}
			case "gui-lan-pair": {
				const refused = faceOk(request.face);
				if (refused) return asHttp(refused);
				// The overlay names one surface for its whole life, so a new code voids the earlier one even across a reopen of its mark.
				return asHttp(pairing(`face:${typeof request.surface === "string" && /^[0-9a-f]{32}$/.test(request.surface) ? request.surface : String(request.face)}`, request));
			}
			case "gui-lan-approve": {
				const refused = faceOk(request.face);
				if (refused) return asHttp(refused);
				const { face: _face, ...rest } = request as Record<string, unknown>;
				const { cmd: _cmd, ...json } = rest;
				return asHttp(deciding(json));
			}
			case "gui-lan-reset": {
				const refused = faceOk(request.face);
				if (refused) return asHttp(refused);
				if (typeof request.unpair !== "boolean") return { ok: false, error: "bad_request" };
				return asHttp(await serial(() => reset(request.unpair as boolean)));
			}
			case "gui-lan-files": return asHttp(files());
			case "gui-lan-ca": return asHttp(certificateOf());
			default: return { ok: false, error: "unknown request" };
		}
	}

	/** The CA this computer serves, for the overlay's fingerprint check (control socket only): public facts, and whether a device was allowed over Wi-Fi under this very certificate (paired at or after it was made). */
	function certificateOf(): Reply {
		const found = stored();
		if ("lost" in found) return bad("no_ca", "There is no Wi-Fi certificate yet; run /boss gui lan first.", 409);
		const c = ca!, f = fingerprints(c), span = caValidity(c), created = Date.parse(c.created);
		return reply(200, { name: c.name, sha256: f.sha256, sha1: f.sha1, created, notBefore: span.notBefore, ended: "ended" in found, pairedUnder: lan().store.list().some((d) => d.paired >= created) });
	}

	function files(): Reply {
		const found = stored();
		if ("lost" in found) return bad("no_ca", "There is no Wi-Fi certificate yet; run /boss gui lan first.", 409);
		const dir = join(o.dir, "lan-ca-files");
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		writeFileSync(join(dir, CA_FILES.profile), mobileconfig(ca!));
		writeFileSync(join(dir, CA_FILES.crt), crt(ca!));
		return reply(200, { dir, files: Object.values(CA_FILES).map((f) => join(dir, f)) });
	}

	/** A new CA: for one that is ending or ended, a key that may have been copied, or a renamed computer. `unpair` also unpairs every device allowed over Wi-Fi. Wi-Fi access comes back on with it when it was wanted. */
	async function reset(unpair: boolean): Promise<Reply> {
		const read = readCa(o.dir);
		if ("lost" in read && read.lost === "missing") return bad("no_ca", "There is no Wi-Fi certificate to replace; run /boss gui lan.", 409);
		const current = names(currentName());
		if (current === "unreadable") return bad("lan_name_unreadable", "This computer's name could not be read just now, so no certificate was made; try again in a moment.", 409);
		const next = createCa(current, now());
		write(next);
		rmSync(join(o.dir, "lan-ca-files"), { recursive: true, force: true });
		ca = next;
		held = undefined;
		const wanted = lan().wanted, running = Boolean(listener);
		// Codes and requests in flight belong to the old certificate; the streams end with the connections.
		lan().disable(true);
		if (unpair) lan().store.clear();
		o.log.line("lan-ca-renewed", { fp8: fp8(next), unpaired: unpair });
		if (running && listener) {
			lan().enable();
			await listener.setCa(next);
			status = listener.status();
		} else if (wanted) {
			lan().enable();
			let serving: boolean;
			try {
				serving = await bringUp(false);
			} catch (error) {
				await failed(error);
				return bad("lan_start_failed", (error as Error).message, 500);
			}
			if (!serving) return bad("lan_taken", lanNote() ?? "Wi-Fi access could not be turned on.", 409);
		}
		return reply(200, { ...factsOf(), text: `A new Wi-Fi certificate was made${unpair ? "; every device paired over Wi-Fi is unpaired" : "; the devices stay paired"}` });
	}

	return {
		faces,
		panel,
		handle,
		/** What lan/access.ts tells of a pairing: the notices and the events the overlay and the tile list. */
		event: onEvent,
		/** The GUI this host serves, once `startGui` returned. */
		attach(running: Gui) { gui = running; },
		facts: factsOf,
		/** Why Wi-Fi access is off or limited, for `up` and the page's notice row. */
		get note() { return lanNote(); },
		/** Wi-Fi access is wanted and something keeps it from running. */
		get wantedOff() { return Boolean(gui && o.primary && lan().wanted && !listener); },
		/** At a start: Wi-Fi access comes back when it was wanted; a failure leaves it off with a note, and the next start tries again. */
		resume: () => serial(async () => {
			if (!gui || !o.primary || !lan().wanted) return;
			held = undefined;
			const found = stored();
			if ("lost" in found) return void (held = found.lost === "corrupt" ? CORRUPT : MISSING);
			if ("ended" in found) return void (held = ENDED);
			try {
				lan().enable();
				await bringUp(false);
			} catch (error) {
				await failed(error);
			}
		}),
		/** The GUI stops, rotates, or the server leaves: the listeners close and everything that belonged to them is void; the wish stays. */
		leave: () => serial(async () => void (gui && (await down(false)))),
	};
}
export type LanHost = ReturnType<typeof createLanHost>;
