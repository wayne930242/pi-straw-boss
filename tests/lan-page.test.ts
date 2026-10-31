import assert from "node:assert/strict";
import { test } from "node:test";
import { CA_FILES } from "../src/lan/ca.ts";

// The pairing tile's Same Wi-Fi tab (gui/lan.ts), the device list's network label (gui/devices.ts), and the tile's tabs (gui/pair.ts) as the page drives them,
// against a fake server and a hand-made DOM: the waiting requests carry no number and are allowed only by the typed one, the certificate step and its fingerprint
// procedure, one code per press, the address toggle, and both languages (docs/specs/2026-10-30-sb-gui-lan.md, "In the GUI", L7).

class El {
	attrs = new Map<string, string>();
	kids: (El | string)[] = [];
	dataset: Record<string, string> = {};
	classes = new Set<string>();
	classList = { add: (c: string) => void this.classes.add(c), remove: (c: string) => void this.classes.delete(c), toggle: (c: string, on?: boolean) => void ((on ?? !this.classes.has(c)) ? this.classes.add(c) : this.classes.delete(c)) };
	listeners = new Map<string, ((e: unknown) => void)[]>();
	onclick: (() => void) | null = null;
	hidden = false;
	disabled = false;
	focused = 0;
	value = "";
	parent: El | undefined;
	tag: string;
	clicked = 0;
	constructor(tag = "") {
		this.tag = tag;
	}
	setAttribute(name: string, value: string) {
		this.attrs.set(name, value);
		if (name === "class") this.classes = new Set(value.split(" "));
	}
	append(...kids: (El | string)[]) {
		for (const k of kids) if (typeof k !== "string") k.parent = this;
		this.kids.push(...kids);
	}
	replaceChildren(...kids: (El | string)[]) {
		this.kids = [];
		this.append(...kids);
	}
	remove() {
		if (this.parent) this.parent.kids = this.parent.kids.filter((k) => k !== this);
	}
	focus() {
		this.focused++;
	}
	click() {
		this.clicked++;
		this.onclick?.();
	}
	addEventListener(type: string, run: (e: unknown) => void) {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), run]);
	}
	fire(type: string, e: unknown = {}) {
		for (const run of this.listeners.get(type) ?? []) run(e);
	}
	get text(): string {
		return this.kids.map((k) => (typeof k === "string" ? k : k.text)).join(" ");
	}
	set textContent(value: string) {
		this.kids = [value];
	}
	find(pred: (el: El) => boolean): El[] {
		return [this, ...this.kids.flatMap((k) => (typeof k === "string" ? [] : k.find(pred)))].filter(pred);
	}
	byTag(tag: string) {
		return this.find((el) => el.tag === tag);
	}
	/** A button by its visible text. */
	button(text: string | RegExp) {
		const found = this.find((el) => el.tag === "button" && (typeof text === "string" ? el.text === text : text.test(el.text)));
		assert.equal(found.length, 1, `one button ${String(text)}, found ${found.length}: ${this.find((e) => e.tag === "button").map((b) => b.text).join(" | ")}`);
		return found[0]!;
	}
	/** Whether the text shows anywhere in this tree and no hidden element above it hides it. */
	shows(text: string | RegExp): boolean {
		if (this.hidden) return false;
		const own = this.kids.some((k) => typeof k === "string" && (typeof text === "string" ? k.includes(text) : text.test(k)));
		return own || this.kids.some((k) => typeof k !== "string" && k.shows(text));
	}
}
const g = globalThis as Record<string, unknown>;
const doc = { querySelector: () => null, createElement: (tag: string) => new El(tag), createElementNS: (_: string, tag: string) => new El(tag) };
Object.assign(g, { document: doc, setInterval: globalThis.setInterval });
const { lanTab } = await import("../gui/lan.ts");
const { deviceList } = await import("../gui/devices.ts");
const { m } = await import("../gui/paraglide/messages.js");
const { overwriteGetLocale } = await import("../gui/paraglide/runtime.js");

type Body = Record<string, unknown>;
interface Call { path: string; body: Body | undefined }
const ans = (body: Body, status = 200) => ({ ok: status < 300, status, body });
const PENDING = { id: "aaaaaaaaaaaa", label: "iPhone · Safari", peer: "192.168.1.23", iface: "en0", since: 1, age: "12 s" };
const CA = { name: "weis-mbp", sha256: "3F 7A 91 C2 B0 4E 55 D1 8A 0C 66 2E 19 F4 73 B5", sha1: "AABBCCDD 11223344 55667788 99AABBCC DDEEFF00", url: "http://weis-mbp.local:8445/sb-ca/", rows: ["101", "010", "101"], files: Object.values(CA_FILES), ended: false };

