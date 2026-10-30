import { deviceList } from "./devices.ts";
import { h, nodes } from "./dom.ts";
import { lanTab } from "./lan.ts";
import type { Tile } from "./layer.ts";
import { m } from "./paraglide/messages.js";
import { get, post } from "./post.ts";
import { square } from "./qr.ts";

// The phone pairing tile, its own small chunk, with two tabs. Tailscale: a fresh one-time pairing URL from the server as a QR code (qr.ts, dark modules on white, drawn
// as one SVG path, never markup). While remote access is off the tab asks first; Turn on opens it to the tailnet from the server's session and
// shows the code it answers with. The code works once, within ten minutes; New code asks for another. Same Wi-Fi: lan.ts. Under either, the paired devices of both networks (devices.ts).

export { square };

/** The id this tile's Same Wi-Fi tab mints its codes under (the server keeps one live code per id). */
const surface = () => `tile-${[...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;

/** `first` is the tab the tile opens on (the page's waiting-request notice opens the Wi-Fi one). */
export function pairTile(first: "tailscale" | "lan" = "tailscale"): Tile {
	let lan: ReturnType<typeof lanTab> | undefined;
	return { id: "pair", title: m.pair_tile(), closed: () => lan?.end(), body: () => {
		const code = h("div", { class: "pair" }), again = h("button", { type: "button", class: "later" }, m.new_code());
		const on = h("button", { type: "button", class: "pair-btn" }, m.remote_turn_on());
		const ask = (path = "remote/pair", waiting = m.asking_code()) => {
			code.replaceChildren(h("p", { class: "chat-empty" }, waiting));
			void post(path, {}).then((r) => {
				void devices.refresh(); // turning remote on shows Turn off, and a code asked for after a restart may follow a pairing
				const rows = r.body.rows, url = String(r.body.url ?? ""), typed = r.body.code;
				if (r.body.error === "remote_off") return code.replaceChildren(h("p", null, m.remote_off_ask()), on);
				if (!r.ok || !Array.isArray(rows)) return code.replaceChildren(h("p", null, r.body.reason ?? m.refused({ status: r.status })), path === "remote/on" ? on : again);
				code.replaceChildren(...nodes(square(rows.map(String)), h("p", null, m.pair_scan()), h("p", null, h("code", null, new URL(url).host)), typeof typed === "string" && h("p", null, m.pair_code(), h("br", null), h("code", { class: "pair-code" }, typed)), again));
			}, () => code.replaceChildren(h("p", null, m.no_answer()), again));
		};
		on.onclick = () => ask("remote/on", m.remote_turning_on());
		again.onclick = () => ask();
		let tab: "tailscale" | "lan" = "tailscale";
		const devices = deviceList(() => code.replaceChildren(h("p", null, m.remote_off_ask()), on), () => tab === "tailscale");
		lan = lanTab({ get, post, surface: surface(), changed: () => void devices.refresh(), every: (run, ms) => { const t = setInterval(run, ms); return () => clearInterval(t); } });
		const ids = ["tailscale", "lan"] as const;
		const tabs = ids.map((id) => {
			const b = h("button", { type: "button", role: "tab", class: "later", id: `pair-tab-${id}`, "aria-controls": `pair-panel-${id}` }, id === "lan" ? m.pair_tab_lan() : m.pair_tab_tailscale());
			b.onclick = () => select(id);
			// Arrow keys, Home, and End move between the tabs (one tab stop for the list, on the selected tab).
			b.addEventListener("keydown", (e) => {
				const key = (e as KeyboardEvent).key, to = key === "ArrowRight" || key === "ArrowLeft" ? (ids.indexOf(id) + (key === "ArrowRight" ? 1 : ids.length - 1)) % ids.length : key === "Home" ? 0 : key === "End" ? ids.length - 1 : -1;
				if (to < 0) return;
				e.preventDefault();
				select(ids[to]!);
				tabs[to]![1].focus();
			});
			return [id, b] as const;
		});
		for (const [id, el] of [["tailscale", code], ["lan", lan!.root]] as const) for (const [k, v] of Object.entries({ role: "tabpanel", id: `pair-panel-${id}`, "aria-labelledby": `pair-tab-${id}` })) el.setAttribute(k, v);
		/** The Tailscale tab asks for a code each time it is shown, as the tile did when it opened; the Wi-Fi tab reads the server and asks when Wi-Fi access is on. */
		const select = (id: typeof tab, first = false) => {
			tab = id;
			for (const [name, b] of tabs) (b.setAttribute("aria-selected", String(name === id)), b.setAttribute("tabindex", name === id ? "0" : "-1"), b.classList.toggle("on", name === id));
			code.hidden = id !== "tailscale";
			lan!.root.hidden = id !== "lan";
			if (id === "lan") lan!.start();
			else (lan!.end(), first || ask());
			void devices.refresh();
		};
		select(first, true);
		if (first === "tailscale") ask();
		return h("div", { class: "pair" }, h("div", { class: "pair-tabs", role: "tablist", "aria-label": m.pair_tabs() }, ...tabs.map(([, b]) => b)), code, lan.root, devices.box);
	} };
}
