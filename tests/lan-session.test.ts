import assert from "node:assert/strict";
import { test } from "node:test";
import { type LanCert, type LanDeps, type LanReply, revealCommand, showLan, type LanStart } from "../src/lanface.ts";
import type { Overlay } from "./fakes.ts";
import { until } from "./fakes.ts";

// The overlay of `/boss gui lan` (src/pairing.ts `showLan`; docs/specs/2026-10-30-sb-gui-lan.md, Steps L6): a stand-in server (a function from request to answer), a clock the test moves, and a ticker it fires by hand. The overlay is the
// unit under test; tests/lan-session-live.test.ts runs it against the real server.

const ESC = "\x1b", CERT: LanCert = { sha256: "3F 7A 91 C2 B0 4E 55 D1 8A 0C 66 2E 19 F4 73 B5", sha1: "AAAAAAAA BBBBBBBB CCCCCCCC DDDDDDDD EEEEEEEE", pairedUnder: false };
const FACTS = { on: true, port: 8445, url: "https://weis-mbp.local:8445/sb-app/", addresses: [{ address: "192.168.1.5", interface: "en0" }, { address: "10.0.0.5", interface: "en1" }] };

type Handler = (request: Record<string, unknown>) => LanReply | undefined | Promise<LanReply | undefined>;
function rig(over: { handler?: Handler; start?: LanStart; paired?: boolean; certificate?: () => Promise<LanCert | undefined>; pane?: string | null } = {}) {
	let t = 10_000, nextFace = 1, overlay: Overlay | undefined, rejectUi: ((error: Error) => void) | undefined;
	const calls: Record<string, unknown>[] = [], blocks: boolean[] = [], told: [string, string | undefined][] = [], copied: string[] = [], revealed: string[][] = [], order: string[] = [];
	const ticks: (() => void)[] = [];
	const controller = new AbortController();
	let minted = 0;
	const standIn: Handler = (r) => {
		switch (r.cmd) {
			case "gui-lan-face": return r.open === true ? { ok: true, face: `face-${nextFace++}` } : { ok: true, closed: true };
			case "gui-lan-pending": return { ok: true, ...FACTS, pending: [], events: [] };
			case "gui-lan-pair": return r.form === "typed" ? { ok: true, code: "ABCD EFGH", entry: FACTS.url } : { ok: true, url: `https://weis-mbp.local:8445/sb-app/pair/code-${++minted}`, rows: [minted.toString(2).padStart(6, "0"), "000000", minted.toString(2).padStart(6, "0"), "111111"] };
			case "gui-lan-files": return { ok: true, dir: "/d", files: ["/d/straw-boss.mobileconfig", "/d/straw-boss-lan-ca.crt"] };
			default: return { ok: true };
		}
	};
	const ask = async (request: Record<string, unknown>): Promise<LanReply> => {
		calls.push(request);
		order.push(`${overlay ? "drawn" : "undrawn"}:${String(request.cmd)}`);
		return (await over.handler?.(request)) ?? (await standIn(request))!;
	};
	const deps: LanDeps = {
		ask, pane: over.pane === undefined ? "wA:p9" : over.pane, block: (active) => void (blocks.push(active), order.push(`${overlay ? "drawn" : "undrawn"}:block-${active}`)), now: () => t,
		every: (fn) => (ticks.push(fn), () => void ticks.splice(ticks.indexOf(fn), 1)),
		copy: async (text) => void copied.push(text), reveal: async (paths) => void revealed.push(paths), tell: (text, level) => void told.push([text, level]),
		certificate: over.certificate ?? (async () => ({ ...CERT, pairedUnder: over.paired === true })), signal: controller.signal,
	};
	const ui = { custom: (factory: (tui: unknown, theme: unknown, keys: unknown, done: () => void) => Overlay) => new Promise<void>((resolve, reject) => { rejectUi = reject; overlay = factory({ requestRender() {} }, {}, {}, () => resolve()); }) };
	const run = showLan(ui as never, deps, over.start ?? { screen: "warning", name: "weis-mbp" });
	const settled = run.then(() => "closed" as const, (error: Error) => error);
	return {
		calls, blocks, told, copied, revealed, order, controller, ticks, settled, ask,
		cmds: (cmd: string) => calls.filter((c) => c.cmd === cmd),
		get overlay() { return overlay!; },
		screen: (width = 120) => overlay!.render(width).join("\n"),
		ready: () => until(() => overlay, "the overlay"),
		advance: (ms: number) => void (t += ms),
		/** One renewal, answered. */
		async tick() {
			const before = calls.length;
			for (const fn of [...ticks]) fn();
			await until(() => calls.length > before, "the renewal");
			await new Promise<void>((r) => setImmediate(r));
		},
		async key(data: string) {
			const before = calls.length;
			overlay!.handleInput!(data);
			await new Promise<void>((r) => setTimeout(r, 4));
			return calls.slice(before);
		},
		fail: (error: Error) => rejectUi?.(error),
		async settle() {
			t += 1500;
			await new Promise<void>((r) => setImmediate(r));
		},
	};
}

