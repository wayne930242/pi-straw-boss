import type { Mark } from "../src/dashboard.ts";
import type { Base, Net, Queued, Unit } from "../src/net.ts";
import type { Monitor } from "../src/monitors.ts";
import type { Todo } from "../src/items.ts";
import type { Chat, Data, HistoryEvent, Who } from "./chat.ts";
import { mountAsk } from "./ask.ts";
import { mountComposer, postTo } from "./composer.ts";
import { docFor, docList, docTile, shelve } from "./doc.ts";
import type { Tile } from "./layer.ts";
import { m } from "./paraglide/messages.js";
import { aim, aimOpening, doing, fillPlate, html, LABEL, mark, PLATE, roleName, sync, text, urgent } from "./render.ts";
import type { Route } from "./router.ts";

// The focus views, a separate chunk loaded on the first route that is not the map. The workspace route is its base zoomed in: the
// tower, each tab as a squad of unit tokens, subagents tethered under their launcher, outposts, and the workspace's other pi panes as
// unaligned units. The session route is the unit's comms log (chat.ts, its own chunk) over the composer (composer.ts), with its dossier in the
// side column. Both are drawn in place with the map's keyed `sync` and unit plates, so state changes animate the same way on every route.

export interface FocusDeps { data(key: string): Data; restart(): void; openTile(tile: Tile, focus?: boolean): void; embedTerminal(key: string, name: string, host: HTMLElement): Promise<() => void>; online(): boolean }
type Found = { u: Who & { subs: Unit[] }; base: Base; squad?: string; launcher?: Unit };
const MAX_QUEUE = 200;

export function locate(net: Net | undefined, key: string): Found | undefined {
	for (const base of net?.bases ?? []) {
		if (base.tower?.key === key) return { u: { key, name: base.tower.name, role: "tower", mark: base.tower.mark, control: base.tower.control, pending: base.tower.pending, docs: base.tower.docs, docsCut: base.tower.docsCut, subs: [] }, base };
		for (const [squad, units] of [...base.tabs.map((t) => [t.label, t.units] as const), [undefined, base.outside] as const])
			for (const u of units) {
				if (u.key === key) return { u, base, squad };
				const sub = u.subs.find((s) => s.key === key);
				if (sub) return { u: sub, base, squad, launcher: u };
			}
	}
}

const tokenEl = () => html(`<a class="token">${PLATE}<span class="name"></span><span class="line"><em class="role"></em><span class="note"></span></span></a>`);
function fillToken(el: HTMLElement, u: { key?: string; name: string; role: string; mark: Mark; note?: string; docs?: { onScreen: boolean }[] }, ws: string) {
	aim(el, u.key ? { view: "session", ws, key: u.key } : undefined);
	el.toggleAttribute("hidden", false);
	el.toggleAttribute("data-alert", Boolean(u.key) && urgent(u.mark));
	mark(el, u.mark);
	fillPlate(el.querySelector(".plate")!, u.role, u.mark, u.docs);
	text(el, ".name", u.name);
	text(el, ".role", roleName(u.role));
	text(el, ".note", doing(u.note, u.mark));
}
const colEl = () => html(`<div class="col"><a class="token">${PLATE}<span class="name"></span><span class="line"><em class="role"></em><span class="note"></span></span></a><div class="say"><p></p></div><div class="drones"></div></div>`);
const ZOOM = () => `<div class="zoom-in"><header class="base keep"><a class="tower big"><i class="sweep"></i><i class="pulse"></i><svg><use href="#i-tower"/></svg><b class="badge"></b></a><div class="title"><span class="crown"><svg><use href="#i-crown"/></svg>${m.head_tower()}</span><h2></h2><p></p></div><dl class="tally"><div><dt>${m.squads()}</dt><dd></dd></div><div><dt>${m.units()}</dt><dd></dd></div><div data-mark="working"><dt>${m.stat_working()}</dt><dd></dd></div><div data-mark="waiting"><dt>${m.stat_waiting()}</dt><dd></dd></div></dl></header><div class="spawn-btns"><button type="button" class="pair-btn"></button></div><div class="squads"></div><div class="camps"><section class="tab squad camp" data-group="outposts"><h3><svg><use href="#i-outpost"/></svg><b>${m.outposts()}</b><small></small></h3><div class="formation"></div></section><section class="tab squad camp" data-group="outside"><h3><svg><use href="#i-outside"/></svg><b>${m.outside_net()}</b><small>${m.outside_note()}</small></h3><div class="formation"></div></section></div><p class="lost" hidden></p></div>`;
const DOSSIER = () => `<div class="dossier-in"><span class="tag">${m.unit_dossier()}</span><div class="portrait">${PLATE}</div><h3></h3><p class="d-line"><em class="role"></em> <span class="state"></span></p><p class="d-note" hidden></p><dl class="specs"></dl><div class="d-docs" hidden><h4>${m.documents()}</h4><div class="d-doc-list"></div><p class="d-docs-cut" hidden>${m.docs_cut()}</p></div><div class="d-drones" hidden><h4>${m.dispatched()}</h4><div class="formation"></div></div></div>`;
const COMMS = () => `<div class="comms-in"><header class="comms-head"><a class="head-back" aria-label="${m.back()}">‹</a><span class="logo"><svg><use href="#i-comms"/></svg></span><div class="head-id"><h2><small>${m.comms()}</small> <span></span></h2><p></p></div><div class="modes" role="group"><button type="button" data-mode="chat" aria-pressed="true">${m.comms()}</button><button type="button" data-mode="term" aria-pressed="false">${m.terminal()}</button></div><span class="chan link" data-state="live"><i></i><b>${m.channel_open()}</b></span></header><div class="chat-root"></div><div class="queue-list" hidden></div><details class="todos" hidden><summary><b></b><span></span></summary><ol></ol></details><details class="monitors" hidden><summary><b></b><span></span></summary><ul></ul></details><div class="ask-root"></div><div class="composer-root"></div><div class="term-root" hidden></div></div>`;

