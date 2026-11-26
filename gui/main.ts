import "./style.css";
import { domEnv, mountPick, mountView, mountZenEnter } from "./view.ts";
import { mountMode } from "./mode.ts";
import { KEYS } from "./prefs.ts";
import { forcePhase, phaseNow } from "./phase.ts";
import type { Face } from "../src/views.ts";
import { createPage } from "./pagecore.ts";
import { localeNames, setLocale, startI18n } from "./i18n.ts";
import { followLabel } from "./viewlabel.ts";
import { m } from "./sentences.ts";
import { getLocale } from "./paraglide/runtime.js";
import { HEAD_KEY } from "../src/headkey.ts";
import type { Net, RunDialog } from "../src/net.ts";
import type { Data, HistoryEvent } from "./chat.ts";
import type { Post } from "./composer.ts";
import type { Alert } from "./alerts.ts";
import type { Drawer } from "./drawer.ts";
import type { mountPanels, Tile } from "./layer.ts";
import type { mountSettings } from "./settings.ts";
import { mountAutoSwitch } from "./auto.ts";
import { mountConnect } from "./connect.ts";
import { MODAL, mountHotkeys } from "./hotkeys.ts";
import { mountLinkBar } from "./linkbar.ts";
import { mountMenus } from "./menu.ts";
import { mountNotify } from "./notify.ts";
import { mountQuit, showDismissAll, showStashed } from "./quit.ts";
import { hang, mountPage } from "./render.ts";
import { fillHeadButton, headDot, seenAt } from "./headpage.ts";
import { settingsAllowed } from "./desk.ts";
import { createRouter, depthOf, netOf, parseRoute, type Route, type Section } from "./router.ts";
import { CONNECTING, createStream, type Source, type Status } from "./stream.ts";
import { onStep } from "./terminalthen.ts";
import { mountTimeline } from "./timeline.ts";
import type { mountFocus } from "./views.ts";
import { badgeOf, iconHref, plainOf } from "./tabicon.ts";
import { isTheme, loadTheme, onTheme, recheckPhase, showTheme } from "./themes/registry.ts";
import { pageThemes } from "./themes/manifest.ts";
import type { mountZen } from "./zen.ts";
import type { TermKit } from "./zentypes.ts";

// The face goes first, before anything is drawn: `data-view` on <html> picks the palette, so no frame is painted in the other one (view.ts). It is Zen while the mode is on (mode.ts) and the route is not the settings page, and the device's theme otherwise.
// The demo's `?zen=<state>` opens it in Zen for this page only (fixture.ts): `sb.zen` is 1 in a store of its own, and nothing is written to the device.
const zenDemo = __LIVE__ ? null : new URLSearchParams(location.search).get("zen");
// The demo's `&phase=day|night` shows Storybook in that phase whatever the clock says (phase.ts), for screenshots; a live page has no such override (docs/specs/2026-11-26-storybook-theme/spec.md O9).
const phaseDemo = __LIVE__ ? null : new URLSearchParams(location.search).get("phase");
if (phaseDemo === "day" || phaseDemo === "night") forcePhase(phaseDemo);
const demoStore = new Map<string, string>([[KEYS.zen, "1"]]);
const env = zenDemo ? { ...domEnv(), storage: { getItem: (key: string) => demoStore.get(key) ?? localStorage.getItem(key), setItem: (key: string, value: string) => void demoStore.set(key, value) } } : domEnv();
const mode = mountMode(env.storage);
/** Whether the page shows Zen: the mode alone until the core knows the route (pagecore.ts `zenOn`). */
let zenShown = () => mode.on();
const view = mountView(env, () => zenShown());
startI18n();
mountMenus();
mountPick(document.getElementById("view-pick")!, view, followLabel);
const page = mountPage(), timeline = mountTimeline(document.getElementById("timeline") as HTMLDetailsElement);
const el = (id: string) => document.getElementById(id)!;
// The header's Zen button, in every theme: it turns the mode on (pagecore.ts `enterZen`).
mountZenEnter(el("zen-enter"), () => core.enterZen());
const time = (at?: number) => (at ? new Date(at).toLocaleTimeString([], { hour12: false }) : m.never());

let started = false, hello = "";