test("the face is opened at the server before anything is drawn or blocked; without its acknowledgement nothing is drawn, nothing is left open, and the boss is told the server did not answer", async () => {
	const r = rig({ handler: (req) => (req.cmd === "gui-lan-face" ? { ok: false, error: "no server" } : undefined) });
	const result = await r.settled;
	assert.match(String((result as Error).message), /^Could not reach the sb server/);
	assert.equal(r.overlay, undefined, "no overlay was made");
	assert.deepEqual(r.blocks, [], "and the session was not reported blocked");
	assert.deepEqual(r.calls.map((c) => c.cmd), ["gui-lan-face"], "nothing else was asked: no code, no certificate");

	const ok = rig({ start: { screen: "home", facts: FACTS } });
	await ok.ready();
	assert.equal(ok.order[0], "undrawn:gui-lan-face", "the open comes first");
	const firstDraw = ok.order.findIndex((x) => x.startsWith("drawn:"));
	const mintAt = ok.order.findIndex((x) => x.endsWith("gui-lan-pair"));
	assert.ok(firstDraw === -1 || mintAt === -1 || mintAt < firstDraw, "a code, if any, is made before the first draw and after the open");
	assert.ok(ok.order.indexOf("undrawn:gui-lan-face") < ok.order.indexOf("undrawn:block-true"), "the face is open before the session reads as blocked");
	ok.overlay.handleInput!(ESC);
	await ok.settled;
});

test("every face takes only Escape for 1.5 s after the acknowledgement and says so; then the answer keys work", async () => {
	const r = rig();
	await r.ready();
	assert.match(r.screen(), /keys wait 1\.5 s/);
	assert.deepEqual(await r.key("y"), [], "y is not taken");
	r.advance(1499);
	assert.deepEqual(await r.key("y"), [], "nor 1.499 s after");
	r.advance(1);
	assert.match(r.screen(), /^(?![\s\S]*keys wait)/, "the line is gone");
	const sent = await r.key("y");
	assert.deepEqual(sent.map((c) => [c.cmd, c.accept_risk, c.face]), [["gui-lan", true, "face-1"]]);
	r.overlay.handleInput!(ESC);
	assert.equal(await r.settled, "closed");

	// Escape works inside the 1.5 s.
	const e = rig();
	await e.ready();
	e.overlay.handleInput!(ESC);
	assert.equal(await e.settled, "closed");
});

test("the renewal keeps the lease alive: each tick renews with the face id, answer keys stop 4 s after the last answered renewal was sent, and a renewal that is answered again restores them", async () => {
	let answering = true;
	const r = rig({ start: { screen: "certificate", facts: FACTS }, handler: (req) => (req.cmd === "gui-lan-pending" && !answering ? Promise.reject(new Error("socket hang up")) : undefined) });
	await r.ready();
	await r.settle();
	await r.tick();
	assert.deepEqual(r.cmds("gui-lan-pending").map((c) => c.face), ["face-1"]);
	answering = false;
	r.advance(3900);
	await r.tick();
	assert.equal((await r.key("f")).length, 1, "3.9 s after the last answered renewal: still taken");
	r.advance(200); // 4.1 s since the renewal that was answered
	await r.tick();
	assert.match(r.screen(), /No answer from the sb server/);
	assert.deepEqual(await r.key("f"), [], "f is not taken once the last answered renewal is 4 s old");
	assert.deepEqual(await r.key("i"), []);
	answering = true;
	await r.tick();
	assert.doesNotMatch(r.screen(), /No answer from the sb server/);
	assert.equal((await r.key("f")).length, 1, "answered again, the keys work");
	r.overlay.handleInput!(ESC);
	await r.settled;
});

