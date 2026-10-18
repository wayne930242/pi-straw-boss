import "./style.css";
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

const page = mountPage();
const el = (id: string) => document.getElementById(id)!;
const time = (at?: number) => (at ? new Date(at).toLocaleTimeString([], { hour12: false }) : "never");

let shown: Net | undefined, logged: Net | undefined, latest: Net | undefined, pending: Net | undefined, status: Status = { state: "connecting", attempt: 0 };
let current: Route = { view: "map" }, started = false, known: Map<string, Alert> | undefined, hello = "";

// The focus views (the zoomed-in base, the session's comms and dossier) are a separate chunk, fetched on the first route that is not the
// map. Calls made before it arrives wait in order, and it starts with the latest net.
type Focus = ReturnType<typeof mountFocus>;
let focus: Focus | undefined, loading: Promise<Focus> | undefined;
const withFocus = (call: (f: Focus) => void) => (focus ? call(focus) : void loading?.then(call));
function loadFocus() {
	loading ??= import("./views.ts").then(({ mountFocus }) => {
		focus = mountFocus({ data, restart: () => stream.restart(), openTile, openTerminal: (key, name) => withPanels((p) => p.terminal.open(key, name)), online: () => status.state === "live" });
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
	el("link-text").textContent = { connecting: "connecting", live: "live", reconnecting: "reconnecting", offline: "offline" }[next.state];
	if (focus && latest) focus.net(latest); // the composer follows the link state
	panels?.stack.redraw(); // and so do the dialogs' Focus terminal buttons
	const banner = el("banner");
	banner.hidden = !stale && !next.problem;
	const lead = next.state === "offline"
		? `Disconnected. Gave up after ${next.attempt - 1} tries; it reconnects when you return to this tab.`
		: next.state === "reconnecting"
			? `Disconnected from the straw net. Reconnecting${next.attempt ? ` (try ${next.attempt})` : ""}… The view shows the last known state.`
			: `The server is up but cannot read the net: ${next.problem}`;
	const last = document.createElement("b");
	last.textContent = time(next.lastContact);
	banner.replaceChildren(`${lead} Last update `, last, ".");
}

/** A history or cards event from the stream; one the page cannot read is dropped. */
function forward(kind: "history" | "cards", raw: string) {
	try {
		const value = JSON.parse(raw);
		withFocus((f) => (kind === "history" ? f.history(value as HistoryEvent) : f.cards(value)));
	} catch {} // the next event replaces it
}

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
	source.listen("hello", (d) => ((hello = d), panels?.terminal.hello()));
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
for (const event of ["focus", "pageshow", "online"]) window.addEventListener(event, () => !document.hidden && resume());
report(status);
navigate(router.route());
stream.start();
started = true;