// The focus views (the zoomed-in base, the session's comms and dossier) are a separate chunk, fetched on the first route that is not the
// map. Calls made before it arrives wait in order, and it starts with the latest net.
type Focus = ReturnType<typeof mountFocus>;
let focus: Focus | undefined, loading: Promise<Focus> | undefined;
const withFocus = (call: (f: Focus) => void) => (focus ? call(focus) : void loading?.then(call));
function loadFocus() {
	loading ??= import("./views.ts").then(({ mountFocus }) => {
		focus = mountFocus({ data, restart: () => stream.restart(), openTile, embedTerminal: (key, name, host) => embed(key, name, host, { keys: false }), online: core.online });
		focus.show(netOf(core.current), netOf(core.current));
		if (core.latest) focus.net(core.latest);
		return focus;
	});
}

/** The page's terminal embedded in a host: the session view's terminal mode and the Zen terminal layer (the overlay chunk holds the terminals). */
const embed = (key: string, name: string, host: HTMLElement, o: { keys: boolean; end?: () => void }) => new Promise<() => void>((done) => withPanels((p) => done(p.terminal.embed(key, name, host, o))));
/** The page's terminals for Zen's layer (the card and the full terminal). */
const terminals = () => new Promise<TermKit>((done) => withPanels((p) => done(p.kit)));
/** A base's name, for the dialogs and Zen's cards. */
const label = (ws: string) => core.latest?.bases.find((b) => b.id === ws)?.label ?? ws;
// The overlay layer (the alert queue, dialogs, and tiles) is a chunk of its own too, fetched on the first alert or tile.
type Panels = ReturnType<typeof mountPanels>;
let panels: Panels | undefined, panelsLoading: Promise<Panels> | undefined;
const withPanels = (call: (p: Panels) => void) => {
	if (panels) return call(panels);
	panelsLoading ??= import("./layer.ts").then(({ mountPanels }) => (panels = mountPanels({
		label,
		recent,
		post: (key) => fixture && ((action, body) => fixture.data(key).post!(action as Parameters<Post>[0], body)), trust: fixture && fixture.trust,
		stream: () => hello,
		showTerminal: (ws, key) => core.openSession(ws, key, { mode: "term" }),
		net: () => core.latest,
	})));
	void panelsLoading.then(call);
};
const openTile = (tile: Tile, take?: boolean) => withPanels((p) => p.tiles.open(tile, take));

// The Zen layer (zen.ts, with the pure model in zenmodel.ts) is a chunk of its own, fetched the first time the page shows Zen (pagecore.ts says when it does).
type Zen = ReturnType<typeof mountZen>;
let zen: Zen | undefined, zenLoading: Promise<Zen> | undefined;
/** Every headless run's dialogs, as the server's last `run-dialogs` event listed them (this computer's page only; docs/specs/2026-11-24-zen-f.md §7.3): Zen's run cards. */
let runDialogs: RunDialog[] = [];
const withZen = (call: (z: Zen) => void) => {
	zenLoading ??= loadTheme("zen").then(({ mountZen, zenPage }) => {
		const host = zenPage({ sound: notify.sound, api: fixture?.api ?? api, snapshot: core.newest }); // the effects, the music, and the companion readers (zenpage.ts) are built in the chunk
		return (zen = mountZen(el("zen"), {
			data, recent, label, online: core.online,
			post: (key) => fixture && ((action, body) => fixture.data(key).post!(action, body)), trust: fixture && fixture.trust,
			remind: (a) => notify.remind(a), sound: host.sound,
			menu: { language: { get: getLocale, names: localeNames, set: setLocale }, sound: { effects: { ...notify.sound.effects, try: host.menuSound.try, all: host.menuSound.all }, background: notify.sound.background } }, // the corner menu's rows act through the settings page's own switches
			music: host.music,
			leave: core.leaveZen, terminals, watch: core.watchLog, companions: host.companions, activity: host.activity, trains: host.trains, settings: core.openSettings, start: fixture?.start,
		}), zen.runs(runDialogs), zen);
	});
	void zenLoading.then(call);
};