test("when the server no longer knows the face (it restarted, or the lease lapsed) the overlay opens a new mark, uses its id, and is deaf for 1.5 s again", async () => {
	let known = true;
	const r = rig({ handler: (req) => (req.cmd === "gui-lan-pending" && !known ? { ok: false, error: "unknown_face" } : undefined) });
	await r.ready();
	await r.settle();
	known = false;
	await r.tick();
	assert.deepEqual(r.cmds("gui-lan-face").map((c) => [c.open, c.face]), [[true, undefined], [true, undefined]], "a second mark was opened");
	assert.match(r.screen(), /keys wait 1\.5 s/);
	assert.deepEqual(await r.key("y"), []);
	known = true;
	await r.settle();
	await r.tick();
	const sent = await r.key("y");
	assert.equal(sent[0]!.face, "face-2", "the answer carries the new face");
	r.overlay.handleInput!(ESC);
	await r.settled;
	assert.equal(r.cmds("gui-lan-face").at(-1)!.face, "face-2", "and the new one is the one dropped");
});

test("the mark is dropped and the session unblocked on every way out: Escape, q, n on the warning, an error in the overlay, the end of the session", async () => {
	const closes = async (how: (r: ReturnType<typeof rig>) => void | Promise<void>, start?: LanStart) => {
		const r = rig(start ? { start } : {});
		await r.ready();
		await r.settle();
		await how(r);
		await r.settled;
		assert.deepEqual(r.blocks, [true, false]);
		assert.deepEqual(r.cmds("gui-lan-face").map((c) => [c.open, c.face]).at(-1), [false, "face-1"]);
		return r;
	};
	await closes((r) => r.overlay.handleInput!(ESC));
	await closes((r) => r.overlay.handleInput!(ESC), { screen: "certificate" });
	await closes(async (r) => void (await r.key("n")));
	await closes(async (r) => void (await r.key("q")), { screen: "certificate" });
	await closes((r) => r.fail(new Error("the terminal went away")));
	await closes((r) => r.controller.abort());
	const e = rig({ start: { screen: "certificate" }, certificate: async () => { throw new Error("cannot read"); } });
	assert.match(String(((await e.settled) as Error).message), /cannot read/, "an error while entering a face is thrown");
	assert.deepEqual(e.blocks, [true, false], "and still unblocks");
	assert.equal(e.cmds("gui-lan-face").at(-1)!.open, false, "and drops the mark");
});

