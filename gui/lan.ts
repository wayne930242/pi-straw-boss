import { h, nodes } from "./dom.ts";
import { m } from "./paraglide/messages.js";
import type { Answer } from "./post.ts";
import { square } from "./qr.ts";

// The pairing tile's Same Wi-Fi tab (this computer's page only; docs/specs/2026-10-30-sb-gui-lan.md, "In the GUI"). While Wi-Fi access is off it shows the risk and asks; while it is on it
// shows, top to bottom: the pair requests waiting (a label, an address, an age, and never a number; the number lives on the phone, the boss types it), the certificate step with Share the
// certificate and the fingerprint procedure, and the pairing QR with Show a code and the address toggle. It polls `lan/pending` once a second while the tab is open, which is also how the server knows
// the tile is open. A QR or a code is minted only by a press (or by the tab opening on a running Wi-Fi access), under the tab's surface id, so each one voids the one before it.

interface Pending { id: string; label: string; peer: string; iface?: string; age: string }
interface Facts { on?: boolean; addresses?: { address: string; interface?: string }[]; note?: string; pending?: Pending[]; events?: string[] }
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
const pendingOf = (v: unknown): Pending[] => (Array.isArray(v) ? v.map((p) => ({ id: String(p?.id), label: String(p?.label ?? ""), peer: String(p?.peer ?? ""), ...(p?.iface ? { iface: String(p.iface) } : {}), age: String(p?.age ?? "") })) : []);
const factsOf = (b: Answer["body"]): Facts => ({ on: b.on === true, addresses: Array.isArray(b.addresses) ? b.addresses.map((a) => ({ address: String(a?.address), ...(a?.interface ? { interface: String(a.interface) } : {}) })) : [], ...(typeof b.note === "string" ? { note: b.note } : {}), pending: pendingOf(b.pending), events: strings(b.events) });
const why = (r: Answer) => String(r.body.reason ?? m.refused({ status: r.status }));
const peerOf = (p: Pending) => (p.iface ? `${p.peer} (${p.iface})` : p.peer);