// The settings page's sections (Phone, Teams, Server) are a chunk of their own, fetched the first time the page opens; they are built when a section opens and dropped when it closes (settings.ts).
// Phone and the server's panel are this computer's: a paired device has neither, and a desk window has no Phone (desk.ts).
const allowed = settingsAllowed(location.hostname), phoneOk = allowed.phone; // restarting the server and reading its log are this computer's too (the server answers 403 local_only to a paired device)
let settings: Promise<ReturnType<typeof mountSettings>> | undefined;
const withSettings = (call: (s: ReturnType<typeof mountSettings>) => unknown) => void (settings ??= import("./settings.ts").then(({ mountSettings }) => mountSettings(el("settings-view"), allowed))).then(call);
/** Opens a section of the settings page: in place when the page is open, else by its route (which a link can also carry). */
const openSection = (section: Section) => (core.current.view === "settings" ? withSettings((s) => s.show(section)) : router.go({ view: "settings", section }));

// The header, the alert queue, and the focus views follow every snapshot. A hidden page keeps only the newest snapshot and draws it
// when it comes back, so a background tab does no DOM work; the timeline follows on every route, the map is drawn only while in view.
// The tab's icon carries the count of units waiting on an answer, a hidden tab's above all; a browser that keeps the first icon shows it plain.
// Each view has its own icon (the build's theme map, boot.js leaves Standard's file name in data-standard); the waiting badge is drawn over the shown view's, in the theme's colours.
const tabIcon = document.querySelector<HTMLLinkElement>('link[rel="icon"]'), homeIcon = tabIcon && (tabIcon.dataset.standard ?? tabIcon.getAttribute("href") ?? ""), themeMap = pageThemes();
const plains = new Map<string, Promise<string | undefined>>();
const plainFor = (shown: Face) => {
	const href = new URL(themeMap[shown].icon ?? homeIcon ?? "", document.baseURI).href;
	if (!plains.has(href)) plains.set(href, plainOf(href));
	return plains.get(href)!;
};
let plain = tabIcon ? plainFor(view.face()) : undefined, badged = 0;
function icon(n: number, again = false) {
	if (!tabIcon || !plain || (n === badged && !again)) return;
	badged = n;
	const requested = plain;
	void requested.then((svg) => svg && requested === plain && n === badged && (tabIcon.href = iconHref(svg, n, badgeOf(themeMap, view.face(), phaseNow()))));
}
/** A phone's `⋯` in the header shows only while something is behind it (Dismiss finished, Stashed); when both go, its panel closes. */
function moreActs() {
	const none = el("dismiss-all").hidden && el("stashed").hidden && el("head-btn").hidden && el("auto-sw").hidden;
	el("bar-more").hidden = none;
	if (none && el("bar-pop").matches(":popover-open")) el("bar-pop").hidePopover();
}
/** Standard's page for a snapshot while it is shown (pagecore.ts says when). */
function draw(net: Net, fresh: Alert[], now: Map<string, Alert>) {
	page.stats(net);
	recheckPhase(); // a phone that slept skipped the theme's timer (Storybook's phase)
	autoSw.net(net);
	showDismissAll(el("dismiss-all"), net);
	showStashed(el("stashed"), el("stashed-list"), net);
	fillHeadButton(el("head-btn"), net.head, seenAt(), core.current.view === "head" || (core.current.view === "session" && core.current.ws === HEAD_KEY));
	moreActs();
	el("bar-more").toggleAttribute("data-news", headDot(net.head, seenAt()) && !(core.current.view === "head" || (core.current.view === "session" && core.current.ws === HEAD_KEY)));
	drawer?.net(net);
	yard?.net(net);
	if (fresh.length || panels) withPanels((p) => p.alerts(fresh, now, net));
	timeline.net(net);
	withFocus((f) => f.net(net));
}

