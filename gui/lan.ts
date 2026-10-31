import { h, nodes } from "./dom.ts";
import { m } from "./paraglide/messages.js";
import type { Answer } from "./post.ts";
import { square } from "./qr.ts";

// The pairing tile's Same Wi-Fi tab (this computer's page only; docs/specs/2026-10-30-sb-gui-lan.md, "In the GUI"). While Wi-Fi access is off it shows the risk and asks; while it is on it
// shows, top to bottom: the pair requests waiting (a label, an address, an age, and never a number; the number lives on the phone, the boss types it), the certificate step with Share the
// certificate and the fingerprint procedure, and the pairing QR with Show a code and the address toggle. It polls `lan/pending` once a second while the tab is open, which is also how the server knows
// the tile is open. A QR or a code is minted only by a press (or by the tab opening on a running Wi-Fi access), under the tab's surface id, so each one voids the one before it.

interface Pending { id: string; label: string; peer: string; iface?: string; age: string; ageMs?: number }
/** A note or an event as the server sends it (src/server/lanhost.ts `Coded`): a code with its params, which this page words itself, and the English text for a code it does not know. */
interface Coded { code?: string; text: string; params?: Record<string, unknown>; of?: Coded[]; at?: number }
interface Facts { on?: boolean; addresses?: { address: string; interface?: string }[]; notes?: Coded[]; pending?: Pending[]; events?: Coded[] }
interface Cert { name?: string | null; sha256: string; sha1: string; url?: string; rows?: string[]; files?: string[]; ended?: boolean }
export interface LanDeps {
	get(path: string): Promise<Answer>;
	post(path: string, body: Record<string, unknown>): Promise<Answer>;
	/** A repeating timer; the answer stops it. */
	every(run: () => void, ms: number): () => void;
	/** The tab's own id for the codes it mints (control.ts: 4 to 64 of `A-Za-z0-9_-`). */
	surface: string;
	/** A device was allowed or the list may have changed: the device list is read again. */
	changed(): void;
}

