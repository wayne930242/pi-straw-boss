import "./style.css";
import { startI18n } from "./i18n.ts";
import { m } from "./paraglide/messages.js";
import type { Net } from "../src/net.ts";
import type { Data, HistoryEvent } from "./chat.ts";
import type { Post } from "./composer.ts";
import { changes } from "./log.ts";
import { type Alert, alertsOf, arrivals } from "./alerts.ts";
import type { mountPanels, Tile } from "./layer.ts";
import { mountPage } from "./render.ts";
import { createRouter, parseRoute, type Route, upOf, watchOf } from "./router.ts";
import { createStream, type Source, type Status } from "./stream.ts";
import type { mountFocus } from "./views.ts";

startI18n();
const page = mountPage();
const el = (id: string) => document.getElementById(id)!;
const time = (at?: number) => (at ? new Date(at).toLocaleTimeString([], { hour12: false }) : m.never());

let shown: Net | undefined, logged: Net | undefined, latest: Net | undefined, pending: Net | undefined, status: Status = { state: "connecting", attempt: 0 };
let current: Route = { view: "map" }, started = false, known: Map<string, Alert> | undefined, hello = "";

// The focus views (the zoomed-in base, the session's comms and dossier) are a separate chunk, fetched on the first route that is not the
// map. Calls made before it arrives wait in order, and it starts with the latest net.
type Focus = ReturnType<typeof mountFocus>;
let focus: Focus | undefined, loading: Promise<Focus> | undefined;
const withFocus = (call: (f: Focus) => void) => (focus ? call(focus) : void loading?.then(call));
function loadFocus() {
	loading ??= import("./views.ts").then(({ mountFocus }) => {
		focus = mountFocus({ data, restart: () => stream.restart(), openTile, embedTerminal: (key, name, host) => new Promise((done) => withPanels((p) => done(p.terminal.embed(key, name, host)))), online: () => status.state === "live" });
		focus.show(current, current);
		if (latest) focus.net(latest);
		return focus;
	});
}

// The overlay layer (the alert queue, dialogs, and tiles) is a chunk of its own too, fetched on the first alert or tile.
type Panels = ReturnType<typeof mountPanels>;
let panels: Panels | undefined, panelsLoading: Promise<Panels> | undefined;
const withPanels = (call: (p: Panels) => void) => {
	if (panels) return call(panels);
	panelsLoading ??= import("./layer.ts").then(({ mountPanels }) => (panels = mountPanels({
		label: (ws) => latest?.bases.find((b) => b.id === ws)?.label ?? ws,
		recent: async (key) => (await (fixture ? fixture.data(key).latest() : history(key, "?limit=12"))).items,
		post: (key) => fixture && ((action, body) => fixture.data(key).post!(action as Parameters<Post>[0], body)),
		stream: () => hello,
		showTerminal: (ws, key) => (panels?.stack.close(), focus?.terminal(key), router.go({ view: "session", ws, key })),
	})));
	void panelsLoading.then(call);
};
const openTile = (tile: Tile, take?: boolean) => withPanels((p) => p.tiles.open(tile, take));

// The header, the alert queue, and the focus views follow every snapshot. A hidden page keeps only the newest snapshot and draws it
// when it comes back, so a background tab does no DOM work; the net log follows on every route, the map is drawn only while in view.
function show(net: Net) {
	latest = pending = net;
	if (document.hidden) return;
	page.stats(net);
	const now = alertsOf(net, Date.now()), fresh = arrivals(known, now);
	if (fresh.length || panels) withPanels((p) => p.alerts(fresh, now));
	known = now;
	page.log(changes(logged, net));
	logged = net;
	withFocus((f) => f.net(net));
	if (current.view !== "map") return;
	page.show(net);
	shown = net;
	pending = undefined;
}

