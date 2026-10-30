// A QR code the server drew (rows of "0" and "1"): dark modules on white as one SVG path, never markup.
import { m } from "./paraglide/messages.js";

const NS = "http://www.w3.org/2000/svg";
/** `label` names the picture for a screen reader (the pairing QR code by default). */
export function square(rows: string[], label = m.pair_qr()) {
	const n = rows.length, svg = document.createElementNS(NS, "svg"), bg = document.createElementNS(NS, "rect"), dots = document.createElementNS(NS, "path");
	svg.setAttribute("viewBox", `-4 -4 ${n + 8} ${n + 8}`);
	svg.setAttribute("class", "qr");
	svg.setAttribute("role", "img");
	svg.setAttribute("aria-label", label);
	for (const [k, v] of Object.entries({ x: "-4", y: "-4", width: String(n + 8), height: String(n + 8), fill: "#fff" })) bg.setAttribute(k, v);
	dots.setAttribute("d", rows.flatMap((row, y) => [...row].flatMap((c, x) => (c === "1" ? [`M${x} ${y}h1v1h-1z`] : []))).join(""));
	dots.setAttribute("fill", "#06101e");
	svg.append(bg, dots);
	return svg;
}