/** A route change: show its view (the focus chunk plays the entrance). */
function navigate(next: Route, before: Route) {
	const from = next.view === "workspace" && before.view === "map" ? document.querySelector(`#bases [data-key="${CSS.escape(next.ws)}"]`)?.getBoundingClientRect() : undefined;
	const slot = next.view === "head" ? "session" : next.view; // the head page is the session view, on the head's key
	document.body.dataset.route = slot; // a phone's map has no location bar (style.css): the page is the net itself
	drawer?.route(next);
	if (next.view === "workspace" || next.view === "session" || next.view === "head") loadFocus();
	el("map").hidden = next.view !== "map";
	el("settings-view").hidden = next.view !== "settings"; // the settings page has a header of its own
	el("crumbs").hidden = next.view === "settings";
	el("legend").hidden = slot === "session" || next.view === "settings";
	el("prefs").toggleAttribute("aria-current", next.view === "settings");
	el("stage").dataset.view = next.view === "head" || (next.view === "session" && next.ws === HEAD_KEY) ? "head" : slot; // the head page has no dossier (its facts are the page's own); the side column (the dossier) is the session view's alone
	withFocus((f) => f.show(netOf(next), netOf(before), from));
	if (next.view === "settings") withSettings((s) => core.current === next && s.show(next.section));
	else if (before.view === "settings") withSettings((s) => s.hide());
}

const leaveSettings = () => (depthOf(window.history.state) > 0 ? window.history.back() : router.go({ view: "map" })); // `history` is the module's own reader of a session's log
const modal = () => document.querySelector(MODAL) !== null;
// The page's face, route, stream state, and watch live in pagecore.ts, with what the page does when asked (open a session, an alert, a pane, leave or come back to Zen, Escape); this file gives it the parts (the DOM, the lazy chunks, the stream).
const core = createPage({
	view, mode, zenEl: el("zen"), zen: () => zen, withZen, hidden: () => document.hidden, faced: () => showFace(), leaveSettings, restart: () => started && stream.restart(),
	icon, link: (link) => linkBar.net(link), signal: (fresh) => notify.signal(fresh), draw, map: page.show, navigate, layout: () => requestAnimationFrame(page.layout),
	panels: () => panels, withPanels, withFocus, go: (route) => router.go(route), modal, chime: () => notify.chime(),
});
zenShown = core.zenOn;
// A face's theme (stylesheet, sprite, nouns) loads the first time the page shows it; its parts take effect, and the tab takes its icon with the badge in its colours (themes/registry.ts).
// In Zen the device's theme loads too, once Zen has drawn and the page is idle, so leaving shows it with no flash of Standard; its sounds and motion run only while its face shows (docs/specs/2026-11-26-storybook-theme/spec.md O10).
const idle = (run: () => void) => ("requestIdleCallback" in window ? requestIdleCallback(() => run()) : setTimeout(run, 200));
let faceShown: Face | undefined;
function showFace() {
	const face = view.face(), theme = view.view();
	if (face === "zen" && isTheme(theme)) idle(() => void loadTheme(theme).catch(() => undefined)); // fetched once (registry.ts); its parts take effect on leaving
	if (face === faceShown) return;
	faceShown = face;
	void showTheme(face, () => { view.refresh(); icon(badged, true); });
}
// A theme that changes under the page (Storybook's day and night) says so: the theme-color and the tab's badge are painted again, nothing else moves (no reload, no route, no focus).
onTheme((shown) => {
	view.refresh();
	if (tabIcon) plain = plainFor(shown);
	icon(badged, true);
	if (core.latest) core.snapshot(core.latest); // the words and icons are drawn again in the shown view's, a switch back to Standard included (RRB2-F001)
});
showFace();
onStep(core.openStep); // the step an accepted answer left (terminalthen.ts)
// The return panel (autoback.ts, a chunk of its own): read once when the first snapshot arrives, and again at once when this page's own switch ends auto mode; a later snapshot only keeps its cards current.
let back: Promise<ReturnType<typeof import("./autoback.ts").mountBack>> | undefined;
const withBack = (call: (b: ReturnType<typeof import("./autoback.ts").mountBack>) => unknown) => void (back ??= import("./autoback.ts").then(({ mountBack, BACK_KEY }) => mountBack(el("auto-back"), { net: () => core.latest, store: { get: () => localStorage.getItem(BACK_KEY), set: (v) => localStorage.setItem(BACK_KEY, v) }, now: Date.now }))).then(call);
let firstNet = true;
const backCheck = (net: Net) => (firstNet ? ((firstNet = false), withBack((b) => b.check())) : back && withBack((b) => b.net(net)));
const autoSw = mountAutoSwitch(el("auto-sw"), { after: () => (el("bar-pop").matches(":popover-open") && el("bar-pop").hidePopover(), withBack((b) => b.check(true))) });
const linkBar = mountLinkBar(() => openSection("teams"), core.news);
const notify = mountNotify(core.notified);