/** A route change: show its view (the focus chunk plays the entrance), and watch what it needs (one connection serves one page). */
function navigate(next: Route) {
	const before = current, from = next.view === "workspace" && before.view === "map" ? document.querySelector(`#bases [data-key="${CSS.escape(next.ws)}"]`)?.getBoundingClientRect() : undefined;
	current = next;
	if (next.view !== "map") loadFocus();
	el("map").hidden = next.view !== "map";
	el("legend").hidden = next.view === "session";
	page.still(next.view !== "map");
	withFocus((f) => f.show(next, before, from));
	if (next.view === "map" && latest && latest !== shown) {
		show(latest);
		requestAnimationFrame(page.layout);
	}
	if (started && watchOf(next) !== watchOf(before)) stream.restart();
}

function report(next: Status) {
	status = next;
	const stale = next.state === "reconnecting" || next.state === "offline";
	document.body.dataset.stale = el("stage").dataset.stale = String(stale);
	el("link").dataset.state = next.state;
	el("link-text").textContent = { connecting: m.link_connecting, live: m.link_live, reconnecting: m.link_reconnecting, offline: m.link_offline }[next.state]();
	if (focus && latest) focus.net(latest); // the composer follows the link state
	panels?.stack.redraw(); // and so do the dialogs' Focus terminal buttons
	const banner = el("banner");
	banner.hidden = !stale && !next.problem;
	const lead = next.state === "offline"
		? m.banner_offline({ tries: next.attempt - 1 })
		: next.state === "reconnecting"
			? next.attempt ? m.banner_reconnecting_try({ attempt: next.attempt }) : m.banner_reconnecting()
			: m.banner_problem({ problem: next.problem ?? "" });
	const last = document.createElement("b");
	last.textContent = time(next.lastContact);
	banner.replaceChildren(`${lead} ${m.banner_last()} `, last, m.banner_end());
}

/** A history or cards event from the stream; one the page cannot read is dropped. */
function forward(kind: "history" | "cards", raw: string) {
	try {
		const value = JSON.parse(raw);
		withFocus((f) => (kind === "history" ? f.history(value as HistoryEvent) : f.cards(value)));
	} catch {} // the next event replaces it
}

// The build the server wrote into this page: a stream from another build (a newer pi-straw-boss took the server over) reloads the page,
// whose lazy chunks that server no longer has.
const build = document.querySelector<HTMLMetaElement>('meta[name="sb-build"]')?.content;
const rebuilt = (raw: string) => Boolean(build && build !== (JSON.parse(raw) as { build?: string }).build);
/** The real stream: the server's events, relative to the page's <base href> so the token path carries over from any route. */
function live(watch: string | null): Source {
	const es = new EventSource(watch ? `events?watch=${encodeURIComponent(watch)}` : "events");
	return {
		onError: (handler) => (es.onerror = handler),
		listen: (type, handler) => es.addEventListener(type, (event) => handler((event as MessageEvent<string>).data)),
		close: () => es.close(),
	};
}