const strings = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
const certOf = (b: Answer["body"]): Cert => ({ name: typeof b.name === "string" ? b.name : null, sha256: String(b.sha256 ?? ""), sha1: String(b.sha1 ?? ""), ...(typeof b.url === "string" ? { url: b.url } : {}), ...(Array.isArray(b.rows) ? { rows: strings(b.rows) } : {}), files: strings(b.files), ended: b.ended === true });
const pendingOf = (v: unknown): Pending[] => (Array.isArray(v) ? v.map((p) => ({ id: String(p?.id), label: String(p?.label ?? ""), peer: String(p?.peer ?? ""), ...(p?.iface ? { iface: String(p.iface) } : {}), age: String(p?.age ?? ""), ...(typeof p?.ageMs === "number" ? { ageMs: p.ageMs } : {}) })) : []);
const codedOf = (v: unknown): Coded[] => (Array.isArray(v) ? v.map((c) => ({ text: String(c?.text ?? ""), ...(typeof c?.code === "string" ? { code: c.code } : {}), ...(c?.params && typeof c.params === "object" ? { params: c.params } : {}), ...(Array.isArray(c?.of) ? { of: codedOf(c.of) } : {}), ...(typeof c?.at === "number" ? { at: c.at } : {}) })) : []);
const factsOf = (b: Answer["body"]): Facts => ({
	on: b.on === true, addresses: Array.isArray(b.addresses) ? b.addresses.map((a) => ({ address: String(a?.address), ...(a?.interface ? { interface: String(a.interface) } : {}) })) : [], pending: pendingOf(b.pending),
	notes: Array.isArray(b.noteList) ? codedOf(b.noteList) : typeof b.note === "string" ? [{ text: b.note }] : [], events: Array.isArray(b.eventList) ? codedOf(b.eventList) : strings(b.events).map((text) => ({ text })),
});
/** A note or event in the page's language; a code this page does not know shows the server's English text. */
function words(c: Coded): string {
	const p = (k: string) => String(c.params?.[k] ?? "");
	switch (c.code) {
		case "paired": return m.lan_paired({ label: p("label") || m.device_unknown(), peer: p("peer") });
		case "refused": return m.lan_refused({ peer: p("peer") });
		case "wrong": return m.lan_wrong_codes({ count: p("count"), peer: p("peer") });
		case "void": return m.lan_void({ peers: p("peers") });
		case "vpn": return m.lan_vpn();
		case "no_address": return m.lan_no_address();
		case "ca_ended": return m.lan_ca_ended();
		case "ca_ending": return m.lan_ca_ending({ date: new Date(Number(p("until"))).toLocaleDateString() });
		case "ca_corrupt": return m.lan_ca_corrupt();
		case "ca_missing": return m.lan_ca_missing();
		case "secondary": return m.lan_secondary();
		case "renamed_n": return m.lan_renamed_n({ caName: p("caName"), name: p("name") });
		case "renamed": return m.lan_renamed({ caName: p("caName"), name: p("name") });
		case "taken": return m.lan_port_taken({ port: p("port"), address: p("address") });
		case "moved": return m.lan_moved({ from: p("from"), to: p("to") });
		case "fw_block_all": return m.lan_fw_block_all();
		case "fw_block_node": return m.lan_fw_block_node();
		case "fw_win_block": return [p("what") ? m.lan_fw_win_block_node({ names: p("names") }) : m.lan_fw_win_block_port({ port: p("port"), names: p("names") }), p("command") ? m.lan_fw_win_block_cmd({ command: p("command") }) : "", p("left") ? m.lan_fw_win_block_left({ left: p("left") }) : ""].filter(Boolean).join(" ");
		case "fw_win_noallow": return m.lan_fw_win_noallow({ port: p("port"), command: p("command") });
		case "fw_win_public": return m.lan_fw_win_public({ where: p("where") });
		case "fw_win_unknown": return m.lan_fw_win_unknown({ why: p("why"), allow: p("allow"), list: p("list") });
		case "refused_n": return m.lan_refused_n({ peer: p("peer"), count: p("count"), time: new Date(c.at ?? 0).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) });
		case "stays_off_error": return m.lan_stays_off_error({ message: p("message") });
		case "fw_other": return m.lan_fw_other({ text: c.text });
		case "stays_off": return c.of ? m.lan_stays_off({ why: c.of.map(words).join(" ") }) : c.text;
		default: return c.text;
	}
}
/** The notes that mean a phone cannot connect now (Wi-Fi access held off, a taken port, an ended certificate, a firewall block) are shown as errors; the rest (a moved port, a VPN, a certificate ending, a renamed computer) are only told. */
const BLOCKING = new Set(["stays_off", "stays_off_error", "ca_corrupt", "ca_missing", "ca_ended", "taken", "no_address", "fw_block_all", "fw_block_node", "fw_win_block", "fw_win_noallow", "fw_win_public"]);
export const blocks = (c: Coded) => BLOCKING.has(c.code ?? "");
/** Refused pairings from the same peer are one line with a count and the time of the latest, placed where the latest was. */
export function collapse(list: Coded[]): Coded[] {
	const count = new Map<string, number>(), last = new Map<string, Coded>();
	for (const e of list) if (e.code === "refused") (count.set(String(e.params?.peer), (count.get(String(e.params?.peer)) ?? 0) + 1), last.set(String(e.params?.peer), e));
	return list.flatMap((e) => (e.code !== "refused" ? [e] : last.get(String(e.params?.peer)) !== e ? [] : count.get(String(e.params?.peer))! > 1 ? [{ ...e, code: "refused_n", params: { ...e.params, count: count.get(String(e.params?.peer))! } }] : [e]));
}
/** The age of a request in the page's language, from the server's milliseconds (its English text only when it sent none). */
const ageOf = (p: Pending) => (p.ageMs === undefined ? p.age : p.ageMs < 60_000 ? m.lan_age_s({ n: String(Math.max(1, Math.round(p.ageMs / 1000))) }) : m.lan_age_min({ n: String(Math.round(p.ageMs / 60_000)) }));
const why = (r: Answer) => String(r.body.reason ?? m.refused({ status: r.status }));
const peerOf = (p: Pending) => (p.iface ? `${p.peer} (${p.iface})` : p.peer);
const labelOf = (p: Pending) => p.label || m.device_unknown();