/** A fake server for the tab: what `lan/pending` answers and how each post is answered; every call is kept. */
function world(over: { ca?: boolean; on?: boolean; pending?: Body[]; events?: (string | Body)[]; addresses?: Body[]; name?: string | null; notes?: Body[] } = {}) {
	const s = { gate: undefined as Promise<void> | undefined, budget: false, nameFallback: false, caFail: false, ca: over.ca ?? true, on: over.on ?? true, pending: over.pending ?? [], events: over.events ?? [], notes: over.notes as Body[] | undefined, addresses: over.addresses ?? [{ address: "192.168.1.5", interface: "en0" }, { address: "10.0.0.8", interface: "en1" }], name: over.name === undefined ? "weis-mbp" : over.name, note: "" };
	const calls: Call[] = [], ticks: (() => void)[] = [];
	let stops = 0, changed = 0, minted = 0;
	const post = async (path: string, body: Body = {}) => {
		calls.push({ path, body });
		switch (path) {
			case "lan/ca": return s.caFail ? ans({ error: "internal" }, 500) : s.ca ? ans({ ...CA, name: s.name }) : ans({ error: "no_ca", reason: "There is no Wi-Fi certificate yet.", name: s.name }, 409);
			case "lan/on": return body.accept_risk === true ? ((s.ca = s.on = true), ans({ on: true })) : s.ca ? ((s.on = true), ans({ on: true })) : ans({ error: "lan_risk", reason: "risk", name: s.name }, 409);
			case "lan/off": return ((s.on = false), ans({}));
			case "lan/pair": {
				minted++;
				const address = body.address as string | undefined, fell = s.nameFallback && body.form === "name", host = fell ? "192.168.1.5" : address ?? (s.name ? `${s.name}.local` : "192.168.1.5");
				return body.form === "typed" ? ans({ form: "name", host, port: 8445, code: "ABCD EFGH", entry: `https://${host}:8445/sb-app/` }) : ans({ form: address || fell ? "address" : "name", host, port: 8445, url: `https://${host}:8445/sb-app/pair/CODE${minted}`, rows: ["101", "010", "101"] });
			}
			case "lan/approve": {
				if (typeof body.number === "string") {
					const hit = s.pending.findIndex((p) => p.number === body.number);
					if (hit < 0 && s.budget) return ((s.pending = []), ans({ error: "no_match", reason: "No request has that number.", denied: 2 }, 404));
					return hit < 0 ? ans({ error: "no_match", reason: "No request has that number." }, 404) : (s.pending.splice(hit, 1), ans({ paired: {} }));
				}
				s.pending = body.deny === "all" ? [] : s.pending.filter((p) => p.id !== body.deny);
				return ans({ denied: 1 });
			}
			default: return ans({ error: "not_found" }, 404);
		}
	};
	const get = async (path: string) => {
		calls.push({ path, body: undefined });
		await s.gate;
		return ans({ on: s.on, wanted: s.on, addresses: s.on ? s.addresses : [], pending: s.pending, events: s.events.map((e) => (typeof e === "string" ? e : e.text)), ...(s.events.some((e) => typeof e !== "string") ? { eventList: s.events.map((e) => (typeof e === "string" ? { text: e } : e)) } : {}), ...(s.note ? { note: s.note } : {}), ...(s.notes ? { noteList: s.notes } : {}) });
	};
	const tab = lanTab({ get, post, surface: "tile-abc123", changed: () => void changed++, every: (run) => (ticks.push(run), () => void stops++) });
	return { tab, root: tab.root as unknown as El, s, calls, ticks, post: (path: string) => calls.filter((c) => c.path === path), get stops() { return stops; }, get changed() { return changed; }, async settle() { for (let i = 0; i < 12; i++) await new Promise<void>((r) => setImmediate(r)); }, async tick() { for (const t of [...ticks]) t(); await this.settle(); } };
}

test("Wi-Fi access off with no certificate: the risk and the hotspot advice above one button, and nothing is made or turned on until it is pressed", async () => {
	const w = world({ ca: false, on: false });
	w.tab.start();
	await w.settle();
	assert.ok(w.root.shows(m.lan_off_ask()));
	assert.ok(w.root.shows(m.lan_risk({ name: "weis-mbp", expiry_note: "" })), "the warning names the computer");
	assert.ok(w.root.shows(m.lan_hotspot()));
	assert.match(m.lan_risk({ name: "weis-mbp", expiry_note: "" }), /weis-mbp\.local/);
	assert.deepEqual(w.post("lan/on"), [], "the computer's name comes with the no_ca answer: the page posts nothing that could turn Wi-Fi access on");
	const turn = w.root.button(m.lan_turn_on());
	turn.click();
	await w.settle();
	assert.deepEqual(w.post("lan/on").at(-1)!.body, { accept_risk: true }, "only the button under the warning accepts the risk");
	assert.ok(w.root.shows(m.lan_step_ca()), "once on, the page goes to the certificate step");
});

test("with a certificate already made, the off state offers Turn on Wi-Fi access (nothing is made) and an ended certificate says so", async () => {
	const w = world({ ca: true, on: false });
	w.tab.start();
	await w.settle();
	w.root.button(m.lan_turn_on_existing());
	assert.equal(w.post("lan/on").length, 0, "no probe is needed when the certificate exists: lan/on would turn it on");
	const none = world({ ca: false, on: false, name: null });
	none.tab.start();
	await none.settle();
	assert.ok(none.root.shows(m.lan_risk_noname({ expiry_note: "" })), "a computer with no usable name gets the risk without the name");
});

test("RVL7-F001: a lan/ca that fails while a certificate exists posts no lan/on at all; only the press of the button turns Wi-Fi access on", async () => {
	const w = world({ ca: true, on: false });
	w.s.caFail = true;
	w.tab.start();
	await w.settle();
	assert.deepEqual(w.post("lan/on"), [], "no lan/on of any kind was posted");
	const pane = w.root.find((e) => e.classes.has("lan-main"))[0]!;
	assert.equal(pane.byTag("button").length, 0, "nothing to press while the certificate state is unknown");
	w.s.caFail = false;
	await w.tick();
	assert.ok(w.root.shows(m.lan_off_ask()), "the next poll reads it again and the off state shows");
	assert.deepEqual(w.post("lan/on"), [], "still nothing posted before a press");
	w.root.button(m.lan_turn_on_existing()).click();
	await w.settle();
	assert.deepEqual(w.post("lan/on").map((c) => c.body), [{ accept_risk: true }]);
});