const api = (path: string) => fetch(`api/${path}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))));
const history = (key: string, query = "") => api(`history/${encodeURIComponent(key)}${query}`);
const fixture = __LIVE__ ? undefined : (await import("./fixture.ts")).createFixture({ resume: () => stream.resume() });
const data = (key: string): Data => fixture?.data(key) ?? { older: (before) => history(key, `?before=${encodeURIComponent(before)}`), latest: () => history(key), entry: (id) => api(`entry/${encodeURIComponent(key)}/${encodeURIComponent(id)}`).catch(() => undefined) };
const open = () => {
	const source = fixture ? fixture.open(watchOf(current)) : live(watchOf(current));
	source.listen("history", (d) => forward("history", d));
	source.listen("cards", (d) => forward("cards", d));
	// The stream's name (terminal tiles attach to it) and their frames go to the overlay layer, which parses them.
	source.listen("hello", (d) => (rebuilt(d) ? location.reload() : ((hello = d), panels?.terminal.hello())));
	source.listen("mirror", (d) => panels?.terminal.frame(d));
	return source;
};
// A click on a unit that waits or failed opens its alert through the dock rather than its route; a modified click still follows the link.
document.addEventListener("click", (event) => {
	const link = (event.target as Element | null)?.closest?.("a[data-alert]"), route = link && parseRoute(link.getAttribute("data-route") ?? "");
	if (!route || route.view !== "session" || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
	const alert = known?.get(route.key);
	if (!alert) return;
	event.preventDefault();
	withPanels((p) => p.stack.show(alert));
}, true);
const router = createRouter((route) => navigate(route));
const stream = createStream({
	open,
	now: Date.now,
	setTimeout: (run, ms) => window.setTimeout(run, ms),
	clearTimeout: (id) => window.clearTimeout(id),
	random: Math.random,
	hidden: () => document.hidden,
	onNet: show,
	onStatus: report,
});
const resume = () => stream.resume();
document.addEventListener("visibilitychange", () => {
	page.pause(document.hidden);
	if (document.hidden) return stream.hide();
	if (pending) show(pending);
	withFocus((f) => f.wake());
	resume();
});
// Escape closes the top dialog; with none open it goes up one route.
addEventListener("keydown", (event) => {
	if (event.key !== "Escape" || event.defaultPrevented) return;
	event.preventDefault();
	if (!panels?.stack.close() && current.view !== "map") router.go(upOf(current));
});
el("pair").addEventListener("click", () => void import("./pair.ts").then(({ pairTile }) => openTile(pairTile(), true)));
// A close button asks first in the page's own dialog (a browser confirm can be dismissed by an attached tool before it is seen), then posts
// close/unit, close/tab, or close/base; the net shows what went, and a refusal says why in the same dialog.
const sheet = (text: string, yes?: string): Promise<boolean> => new Promise((done) => {
	const d = document.createElement("dialog"), p = document.createElement("p"), row = document.createElement("div");
	const button = (label: string, cls: string, answer: boolean) => Object.assign(document.createElement("button"), { type: "button", className: cls, textContent: label, onclick: () => (d.close(), done(answer)) });
	[d.className, p.textContent, row.className] = ["sheet", text, "sheet-row"];
	row.append(...(yes ? [button(m.cancel(), "later", false), button(yes, "sheet-yes", true)] : [button(m.close(), "later", false)]));
	d.append(p, row);
	d.addEventListener("close", () => (d.remove(), done(false)));
	document.body.append(d);
	d.showModal();
});
document.addEventListener("click", (event) => {
	const b = (event.target as Element | null)?.closest?.<HTMLElement>("button[data-close]"), d = b?.dataset;
	if (!b || !d) return;
	event.preventDefault();
	const ask = d.close === "base" ? m.close_base_ask : d.close === "tab" ? m.close_squad_ask : d.role === "tower" ? m.close_tower_ask : m.close_unit_ask;
	void sheet(ask({ name: d.name ?? "" }), m.close()).then((yes) => {
		if (!yes) return;
		b.toggleAttribute("disabled", true);
		void import("./post.ts").then(({ post }) => post(`close/${d.close}`, d.close === "unit" ? { key: d.key } : { workspace: d.ws, ...(d.tab && { tab: d.tab }) }))
			.then((r) => r.ok || sheet(r.body.reason ?? m.refused({ status: r.status })), () => sheet(m.no_answer())).finally(() => b.toggleAttribute("disabled", false));
	});
});
// The opening buttons on the map and in a base (data-open with data-ws and data-tab) open their tile, read against the newest net.
document.addEventListener("click", (event) => {
	const button = (event.target as Element | null)?.closest?.<HTMLElement>("button[data-open]");
	if (button) void import("./spawn.ts").then(({ openingOf, spawnTile }) => {
		const opening = openingOf(button, latest?.bases ?? []);
		if (opening) openTile(spawnTile(opening), true);
	});
});
for (const event of ["focus", "pageshow", "online"]) window.addEventListener(event, () => !document.hidden && resume());
report(status);
navigate(router.route());
stream.start();
started = true;
