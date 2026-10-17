import { h } from "./dom.ts";
import type { Tile } from "./layer.ts";
import { post } from "./post.ts";

// The phone pairing tile, its own small chunk: a fresh one-time pairing URL from the server as a QR code (dark modules on white, drawn
// as one SVG path, never markup), while remote access is on. The code works once, within ten minutes; New code asks for another.

const NS = "http://www.w3.org/2000/svg";
function square(rows: string[]) {
	const n = rows.length, svg = document.createElementNS(NS, "svg"), bg = document.createElementNS(NS, "rect"), dots = document.createElementNS(NS, "path");
	svg.setAttribute("viewBox", `-4 -4 ${n + 8} ${n + 8}`);
	svg.setAttribute("class", "qr");
	svg.setAttribute("role", "img");
	svg.setAttribute("aria-label", "Pairing QR code");
	for (const [k, v] of Object.entries({ x: "-4", y: "-4", width: String(n + 8), height: String(n + 8), fill: "#fff" })) bg.setAttribute(k, v);
	dots.setAttribute("d", rows.flatMap((row, y) => [...row].flatMap((c, x) => (c === "1" ? [`M${x} ${y}h1v1h-1z`] : []))).join(""));
	dots.setAttribute("fill", "#06101e");
	svg.append(bg, dots);
	return svg;
}

export function pairTile(): Tile {
	return { id: "pair", title: "Pair a phone", body: () => {
		const body = h("div", { class: "pair" }), again = h("button", { type: "button", class: "later" }, "New code");
		const ask = () => {
			body.replaceChildren(h("p", { class: "chat-empty" }, "Asking for a pairing code…"));
			void post("remote/pair", {}).then((r) => {
				const rows = r.body.rows, url = String(r.body.url ?? "");
				if (!r.ok || !Array.isArray(rows)) return body.replaceChildren(h("p", null, r.body.reason ?? `Refused (${r.status}).`), again);
				body.replaceChildren(square(rows.map(String)), h("p", null, "Scan it with a phone signed in to Tailscale as this machine's user. It works once, within ten minutes."), h("p", null, h("code", null, new URL(url).host)), again);
			}, () => body.replaceChildren(h("p", null, "The server did not answer."), again));
		};
		again.onclick = ask;
		ask();
		return body;
	} };
}