test("on: the certificate step has a link for each public file, and the fingerprint procedure per platform", async () => {
	const w = world();
	w.tab.start();
	await w.settle();
	assert.ok(w.root.shows(m.lan_risk_short()));
	const details = w.root.byTag("details")[0]!;
	assert.equal(details.byTag("summary")[0]!.text, m.lan_risk_details());
	assert.ok(details.shows(m.lan_risk({ name: "weis-mbp", expiry_note: "" })) && details.shows(m.lan_hotspot()), "Details holds the full warning");
	assert.ok(w.root.shows(m.lan_share_ca()));
	const links = w.root.byTag("a");
	assert.deepEqual(links.map((a) => [a.attrs.get("href"), a.attrs.get("download"), a.text, a.clicked]), [["api/lan/ca/straw-boss.mobileconfig", "straw-boss.mobileconfig", m.lan_share_profile(), 0], ["api/lan/ca/straw-boss-lan-ca.crt", "straw-boss-lan-ca.crt", m.lan_share_crt(), 0]], "RVL7-F009: one link for each public file, which the boss presses; nothing starts two downloads from one click");
	assert.ok(w.root.shows(m.lan_fp_lead()));
	assert.ok(w.root.shows(CA.sha256), "the first 16 bytes of the SHA-256 in byte pairs");
	for (const line of [m.lan_fp_ios(), m.lan_fp_android(), m.lan_fp_mac(), m.lan_fp_windows({ sha1: CA.sha1 })]) assert.ok(w.root.shows(line), line);
	assert.ok(w.root.shows(CA.url) && w.root.shows(m.lan_scan_ca()), "the certificate page's QR and address");
	assert.ok(w.root.shows(m.lan_step_pair()));
});

test("pairing: every code goes out under the tab's own surface id, a typed code only after Show a code, and a new QR drops the typed code it voids", async () => {
	const w = world();
	w.tab.start();
	await w.settle();
	const pairs = () => w.post("lan/pair").map((c) => c.body);
	assert.deepEqual(pairs(), [{ surface: "tile-abc123", form: "name" }], "opening the tab on a running Wi-Fi access mints one QR, and no typed code");
	assert.equal(w.root.shows("ABCD EFGH"), false);
	w.root.button(m.lan_show_code()).click();
	await w.settle();
	assert.deepEqual(pairs().at(-1), { surface: "tile-abc123", form: "typed" });
	assert.ok(w.root.shows("ABCD EFGH"));
	w.root.button(m.new_code()).click();
	await w.settle();
	assert.deepEqual(pairs().at(-1), { surface: "tile-abc123", form: "name" });
	assert.equal(w.root.shows("ABCD EFGH"), false, "the new QR voided the typed code and the screen no longer shows it");
	assert.equal(pairs().length, 3);
	assert.ok(pairs().every((b) => b?.surface === "tile-abc123"));
});

test("the address toggle steps through the name and each served address and back, asking for a new code each time", async () => {
	const w = world();
	w.tab.start();
	await w.settle();
	const pairs = () => w.post("lan/pair").map((c) => c.body);
	w.root.button(m.lan_use_address({ address: "192.168.1.5" })).click();
	await w.settle();
	assert.deepEqual(pairs().at(-1), { surface: "tile-abc123", form: "address", address: "192.168.1.5" });
	assert.ok(w.root.shows("192.168.1.5:8445"));
	w.root.button(m.lan_use_address({ address: "10.0.0.8" })).click();
	await w.settle();
	assert.deepEqual(pairs().at(-1), { surface: "tile-abc123", form: "address", address: "10.0.0.8" });
	w.root.button(m.lan_use_name({ name: "weis-mbp" })).click();
	await w.settle();
	assert.deepEqual(pairs().at(-1), { surface: "tile-abc123", form: "name" });
	w.root.button(m.new_code()).click();
	await w.settle();
	assert.deepEqual(pairs().at(-1), { surface: "tile-abc123", form: "name" }, "New code keeps the form on screen");
	const nameless = world({ name: null, addresses: [{ address: "192.168.1.5" }] });
	nameless.tab.start();
	await nameless.settle();
	assert.deepEqual(nameless.post("lan/pair").map((c) => c.body?.form), ["name"], "the server answers an address when there is no name");
	assert.equal(nameless.root.find((e) => e.tag === "button" && /192\.168\.1\.5/.test(e.text)).length, 0, "one target: no toggle");
});