function report(next: Status) {
	connect(next); // the overlay opens or closes before Zen's card redraws under it (its controls change with the state, and the overlay notes and restores the focus)
	core.status(next);
	const stale = next.state === "reconnecting" || next.state === "offline" || next.state === "replaced";
	document.body.dataset.stale = el("stage").dataset.stale = String(stale);
	el("link").dataset.state = next.state;
	el("link-text").textContent = { connecting: m.link_connecting, live: m.link_live, reconnecting: m.link_reconnecting, offline: m.link_offline, replaced: m.link_offline }[next.state]();
	if (focus && core.latest) focus.net(core.latest); // the composer follows the link state
	panels?.stack.redraw(); // and so do the dialogs' Focus terminal buttons
	const banner = el("banner");
	banner.hidden = !stale && !next.problem;
	const lead = next.state === "replaced"
		? m.banner_replaced()
		: next.state === "offline"
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
		if (kind === "history") zen?.history(value as HistoryEvent);
		withFocus((f) => (kind === "history" ? f.history(value as HistoryEvent) : f.cards(value)));
	} catch {} // the next event replaces it
}

// The build the server wrote into this page: a stream from another build (a newer pi-straw-boss took the server over) reloads the page,
// whose lazy chunks that server no longer has. Standard and Geek reload at once; a page showing Zen waits for the breath (core.upgrade).
const build = document.querySelector<HTMLMetaElement>('meta[name="sb-build"]')?.content ?? (__LIVE__ ? undefined : "demo"); // the demo's own hello says "demo" (fixture.ts), and `&upgrade=<ms>` announces another
const rebuilt = (raw: string) => Boolean(build && build !== (JSON.parse(raw) as { build?: string }).build);
/** The server's default view from a `hello` (its `view`) or a `view` event (the value itself); anything else is left. */
function serverView(raw: string, bare = false) {
	try {
		const value: unknown = JSON.parse(raw);
		const named = bare ? value : (value as { view?: unknown } | null)?.view;
		if (typeof named === "string") view.setServer(named);
	} catch {} // the next hello says it again
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
if (fixture) void import("./box.ts").then(({ useRuns }) => useRuns(fixture.api)); // the demo answers a remote base's Earlier runs itself (demo-box.ts); the live page reads api/transcripts
const data = (key: string): Data => fixture?.data(key) ?? { older: (before) => history(key, `?before=${encodeURIComponent(before)}`), latest: () => history(key), entry: (id) => api(`entry/${encodeURIComponent(key)}/${encodeURIComponent(id)}`).catch(() => undefined), pic: (id, n) => `api/image/${encodeURIComponent(key)}/${encodeURIComponent(id)}/${n}` };
/** A session's newest entries, for what an alert's unit last said. */
const recent = async (key: string) => (await (fixture ? fixture.data(key).latest() : history(key, "?limit=12"))).items;
const open = () => {
	const watching = core.opened();
	const source = fixture ? fixture.open(watching) : live(watching);
	source.listen("history", (d) => forward("history", d));
	source.listen("cards", (d) => forward("cards", d));
	source.listen("run-dialogs", (d) => { try { runDialogs = JSON.parse(d) as RunDialog[]; zen?.runs(runDialogs); } catch {} }); // the next event replaces one the page cannot read
	// The stream's name (terminal tiles attach to it) and their frames go to the overlay layer, which parses them.
	source.listen("hello", (d) => (rebuilt(d) ? core.upgrade(() => location.reload()) : ((hello = d), serverView(d), panels?.terminal.hello())));
	// The server's default view changed (`/boss gui view`): a page that follows the server switches without a reload. A hello says it too, so a stream that missed the event heals when it reconnects.
	source.listen("view", (d) => serverView(d, true));
	source.listen("mirror", (d) => panels?.terminal.frame(d));
	return source;
};
// A click on a unit that waits or failed opens its alert through the dock rather than its route; a modified click still follows the link.
document.addEventListener("click", (event) => {
	const link = (event.target as Element | null)?.closest?.("a[data-alert]"), route = link && parseRoute(link.getAttribute("data-route") ?? "");
	if (!route || route.view !== "session" || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
	const alert = core.alertOf(route.key);
	if (!alert) return;
	event.preventDefault();
	core.openAlert(alert);
}, true);
const router = createRouter((route) => core.route(route));
const stream = createStream({
	open,
	now: Date.now,
	setTimeout: (run, ms) => window.setTimeout(run, ms),
	clearTimeout: (id) => window.clearTimeout(id),
	random: Math.random,
	hidden: () => document.hidden,
	onNet: (net) => (core.snapshot(net), backCheck(net)),
	onStatus: report,
	replaced: () => fetch("./", { cache: "no-store" }).then((r) => r.status === 403),
});
const resume = () => stream.resume();
const connect = mountConnect(resume); // the overlay while the page has no live state (before the first snapshot, and while the stream reconnects)
document.addEventListener("visibilitychange", () => {
	page.pause(document.hidden);
	zen?.visible(!document.hidden);
	if (document.hidden) return stream.hide();
	core.wake();
	withFocus((f) => f.wake());
	resume();
});
// Escape (pagecore.ts): in Zen the layer takes it first, in the capture phase.
addEventListener("keydown", (event) => core.escape(event, true), true);
addEventListener("keydown", (event) => core.escape(event, false));
mountHotkeys(core.hotkey, core.modal, window, core.keys); // the keymap (hotkeys.ts): Space opens the next alert, F enlarges the top dialog; in Zen Enter and Space end the pause; nothing before the layer has loaded
// The gear is a link to the settings page; on the page it leaves it, as Escape does.
el("prefs").addEventListener("click", (event) => core.current.view === "settings" && (event.preventDefault(), leaveSettings()));
// A pair request waits while the Same Wi-Fi tab is not open: a header notice that opens the settings page on that tab (this computer's page only).
if (phoneOk) void import("./lanwait.ts").then(({ mountLanWait }) => mountLanWait(el("lan-wait") as HTMLButtonElement, () => openSection("wifi"), undefined, core.pairing));
// The phone's quick-switch drawer (drawer.ts, swipe.ts): its own chunk, fetched where there is a touch screen or a narrow window, now or once the window narrows.
let drawer: Drawer | undefined;
const touchy = matchMedia("(pointer: coarse), (max-width: 640px)");
const loadDrawer = () => void import("./drawer.ts").then(({ mountDrawer }) => ((drawer ??= mountDrawer(core.noDrawer)), core.latest && drawer.net(core.latest), drawer.route(core.current)));
if (touchy.matches) loadDrawer();
else touchy.addEventListener("change", () => touchy.matches && !drawer && loadDrawer(), { once: true });
mountQuit({ route: () => netOf(core.current), net: () => core.latest, go: (route) => router.go(route) });
el("stashed-pop").addEventListener("toggle", (e) => (e as ToggleEvent).newState === "open" && hang(el("stashed-pop"), el("stashed")));
// The opening buttons on the map and in a base (data-open with data-ws and data-tab) open their tile, read against the newest net.
document.addEventListener("click", (event) => {
	const button = (event.target as Element | null)?.closest?.<HTMLElement>("button[data-open]");
	if (button) void import("./spawn.ts").then(({ openingOf, spawnTile }) => {
		const opening = openingOf(button, core.latest?.bases ?? []);
		if (opening) openTile(spawnTile(opening, (ws, key, tile) => (panels?.tiles.close(tile), core.openSession(ws, key))), true);
	});
});
// The yard (yard.ts, with the model in trains.ts) is a chunk of its own, fetched the first time a base's chip, the header's chip or an integrator's card opens it (data-yard names the projects).
let yard: ReturnType<typeof import("./yard.ts").mountYard> | undefined;
document.addEventListener("click", (event) => {
	const opener = (event.target as Element | null)?.closest?.<HTMLElement>("[data-yard]");
	if (opener) void import("./yard.ts").then(({ mountYard }) => ((yard ??= mountYard()), core.latest && yard.net(core.latest), yard.open((opener.dataset.yard ?? "").split(" ").filter(Boolean), opener)));
});
for (const event of ["focus", "pageshow", "online"]) window.addEventListener(event, () => !document.hidden && resume());
report(CONNECTING);
core.route(router.route());
core.sync(); // a page that opens in Zen
stream.start();
started = true;
