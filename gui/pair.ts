import { deviceList } from "./devices.ts";
import { h } from "./dom.ts";
import type { Tile } from "./layer.ts";
import { m } from "./paraglide/messages.js";
import { post } from "./post.ts";

// The phone pairing tile, its own small chunk: a fresh one-time pairing URL from the server as a QR code (dark modules on white, drawn
// as one SVG path, never markup). While remote access is off the tile asks first; Turn on opens it to the tailnet from the server's session and
// shows the code it answers with. The code works once, within ten minutes; New code asks for another. Under it, the paired devices (devices.ts).

const NS = "http://www.w3.org/2000/svg";
export function square(rows: string[]) {
	const n = rows.length, svg = document.createElementNS(NS, "svg"), bg = document.createElementNS(NS, "rect"), dots = document.createElementNS(NS, "path");
	svg.setAttribute("viewBox", `-4 -4 ${n + 8} ${n + 8}`);
	svg.setAttribute("class", "qr");
	svg.setAttribute("role", "img");
	svg.setAttribute("aria-label", m.pair_qr());
	for (const [k, v] of Object.entries({ x: "-4", y: "-4", width: String(n + 8), height: String(n + 8), fill: "#fff" })) bg.setAttribute(k, v);
	dots.setAttribute("d", rows.flatMap((row, y) => [...row].flatMap((c, x) => (c === "1" ? [`M${x} ${y}h1v1h-1z`] : []))).join(""));
	dots.setAttribute("fill", "#06101e");
	svg.append(bg, dots);
	return svg;
}

export function pairTile(): Tile {
	return { id: "pair", title: m.pair_tile(), body: () => {
		const code = h("div", { class: "pair" }), again = h("button", { type: "button", class: "later" }, m.new_code());
		const on = h("button", { type: "button", class: "pair-btn" }, m.remote_turn_on());
		const ask = (path = "remote/pair", waiting = m.asking_code()) => {
			code.replaceChildren(h("p", { class: "chat-empty" }, waiting));
			void post(path, {}).then((r) => {
				void devices.refresh(); // turning remote on shows Turn off, and a code asked for after a restart may follow a pairing
				const rows = r.body.rows, url = String(r.body.url ?? "");
				if (r.body.error === "remote_off") return code.replaceChildren(h("p", null, m.remote_off_ask()), on);
				if (!r.ok || !Array.isArray(rows)) return code.replaceChildren(h("p", null, r.body.reason ?? m.refused({ status: r.status })), path === "remote/on" ? on : again);
				code.replaceChildren(square(rows.map(String)), h("p", null, m.pair_scan()), h("p", null, h("code", null, new URL(url).host)), again);
			}, () => code.replaceChildren(h("p", null, m.no_answer()), again));
		};
		on.onclick = () => ask("remote/on", m.remote_turning_on());
		again.onclick = () => ask();
		const devices = deviceList(() => code.replaceChildren(h("p", null, m.remote_off_ask()), on));
		ask();
		return h("div", { class: "pair" }, code, devices.box);
	} };
}