test("the warning names the computer and the risk; y accepts it from this face only, n and Escape cancel with nothing sent; a name-less certificate is warned without a name", async () => {
	const r = rig();
	await r.ready();
	assert.match(r.screen(), /as weis-mbp\.local and as any private-network address/);
	assert.match(r.screen(), /phone's hotspot/);
	assert.match(r.screen(), /y {2}make the certificate and turn Wi-Fi access on/);
	r.overlay.handleInput!(ESC);
	await r.settled;
	assert.deepEqual(r.cmds("gui-lan"), [], "cancelled: nothing turned on, no certificate asked for");

	const nameless = rig({ start: { screen: "warning", name: null } });
	await nameless.ready();
	assert.match(nameless.screen(), /as any private-network address, such as your router's/);
	assert.doesNotMatch(nameless.screen(), /\.local/);
	nameless.overlay.handleInput!(ESC);
	await nameless.settled;

	const y = rig({ handler: (req) => (req.cmd === "gui-lan" ? { ok: true, ...FACTS, text: "on" } : undefined) });
	await y.ready();
	await y.settle();
	await y.key("y");
	await until(() => /Step 1, once per phone/.test(y.screen()), "the certificate face");
	assert.deepEqual(y.cmds("gui-lan").map((c) => [c.on, c.accept_risk, c.face]), [[true, true, "face-1"]]);
	assert.match(y.told.at(-1)![0], /^Wi-Fi access is on: https:\/\/weis-mbp\.local:8445\/sb-app\/ \(served: 192\.168\.1\.5 \(en0\), 10\.0\.0\.5 \(en1\)\)\. Pair in the overlay; you allow each new device here by typing the number its screen shows\.$/);
	y.overlay.handleInput!(ESC);
	await y.settled;
});

test("a refusal on the warning is said and nothing moves on; a paired device's write as the face opened leaves only Escape", async () => {
	const r = rig({ handler: (req) => (req.cmd === "gui-lan" ? { ok: false, error: "typed_into", reason: "A paired device typed into this session as this screen opened; press Esc and run /boss gui lan again." } : undefined) });
	await r.ready();
	await r.settle();
	await r.key("y");
	assert.match(r.screen(), /A paired device typed into this session as this screen opened; press Esc and run \/boss gui lan again\./);
	assert.deepEqual(await r.key("y"), [], "nothing is taken any more");
	await r.tick();
	assert.deepEqual(await r.key("y"), [], "not even after a renewal");
	assert.match(r.screen(), /Step|Wi-Fi access needs a certificate/);
	r.overlay.handleInput!(ESC);
	assert.equal(await r.settled, "closed");
});

test("the certificate face shows the QR of the plain page, the fingerprint, and each platform's check; i steps through the name and the addresses; f writes and shows the files; t and p move between faces", async () => {
	const r = rig({ start: { screen: "certificate", facts: FACTS } });
	await r.ready();
	await r.settle();
	const screen = r.screen();
	assert.match(screen, /Wi-Fi access is on: https:\/\/weis-mbp\.local:8445 \(served: 192\.168\.1\.5 \(en0\), 10\.0\.0\.5 \(en1\)\)/);
	assert.ok(screen.includes("█") || screen.includes("▀") || screen.includes("▄"), "a QR is drawn");
	assert.match(screen, /SHA-256 starting: 3F 7A 91 C2 B0 4E 55 D1 8A 0C 66 2E 19 F4 73 B5/);
	assert.match(screen, /iPhone, before Install: Profile Downloaded, the profile\. Contains must say only Certificate/);
	assert.match(screen, /Android, after installing: Encryption & credentials, Trusted credentials, User: exactly one Straw Boss LAN CA/);
	assert.match(screen, /SHA-1 thumbprint AAAAAAAA BBBBBBBB/);
	assert.match(r.screen(200), /f {2}show the certificate files {4}p {2}pairing QR \(step 2\) {4}i {2}use the address 192\.168\.1\.5 instead of the name/);
	const narrow = r.screen(30);
	assert.match(narrow, /This pane is 30 columns wide;\n\s+the QR code needs \d+\./);
	assert.ok(r.overlay.render(30).every((line) => [...line].length <= 30));
	assert.equal(r.cmds("gui-lan-pair").length, 0, "the certificate face mints no code");
	await r.key("i");
	assert.match(r.screen(), /Wi-Fi access is on: https:\/\/192\.168\.1\.5:8445/);
	assert.match(r.screen(), /i {2}use the address 10\.0\.0\.5 instead of the name/);
	await r.key("i");
	await r.key("i");
	assert.match(r.screen(), /Wi-Fi access is on: https:\/\/weis-mbp\.local:8445/, "and round to the name");
	assert.equal(r.cmds("gui-lan-pair").length, 0, "still no code on this face");
	const files = await r.key("f");
	assert.deepEqual(files.map((c) => c.cmd), ["gui-lan-files"]);
	assert.deepEqual(r.revealed, [["/d/straw-boss.mobileconfig", "/d/straw-boss-lan-ca.crt"]]);
	assert.match(r.screen(), /The certificate files are in \/d/);
	await r.key("p");
	await until(() => /Scan with a phone on this network/.test(r.screen()), "the pairing face");
	assert.deepEqual(r.cmds("gui-lan-pair").map((c) => [c.form, c.face]), [["name", "face-1"]]);
	assert.match(r.screen(), /If the phone warns that the connection is not private, do not go on: press t and install the certificate\./);
	await r.key("t");
	await until(() => /Step 1, once per phone/.test(r.screen()), "back on the certificate face");
	r.overlay.handleInput!(ESC);
	await r.settled;
});

test("it opens on the certificate face while no device was allowed under this certificate, and on the pairing face after that", async () => {
	for (const [paired, expect] of [[false, /Step 1, once per phone/], [true, /Scan with a phone on this network/]] as const) {
		const r = rig({ start: { screen: "home", facts: FACTS }, paired });
		await r.ready();
		assert.match(r.screen(), expect);
		r.overlay.handleInput!(ESC);
		await r.settled;
	}
});

test("a code is minted only by a press: a redraw, a resize, a renewal, and a keypress that means nothing mint none; p, i, c, and k each mint one under the face", async () => {
	const r = rig({ start: { screen: "pairing", facts: FACTS } });
	await r.ready();
	await r.settle();
	assert.equal(r.cmds("gui-lan-pair").length, 1, "entering the pairing face made its QR");
	for (let i = 0; i < 5; i++) (r.screen(120), r.screen(20));
	await r.tick();
	await r.key("x");
	assert.equal(r.cmds("gui-lan-pair").length, 1, "nothing else minted");
	const shown = () => r.screen().split("\n").filter((line) => /[▀▄█]/.test(line)).join("\n");
	const first = shown();
	await r.key("k");
	assert.deepEqual(r.cmds("gui-lan-pair").at(-1), { cmd: "gui-lan-pair", face: "face-1", surface: r.cmds("gui-lan-pair")[0]!.surface, form: "typed" });
	assert.match(r.screen(), /Or in an installed app, type these 8 characters \(no hyphen; it works once, within ten minutes\):\nABCD EFGH/);
	assert.doesNotMatch(r.screen(), /[▀▄█]{4}/, "the typed code replaces the QR: one code on the screen");
	assert.match(r.screen(), /p {2}a new QR/);
	await r.key("p");
	assert.notEqual(shown(), first, "p draws a new QR");
	assert.doesNotMatch(r.screen(), /ABCD EFGH/);
	await r.key("c");
	assert.equal(r.copied.length, 1);
	assert.equal(r.copied[0], `https://weis-mbp.local:8445/sb-app/pair/code-${r.cmds("gui-lan-pair").filter((c) => c.form !== "typed").length}`, "the clipboard holds the link of the last code made");
	assert.match(r.copied[0]!, /^https:\/\/[^/]+\/sb-app\/pair\/code-\d+$/, "a link without the token");
	assert.notEqual(shown(), first);
	await r.key("i");
	assert.deepEqual(r.cmds("gui-lan-pair").at(-1), { cmd: "gui-lan-pair", face: "face-1", surface: r.cmds("gui-lan-pair")[0]!.surface, form: "address", address: "192.168.1.5" });
	assert.equal(r.cmds("gui-lan-pair").length, 5, "the QR on entering, k, p, c, and i: one each");
	r.overlay.handleInput!(ESC);
	await r.settled;
});

test("a pending request is shown above the face without its number; the number is typed by the boss and nothing fills it in; Enter sends it with the face; a wrong one says so; n denies all; digits mean nothing while nothing waits", async () => {
	let waiting: Record<string, unknown>[] = [];
	let approve: LanReply = { ok: true, paired: { id: "a" } };
	const r = rig({ start: { screen: "pairing", facts: FACTS }, handler: (req) => (req.cmd === "gui-lan-pending" ? { ok: true, ...FACTS, pending: waiting, events: [] } : req.cmd === "gui-lan-approve" ? approve : undefined) });
	await r.ready();
	await r.settle();
	assert.deepEqual(await r.key("4"), [], "no request, no number prompt");
	assert.doesNotMatch(r.screen(), /Number:/);
	waiting = [{ id: "a1", label: "iPhone · Safari", peer: "192.168.1.23", iface: "en0", number: "4821" }];
	await r.tick();
	const screen = r.screen();
	assert.match(screen, /^Pair request: iPhone · Safari from 192\.168\.1\.23 \(en0\)\nType the number your phone shows, then Enter, to allow it\. {3}n {2}deny all {3}Esc {2}decide later\nNumber: █\n/, "above everything else");
	assert.doesNotMatch(screen, /4821/, "the number is not printed even when a server sent it");
	assert.equal(r.cmds("gui-lan-approve").length, 0, "left alone, nothing is allowed");
	await r.tick();
	await r.tick();
	assert.equal(r.cmds("gui-lan-approve").length, 0, "and renewals fill nothing in");
	assert.deepEqual(await r.key("\r"), [], "Enter with no digits sends nothing");
	assert.match(r.screen(), /Type the four digits the phone shows\./);
	for (const d of ["4", "8", "2"]) await r.key(d);
	assert.deepEqual(await r.key("\r"), [], "three digits are not enough");
	assert.match(r.screen(), /Number: 482█/, "what was typed is kept for the retry");
	await r.key("\x7f");
	await r.key("2");
	await r.key("1");
	await r.key("\x1b[53u"); // a fifth digit, as the kitty protocol sends 5
	assert.match(r.screen(), /Number: 4821█/, "four digits at most");
	approve = { ok: false, error: "no_match", reason: "No request has that number." };
	assert.deepEqual((await r.key("\r")).map((c) => [c.cmd, c.face, c.number]), [["gui-lan-approve", "face-1", "4821"]]);
	assert.match(r.screen(), /No request has that number/);
	assert.match(r.screen(), /Number: █/, "the field is cleared");
	approve = { ok: true, denied: 1 };
	assert.deepEqual((await r.key("n")).map((c) => [c.cmd, c.face, c.deny]), [["gui-lan-approve", "face-1", "all"]]);
	waiting.push({ id: "a2", label: "Android · Chrome", peer: "192.168.1.40", iface: "en0" });
	await r.tick();
	assert.match(r.screen(), /^More than one device used a code: only one of them can be your phone\.\nPair request: iPhone · Safari from 192\.168\.1\.23 \(en0\)\nPair request: Android · Chrome from 192\.168\.1\.40 \(en0\)\n/);
	r.overlay.handleInput!(ESC);
	assert.equal(await r.settled, "closed");
	assert.equal(r.cmds("gui-lan-approve").filter((c) => c.number).length, 1, "only the number the boss typed was ever sent");
});

test("the events the server reports are told to the session once, and the overlay lists the latest", async () => {
	let events: string[] = ["old line"];
	const r = rig({ start: { screen: "certificate", facts: FACTS }, handler: (req) => (req.cmd === "gui-lan-pending" ? { ok: true, ...FACTS, pending: [], events } : undefined) });
	await r.ready();
	await r.tick();
	assert.deepEqual(r.told, [], "what was there before the overlay is not told again");
	events = ["old line", "Paired over Wi-Fi: iPhone · Safari (192.168.1.23)"];
	await r.tick();
	await r.tick();
	assert.deepEqual(r.told, [["Paired over Wi-Fi: iPhone · Safari (192.168.1.23)", "info"]]);
	assert.match(r.screen(), /Paired over Wi-Fi: iPhone · Safari \(192\.168\.1\.23\)/);
	events = ["old line", "Paired over Wi-Fi: iPhone · Safari (192.168.1.23)", "A Wi-Fi pairing code was used from 192.168.1.40 and not allowed. If that was not your phone, someone saw the code."];
	await r.tick();
	assert.equal(r.told.at(-1)![1], "warning");
	r.overlay.handleInput!(ESC);
	await r.settled;
});

test("the reset face asks before anything changes: Escape and q cancel with nothing sent; r renews and keeps the devices, u unpairs; each goes to the certificate face", async () => {
	for (const [choice, unpair] of [["r", false], ["u", true]] as const) {
		const r = rig({ start: { screen: "reset" }, handler: (req) => (req.cmd === "gui-lan-reset" ? { ok: true, ...FACTS, text: "A new Wi-Fi certificate was made" } : undefined) });
		await r.ready();
		const screen = r.screen();
		assert.match(screen, /Make a new Wi-Fi access certificate\?/);
		assert.match(screen, /Time Machine's local snapshots may keep a copy of it for up to a day\./);
		assert.match(screen, /r {2}renew: new certificate, devices stay paired/);
		assert.match(screen, /u {2}new certificate and unpair every device paired over Wi-Fi/);
		await r.settle();
		assert.deepEqual((await r.key("x")).length, 0);
		await r.key(choice);
		await until(() => /Step 1, once per phone/.test(r.screen()), "the certificate face");
		assert.deepEqual(r.cmds("gui-lan-reset").map((c) => [c.unpair, c.face]), [[unpair, "face-1"]]);
		assert.match(r.told.at(-1)![0], /A new Wi-Fi certificate was made/);
		r.overlay.handleInput!(ESC);
		await r.settled;
	}
	for (const how of [ESC, "q"]) {
		const r = rig({ start: { screen: "reset", ended: true } });
		await r.ready();
		assert.match(r.screen(), /^This computer's Wi-Fi certificate has ended\./);
		await r.settle();
		r.overlay.handleInput!(how);
		await r.settled;
		assert.deepEqual(r.cmds("gui-lan-reset"), [], `${how === ESC ? "Escape" : "q"} cancels with no reset`);
	}
	const early = rig({ start: { screen: "reset" } });
	await early.ready();
	assert.deepEqual(await early.key("r"), [], "inside the 1.5 s r does nothing");
	early.overlay.handleInput!(ESC);
	await early.settled;
});

test("the session reads as blocked from before the first draw to the close; a pane outside Herdr opens its mark with no pane", async () => {
	const r = rig({ pane: null });
	await r.ready();
	assert.ok(r.order.indexOf("undrawn:block-true") >= 0, "blocked before the overlay existed");
	assert.deepEqual(r.cmds("gui-lan-face")[0], { cmd: "gui-lan-face", pane: null, open: true });
	r.overlay.handleInput!(ESC);
	await r.settled;
	assert.deepEqual(r.blocks, [true, false]);
});

test("the files are shown in Finder, Explorer, or the file manager by the platform's own command", () => {
	const files = ["/d/straw-boss.mobileconfig", "/d/straw-boss-lan-ca.crt"];
	assert.deepEqual(revealCommand(files, "darwin"), ["open", ["-R", ...files]]);
	assert.deepEqual(revealCommand(["C:\\d\\a.crt", "C:\\d\\b.crt"], "win32", { SystemRoot: "C:\\Windows" }), ["C:\\Windows\\explorer.exe", ["/select,C:\\d\\a.crt"]]);
	assert.deepEqual(revealCommand(files, "linux"), ["xdg-open", ["/d"]]);
});

test("RVL6-F003: a reopen after typed_into keeps the face dead (Escape only) and clears the digits already typed", async () => {
	let known = true, taint = false;
	const r = rig({ start: { screen: "pairing", facts: FACTS }, handler: (req) => {
		if (req.cmd === "gui-lan-pending") return known ? { ok: true, ...FACTS, pending: [{ id: "a1", label: "iPhone", peer: "192.168.1.23", iface: "en0" }], events: [] } : { ok: false, error: "unknown_face" };
		if (req.cmd === "gui-lan-approve" && taint) return { ok: false, error: "typed_into", reason: "A paired device typed into this session as this screen opened; press Esc and run /boss gui lan again." };
	} });
	await r.ready();
	await r.settle();
	await r.tick();
	await r.key("1");
	await r.key("2");
	assert.match(r.screen(), /Number: 12█/);
	known = false;
	await r.tick();
	known = true;
	await r.settle();
	await r.tick();
	assert.equal(r.cmds("gui-lan-face").filter((c) => c.open === true).length, 2, "a second mark was opened");
	assert.match(r.screen(), /Number: █/, "the reopen cleared the digits");
	for (const d of ["1", "2", "3", "4"]) await r.key(d);
	taint = true;
	assert.equal((await r.key("\r")).length, 1);
	assert.match(r.screen(), /A paired device typed into this session/);
	known = false;
	await r.tick();
	known = true;
	await r.settle();
	await r.tick();
	assert.equal(r.cmds("gui-lan-face").filter((c) => c.open === true).length, 3);
	assert.deepEqual(await r.key("p"), [], "dead stays dead after the reopen");
	assert.deepEqual(await r.key("t"), []);
	r.overlay.handleInput!(ESC);
	await r.settled;
});

test("RVL6-F004: the codes of one overlay share one surface across a reopen, so the face id changing does not leave the earlier code live", async () => {
	let known = true;
	const r = rig({ start: { screen: "pairing", facts: FACTS }, handler: (req) => (req.cmd === "gui-lan-pending" && !known ? { ok: false, error: "unknown_face" } : undefined) });
	await r.ready();
	await r.settle();
	const before = r.cmds("gui-lan-pair").at(-1)!;
	known = false;
	await r.tick();
	known = true;
	await r.settle();
	await r.tick();
	await r.key("p");
	const after = r.cmds("gui-lan-pair").at(-1)!;
	assert.notEqual(after.face, before.face);
	assert.match(String(after.surface), /^[0-9a-f]{32}$/);
	assert.equal(after.surface, before.surface, "same surface: the server voids the earlier code");
	r.overlay.handleInput!(ESC);
	await r.settled;
});