export function lanTab(deps: LanDeps) {
	const root = h("div", { class: "lan" }), board = h("div", { class: "lan-board" }), main = h("div", { class: "lan-main" }), note = h("p", { class: "lan-note", role: "status" }), news = h("ul", { class: "lan-news", role: "status" });
	root.append(board, note, news, main);
	let stop: (() => void) | undefined, shown: boolean | undefined, turn = 0, cert: Cert | undefined, facts: Facts = {}, last = "";
	const say = (text: string) => note.replaceChildren(text);

	// The waiting requests: one row each with its own Deny, one field for the number the phone shows, Allow, and Deny all. The field survives the polls; only the rows are drawn again.
	const rows = h("ul", { class: "lan-rows" }), many = h("p", null, m.lan_pending_many()), answer = h("p", { class: "lan-no", role: "status" });
	const field = h("input", { type: "text", inputmode: "numeric", pattern: "[0-9]{4}", maxlength: "4", autocomplete: "off", spellcheck: "false", class: "lan-number", "aria-label": m.lan_number_ask(), placeholder: "0000" });
	const allow = h("button", { type: "button", class: "go" }, m.lan_allow()), denyAll = h("button", { type: "button", class: "later" }, m.lan_deny());
	const decide = (body: Record<string, unknown>) => deps.post("lan/approve", body).then((r) => {
		answer.replaceChildren(r.ok ? "" : r.body.error === "no_match" ? m.lan_no_match() : why(r));
		if (r.ok) field.value = "";
		deps.changed();
		return poll();
	}, () => answer.replaceChildren(m.no_answer()));
	const send = () => /^\d{4}$/.test(field.value) && void decide({ number: field.value });
	field.addEventListener("input", () => (field.value = field.value.replace(/\D/g, "").slice(0, 4)));
	field.addEventListener("keydown", (e) => (e as KeyboardEvent).key === "Enter" && send());
	allow.onclick = send;
	denyAll.onclick = () => void decide({ deny: "all" });
	const ask = h("div", { class: "lan-ask" }, h("label", null, m.lan_number_ask()), h("div", { class: "lan-ask-row" }, field, allow, denyAll), answer);
	function drawPending(list: Pending[]) {
		board.hidden = list.length === 0;
		rows.replaceChildren(...list.map((p) => {
			const deny = h("button", { type: "button", class: "later", "aria-label": `${m.lan_deny_one()}: ${p.label}` }, m.lan_deny_one());
			deny.onclick = () => void decide({ deny: p.id });
			return h("li", null, h("span", null, m.lan_pending({ label: p.label, peer: peerOf(p), age: p.age })), deny);
		}));
		many.hidden = list.length < 2;
		if (!list.length) answer.replaceChildren();
	}
	board.append(many, rows, ask);

	// The off state: what Wi-Fi access is, its risk, and the button. The warning is the one `/boss gui lan` shows before the first certificate.
	const riskOf = (name: string | null | undefined) => (name ? m.lan_risk({ name, expiry_note: "" }) : m.lan_risk_noname({ expiry_note: "" }));
	async function drawOff(id: number) {
		const have = await deps.post("lan/ca", {}).catch(() => undefined);
		let name: string | null | undefined = have?.ok ? certOf(have.body).name : undefined;
		if (!have?.ok) {
			const risk = await deps.post("lan/on", {}).catch(() => undefined); // no certificate: this answers lan_risk with the computer's name and turns nothing on
			name = risk?.body.error === "lan_risk" && typeof risk.body.name === "string" ? risk.body.name : undefined;
		}
		if (id !== turn) return;
		const on = h("button", { type: "button", class: "pair-btn" }, have?.ok ? m.lan_turn_on_existing() : m.lan_turn_on());
		const out = h("p", { class: "lan-no", role: "status" });
		if (have?.ok && certOf(have.body).ended) out.append(m.lan_ca_ended());
		on.onclick = () => ((on.disabled = true), out.replaceChildren(m.lan_turning_on()), void deps.post("lan/on", { accept_risk: true }).then((r) => (r.ok ? poll() : (out.replaceChildren(r.body.error === "lan_ca_ended" ? m.lan_ca_ended() : why(r)), void (on.disabled = false))), () => (out.replaceChildren(m.no_answer()), void (on.disabled = false))));
		main.replaceChildren(h("p", null, m.lan_off_ask()), h("p", null, riskOf(name)), h("p", null, m.lan_hotspot()), on, out);
	}

	// The on state: the certificate step, then the pairing.
	const toggled = h("div", { class: "lan-pair" });
	let form: "name" | "address" = "name", at = -1;
	/** The names the toggle steps through: the computer's name (when the certificate has one), then each served address. */
	const targets = () => [...(cert?.name ? [""] : []), ...(facts.addresses ?? []).map((a) => a.address)];
	async function pairing(id: number, kind: "name" | "address" | "typed", address?: string) {
		toggled.replaceChildren(h("p", { class: "chat-empty" }, m.asking_code()));
		const r = await deps.post("lan/pair", { surface: deps.surface, form: kind, ...(address ? { address } : {}) }).catch(() => undefined);
		if (id !== turn) return;
		if (!r?.ok) return void toggled.replaceChildren(h("p", null, r ? why(r) : m.no_answer()), again());
		const body = r.body, rowsOf = body.rows, typed = body.code;
		if (kind !== "typed") (form = body.form === "address" ? "address" : "name", at = form === "name" ? targets().indexOf("") : targets().indexOf(String(body.host)));
		const next = targets(), to = next.length > 1 ? next[(at + 1) % next.length] : undefined;
		const cycle = to === undefined ? undefined : h("button", { type: "button", class: "later" }, to ? m.lan_use_address({ address: to }) : m.lan_use_name({ name: cert?.name ?? "" }));
		if (cycle) cycle.onclick = () => void pairing(turn, to ? "address" : "name", to || undefined);
		const code = h("button", { type: "button", class: "later" }, m.lan_show_code());
		code.onclick = () => void pairing(turn, "typed");
		const qr = Array.isArray(rowsOf) ? square(rowsOf.map(String)) : undefined;
		toggled.replaceChildren(...nodes(h("p", null, m.lan_step_pair()), qr, h("p", null, h("code", null, `${body.host}:${body.port}`)), typeof typed === "string" && h("p", null, m.pair_code(), h("br", null), h("code", { class: "pair-code" }, typed), h("br", null), h("small", null, String(body.entry ?? ""))), h("p", { class: "lan-hint" }, m.lan_not_private()), h("div", { class: "devices-acts" }, again(), code, cycle)));
	}
	const again = () => {
		const b = h("button", { type: "button", class: "later" }, m.new_code());
		b.onclick = () => void pairing(turn, form, form === "address" ? targets()[at] : undefined);
		return b;
	};
	function share() {
		for (const file of cert?.files ?? []) {
			const a = h("a", { href: `api/lan/ca/${file}`, download: file });
			(root.append(a), a.click(), a.remove());
		}
	}
	async function drawOn(id: number) {
		const r = await deps.post("lan/ca", {}).catch(() => undefined);
		if (id !== turn) return;
		if (!r?.ok) return void main.replaceChildren(h("p", null, r ? why(r) : m.no_answer()));
		cert = certOf(r.body);
		const send_ = h("button", { type: "button", class: "go" }, m.lan_share_ca()), off = h("button", { type: "button", class: "later" }, m.lan_turn_off());
		send_.onclick = share;
		off.onclick = () => ((off.disabled = true), void deps.post("lan/off", {}).then(() => poll(), () => say(m.no_answer())));
		const print = [m.lan_fp_ios(), m.lan_fp_android(), m.lan_fp_mac(), m.lan_fp_windows({ sha1: cert.sha1 })];
		main.replaceChildren(
			h("p", { class: "lan-risk" }, m.lan_risk_short()),
			h("details", null, h("summary", null, m.lan_risk_details()), h("p", null, riskOf(cert.name)), h("p", null, m.lan_hotspot())),
			h("h4", null, m.lan_step_ca()), send_,
			...(cert.url && cert.rows ? [h("p", null, m.lan_scan_ca()), square(cert.rows.map(String)), h("p", null, h("code", null, cert.url))] : []),
			h("p", null, m.lan_fp_lead()), h("p", null, h("code", { class: "pair-code lan-fp" }, cert.sha256)), h("ul", { class: "lan-fps" }, ...print.map((t) => h("li", null, t))),
			h("hr", null), toggled, h("div", { class: "devices-acts" }, off));
		await pairing(id, "name");
	}

	// The poll: the facts and the waiting requests every second; the page below them is drawn again only when Wi-Fi access turns on or off.
	async function poll() {
		const r = await deps.get("lan/pending").catch(() => undefined);
		if (!r) return say(m.no_answer());
		if (!r.ok) return say(why(r));
		facts = factsOf(r.body);
		const on = facts.on === true, id = shown === on ? turn : ++turn, list = facts.pending ?? [];
		drawPending(on ? list : []);
		say(on && !(facts.addresses ?? []).length ? m.lan_no_address() : facts.note ?? "");
		news.replaceChildren(...(on ? (facts.events ?? []) : []).map((e) => h("li", null, e)));
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
			void poll();
			stop = deps.every(() => void poll(), 1000);
		},
		/** The tab is left or the tile closed. */
		end() {
			stop?.();
			stop = undefined;
			turn++;
		},
	};
}