export function mountFocus({ data, restart, openTile, embedTerminal, online }: FocusDeps) {
	const $ = (id: string) => document.getElementById(id)!;
	const [wsView, sessionView, dossier] = ["ws-view", "session-view", "dossier"].map($) as HTMLElement[];
	let route: Route = { view: "map" }, net: Net | undefined, cards: Record<string, string> = {}, chat: Chat | undefined, queue: HistoryEvent[] = [], stale = false;
	const seen = new Map<string, Set<string>>(); // each unit's documents at the last snapshot: what is new arrives
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
		if (r.view === "map") return nav.replaceChildren(part("b", "Straw Net"), part("span", m.all_bases()));
		const label = net?.bases.find((b) => b.id === r.ws)?.label ?? r.ws, name = r.view === "session" ? (locate(net, r.key)?.u.name ?? info?.name ?? r.key) : "";
		// A subagent sits under the session that launched it, and that one under its own launcher.
		const chain: { key: string; name: string }[] = [];
		for (let f = r.view === "session" ? locate(net, r.key) : undefined, n = 0; f?.launcher && n < 8; f = locate(net, f.launcher.key), n++) chain.unshift(f.launcher);
		const parts = [part("a", "Straw Net", { view: "map" }), r.view === "workspace" ? part("b", label) : part("a", label, { view: "workspace", ws: r.ws }), ...chain.map((u) => part("a", u.name, { view: "session", ws: r.ws, key: u.key })), ...(name ? [part("b", name)] : [])];
		// On a narrow screen the levels between the net and the last two fold into "…", which unfolds them.
		parts.slice(1, -2).forEach((p) => p.classList.add("mid"));
		const more = parts.length > 3 ? [Object.assign(part("span", "…"), { className: "crumb-more", role: "button", tabIndex: 0, onclick: () => nav.classList.toggle("open") })] : [];
		nav.classList.remove("open");
		nav.replaceChildren(parts[0]!, ...more, ...parts.slice(1));
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
		if (!wsView.firstElementChild) wsView.append(html(ZOOM()));
		const root = wsView.firstElementChild as HTMLElement, base = net?.bases.find((b) => b.id === ws());
		const lost = root.querySelector<HTMLElement>(".lost")!;
		lost.hidden = Boolean(base);
		lost.textContent = net ? m.lost_workspace() : m.waiting_net();
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
		aimOpening(root.querySelector(".spawn-btns button")!, base);
		text(root, ".title p", base.tower ? m.control_tower({ state: LABEL[base.tower.mark]() }) : m.no_tower());
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
		sync(root.querySelector(".squads")!, base.tabs, () => html(`<section class="tab squad"><h3><i class="flag"></i><b></b><small></small><button type="button" class="tab-add"></button></h3><div class="formation"></div></section>`), (el, t) => {
			text(el, "h3 b", m.squad_label({ label: t.label }));
			aimOpening(el.querySelector(".tab-add")!, base, t.id);
			const busy = t.units.flatMap((u) => [u, ...u.subs]);
			text(el, "h3 small", m.unit_count({ count: busy.length }));
			mark(el, (["waiting", "error", "working"] as const).find((m) => busy.some((u) => u.mark === m)) ?? "idle");
			sync(el.querySelector(".formation")!, t.units, colEl, fillCol);
		});
		const camp = (group: string, list: { id: string; key?: string; name: string; role: string; mark: Mark; note?: string }[]) => {
			const el = root.querySelector<HTMLElement>(`[data-group="${group}"]`)!;
			el.hidden = !list.length;
			sync(el.querySelector(".formation")!, list, tokenEl, (t, u) => fillToken(t, u, base.id));
		};
		camp("outposts", base.outposts.map((o) => ({ id: o.id, name: o.label, role: "outpost", mark: o.mark, note: o.mark === "unknown" ? m.no_agent() : undefined })));
		camp("outside", base.outside);
	}

	function drawDossier() {
		if (route.view !== "session") return;
		if (!dossier.firstElementChild) dossier.append(html(DOSSIER()));
		const root = dossier.firstElementChild as HTMLElement, hit = locate(net, route.key), u = hit?.u, mk = u?.mark ?? "unknown";
		mark(root, mk);
		fillPlate(root.querySelector(".plate")!, u?.role ?? info?.role ?? "member", mk);
		text(root, "h3", u?.name ?? info?.name ?? route.key);
		text(root, ".role", roleName(u?.role ?? info?.role ?? "session"));
		text(root, ".state", u ? doing(u.note, mk) : m.not_in_net());
		const note = root.querySelector<HTMLElement>(".d-note")!, state = info?.state;
		note.hidden = state !== "recent" && state !== "unknown";
		note.replaceChildren(state === "unknown" ? m.note_unknown() : m.note_recent());
		if (info?.successor) note.append(` ${m.successor()} `, linkTo({ view: "session", ws: ws(), key: info.successor }, locate(net, info.successor)?.u.name ?? m.new_session()));
		const rows: [string, string | Node | undefined][] = [
			[m.spec_model(), model], [m.spec_context(), ctx ? m.tokens({ count: ctx.toLocaleString() }) : undefined], [m.spec_directory(), info?.header?.cwd],
			[m.spec_base(), hit && linkTo({ view: "workspace", ws: hit.base.id }, hit.base.label)], [m.spec_squad(), hit?.squad],
			[m.spec_launcher(), hit?.launcher && linkTo({ view: "session", ws: hit.base.id, key: hit.launcher.key }, hit.launcher.name)],
			[m.spec_unreadable(), info?.unreadable ? m.entry_count({ count: info.unreadable }) : undefined],
		];
		root.querySelector(".specs")!.replaceChildren(...rows.filter(([, v]) => v).map(([k, v]) => {
			const row = html(`<div><dt></dt><dd></dd></div>`);
			row.firstElementChild!.textContent = k;
			row.lastElementChild!.append(v!);
			return row;
		}));
		const key = route.key, name = u?.name ?? info?.name ?? key; // the header's Comms | Terminal switch shows the pane's screen
		sessionView.querySelector<HTMLElement>(".modes")?.toggleAttribute("hidden", !u?.control);
		docList(root.querySelector(".d-docs")!, u?.docs, u?.docsCut, (card) => openTile(docTile(name, card)));
		chat?.docs();
		const drones = root.querySelector<HTMLElement>(".d-drones")!;
		drones.hidden = !u?.subs.length;
		sync(drones.querySelector(".formation")!, (u?.subs ?? []).map((s) => ({ ...s, id: s.key })), tokenEl, (el, s) => (el.classList.add("drone"), fillToken(el, s, ws())));
		// The comms header and the live line follow the same unit.
		const head = sessionView.querySelector<HTMLElement>(".comms-head");
		if (head) {
			text(head, "h2 span", u?.name ?? info?.name ?? "");
			text(head, "p", [hit?.base.label, hit?.squad && m.squad_label({ label: hit.squad })].filter(Boolean).join(" · "));
			const chan = head.querySelector<HTMLElement>(".chan")!, open = state === "live" || (!state && u);
			chan.dataset.state = open ? "live" : "closed";
			text(chan, "b", open ? m.channel_open() : state === "recent" ? m.channel_closed() : m.no_channel());
			chan.title = chan.querySelector("b")!.textContent ?? ""; // a phone shows the dot alone
			aim(head.querySelector(".head-back")!, { view: "workspace", ws: ws() }); // a phone's full-screen comms go back with it
		}
		drawTodos(info?.todos);
		drawMonitors(u?.monitors);
		drawQueued(u?.queued);
		chat?.setLive(mk === "working" ? `${doing(u!.note, mk)}` : urgent(mk) ? LABEL[mk]() : "", mk);
		composer?.update({ name: u?.name ?? info?.name ?? route.key, control: Boolean(u?.control), live: state ? state === "live" : Boolean(u), mark: mk, online: online(), answerable: Boolean(u?.pending?.answer) });
		asker?.update(u?.pending, mk === "waiting" && Boolean(u?.control) && online()); // its dialog above the composer, answerable or not
	}
	/** Focus that fell to the page (the dialog that opened this route closed, its link gone) lands in the comms: the box, or the log on a touch screen. */
	const claim = () => setTimeout(() => route.view === "session" && (document.activeElement ?? document.body) === document.body && (matchMedia("(pointer: fine)").matches && composer?.ready() ? composer.box : chat?.log)?.focus({ preventScroll: true }));

	async function enter(key: string) {
		const turn = ++entering, { mountChat } = await import("./chat.ts");
		if (turn !== entering || route.view !== "session") return;
		sessionView.replaceChildren(html(COMMS()));
		const who = () => locate(net, key)?.u ?? { key, name: info?.name ?? key, role: info?.role ?? "member", mark: "unknown" as Mark };
		const link = (name: string) => {
			const hit = locate(net, key), sub = hit?.u.subs.find((s) => s.name === name) ?? net?.bases.flatMap((b) => [...b.tabs.flatMap((t) => t.units), ...b.outside]).find((x) => x.name === name);
			return sub && linkTo({ view: "session", ws: locate(net, sub.key)?.base.id ?? ws(), key: sub.key }, name);
		};
		const opener = (path: string, card = docFor(locate(net, key)?.u.docs, info?.header?.cwd, path)) => card && (() => openTile(docTile(who().name, card)));
		chat = mountChat(sessionView.querySelector(".chat-root")!, data(key), { who, link, docFor: opener });
		const send = data(key).post ?? postTo(key);
		[composer, asker] = [mountComposer(sessionView.querySelector(".composer-root")!, key, send), mountAsk(sessionView.querySelector(".ask-root")!, send, undefined, () => setMode("term"))];
		sessionView.querySelectorAll<HTMLButtonElement>(".modes button").forEach((b) => (b.onclick = () => setMode(b.dataset.mode as "chat" | "term")));
		if (pendingMode === "term") setMode("term");
		pendingMode = undefined;
		chat.reveal(route.at);
		queue.splice(0).forEach(apply);
		(drawDossier(), claim());
	}
	function apply(e: HistoryEvent) {
		chat?.apply(e);
		for (const it of e.items ?? []) if (it.kind === "assistant") [model, ctx] = [it.model ?? model, it.ctx ?? ctx];
	}
	/** What the session's queue holds, under the chat as the bubbles it will become, until a turn takes them. */
	function drawQueued(list: Queued[] | undefined) {
		const box = sessionView.querySelector<HTMLElement>(".queue-list");
		if (!box) return;
		box.hidden = !list?.length;
		const tag = (q: Queued) => Object.assign(document.createElement("b"), { textContent: q.as === "steer" ? m.queued_steer() : m.queued_follow() });
		box.replaceChildren(...(list ?? []).map((q) => {
			const p = document.createElement("p");
			p.append(tag(q), document.createTextNode(q.text));
			return p;
		}));
	}
	/** The session's todo list above the composer: folded to the count and the task in progress, unfolded to every task. */
	function drawTodos(list: Todo[] | null | undefined) {
		const box = sessionView.querySelector<HTMLDetailsElement>(".todos");
		if (!box) return;
		box.hidden = !list?.length;
		if (!list?.length) return;
		const done = list.filter((t) => t.status === "completed").length, now = list.find((t) => t.status === "in_progress");
		text(box, "summary b", m.todos_count({ done, total: list.length }));
		text(box, "summary span", now ? (now.activeForm ?? now.subject) : done === list.length ? m.todos_done() : "");
		box.querySelector("ol")!.replaceChildren(...list.map((t) => Object.assign(document.createElement("li"), { textContent: t.subject, className: t.status })));
	}
	/** The session's background monitors under its todos (read-only: pi-loop-monitor lets nothing else stop one): folded to how many run or failed and the newest running one's last line, unfolded to each with its state, exit code, line count, and last line. */
	function drawMonitors(list: Monitor[] | undefined) {
		const box = sessionView.querySelector<HTMLDetailsElement>(".monitors");
		if (!box) return;
		box.hidden = !list?.length;
		if (!list?.length) return;
		const running = list.filter((x) => x.status === "running"), failed = list.filter((x) => x.status === "error" || x.status === "stale").length;
		box.dataset.failed = String(failed > 0);
		text(box, "summary b", [m.monitors_title(), running.length && m.monitors_running({ count: running.length }), failed && m.monitors_failed({ count: failed })].filter(Boolean).join(" · "));
		text(box, "summary span", running[0] ? (running[0].last ?? running[0].what) : "");
		const state = { running: m.monitor_state_running, done: m.monitor_state_done, error: m.monitor_state_error, stale: m.monitor_state_stale, stopped: m.monitor_state_stopped };
		box.querySelector("ul")!.replaceChildren(...list.map((x) => {
			const li = Object.assign(document.createElement("li"), { className: x.status });
			const meta = [state[x.status](), x.exit !== undefined && m.monitor_exit({ code: x.exit }), m.monitor_lines({ count: x.lines })].filter(Boolean).join(" · ");
			li.append(Object.assign(document.createElement("b"), { textContent: x.what }), Object.assign(document.createElement("small"), { textContent: meta }));
			if (x.last) li.append(Object.assign(document.createElement("code"), { textContent: x.last }));
			return li;
		}));
	}
	/** The session view shows its chat or its terminal, one at a time; the terminal mirrors the pane only while it shows. */
	let unembed: (() => void) | undefined, pendingMode: "term" | undefined, modeTurn = 0;
	function setMode(mode: "chat" | "term") {
		if (route.view !== "session") return;
		const key = route.key, root = sessionView.querySelector<HTMLElement>(".comms-in");
		if (!root) return void (pendingMode = mode === "term" ? "term" : undefined);
		root.querySelectorAll<HTMLButtonElement>(".modes button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === mode)));
		for (const sel of [".chat-root", ".ask-root", ".composer-root"]) root.querySelector<HTMLElement>(sel)!.hidden = mode === "term";
		const host = root.querySelector<HTMLElement>(".term-root")!;
		host.hidden = mode !== "term";
		root.classList.toggle("in-term", mode === "term");
		unembed?.();
		unembed = undefined;
		if (mode !== "term") return claim();
		const turn = ++modeTurn, name = locate(net, key)?.u.name ?? info?.name ?? key;
		// Switching to the terminal gives it the keyboard once, on a desktop (only a desktop's mirror has the text box that takes it).
		void embedTerminal(key, name, host).then((off) => (turn === modeTurn && route.view === "session" && route.key === key ? ((unembed = off), host.querySelector<HTMLElement>(".term-sink")?.focus({ preventScroll: true })) : off()));
	}
	const leaveMode = () => (modeTurn++, unembed?.(), (unembed = undefined));
	const draw = () => (crumbs(), route.view === "workspace" ? drawWorkspace() : drawDossier());
	return {
		/** Shows a session's terminal: its view, in terminal mode (an alert's "terminal" asks for it). */
		terminal(key: string) {
			if (route.view === "session" && route.key === key) setMode("term");
			else pendingMode = "term";
		},
		locate: (key: string) => locate(net, key),
		show(next: Route, before: Route, from?: DOMRect) {
			const [key, at] = route.view === "session" ? [route.key, route.at] : [];
			if (next.view !== "workspace" || route.view !== "workspace" || next.ws !== route.ws) cards = {};
			route = next;
			wsView.hidden = next.view !== "workspace";
			sessionView.hidden = dossier.hidden = next.view !== "session";
			if (next.view !== "session" || next.key !== key) leaveMode();
			if (next.view === "session" && next.key !== key) {
				[chat, composer, asker, info, model, ctx, queue, stale] = [undefined, undefined, undefined, undefined, undefined, undefined, [], false];
				sessionView.replaceChildren(html(`<p class="lost">${m.opening_channel()}</p>`));
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
			shelve(next, seen, route.view === "session" ? route.key : undefined, (unit, card) => openTile(docTile(unit, card), false));
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
