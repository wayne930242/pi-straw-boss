import type { Mark } from "../src/dashboard.ts";
import type { Base, Net, Unit } from "../src/net.ts";
import type { Chat, Data, HistoryEvent, Who } from "./chat.ts";
import { mountAsk } from "./ask.ts";
import { mountComposer, postTo } from "./composer.ts";
import type { Tile } from "./layer.ts";
import { aim, doing, fillPlate, html, LABEL, mark, PLATE, sync, text, urgent } from "./render.ts";
import type { Route } from "./router.ts";

// The focus views, a separate chunk loaded on the first route that is not the map. The workspace route is its base zoomed in: the
// tower, each tab as a squad of unit tokens, subagents tethered under their launcher, outposts, and the workspace's other pi panes as
// unaligned units. The session route is the unit's comms log (chat.ts, its own chunk) over the composer (composer.ts), with its dossier in the
// side column. Both are drawn in place with the map's keyed `sync` and unit plates, so state changes animate the same way on every route.

export interface FocusDeps { data(key: string): Data; restart(): void; openTile(tile: Tile, focus?: boolean): void; online(): boolean }
type Found = { u: Who & { subs: Unit[] }; base: Base; squad?: string; launcher?: Unit };
const MAX_QUEUE = 200;

export function locate(net: Net | undefined, key: string): Found | undefined {
	for (const base of net?.bases ?? []) {
		if (base.tower?.key === key) return { u: { key, name: base.tower.name, role: "tower", mark: base.tower.mark, control: base.tower.control, pending: base.tower.pending, subs: [] }, base };
		for (const [squad, units] of [...base.tabs.map((t) => [t.label, t.units] as const), [undefined, base.outside] as const])
			for (const u of units) {
				if (u.key === key) return { u, base, squad };
				const sub = u.subs.find((s) => s.key === key);
				if (sub) return { u: sub, base, squad, launcher: u };
			}
	}
}

const tokenEl = () => html(`<a class="token">${PLATE}<span class="name"></span><span class="line"><em class="role"></em><span class="note"></span></span></a>`);
function fillToken(el: HTMLElement, u: { key?: string; name: string; role: string; mark: Mark; note?: string }, ws: string) {
	aim(el, u.key ? { view: "session", ws, key: u.key } : undefined);
	el.toggleAttribute("hidden", false);
	el.toggleAttribute("data-alert", Boolean(u.key) && urgent(u.mark));
	mark(el, u.mark);
	fillPlate(el.querySelector(".plate")!, u.role, u.mark);
	text(el, ".name", u.name);
	text(el, ".role", u.role === "outside" ? "unaligned" : u.role);
	text(el, ".note", doing(u.note, u.mark));
}
const colEl = () => html(`<div class="col"><a class="token">${PLATE}<span class="name"></span><span class="line"><em class="role"></em><span class="note"></span></span></a><div class="say"><p></p></div><div class="drones"></div></div>`);
const ZOOM = `<div class="zoom-in"><header class="base keep"><a class="tower big"><i class="sweep"></i><i class="pulse"></i><svg><use href="#i-tower"/></svg><b class="badge"></b></a><div class="title"><span class="crown"><svg><use href="#i-crown"/></svg>head tower</span><h2></h2><p></p></div><dl class="tally"><div><dt>Squads</dt><dd></dd></div><div><dt>Units</dt><dd></dd></div><div data-mark="working"><dt>Working</dt><dd></dd></div><div data-mark="waiting"><dt>Waiting</dt><dd></dd></div></dl></header><div class="squads"></div><div class="camps"><section class="tab squad camp" data-group="outposts"><h3><svg><use href="#i-outpost"/></svg><b>Outposts</b><small></small></h3><div class="formation"></div></section><section class="tab squad camp" data-group="outside"><h3><svg><use href="#i-outside"/></svg><b>Outside the net</b><small>unaligned pi panes</small></h3><div class="formation"></div></section></div><p class="lost" hidden></p></div>`;
const DOSSIER = `<div class="dossier-in"><span class="tag">unit dossier</span><div class="portrait">${PLATE}</div><h3></h3><p class="d-line"><em class="role"></em> <span class="state"></span></p><p class="d-note" hidden></p><dl class="specs"></dl><div class="d-drones" hidden><h4>Dispatched</h4><div class="formation"></div></div></div>`;
const COMMS = `<div class="comms-in"><header class="comms-head"><span class="logo"><svg><use href="#i-comms"/></svg></span><div><h2><small>comms</small> <span></span></h2><p></p></div><span class="chan link" data-state="live"><i></i><b>channel open</b></span></header><div class="chat-root"></div><div class="ask-root"></div><div class="composer-root"></div></div>`;

