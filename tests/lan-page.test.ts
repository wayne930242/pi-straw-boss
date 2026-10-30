import assert from "node:assert/strict";
import { test } from "node:test";

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
const CA = { name: "weis-mbp", sha256: "3F 7A 91 C2 B0 4E 55 D1 8A 0C 66 2E 19 F4 73 B5", sha1: "AABBCCDD 11223344 55667788 99AABBCC DDEEFF00", url: "http://weis-mbp.local:8445/sb-ca/", rows: ["101", "010", "101"], files: ["straw-boss.mobileconfig", "straw-boss-lan-ca.crt"], ended: false };

/** A fake server for the tab: what `lan/pending` answers and how each post is answered; every call is kept. */
function world(over: { ca?: boolean; on?: boolean; pending?: Body[]; events?: string[]; addresses?: Body[]; name?: string | null } = {}) {
	const s = { ca: over.ca ?? true, on: over.on ?? true, pending: over.pending ?? [], events: over.events ?? [], addresses: over.addresses ?? [{ address: "192.168.1.5", interface: "en0" }, { address: "10.0.0.8", interface: "en1" }], name: over.name === undefined ? "weis-mbp" : over.name, note: "" };
	const calls: Call[] = [], ticks: (() => void)[] = [];
	let stops = 0, changed = 0, minted = 0;
	const post = async (path: string, body: Body = {}) => {
		calls.push({ path, body });
		switch (path) {
			case "lan/ca": return s.ca ? ans({ ...CA, name: s.name }) : ans({ error: "no_ca", reason: "There is no Wi-Fi certificate yet." }, 409);
			case "lan/on": return body.accept_risk === true ? ((s.ca = s.on = true), ans({ on: true })) : s.ca ? ((s.on = true), ans({ on: true })) : ans({ error: "lan_risk", reason: "risk", name: s.name }, 409);
			case "lan/off": return ((s.on = false), ans({}));
			case "lan/pair": {
				minted++;
				const address = body.address as string | undefined, host = address ?? (s.name ? `${s.name}.local` : "192.168.1.5");
				return body.form === "typed" ? ans({ form: "name", host, port: 8445, code: "ABCD-EFGH", entry: `https://${host}:8445/sb-app/` }) : ans({ form: address ? "address" : "name", host, port: 8445, url: `https://${host}:8445/sb-app/pair/CODE${minted}`, rows: ["101", "010", "101"] });
			}
			case "lan/approve": {
				if (typeof body.number === "string") {
					const hit = s.pending.findIndex((p) => p.number === body.number);
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
		return ans({ on: s.on, wanted: s.on, addresses: s.on ? s.addresses : [], pending: s.pending, events: s.events, ...(s.note ? { note: s.note } : {}) });
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
	assert.deepEqual(w.post("lan/on").map((c) => c.body), [{}], "the page asked what the warning needs and sent no accept_risk");
	const turn = w.root.button(m.lan_turn_on());
	assert.equal(w.post("lan/on").length, 1);
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

test("on: the certificate step has Share the certificate, which downloads both public files from this computer, and the fingerprint procedure per platform", async () => {
	const w = world();
	w.tab.start();
	await w.settle();
	assert.ok(w.root.shows(m.lan_risk_short()));
	const details = w.root.byTag("details")[0]!;
	assert.equal(details.byTag("summary")[0]!.text, m.lan_risk_details());
	assert.ok(details.shows(m.lan_risk({ name: "weis-mbp", expiry_note: "" })) && details.shows(m.lan_hotspot()), "Details holds the full warning");
	const share = w.root.button(m.lan_share_ca());
	const downloads: El[] = [];
	const made = doc.createElement;
	doc.createElement = (tag: string) => { const el = made(tag); if (tag === "a") downloads.push(el); return el; };
	share.click();
	doc.createElement = made;
	assert.deepEqual(downloads.map((a) => [a.attrs.get("href"), a.attrs.get("download"), a.clicked]), [["api/lan/ca/straw-boss.mobileconfig", "straw-boss.mobileconfig", 1], ["api/lan/ca/straw-boss-lan-ca.crt", "straw-boss-lan-ca.crt", 1]]);
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
	assert.equal(w.root.shows("ABCD-EFGH"), false);
	w.root.button(m.lan_show_code()).click();
	await w.settle();
	assert.deepEqual(pairs().at(-1), { surface: "tile-abc123", form: "typed" });
	assert.ok(w.root.shows("ABCD-EFGH"));
	w.root.button(m.new_code()).click();
	await w.settle();
	assert.deepEqual(pairs().at(-1), { surface: "tile-abc123", form: "name" });
	assert.equal(w.root.shows("ABCD-EFGH"), false, "the new QR voided the typed code and the screen no longer shows it");
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
		w.root.button("分享憑證（用 AirDrop 或快速分享傳到手機；除非手機要你接受來自不明傳送者的檔案，否則不必核對）");
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
	assert.ok(!seen.some((s) => s.includes("lan/")), "the Wi-Fi tab asks nothing until it is shown");
	assert.equal(timers.size, 0);
	wifi.click();
	await settle();
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