test("waiting requests: a row each (label, address with its interface, age), never a number, no button that allows a row; the field and Allow send the typed number alone", async () => {
	const second = { ...PENDING, id: "bbbbbbbbbbbb", label: "Android · Chrome", peer: "192.168.1.40", number: "7305" };
	const w = world({ pending: [{ ...PENDING, number: "4821" }, second] });
	w.tab.start();
	await w.settle();
	const text = w.root.text;
	assert.ok(w.root.shows(m.lan_pending({ label: "iPhone · Safari", peer: "192.168.1.23 (en0)", age: "12 s" })));
	assert.ok(w.root.shows(m.lan_pending({ label: "Android · Chrome", peer: "192.168.1.40 (en0)", age: "12 s" })));
	assert.ok(w.root.shows(m.lan_pending_many()), "two requests: only one can be the boss's phone");
	assert.ok(!/4821|7305/.test(text), "the tile prints no number, even one the server sent");
	assert.ok(w.root.shows(m.lan_number_ask()));
	const rows = w.root.byTag("li").filter((li) => li.shows("Safari") || li.shows("Chrome"));
	assert.equal(rows.length, 2);
	for (const row of rows) assert.deepEqual(row.byTag("button").map((b) => b.text), [m.lan_deny_one()], "a row's only button is its Deny");
	assert.equal(w.root.find((e) => e.tag === "button" && e.text === m.lan_allow()).length, 1, "one Allow, for the field");
	const field = w.root.byTag("input")[0]!;
	assert.equal(field.attrs.get("maxlength"), "4");
	field.value = "48a2x1";
	field.fire("input");
	assert.equal(field.value, "4821", "digits only, four at most");
	field.value = "482";
	w.root.button(m.lan_allow()).click();
	await w.settle();
	assert.equal(w.post("lan/approve").length, 0, "three digits send nothing");
	field.value = "0000";
	w.root.button(m.lan_allow()).click();
	await w.settle();
	assert.deepEqual(w.post("lan/approve").map((c) => c.body), [{ number: "0000" }]);
	assert.ok(w.root.shows(m.lan_no_match()), "a number that matches none says so");
	field.value = "4821";
	field.fire("keydown", { key: "Enter" });
	await w.settle();
	assert.deepEqual(w.post("lan/approve").at(-1)!.body, { number: "4821" }, "Enter allows too");
	assert.equal(field.value, "", "an allowed number clears the field");
	assert.ok(!w.root.shows("iPhone · Safari"), "the allowed request is gone from the list");
	assert.ok(w.root.shows("Android · Chrome"));
	assert.ok(!w.root.shows(m.lan_pending_many()), "one left: no more-than-one line");
	assert.ok(w.changed > 0, "the device list is read again");
	for (const c of w.post("lan/approve")) assert.ok(Object.keys(c.body!).length === 1 && ("number" in c.body! || "deny" in c.body!), "the tile sends a number or a deny and nothing else");
});

test("Deny on a row denies that request, Deny all denies every one, and the whole panel is gone when nothing waits", async () => {
	const w = world({ pending: [PENDING, { ...PENDING, id: "bbbbbbbbbbbb", label: "Android · Chrome", number: "1" }] });
	w.tab.start();
	await w.settle();
	w.root.find((e) => e.tag === "button" && e.attrs.get("aria-label") === `${m.lan_deny_one()}: iPhone · Safari`)[0]!.click();
	await w.settle();
	assert.deepEqual(w.post("lan/approve").at(-1)!.body, { deny: "aaaaaaaaaaaa" });
	assert.ok(!w.root.shows("iPhone · Safari") && w.root.shows("Android · Chrome"));
	w.root.button(m.lan_deny()).click();
	await w.settle();
	assert.deepEqual(w.post("lan/approve").at(-1)!.body, { deny: "all" });
	const board = w.root.find((e) => e.classes.has("lan-board"))[0]!;
	assert.equal(board.hidden, true, "no request: the rows and the field are hidden");
	assert.equal(w.root.shows(m.lan_number_ask()), false);
});

test("the poll runs at once and every second while the tab is open, draws a request that arrives, and stops when the tab is left", async () => {
	const w = world();
	w.tab.start();
	await w.settle();
	assert.equal(w.calls.filter((c) => c.path === "lan/pending").length, 1);
	assert.equal(w.ticks.length, 1);
	assert.ok(!w.root.shows(m.lan_number_ask()));
	w.s.pending.push({ ...PENDING, number: "4821" });
	await w.tick();
	assert.ok(w.root.shows(m.lan_number_ask()) && w.root.shows("iPhone · Safari"));
	assert.equal(w.calls.filter((c) => c.path === "lan/pending").length, 2);
	const field = w.root.byTag("input")[0]!;
	field.value = "48";
	await w.tick();
	assert.equal(field.value, "48", "a poll draws the rows again and leaves the digits being typed");
	assert.equal(w.post("lan/pair").length, 1, "a poll mints no code");
	assert.equal(w.post("lan/ca").length, 1, "a poll draws the steps again only when Wi-Fi access turns on or off");
	w.tab.end();
	assert.equal(w.stops, 1);
	w.s.on = false;
	w.tab.start();
	await w.settle();
	assert.ok(w.root.shows(m.lan_off_ask()), "turned off from elsewhere: the tab follows");
	assert.equal(w.root.shows("iPhone · Safari"), false, "no request is listed while Wi-Fi access is off");
});

test("Turn off Wi-Fi access asks the server and the tab goes to the off state; the notes and events the server sends show, and no address says so", async () => {
	const w = world({ events: ["Paired over Wi-Fi: iPhone · Safari (192.168.1.23)"] });
	w.s.note = "Port 8445 is taken on 10.0.0.8 by another program.";
	w.tab.start();
	await w.settle();
	assert.ok(w.root.shows("Paired over Wi-Fi: iPhone · Safari (192.168.1.23)"));
	assert.ok(w.root.shows("Port 8445 is taken on 10.0.0.8 by another program."));
	w.root.button(m.lan_turn_off()).click();
	await w.settle();
	assert.equal(w.post("lan/off").length, 1);
	assert.ok(w.root.shows(m.lan_off_ask()));
	const lone = world({ addresses: [] });
	lone.tab.start();
	await lone.settle();
	assert.ok(lone.root.shows(m.lan_no_address()));
});