export function mountFocus({ data, restart, openTile, online }: FocusDeps) {
	const $ = (id: string) => document.getElementById(id)!;
	const [wsView, sessionView, dossier] = ["ws-view", "session-view", "dossier"].map($) as HTMLElement[];
	let route: Route = { view: "map" }, net: Net | undefined, cards: Record<string, string> = {}, chat: Chat | undefined, queue: HistoryEvent[] = [], stale = false;
	let info: HistoryEvent | undefined, model: string | undefined, ctx: number | undefined, entering = 0, composer: ReturnType<typeof mountComposer> | undefined, asker: ReturnType<typeof mountAsk> | undefined;
	const ws = () => (route.view === "map" ? "" : route.ws);
	const linkTo = (r: Route, label: string) => {
		const a = document.createElement("a");
		aim(a, r);
		a.textContent = label;
		return a;
	};

	/** The location bar under the HUD: the net, the base, the unit, each a link one level up. */
	function crumbs() {
		const part = (tag: "a" | "b" | "span", label: string, to?: Route) => {
			const node = document.createElement(tag);
			node.textContent = label;
			if (to) aim(node, to);
			return node;
		};
		const nav = $("crumbs"), r = route;
		if (r.view === "map") return nav.replaceChildren(part("b", "Straw Net"), part("span", "all bases"));
		const label = net?.bases.find((b) => b.id === r.ws)?.label ?? r.ws, name = r.view === "session" ? (locate(net, r.key)?.u.name ?? info?.name ?? r.key) : "";
		nav.replaceChildren(part("a", "Straw Net", { view: "map" }), r.view === "workspace" ? part("b", label) : part("a", label, { view: "workspace", ws: r.ws }), ...(name ? [part("b", name)] : []));
	}
	/** Into a base the view zooms out of the base's spot on the map; into a session it slides in; going up it settles back. */
	function entrance(next: Route, before: Route, from?: DOMRect) {
		const depth = (r: Route) => ["map", "workspace", "session"].indexOf(r.view);
		const kind = depth(next) < depth(before) ? "enter-back" : next.view === "workspace" && from ? "enter-zoom" : next.view === "session" && before.view !== "session" ? "enter-slide" : "";
		const view = $({ map: "map", workspace: "ws-view", session: "session-view" }[next.view]);
		if (!kind) return;
		if (from) {
			const box = view.getBoundingClientRect();
			view.style.setProperty("--ox", `${Math.round(from.x + from.width / 2 - box.x)}px`);
			view.style.setProperty("--oy", `${Math.round(from.y + from.height / 2 - box.y)}px`);
		}
		view.classList.remove("enter-zoom", "enter-slide", "enter-back");
		void view.offsetWidth;
		view.classList.add(kind);
		setTimeout(() => view.classList.remove(kind), 700);
	}

	function drawWorkspace() {
		if (!wsView.firstElementChild) wsView.append(html(ZOOM));
		const root = wsView.firstElementChild as HTMLElement, base = net?.bases.find((b) => b.id === ws());
		const lost = root.querySelector<HTMLElement>(".lost")!;
		lost.hidden = Boolean(base);
		lost.textContent = net ? "This workspace is not part of the net." : "Waiting for the net…";
		root.classList.toggle("void", !base);
		if (!base) return;
		const keep = root.querySelector<HTMLElement>(".keep")!;
		mark(keep, base.mark);
		keep.classList.toggle("head", base.head);
		const tower = root.querySelector<HTMLElement>(".tower")!;
		tower.classList.toggle("ghost", !base.tower);
		mark(tower, base.tower?.mark ?? "unknown");
		aim(tower, base.tower ? { view: "session", ws: base.id, key: base.tower.key } : undefined);
		tower.toggleAttribute("hidden", false);
		tower.toggleAttribute("data-alert", Boolean(base.tower && urgent(base.tower.mark)));
		text(root, "h2", base.label);
		text(root, ".title p", base.tower ? `control tower · ${LABEL[base.tower.mark]}` : "no tower yet");
		const all = base.tabs.flatMap((t) => t.units.flatMap((u) => [u, ...u.subs]));
		[base.tabs.length, all.length, all.filter((u) => u.mark === "working").length, all.filter((u) => u.mark === "waiting").length].forEach((n, i) => (root.querySelectorAll("dd")[i]!.textContent = String(n)));
		const fillCol = (col: HTMLElement, u: Unit) => {
			mark(col, u.mark);
			fillToken(col.querySelector(".token")!, u, base.id);
			const say = col.querySelector<HTMLElement>(".say")!, line = cards[u.key] ?? "";
			say.hidden = !line;
			text(say, "p", line);
			sync(col.querySelector(".drones")!, u.subs, tokenEl, (el, s) => (el.classList.add("drone"), fillToken(el, s, base.id)));
		};
		sync(root.querySelector(".squads")!, base.tabs, () => html(`<section class="tab squad"><h3><i class="flag"></i><b></b><small></small></h3><div class="formation"></div></section>`), (el, t) => {
			text(el, "h3 b", `squad ${t.label}`);
			const busy = t.units.flatMap((u) => [u, ...u.subs]);
			text(el, "h3 small", `${busy.length} unit${busy.length === 1 ? "" : "s"}`);
			mark(el, (["waiting", "error", "working"] as const).find((m) => busy.some((u) => u.mark === m)) ?? "idle");
			sync(el.querySelector(".formation")!, t.units, colEl, fillCol);
		});
		const camp = (group: string, list: { id: string; key?: string; name: string; role: string; mark: Mark; note?: string }[]) => {
			const el = root.querySelector<HTMLElement>(`[data-group="${group}"]`)!;
			el.hidden = !list.length;
			sync(el.querySelector(".formation")!, list, tokenEl, (t, u) => fillToken(t, u, base.id));
		};
		camp("outposts", base.outposts.map((o) => ({ id: o.id, name: o.label, role: "outpost", mark: o.mark, note: o.mark === "unknown" ? "no agent running" : undefined })));
		camp("outside", base.outside);
	}

	function drawDossier() {
		if (route.view !== "session") return;
		if (!dossier.firstElementChild) dossier.append(html(DOSSIER));
		const root = dossier.firstElementChild as HTMLElement, hit = locate(net, route.key), u = hit?.u, m = u?.mark ?? "unknown";
		mark(root, m);
		fillPlate(root.querySelector(".plate")!, u?.role ?? info?.role ?? "member", m);
		text(root, "h3", u?.name ?? info?.name ?? route.key);
		text(root, ".role", u?.role === "outside" ? "unaligned" : (u?.role ?? info?.role ?? "session"));
		text(root, ".state", u ? doing(u.note, m) : "not in the net");
		const note = root.querySelector<HTMLElement>(".d-note")!, state = info?.state;
		note.hidden = state !== "recent" && state !== "unknown";
		note.replaceChildren(state === "unknown" ? "Not in the net (it may have ended more than ten minutes ago)." : "No longer live; its history stays readable for ten minutes.");
		if (info?.successor) note.append(" Now: ", linkTo({ view: "session", ws: ws(), key: info.successor }, locate(net, info.successor)?.u.name ?? "the new session"));
		const rows: [string, string | Node | undefined][] = [
			["model", model], ["context", ctx ? `${ctx.toLocaleString()} tokens` : undefined], ["directory", info?.header?.cwd],
			["base", hit && linkTo({ view: "workspace", ws: hit.base.id }, hit.base.label)], ["squad", hit?.squad],
			["launcher", hit?.launcher && linkTo({ view: "session", ws: hit.base.id, key: hit.launcher.key }, hit.launcher.name)],
			["unreadable", info?.unreadable ? `${info.unreadable} entr${info.unreadable === 1 ? "y" : "ies"}` : undefined],
		];
		root.querySelector(".specs")!.replaceChildren(...rows.filter(([, v]) => v).map(([k, v]) => {
			const row = html(`<div><dt></dt><dd></dd></div>`);
			row.firstElementChild!.textContent = k;
			row.lastElementChild!.append(v!);
			return row;
		}));
		const drones = root.querySelector<HTMLElement>(".d-drones")!;
		drones.hidden = !u?.subs.length;
		sync(drones.querySelector(".formation")!, (u?.subs ?? []).map((s) => ({ ...s, id: s.key })), tokenEl, (el, s) => (el.classList.add("drone"), fillToken(el, s, ws())));
		// The comms header and the live line follow the same unit.
		const head = sessionView.querySelector<HTMLElement>(".comms-head");
		if (head) {
			text(head, "h2 span", u?.name ?? info?.name ?? "");
			text(head, "p", [hit?.base.label, hit?.squad && `squad ${hit.squad}`].filter(Boolean).join(" · "));
			const chan = head.querySelector<HTMLElement>(".chan")!, open = state === "live" || (!state && u);
			chan.dataset.state = open ? "live" : "closed";
			text(chan, "b", open ? "channel open" : state === "recent" ? "channel closed" : "no channel");
		}
		chat?.setLive(m === "working" ? `${doing(u!.note, m)}` : urgent(m) ? LABEL[m] : "", m);
		composer?.update({ name: u?.name ?? info?.name ?? route.key, control: Boolean(u?.control), live: state ? state === "live" : Boolean(u), mark: m, online: online() });
		asker?.update(u?.pending, m === "waiting" && Boolean(u?.control) && online()); // its question, read-only above the composer
	}
	/** Focus that fell to the page (the dialog that opened this route closed, its link gone) lands in the comms: the box, or the log on a touch screen. */
	const claim = () => setTimeout(() => route.view === "session" && (document.activeElement ?? document.body) === document.body && (matchMedia("(pointer: fine)").matches && composer?.ready() ? composer.box : chat?.log)?.focus({ preventScroll: true }));

	async function enter(key: string) {
		const turn = ++entering, { mountChat } = await import("./chat.ts");
		if (turn !== entering || route.view !== "session") return;
		sessionView.replaceChildren(html(COMMS));
		const who = () => locate(net, key)?.u ?? { key, name: info?.name ?? key, role: info?.role ?? "member", mark: "unknown" as Mark };
		const link = (name: string) => {
			const hit = locate(net, key), sub = hit?.u.subs.find((s) => s.name === name) ?? net?.bases.flatMap((b) => [...b.tabs.flatMap((t) => t.units), ...b.outside]).find((x) => x.name === name);
			return sub && linkTo({ view: "session", ws: locate(net, sub.key)?.base.id ?? ws(), key: sub.key }, name);
		};
		chat = mountChat(sessionView.querySelector(".chat-root")!, data(key), { who, link, openTile });
		const send = data(key).post ?? postTo(key);
		[composer, asker] = [mountComposer(sessionView.querySelector(".composer-root")!, key, send), mountAsk(sessionView.querySelector(".ask-root")!, () => send("focus", {}))];
		chat.reveal(route.at);
		queue.splice(0).forEach(apply);
		(drawDossier(), claim());
	}
	function apply(e: HistoryEvent) {
		chat?.apply(e);
		for (const it of e.items ?? []) if (it.kind === "assistant") [model, ctx] = [it.model ?? model, it.ctx ?? ctx];
	}
	const draw = () => (crumbs(), route.view === "workspace" ? drawWorkspace() : drawDossier());
	return {
		locate: (key: string) => locate(net, key),
		show(next: Route, before: Route, from?: DOMRect) {
			const [key, at] = route.view === "session" ? [route.key, route.at] : [];
			if (next.view !== "workspace" || route.view !== "workspace" || next.ws !== route.ws) cards = {};
			route = next;
			wsView.hidden = next.view !== "workspace";
			sessionView.hidden = dossier.hidden = next.view !== "session";
			if (next.view === "session" && next.key !== key) {
				[chat, composer, asker, info, model, ctx, queue, stale] = [undefined, undefined, undefined, undefined, undefined, undefined, [], false];
				sessionView.replaceChildren(html(`<p class="lost">Opening the channel…</p>`));
				void enter(next.key);
			} else if (next.view === "session" && next.at !== at) (chat?.reveal(next.at), claim());
			else if (next.view !== "session") {
				entering++;
				chat = composer = asker = undefined;
			}
			draw();
			if (next !== before) entrance(next, before, from);
		},
		net(next: Net) {
			net = next;
			if (route.view !== "map") draw();
		},
		cards(next: Record<string, string>) {
			cards = { ...cards, ...next };
			if (route.view === "workspace") drawWorkspace();
		},
		history(e: HistoryEvent) {
			if (route.view !== "session" || e.key !== route.key) return;
			info = { ...info, ...e, items: undefined };
			if (e.reset) [model, ctx] = [undefined, undefined];
			if (document.hidden) return queue.length < MAX_QUEUE ? void queue.push(e) : void (stale = true);
			chat ? apply(e) : queue.push(e);
			drawDossier();
		},
		/** The page is visible again: replay what waited, or ask for a fresh history when too much did. */
		wake() {
			if (stale) return (stale = false), (queue = []), restart();
			queue.splice(0).forEach((e) => chat && apply(e));
			draw();
		},
	};
}