export function lanTab(deps: LanDeps) {
	const root = h("div", { class: "lan" }), board = h("div", { class: "lan-board" }), main = h("div", { class: "lan-main" }), note = h("div", { class: "lan-note", role: "status" }), news = h("ul", { class: "lan-news", role: "status" });
	/** What a decision did that the request list cannot show once it is empty: three wrong numbers denied every request. */
	const verdict = h("p", { class: "lan-no", role: "status" });
	root.append(board, verdict, note, news, main);
	// `live` is the tab being shown; `epoch` changes at each start and end, so a poll in flight when the tab is left (or left and shown again) is dropped when it returns and mints nothing.
	let stop: (() => void) | undefined, shown: boolean | undefined, turn = 0, epoch = 0, live = false, cert: Cert | undefined, facts: Facts = {}, last = "", noteText = "";
	/** A live region is touched only when its words change, so a screen reader hears a change and not every poll. */
	const say = (text: string, kinds?: boolean[]) => text !== noteText && (noteText = text, note.replaceChildren(...(text ? text.split("\n").map((t, i) => h("p", { class: (kinds ?? [])[i] ?? true ? "lan-no" : "lan-info" }, t)) : [])));

	// The waiting requests: one row each with its own Deny, one field for the number the phone shows, Allow, and Deny all. The field survives the polls, and so do the rows: a poll adds a row that arrived, drops one that left, and updates a row's age
	// in place, so a Deny under the pointer or the keyboard stays where it is.
	const rows = h("ul", { class: "lan-rows" }), many = h("p", null, m.lan_pending_many()), answer = h("p", { class: "lan-no", role: "status" });
	const field = h("input", { type: "text", inputmode: "numeric", pattern: "[0-9]{4}", maxlength: "4", autocomplete: "off", spellcheck: "false", class: "lan-number", "aria-label": m.lan_number_ask(), placeholder: "0000" });
	const allow = h("button", { type: "button", class: "go" }, m.lan_allow()), denyAll = h("button", { type: "button", class: "later" }, m.lan_deny());
	/** One decision at a time: a double submit (Enter and a click, two Enters) is one request, so it never counts twice toward the three wrong numbers. */
	let busy = false;
	const decide = (body: Record<string, unknown>) => {
		if (busy) return Promise.resolve();
		busy = allow.disabled = denyAll.disabled = true;
		return deps.post("lan/approve", body).then((r) => {
			const budget = !r.ok && r.body.error === "no_match" && Number(r.body.denied) > 0;
			answer.replaceChildren(r.ok || budget ? "" : r.body.error === "no_match" ? m.lan_no_match() : why(r));
			verdict.replaceChildren(budget ? m.lan_wrong_budget() : "");
			if (r.ok) field.value = "";
			deps.changed();
			return poll();
		}, () => answer.replaceChildren(m.no_answer())).finally(() => (busy = allow.disabled = denyAll.disabled = false));
	};
	const send = () => /^\d{4}$/.test(field.value) && void decide({ number: field.value });
	field.addEventListener("input", () => (field.value = field.value.replace(/\D/g, "").slice(0, 4)));
	field.addEventListener("keydown", (e) => (e as KeyboardEvent).key === "Enter" && send());
	allow.onclick = send;
	denyAll.onclick = () => void decide({ deny: "all" });
	const ask = h("div", { class: "lan-ask" }, h("label", null, m.lan_number_ask()), h("div", { class: "lan-ask-row" }, field, allow, denyAll), answer);
	const drawn = new Map<string, { li: HTMLElement; span: HTMLElement; text: string }>();
	function drawPending(list: Pending[]) {
		board.hidden = list.length === 0;
		const ids = new Set(list.map((p) => p.id));
		for (const [id, row] of drawn) if (!ids.has(id)) (row.li.remove(), drawn.delete(id));
		for (const p of list) {
			const text = m.lan_pending({ label: labelOf(p), peer: peerOf(p), age: ageOf(p) }), row = drawn.get(p.id);
			if (row) {
				if (row.text !== text) (row.span.replaceChildren(text), row.text = text);
				continue;
			}
			const deny = h("button", { type: "button", class: "later", "aria-label": `${m.lan_deny_one()}: ${labelOf(p)}` }, m.lan_deny_one()), span = h("span", null, text), li = h("li", null, span, deny);
			deny.onclick = () => void decide({ deny: p.id });
			rows.append(li);
			drawn.set(p.id, { li, span, text });
		}
		many.hidden = list.length < 2;
		if (list.length) verdict.replaceChildren();
		else answer.replaceChildren();
	}
	board.append(many, rows, ask);
	/** The server's events, the newest last; one that is already on screen is left alone, so nothing is announced twice. */
	const told = new Map<string, HTMLElement>();
	function drawNews(all: Coded[]) {
		const list = collapse(all);
		const keys = list.map((e) => `${e.at ?? ""}|${e.code ?? ""}|${e.text}`);
		for (const [key, li] of told) if (!keys.includes(key)) (li.remove(), told.delete(key));
		list.forEach((e, i) => {
			if (told.has(keys[i]!)) return;
			const li = h("li", null, words(e));
			news.append(li);
			told.set(keys[i]!, li);
		});
	}

	// The off state: what Wi-Fi access is, its risk, and the button. The warning is the one `/boss gui lan` shows before the first certificate. Only a press of the button turns it on: the page asks nothing that could (the computer's name
	// comes with the "no certificate" answer), and a certificate read that fails shows why and is read again at the next poll.
	const riskOf = (name: string | null | undefined) => (name ? m.lan_risk({ name }) : m.lan_risk_noname());
	async function drawOff(id: number) {
		const have = await deps.post("lan/ca", {}).catch(() => undefined);
		if (id !== turn) return;
		const none = have?.status === 409 && have.body.error === "no_ca";
		if (!have?.ok && !none) return void (main.replaceChildren(h("p", null, have ? why(have) : m.no_answer())), shown = undefined);
		const name = have.ok ? certOf(have.body).name : typeof have.body.name === "string" ? have.body.name : null;
		const on = h("button", { type: "button", class: "pair-btn" }, have.ok ? m.lan_turn_on_existing() : m.lan_turn_on());
		const out = h("p", { class: "lan-no", role: "status" });
		if (have.ok && certOf(have.body).ended) out.append(m.lan_ca_ended());
		on.onclick = () => ((on.disabled = true), out.replaceChildren(m.lan_turning_on()), void deps.post("lan/on", { accept_risk: true }).then((r) => (r.ok ? poll() : (out.replaceChildren(r.body.error === "lan_ca_ended" ? m.lan_ca_ended() : why(r)), void (on.disabled = false))), () => (out.replaceChildren(m.no_answer()), void (on.disabled = false))));
		main.replaceChildren(h("p", null, m.lan_off_ask()), h("p", null, riskOf(name)), h("p", { class: "lan-risk" }, m.lan_unverified()), h("p", null, m.lan_hotspot()), on, out);
	}

	// The on state: the certificate step, then the pairing.
	const toggled = h("div", { class: "lan-pair" });
	let form: "name" | "address" = "name", at = -1, nameOff = false;
	/** The names the toggle steps through: the computer's name (when the certificate has one and the server still answers to it), then each served address. */
	const targets = () => [...(cert?.name && !nameOff ? [""] : []), ...(facts.addresses ?? []).map((a) => a.address)];
	async function pairing(id: number, kind: "name" | "address" | "typed", address?: string) {
		toggled.replaceChildren(h("p", { class: "chat-empty" }, m.asking_code()));
		const r = await deps.post("lan/pair", { surface: deps.surface, form: kind, ...(address ? { address } : {}) }).catch(() => undefined);
		if (id !== turn) return;
		if (!r?.ok) return void toggled.replaceChildren(h("p", null, r ? why(r) : m.no_answer()), again());
		const body = r.body, rowsOf = body.rows, typed = body.code;
		if (kind === "name") nameOff = body.form === "address"; // the server fell back to the address (the computer was renamed): the name is no choice to offer
		if (kind !== "typed") (form = body.form === "address" ? "address" : "name", at = form === "name" ? targets().indexOf("") : targets().indexOf(String(body.host)));
		const next = targets(), to = next.length > 1 ? next[(at + 1) % next.length] : undefined;
		const cycle = to === undefined ? undefined : h("button", { type: "button", class: "later" }, to ? m.lan_use_address({ address: to }) : m.lan_use_name({ name: cert?.name ?? "" }));
		if (cycle) cycle.onclick = () => void pairing(turn, to ? "address" : "name", to || undefined);
		const code = h("button", { type: "button", class: "later" }, m.lan_show_code());
		code.onclick = () => void pairing(turn, "typed");
		const qr = Array.isArray(rowsOf) ? square(rowsOf.map(String)) : undefined;
		toggled.replaceChildren(...nodes(h("p", null, m.lan_step_pair()), qr, h("p", null, h("code", null, `${body.host}:${body.port}`)), typeof typed === "string" && h("p", null, m.pair_code(), h("br", null), h("code", { class: "pair-code" }, typed), h("br", null), h("small", null, String(body.entry ?? ""))), h("p", { class: "lan-hint" }, m.lan_not_private()), cycle && form === "name" && h("p", { class: "lan-hint" }, m.lan_cant_open()), h("div", { class: "devices-acts" }, again(), code, cycle)));
	}
	const again = () => {
		const b = h("button", { type: "button", class: "later" }, m.new_code());
		b.onclick = () => void pairing(turn, form, form === "address" ? targets()[at] : undefined);
		return b;
	};
	async function drawOn(id: number) {
		const r = await deps.post("lan/ca", {}).catch(() => undefined);
		if (id !== turn) return;
		if (!r?.ok) return void main.replaceChildren(h("p", null, r ? why(r) : m.no_answer()));
		cert = certOf(r.body);
		nameOff = false;
		const off = h("button", { type: "button", class: "later" }, m.lan_turn_off());
		off.onclick = () => ((off.disabled = true), void deps.post("lan/off", {}).then(() => poll(), () => say(m.no_answer())));
		// One link for each public file, so one press is one download (a script that starts two is held by a browser, or dropped).
		const links = [...(cert.files ?? [])].filter((file) => file.endsWith(".crt") || file.endsWith(".mobileconfig")).sort().reverse().map((file) => h("a", { href: `api/lan/ca/${file}`, download: file, class: "go" }, file.endsWith(".crt") ? m.lan_share_crt() : m.lan_share_profile()));
		const print = [m.lan_fp_ios(), m.lan_fp_android(), m.lan_fp_mac(), m.lan_fp_windows({ sha1: cert.sha1 })];
		main.replaceChildren(
			h("p", { class: "lan-risk" }, m.lan_risk_short()),
			h("details", null, h("summary", null, m.lan_risk_details()), h("p", null, riskOf(cert.name)), h("p", { class: "lan-risk" }, m.lan_unverified()), h("p", null, m.lan_hotspot())),
			h("h4", null, m.lan_step_ca()), h("p", null, m.lan_share_ca()), h("div", { class: "devices-acts" }, ...links),
			...(cert.url && cert.rows ? [h("p", null, m.lan_scan_ca()), square(cert.rows.map(String), m.lan_ca_qr()), h("p", null, h("code", null, cert.url))] : []),
			h("p", null, m.lan_fp_lead()), h("p", null, h("code", { class: "pair-code lan-fp" }, cert.sha256)), h("ul", { class: "lan-fps" }, ...print.map((t) => h("li", null, t))),
			h("hr", null), toggled, h("div", { class: "devices-acts" }, off));
		await pairing(id, "name");
	}

	// The poll: the facts and the waiting requests every second; the page below them is drawn again only when Wi-Fi access turns on or off.
	async function poll() {
		if (!live) return;
		const began = epoch, r = await deps.get("lan/pending").catch(() => undefined);
		if (!live || began !== epoch) return; // the tab was left (or left and shown again) while this was on the way: it draws nothing and mints nothing
		if (!r) return say(m.no_answer());
		if (!r.ok) return say(why(r));
		facts = factsOf(r.body);
		const on = facts.on === true, id = shown === on ? turn : ++turn, list = facts.pending ?? [];
		drawPending(on ? list : []);
		say(on && !(facts.addresses ?? []).length ? m.lan_no_address() : (facts.notes ?? []).map(words).join("\n"), (facts.notes ?? []).map(blocks));
		drawNews(on ? facts.events ?? [] : []);
		const key = JSON.stringify([facts.events, list.length]);
		if (key !== last) (last = key, deps.changed());
		if (shown !== on) (shown = on, void (on ? drawOn(id) : drawOff(id)));
	}
	return {
		root,
		/** The tab is shown: read at once, then every second. */
		start() {
			stop?.();
			shown = undefined;
			live = true;
			epoch++;
			void poll();
			stop = deps.every(() => void poll(), 1000);
		},
		/** The tab is left or the tile closed. */
		end() {
			stop?.();
			stop = undefined;
			live = false;
			epoch++;
			turn++;
		},
	};
}