test("both languages: the tab's text is Traditional Chinese under zh-TW", async () => {
	overwriteGetLocale(() => "zh-TW");
	try {
		const w = world({ pending: [PENDING] });
		w.tab.start();
		await w.settle();
		assert.ok(w.root.shows("輸入你手機上顯示的號碼"));
		assert.ok(w.root.shows("允許") || w.root.button("允許"));
		w.root.button("全部拒絕");
		assert.ok(w.root.shows("在這裡下載憑證，再用 AirDrop 或快速分享傳到手機（除非手機要你接受來自不明傳送者的檔案，否則不必核對）。"));
		assert.deepEqual(w.root.byTag("a").map((a) => a.text), ["iPhone 或 Mac 用：描述檔（.mobileconfig）", "Android 或 Windows 用：憑證（.crt）"]);
		assert.ok(w.root.shows("配對請求：iPhone · Safari，來自 192.168.1.23 (en0)，12 s前"));
		assert.equal(m.pair_tab_lan(), "同一個 Wi-Fi");
		assert.equal(m.pair_title(), "配對手機");
		assert.equal(m.device_net_lan({ host: "weis-mbp.local" }), "Wi-Fi・weis-mbp.local");
		assert.doesNotMatch(Object.values({ a: m.lan_risk_details(), b: m.lan_hotspot(), c: m.lan_fp_ios(), d: m.lan_pending_many() }).join(""), /[们这个来过证书设]/, "no Simplified characters");
	} finally {
		overwriteGetLocale(() => "en");
	}
	assert.equal(m.pair_tab_lan(), "Same Wi-Fi");
	assert.equal(m.pair_title(), "Pair a phone");
});

test("the device list labels each device with its network, Turn off remote access shows only on the Tailscale tab, and Unpair acts on either", async () => {
	const calls: string[] = [];
	let tab = true;
	Object.assign(g, {
		fetch: async (url: string, init?: { body?: string }) => {
			calls.push(`${url} ${init?.body ?? ""}`);
			const body = url.endsWith("remote/devices") ? { on: true, devices: [{ id: "a1", label: "iPhone", paired: 1, seen: 2, net: "lan", host: "weis-mbp.local" }, { id: "b2", label: "Pixel", paired: 1, seen: 1, net: "tailnet" }, { id: "c3", label: "Old", paired: 1, seen: 0 }] } : {};
			return { ok: true, status: 200, json: async () => body };
		},
	});
	const list = deviceList(() => {}, () => tab);
	await new Promise<void>((r) => setImmediate(r));
	const box = list.box as unknown as El;
	assert.ok(box.shows(m.device_net_lan({ host: "weis-mbp.local" })), "Wi-Fi · host");
	assert.equal(box.find((e) => e.tag === "small" && e.text === m.device_net_tailscale()).length, 2, "tailnet devices, and one with no network field, read Tailscale");
	assert.ok(box.shows(m.remote_turn_off()));
	tab = false;
	await list.refresh();
	assert.equal(box.shows(m.remote_turn_off()), false, "the Wi-Fi tab has its own Turn off");
	const lan = box.find((e) => e.tag === "button" && e.attrs.get("aria-label") === m.unpair_device({ name: "iPhone" }))[0]!;
	lan.click();
	await new Promise<void>((r) => setImmediate(r));
	assert.ok(calls.some((c) => c.startsWith("api/remote/unpair ") && c.includes('"id":"a1"')), "Unpair names the id of a Wi-Fi device through the shared route");
});

test("the pairing tile has the Tailscale and Same Wi-Fi tabs, keeps the device list under both, polls only while the Wi-Fi tab is shown, and stops when the tile closes", async () => {
	const seen: string[] = [], timers = new Map<number, () => void>();
	let n = 0;
	Object.assign(g, {
		setInterval: (run: () => void) => (timers.set(++n, run), n),
		clearInterval: (id: number) => void timers.delete(id),
		fetch: async (url: string, init?: { body?: string }) => {
			seen.push(`${url} ${init?.body ?? ""}`.trim());
			const body = url.endsWith("remote/pair") ? { url: "https://box.ts.net/x", rows: ["1"] } : url.endsWith("remote/devices") ? { on: false, devices: [] } : url.endsWith("lan/pending") ? { on: false, pending: [], events: [], addresses: [] } : url.endsWith("lan/ca") ? { error: "no_ca" } : { error: "lan_risk", name: "weis-mbp" };
			return { ok: true, status: 200, json: async () => body };
		},
	});
	const { pairTile } = await import("../gui/pair.ts");
	const tile = pairTile(), root = tile.body() as unknown as El;
	const settle = async () => { for (let i = 0; i < 12; i++) await new Promise<void>((r) => setImmediate(r)); };
	await settle();
	assert.deepEqual(root.find((e) => e.attrs.get("role") === "tab").map((b) => b.text), [m.pair_tab_tailscale(), m.pair_tab_lan()]);
	const [ts, wifi] = root.find((e) => e.attrs.get("role") === "tab") as [El, El];
	const lan = root.find((e) => e.classes.has("lan"))[0]!, code = root.find((e) => e.classes.has("pair") && e !== root)[0]!, devices = root.find((e) => e.classes.has("devices"))[0]!;
	assert.equal(lan.hidden, true);
	assert.equal(code.hidden, false);
	assert.equal(ts.attrs.get("aria-selected"), "true");
	assert.equal(root.find((e) => e.attrs.get("role") === "tablist").length, 1, "RVL7-F008: the tabs are a tablist");
	assert.deepEqual([ts, wifi].map((b) => [b.attrs.get("aria-controls"), b.attrs.get("tabindex")]), [["pair-panel-tailscale", "0"], ["pair-panel-lan", "-1"]]);
	assert.deepEqual([code, lan].map((p) => [p.attrs.get("role"), p.attrs.get("id"), p.attrs.get("aria-labelledby")]), [["tabpanel", "pair-panel-tailscale", "pair-tab-tailscale"], ["tabpanel", "pair-panel-lan", "pair-tab-lan"]]);
	assert.ok(!seen.some((s) => s.includes("lan/")), "the Wi-Fi tab asks nothing until it is shown");
	assert.equal(timers.size, 0);
	let prevented = 0;
	ts.fire("keydown", { key: "ArrowRight", preventDefault: () => void prevented++ });
	await settle();
	assert.deepEqual([prevented, wifi.focused, wifi.attrs.get("aria-selected"), wifi.attrs.get("tabindex")], [1, 1, "true", "0"], "the arrow key moves to the next tab and focuses it");
	assert.equal(lan.hidden, false);
	assert.equal(code.hidden, true);
	assert.equal(wifi.attrs.get("aria-selected"), "true");
	assert.equal(ts.attrs.get("aria-selected"), "false");
	assert.ok(seen.includes("api/lan/pending"), "the Wi-Fi tab polls");
	assert.equal(timers.size, 1);
	assert.ok(devices.shows(m.devices_title()), "the device list stays under the Wi-Fi tab");
	ts.click();
	await settle();
	assert.equal(timers.size, 0, "leaving the tab stops its poll");
	wifi.click();
	await settle();
	assert.equal(timers.size, 1);
	tile.closed!();
	assert.equal(timers.size, 0, "closing the tile stops it");
	assert.ok(seen.every((s) => !s.startsWith("api/lan/") || s.startsWith("api/lan/pending") || s.startsWith("api/lan/ca") || s.startsWith("api/lan/on {}")), "nothing mints or turns on by opening the tab");
});

test("RVL7-F002: the server's events, notes, and ages show in the page's language through their codes, never name a key the tile lacks, and a code the page does not know shows the server's text", async () => {
	const events = [
		{ at: 1, code: "paired", params: { label: "iPhone · Safari", peer: "192.168.1.23" }, text: "Paired over Wi-Fi: iPhone · Safari (192.168.1.23)" },
		{ at: 2, code: "void", params: { peers: 3 }, text: "Too many wrong codes from 3 addresses; this code is void. Press c for a new one (the QR still works)." },
		{ at: 3, code: "mystery", text: "Something new the page has no words for." },
	];
	const notes = [
		{ code: "vpn", text: "A VPN carries this computer's traffic." },
		{ code: "renamed_n", params: { caName: "weis-mbp", name: "weis-mbp-2" }, text: "macOS renamed this computer weis-mbp-2. Use the address form here (press i)." },
		{ code: "ca_ending", params: { days: 12, until: Date.UTC(2027, 0, 5, 12) }, text: "ends in 12 days" },
		{ code: "stays_off", of: [{ code: "taken", params: { port: 8445, address: "10.0.0.8" }, text: "Port 8445 is taken on 10.0.0.8" }], text: "Wi-Fi access stays off: Port 8445 is taken on 10.0.0.8" },
	];
	const pending = [{ ...PENDING, age: "25 s", ageMs: 25_000 }, { ...PENDING, id: "bbbbbbbbbbbb", age: "2 min", ageMs: 90_000 }];
	const seen = async () => {
		const w = world({ events, notes, pending });
		w.tab.start();
		await w.settle();
		return w.root;
	};
	const en = await seen();
	assert.ok(en.shows(m.lan_paired({ label: "iPhone · Safari", peer: "192.168.1.23" })) && en.shows(m.lan_void({ peers: "3" })) && en.shows(m.lan_vpn()));
	assert.ok(en.shows("Something new the page has no words for."), "an unknown code shows the server's text");
	assert.ok(en.shows(m.lan_pending({ label: "iPhone · Safari", peer: "192.168.1.23 (en0)", age: "25 s" })) && en.shows(m.lan_pending({ label: "iPhone · Safari", peer: "192.168.1.23 (en0)", age: "2 min" })));
	assert.doesNotMatch(en.text, /press [ci]\b/i, "no key of the overlay is named on the tile");
	assert.ok(en.shows(m.lan_stays_off({ why: m.lan_port_taken({ port: "8445", address: "10.0.0.8" }) })), "a note that holds others is worded from the ones inside");
	overwriteGetLocale(() => "zh-TW");
	try {
		const zh = await seen();
		assert.ok(zh.shows("已透過 Wi-Fi 配對：iPhone · Safari（192.168.1.23）"));
		assert.ok(zh.shows(m.lan_void({ peers: "3" })) && /[一-鿿]/.test(m.lan_void({ peers: "3" })));
		assert.ok(zh.shows("配對請求：iPhone · Safari，來自 192.168.1.23 (en0)，25 秒前"), "the age is worded on the page");
		assert.ok(zh.shows("配對請求：iPhone · Safari，來自 192.168.1.23 (en0)，2 分鐘前"));
		assert.ok(zh.shows(m.lan_renamed_n({ caName: "weis-mbp", name: "weis-mbp-2" })) && zh.shows(m.lan_vpn()));
		assert.doesNotMatch(zh.text, /Paired over|Too many wrong|press [ci]\b|A VPN carries| s前/i, "no English server sentence and no raw age on the zh page");
		assert.ok(zh.shows(m.lan_ca_ending({ date: new Date(Date.UTC(2027, 0, 5, 12)).toLocaleDateString() })));
	} finally {
		overwriteGetLocale(() => "en");
	}
});

test("RVL7-F003: a poll in flight when the tab is left mints no QR and draws nothing", async () => {
	const w = world();
	let release!: () => void;
	w.s.gate = new Promise<void>((r) => (release = r));
	w.tab.start();
	w.tab.end();
	release();
	await w.settle();
	assert.deepEqual([w.post("lan/pair").length, w.post("lan/ca").length], [0, 0], "the late answer drew no step and minted no code");
	w.tab.start();
	await w.settle();
	assert.equal(w.post("lan/pair").length, 1, "shown again: one QR, as always");
});

test("RVL7-F004: a poll leaves the rows, the Deny under the pointer, and the live regions alone; only an age or a new row or event changes", async () => {
	const w = world({ pending: [{ ...PENDING, ageMs: 12_000 }], events: [{ at: 1, code: "wrong", params: { count: 1, peer: "192.168.1.40" }, text: "1 wrong codes from 192.168.1.40" }] });
	w.tab.start();
	await w.settle();
	const row = w.root.byTag("li").find((li) => li.shows("Safari"))!, deny = row.byTag("button")[0]!;
	const first = w.root.find((e) => e.classes.has("lan-news"))[0]!.byTag("li")[0]!, note = w.root.find((e) => e.classes.has("lan-note"))[0]!;
	let notes = 0, newsKids = 0;
	const was = note.replaceChildren.bind(note);
	note.replaceChildren = (...k: (El | string)[]) => (notes++, was(...k));
	const news = w.root.find((e) => e.classes.has("lan-news"))[0]!, wasNews = news.replaceChildren.bind(news);
	news.replaceChildren = (...k: (El | string)[]) => (newsKids++, wasNews(...k));
	await w.tick();
	await w.tick();
	assert.ok(row.parent && deny.parent === row, "the row and its Deny are the same elements after the polls (focus and a press survive)");
	assert.deepEqual([notes, newsKids], [0, 0], "no live region was rewritten by a poll that changed nothing");
	assert.equal(w.root.byTag("li").filter((li) => li.shows("Safari")).length, 1);
	w.s.pending = [{ ...PENDING, ageMs: 75_000 }, { ...PENDING, id: "bbbbbbbbbbbb", label: "Pixel", ageMs: 3000 }];
	w.s.events = [...w.s.events, { at: 2, code: "wrong", params: { count: 2, peer: "192.168.1.40" }, text: "2 wrong codes" }];
	await w.tick();
	assert.ok(row.shows(m.lan_pending({ label: "iPhone · Safari", peer: "192.168.1.23 (en0)", age: m.lan_age_min({ n: "1" }) })), "the age changed in place");
	assert.ok(deny.parent === row && first.parent, "the first row and the first event are the same elements");
	assert.equal(news.byTag("li").length, 2, "the new event was added");
	assert.equal(w.root.byTag("li").filter((li) => li.shows("Pixel")).length, 1, "the new row was added");
	w.s.pending = [];
	await w.tick();
	assert.ok(!w.root.find((e) => e.classes.has("lan-rows"))[0]!.kids.includes(row), "the row of a request that left is removed");
	assert.ok(!w.root.shows("Pixel") && !w.root.shows("Safari"), "rows that left are gone");
});

test("RVL7-F005: the narrow zh layout keeps Deny whole and does not uppercase the Wi-Fi buttons", async () => {
	const { readFileSync } = await import("node:fs");
	const css = readFileSync(new URL("../gui/style.css", import.meta.url), "utf8");
	assert.match(css, /\.lan-rows li > button \{[^}]*flex: none;[^}]*white-space: nowrap/);
	assert.match(css, /\.lan button, \.lan a\.go \{ text-transform: none; \}/);
});

test("RVL7-F007: Allow takes one submit at a time (a double Enter or click counts once toward the three wrong numbers), and three wrong numbers say every request was denied", async () => {
	const w = world({ pending: [{ ...PENDING, number: "4821" }] });
	w.tab.start();
	await w.settle();
	const field = w.root.byTag("input")[0]!, allow = w.root.button(m.lan_allow());
	field.value = "4821";
	field.fire("keydown", { key: "Enter" });
	field.fire("keydown", { key: "Enter" });
	allow.click();
	assert.equal(allow.disabled, true, "Allow is off while the answer is on the way");
	await w.settle();
	assert.equal(w.post("lan/approve").length, 1, "a double submit is one request");
	assert.ok(!w.root.shows(m.lan_no_match()), "no false \"no request has that number\" after a success");
	assert.equal(allow.disabled, false);
	const b = world({ pending: [PENDING, { ...PENDING, id: "bbbbbbbbbbbb", label: "Android · Chrome" }] });
	b.s.budget = true;
	b.tab.start();
	await b.settle();
	const f2 = b.root.byTag("input")[0]!;
	f2.value = "0000";
	b.root.button(m.lan_allow()).click();
	await b.settle();
	assert.ok(b.root.shows(m.lan_wrong_budget()), "the page says plainly that every request was denied");
	assert.equal(b.root.shows(m.lan_no_match()), false);
	assert.equal(b.root.find((e) => e.classes.has("lan-board"))[0]!.hidden, true);
});

test("RVL7-F008: the certificate QR has its own label, an unnamed device reads Unknown device, and the pairing tile's tabs are a tablist with panels and arrow keys", async () => {
	const w = world({ pending: [{ ...PENDING, label: "" }], events: [{ at: 1, code: "paired", params: { label: "", peer: "192.168.1.23" }, text: "Paired over Wi-Fi:  (192.168.1.23)" }] });
	w.tab.start();
	await w.settle();
	assert.deepEqual(w.root.byTag("svg").map((s) => s.attrs.get("aria-label")), [m.lan_ca_qr(), m.pair_qr()], "two QR codes, two names");
	assert.notEqual(m.lan_ca_qr(), m.pair_qr());
	assert.ok(w.root.shows(m.lan_pending({ label: m.device_unknown(), peer: "192.168.1.23 (en0)", age: "12 s" })));
	assert.ok(w.root.find((e) => e.attrs.get("aria-label") === `${m.lan_deny_one()}: ${m.device_unknown()}`).length === 1);
	assert.ok(w.root.shows(m.lan_paired({ label: m.device_unknown(), peer: "192.168.1.23" })));
});

test("RVL7-F010: when the server falls back to the address for a name request, the toggle never offers the name, and the name form carries the cannot-open-it hint", async () => {
	const w = world();
	w.tab.start();
	await w.settle();
	assert.ok(w.root.shows(m.lan_cant_open()), "on the name form, with an address to fall back on, the tile says what to do if the phone cannot open it");
	const fell = world();
	fell.s.nameFallback = true;
	fell.tab.start();
	await fell.settle();
	assert.equal(fell.root.find((e) => e.tag === "button" && e.text === m.lan_use_name({ name: "weis-mbp" })).length, 0, "the name is no choice");
	fell.root.button(m.lan_use_address({ address: "10.0.0.8" })).click();
	await fell.settle();
	assert.equal(fell.root.find((e) => e.tag === "button" && /weis-mbp\.local/.test(e.text)).length, 0, "nor after stepping through the addresses");
	assert.equal(fell.root.shows(m.lan_cant_open()), false, "the hint is for the name form only");
});

test("RVL7-F011: the header notice for a waiting request reads without counting as an open tile, shows the peer, opens the Wi-Fi tab, and goes while that tab is open", async () => {
	const { mountLanWait } = await import("../gui/lanwait.ts");
	const seen: string[] = [];
	let body: Body = { pending: [{ peer: "192.168.1.23" }] }, tabOpen: unknown = null;
	Object.assign(g, { fetch: async (url: string) => (seen.push(url), { ok: true, status: 200, json: async () => body }) });
	doc.querySelector = () => tabOpen as never;
	Object.assign(doc, { hidden: false });
	const button = new El("button");
	let opened = 0;
	const timer = mountLanWait(button as never, () => void opened++, 60_000);
	try {
		await new Promise<void>((r) => setImmediate(r));
		await new Promise<void>((r) => setImmediate(r));
		assert.deepEqual(seen, ["api/lan/pending?peek=1"], "a peek, so the sessions keep their own notice");
		assert.equal(button.hidden, false);
		assert.equal(button.text, m.lan_pending_waiting({ peer: "192.168.1.23" }));
		button.click();
		assert.equal(opened, 1);
	} finally {
		clearInterval(timer);
	}
	const hide = (next: Body, open: unknown) => { body = next; tabOpen = open; };
	hide({ pending: [] }, null);
	const again = mountLanWait(button as never, () => {}, 60_000);
	await new Promise<void>((r) => setImmediate(r));
	await new Promise<void>((r) => setImmediate(r));
	assert.equal(button.hidden, true, "nothing waits: no notice");
	clearInterval(again);
	hide({ pending: [{ peer: "192.168.1.23" }] }, new El("div"));
	const open = mountLanWait(button as never, () => {}, 60_000);
	await new Promise<void>((r) => setImmediate(r));
	await new Promise<void>((r) => setImmediate(r));
	assert.equal(button.hidden, true, "the Wi-Fi tab is open and lists the request itself");
	clearInterval(open);
	doc.querySelector = () => null;
});

test("RVL7 integration: firewall notes show in the page's language with the commands verbatim, only the notes that block Wi-Fi access are errors, and refused events from one peer are one line", async () => {
	const command = 'New-NetFirewallRule -DisplayName "Straw Boss Wi-Fi (TCP 8445)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8445 -RemoteAddress LocalSubnet -Profile Private';
	const notes = [
		{ code: "fw_win_noallow", params: { port: 8445, command }, text: "No Windows Firewall rule allows incoming connections to TCP port 8445" },
		{ code: "fw_block_node", text: "macOS firewall blocks node" },
		{ code: "vpn", text: "A VPN carries this computer's traffic." },
		{ code: "moved", params: { from: 8445, to: 8446 }, text: "moved" },
	];
	const events = [
		{ at: 1_000, code: "refused", params: { peer: "192.168.1.40" }, text: "refused" },
		{ at: 2_000, code: "refused", params: { peer: "192.168.1.41" }, text: "refused" },
		{ at: 3_000, code: "refused", params: { peer: "192.168.1.40" }, text: "refused" },
		{ at: 4_000, code: "refused", params: { peer: "192.168.1.40" }, text: "refused" },
	];
	const seen = async () => {
		const w = world({ notes, events });
		w.tab.start();
		await w.settle();
		return w.root;
	};
	const kind = (root: El, text: string) => root.find((e) => e.classes.has("lan-note"))[0]!.byTag("p").find((p) => p.shows(text))!.classes;
	for (const lang of ["en", "zh-TW"]) {
		overwriteGetLocale(() => lang as "en");
		try {
			const root = await seen();
			assert.ok(root.shows(m.lan_fw_win_noallow({ port: "8445", command })) && root.text.includes(command), "the command is verbatim");
			assert.ok(kind(root, m.lan_fw_win_noallow({ port: "8445", command })).has("lan-no") && kind(root, m.lan_fw_block_node()).has("lan-no"), "a block is an error");
			assert.ok(!kind(root, m.lan_vpn()).has("lan-no") && !kind(root, m.lan_moved({ from: "8445", to: "8446" })).has("lan-no"), "information is not");
			const news = root.find((e) => e.classes.has("lan-news"))[0]!.byTag("li");
			assert.equal(news.length, 2, "one line per peer");
			assert.ok(news.some((li) => li.shows(new RegExp(`192\\.168\\.1\\.40.*3`))) && news.some((li) => li.shows("192.168.1.41")));
			assert.ok(root.shows(m.lan_refused_n({ peer: "192.168.1.40", count: "3", time: new Date(4_000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) })), "the count and the latest time");
		} finally {
			overwriteGetLocale(() => "en");
		}
	}
});
