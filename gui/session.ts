import type { Mark } from "../src/netdata.ts";
import type { Chat, Data, Who } from "./chat.ts";
import { answerPost, canAnswer, mountAnswer } from "./answer.ts";
import { drawMonitors, drawQueued, drawTodos, foldQueue, mountQueueEdit, mountQueueFold } from "./bars.ts";
import { mountComposer } from "./composer.ts";
import { docFor, docTile } from "./doc.ts";
import type { Tile } from "./layer.ts";
import { m } from "./sentences.ts"; import { noun } from "./nouns.ts";
import { aimSession } from "./quit.ts"; import { baseTitle, can } from "./boxmodel.ts";
import { aim, aimOpening, html, LABEL, mark, roleWord, text } from "./render.ts";
import { channelOf, locate, type Scene, type Subject, towerBase, wsOf } from "./scene.ts";
import { linkTo } from "./tokens.ts";
import { composerUnit } from "./sessionfacts.ts";
import { fillAllies } from "./towerallies.ts";
import { fillConversation } from "./towerconv.ts";
import { fillMemory } from "./towermemory.ts";
import { fillNotices } from "./towernotes.ts";
import { statusLine } from "./towermodel.ts";
import { termHold } from "./towerturns.ts";
import { h } from "./dom.ts";
import { HEAD_KEY } from "../src/headkey.ts";
import { fillHeadActs } from "./headacts.ts";
import { fillAuto } from "./auto.ts";
import { fillBoard } from "./board.ts";
import { fillHeadAsks, fillHeadLog, fillHeadTitle, headMemory, remember } from "./headpage.ts";
import { fillAskList } from "./asklist.ts";
import { fillRunDialogs } from "./rundialogs.ts";
import { post } from "./post.ts";
import { type Target, targetsOf } from "./targets.ts";
import { mountTarget, type TargetPicker } from "./targetpicker.ts";

// The session route's comms: the header, the log (chat.ts, its own chunk), the bars above the composer, the composer, the question panel, and the
// session's terminal as the other mode. A phone's Info button, in the header, opens the dossier full-screen through `fullScreen`.

const COMMS = () => `<div class="comms-in"><header class="comms-head"><a class="head-back" data-back aria-label="${m.back()}">‹</a><span class="logo"><svg><use class="head-icon" data-icon="comms"/></svg></span><div class="head-id"><h2><small class="head-kicker" data-m="comms">${noun("comms")}</small> <span class="head-title"></span></h2><p class="head-line"></p><div class="allies comms-allies" hidden></div></div><div class="modes" role="group"><button type="button" data-mode="chat" aria-pressed="true" data-m="comms">${noun("comms")}</button><button type="button" data-mode="term" aria-pressed="false">${m.terminal()}</button></div><span class="chan link" data-state="live"><i></i><b>${m.channel_open()}</b></span><button type="button" class="pair-btn head-info">${m.info()}</button><span class="menu head-menu"><button type="button" class="pair-btn menu-btn" popovertarget="head-pop" aria-haspopup="true" aria-label="${m.menu_more()}" title="${m.menu_more()}">⋯</button><div class="menu-pop hud-pop" id="head-pop" popover role="group" aria-label="${m.menu_more()}"><button type="button" class="pair-btn head-main" hidden></button><button type="button" class="pair-btn head-viewer" hidden></button><button type="button" class="quit-btn head-quit" data-close="unit" hidden></button></div></span></header><div class="chat-root"></div><div class="tower-notes"><p class="head-absent" hidden></p><div class="head-auto" hidden></div><section class="boss-asks" hidden></section><details class="head-log" hidden><summary><b></b><span></span></summary><div class="head-asks" role="group"></div></details><details class="head-board" hidden><summary><b></b><i class="board-mini" aria-hidden="true"></i><span></span></summary><div class="board-rows"></div></details><div class="tower-conv" hidden></div><div class="tower-notices"></div><div class="tower-memory" hidden></div></div><div class="queue-bar" hidden><button type="button" class="queue-fold" aria-expanded="false"><b></b></button></div><div class="queue-list" hidden></div><div class="queue-act" hidden><button type="button" class="cmp-alt">${m.queue_edit()}</button></div><details class="todos" hidden><summary><b></b><span></span></summary><ol></ol></details><details class="monitors" hidden><summary><b></b><span></span></summary><ul></ul></details><div class="run-dialogs" role="group" hidden></div><div class="ask-root"></div><div class="head-acts" hidden></div><div class="composer-root"></div><div class="term-root" hidden></div></div>`;

export interface SessionDeps {
	view: HTMLElement; data(key: string): Data; openTile(tile: Tile, focus?: boolean): void; embedTerminal(key: string, name: string, host: HTMLElement): Promise<() => void>; online(): boolean;
	/** Shows or hides the dossier over the comms (a phone's Info). */
	fullScreen(on: boolean): void;
	/** The comms are mounted: the history that waited goes into the log and the views draw. */
	opened(): void;
}

export function mountSession(scene: Readonly<Scene>, { view, data, openTile, embedTerminal, online, fullScreen, opened }: SessionDeps) {
	let chat: Chat | undefined, composer: ReturnType<typeof mountComposer> | undefined, asker: ReturnType<typeof mountAnswer> | undefined, entering = 0;
	let unembed: (() => void) | undefined, pendingMode: "term" | undefined, modeTurn = 0, shown: "chat" | "term" = "chat", held: string | undefined;
	/** What stands where a tower's terminal would be while the sb server's service has no run live (the server answers its keys and mirror with 409): a sentence, and no pad over an empty box. */
	const holdOf = (key: string) => termHold(locate(scene.net, key)?.u.service);
	/** Focus that fell to the page (the dialog that opened this route closed, its link gone) lands in the comms: the box, or the log on a touch screen. */
	const claim = () => setTimeout(() => scene.route.view === "session" && (document.activeElement ?? document.body) === document.body && (matchMedia("(pointer: fine)").matches && composer?.ready() ? composer.box : chat?.log)?.focus({ preventScroll: true }));

	let target: Target | undefined, picker: TargetPicker | undefined;
	/** The note after a direct send: where the line went, and its tower's comms one click away (no navigation by itself). `to` is a workspace id, or the label a typed `@` named. */
	function sentTo(note: HTMLElement, to: string) {
		const base = scene.net?.bases.find((b) => b.id === to) ?? scene.net?.bases.find((b) => b.label === to), name = base?.label ?? to;
		const route = base?.tower ? { view: "session" as const, ws: base.id, key: base.tower.key } : base ? { view: "workspace" as const, ws: base.id } : undefined;
		note.replaceChildren(m.direct_sent({ name }), ...(route ? [" · ", linkTo(route, m.direct_open())] : []));
	}
	async function enter(key: string) {
		const turn = ++entering, { mountChat } = await import("./chat.ts");
		if (turn !== entering || scene.route.view !== "session") return;
		view.replaceChildren(html(COMMS()));
		shown = "chat";
		const who = (): Who => locate(scene.net, key)?.u ?? { key, name: scene.info?.name ?? key, role: scene.info?.role ?? "member", mark: "unknown" as Mark };
		const link = (name: string) => {
			const hit = locate(scene.net, key), sub = hit?.u.subs.find((s) => s.name === name) ?? scene.net?.bases.flatMap((b) => [...b.tabs.flatMap((t) => t.units), ...b.outside]).find((x) => x.name === name);
			return sub && linkTo({ view: "session", ws: locate(scene.net, sub.key)?.base.id ?? wsOf(scene), key: sub.key }, name);
		};
		const opener = (path: string, card = docFor(locate(scene.net, key)?.u.docs, scene.info?.header?.cwd, path)) => card && (() => openTile(docTile(who().name, card)));
		chat = mountChat(view.querySelector(".chat-root")!, data(key), { who, link, docFor: opener, page: true, away: () => !can(locate(scene.net, key)?.base, "input"), net: () => scene.net });
		const raw = answerPost(key, () => data(key).post), headRoute = scene.route.view === "session" && scene.route.ws === HEAD_KEY;
		// The head page's target (docs/specs/2026-11-24-zen-f.md §6): a button before `+` with its list; the target holds for the page, and a direct send stays here with a quiet note linking that tower's comms.
		target = undefined;
		picker = headRoute ? mountTarget({ rows: () => targetsOf(scene.net, [], noun("head_tower")), chosen: () => target?.ws ?? HEAD_KEY, pick: (t) => ((target = t.ws === HEAD_KEY ? undefined : t), composer?.redraw(), composer?.box.focus()) }) : undefined;
		const note = h("p", { class: "direct-note", role: "status" });
		const send: typeof raw = (action, body) => raw(action, body).then((r) => (headRoute && action === "input" && typeof body.to === "string" && r.ok && sentTo(note, body.to), r));
		[composer, asker] = [mountComposer(view.querySelector(".composer-root")!, key, send, undefined, picker ? { target: { button: picker.button, to: () => target?.ws, placeholder: () => (target ? m.placeholder_direct({ name: target.label }) : undefined) } } : {}), mountAnswer(view.querySelector(".ask-root")!, { key, post: send, box: () => Boolean(locate(scene.net, key)?.base.box), show: () => setMode("term") })];
		if (picker) ((view.querySelector(".composer-root .composer") ?? view.querySelector(".composer-root"))!.append(note), view.querySelector(".comms-in")!.append(picker.veil)); // the note at the composer's foot
		mountQueueEdit(view, () => composer?.takeQueue() ?? Promise.resolve());
		mountQueueFold(view);
		view.querySelectorAll<HTMLButtonElement>(".modes button").forEach((b) => (b.onclick = () => setMode(b.dataset.mode as "chat" | "term")));
		view.querySelector<HTMLElement>(".head-info")!.onclick = () => fullScreen(true);
		if (pendingMode === "term") setMode("term");
		pendingMode = undefined;
		chat.reveal(scene.route.at);
		opened();
		claim();
	}
	/** The session view shows its chat or its terminal, one at a time; the terminal mirrors the pane only while it shows. */
	function setMode(mode: "chat" | "term") {
		if (scene.route.view !== "session") return;
		const key = scene.route.key, root = view.querySelector<HTMLElement>(".comms-in");
		if (!root) return void (pendingMode = mode === "term" ? "term" : undefined);
		shown = mode;
		root.querySelectorAll<HTMLButtonElement>(".modes button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === mode)));
		for (const sel of [".chat-root", ".ask-root", ".composer-root"]) {
			const part = root.querySelector<HTMLElement>(sel)!, at = document.activeElement as HTMLElement | null;
			// The terminal has the keys now: whatever the chat held (the composer's box) lets go, or a soft keyboard stays open for a hidden box and keys typed go there.
			if (mode === "term" && at && part.contains(at)) at.blur();
			part.hidden = mode === "term";
		}
		const host = root.querySelector<HTMLElement>(".term-root")!;
		host.hidden = mode !== "term";
		root.classList.toggle("in-term", mode === "term");
		unembed?.();
		unembed = undefined;
		if (mode !== "term") return claim();
		const turn = ++modeTurn, name = locate(scene.net, key)?.u.name ?? scene.info?.name ?? key;
		if ((held = holdOf(key))) return host.replaceChildren(h("p", { class: "term-hold", role: "status" }, held));
		// Switching to the terminal gives it the keyboard once, on a desktop; a phone opens its soft keyboard with the terminal's Keyboard button (a focus without a tap does not open it).
		void embedTerminal(key, name, host).then((off) => (turn === modeTurn && scene.route.view === "session" && scene.route.key === key ? ((unembed = off), matchMedia("(pointer: fine)").matches && host.querySelector<HTMLElement>(".term-sink")?.focus({ preventScroll: true })) : off()));
	}
	return {
		get chat() { return chat; },
		/** A session other than the one shown: the comms start over for `key`. */
		open(key: string) {
			[chat, composer, asker, picker, target] = [undefined, undefined, undefined, undefined, undefined];
			delete view.dataset.role; // the role of the unit before is not this one's until the next draw
			view.replaceChildren(html(`<p class="lost">${m.opening_channel()}</p>`));
			void enter(key);
		},
		/** A route that is not a session: its comms go, since entries that wait hidden with content-visibility keep a page with moving parts producing frames. */
		close() {
			entering++;
			(chat = composer = asker = undefined), (picker = target = undefined), view.replaceChildren();
			delete view.dataset.role;
		},
		reveal(at?: string) {
			chat?.reveal(at);
			claim();
		},
		leaveMode: () => (modeTurn++, unembed?.(), (unembed = undefined)),
		/** Shows the session's terminal: its view, in terminal mode (an alert's "terminal" asks for it). */
		terminal(key: string) {
			if (scene.route.view === "session" && scene.route.key === key) setMode("term");
			else pendingMode = "term";
		},
		/** The header's Comms | Terminal switch, name and channel, then the bars, the live line, and the composer and its question panel, all of the same unit. */
		draw({ u, hit, mk, state, name }: Subject) {
			const isHead = hit?.base.id === HEAD_KEY, headUnit = isHead ? scene.net?.head : undefined, role = u?.role ?? scene.info?.role;
			if (role) view.dataset.role = role; // a theme dresses the page by it (Raven Keep's rooms)
			view.querySelector<HTMLElement>(".modes")?.toggleAttribute("hidden", !u?.control || headUnit?.state === "absent"); // the head has no terminal before it exists
			chat?.docs();
			chat?.box();
			chat?.runs((u?.service?.localRuns ?? []).filter((r) => r.kind === "conversation"));
			const head = view.querySelector<HTMLElement>(".comms-head");
			if (head) {
				mark(head, mk); // the head glows while the unit is commanding
				// An ally run's comms are a unit the net lists only on its tower's chip (src/net.ts): the history names it by its device, and the page says what it is.
				const ally = !u && scene.info?.role === "ally", eventRun = !u && scene.info?.role === "run";
				text(head, "h2 span", ally ? m.ally_run({ device: scene.info?.name ?? "" }) : eventRun ? m.event_run({ id: scene.info?.name ?? "" }) : (u?.name ?? scene.info?.name ?? ""));
				text(head, "p", [(hit && baseTitle(hit.base)) ?? ((ally || eventRun) ? scene.net?.bases.find((b) => b.id === wsOf(scene))?.label : undefined), hit?.squad && m.squad_label({ label: hit.squad }), u?.service && statusLine(u.service, mk, (k) => LABEL[k]()), ally && noun("role_ally"), eventRun && noun("role_run"), u?.duty && roleWord(u.role, u.duty, u.todo?.graph)].filter(Boolean).join(" · "));
				fillAllies(view.querySelector<HTMLElement>(".comms-allies")!, hit?.base.id ?? wsOf(scene), u?.service);
				const chan = head.querySelector<HTMLElement>(".chan")!, kind = channelOf(u, state, ally || eventRun);
				chan.dataset.state = kind === "live" ? "live" : "closed";
				text(chan, "b", { live: m.channel_open, readonly: m.channel_readonly, closed: m.channel_closed, none: m.no_channel }[kind]());
				chan.hidden = headUnit?.state === "absent"; // the first message makes the head: "not open" and "channel open" would contradict
				chan.title = chan.querySelector("b")!.textContent ?? ""; // a phone shows the dot alone
				// A tower's comms open a main in its base (main.ts opens the same tile the map's "+ Main" does); no other unit has the button.
				const add = head.querySelector<HTMLButtonElement>(".head-main")!, base = towerBase(hit);
				add.hidden = !base;
				head.toggleAttribute("data-tower", Boolean(base) || isHead); // a phone puts a tower's + Main and Quit tower behind the `⋯`; any other unit's Quit stays in the row
				if (base) (aimOpening(add, base), (add.title = m.open_main_title({ base: base.label })));
				// Headless runs: a tower has no pane of its own; Open viewer asks the server for a viewer tab on this computer (`ensure-tower {view: true}`; docs/specs/2026-11-23-f-entry.md §2.8).
				const viewer = head.querySelector<HTMLButtonElement>(".head-viewer")!, ws = hit?.base.id;
				viewer.hidden = !base || !u?.service?.headless || Boolean(u.service.viewer) || !online();
				if (!viewer.hidden && ws) [viewer.textContent, viewer.title, viewer.onclick] = [m.tower_open_viewer(), m.tower_open_viewer_title(), () => void post(`tower/${encodeURIComponent(ws)}/viewer`, {}).then((r) => (viewer.title = r.ok ? m.tower_viewer_opened() : String(r.body.reason ?? m.refused({ status: r.status }))))];
				aimSession(head.querySelector(".head-quit")!, hit); // the map's Quit for this unit: the same confirmation, request, and refusals (quit.ts)
				aim(head.querySelector(".head-back")!, isHead ? { view: "map" } : { view: "workspace", ws: wsOf(scene) }); // a phone's full-screen comms go back with it: to the page before, or up when the page opened here
				head.toggleAttribute("data-head", isHead);
				if (headUnit) {
					// The head tower: the crown, its title and state line, and its own Close (head/close, asked once) in place of a tower's Quit (quit.ts).
					fillHeadTitle(view, headUnit);
					const close = head.querySelector<HTMLButtonElement>(".head-quit")!;
					Object.assign(close.dataset, { close: "head", name: noun("head_tower") });
					[close.textContent, close.hidden] = [m.head_close(), true]; // Close lives in the row above the composer (headacts.ts)
				}
			}
			const asks = view.querySelector<HTMLElement>(".head-asks");
			if (asks) (fillHeadAsks(asks, headUnit, scene.net), fillHeadLog(view.querySelector<HTMLElement>(".head-log")!, headUnit, scene.net));
			const bossAsks = view.querySelector<HTMLElement>(".boss-asks");
			if (bossAsks) fillAskList(bossAsks, isHead ? scene.net?.asks : undefined); // every open question to the boss, on the head page (docs/specs/2026-11-28-boss-asks.md)
			const auto = view.querySelector<HTMLElement>(".head-auto");
			if (auto) fillAuto(auto, isHead ? scene.net : undefined); // the head request to start auto mode waits for the boss tap here (docs/specs/2026-11-09-auto-mode.md, D9)
			const board = view.querySelector<HTMLElement>(".head-board");
			if (board) fillBoard(board, isHead ? scene.net : undefined); // the work board is the head page's own (docs/specs/2026-11-09-board-view.md)
			if (headUnit?.said) remember(headUnit.said); // the head page shows its newest words: the header's dot is for what comes after
			const dialogs = view.querySelector<HTMLElement>(".run-dialogs");
			if (dialogs) fillRunDialogs(dialogs, isHead ? HEAD_KEY : hit?.base.id ?? wsOf(scene), scene.info?.dialogs);
			drawTodos(view, scene.info?.todos, { net: scene.net, main: u?.key });
			drawMonitors(view, u?.monitors);
			drawQueued(view, u?.queued, u?.key, Boolean(u?.service));
			foldQueue(view, u?.queued?.length ?? 0);
			const notes = view.querySelector<HTMLElement>(".tower-notices");
			if (notes) (fillHeadActs(view.querySelector<HTMLElement>(".head-acts")!, isHead ? u?.service : undefined, isHead && headUnit?.state !== "absent"), fillConversation(view.querySelector<HTMLElement>(".tower-conv")!, hit?.base.id ?? wsOf(scene), isHead ? undefined : u?.service), fillNotices(notes, hit?.base.id ?? wsOf(scene), u?.service, u?.key, (k) => locate(scene.net, k)?.base.id, Boolean(hit?.base.box)), fillMemory(view.querySelector<HTMLElement>(".tower-memory")!, hit?.base.id ?? wsOf(scene), isHead ? headMemory(u?.service?.memory) : u?.service?.memory)); // the head's page is the conversation and its composer: its actions sit beside the composer (headacts.ts), it has no conversation line and its memory shows only when there is something to read (headpage.ts)
			if (shown === "term" && holdOf(u?.key ?? "") !== held) setMode("term"); // the tower woke or went to stand by: the terminal or its sentence changes
			if (picker) (picker.button.hidden = !(isHead && u?.service?.headless), picker.button.hidden && ((target = undefined), picker.close(false)), picker.sync()); // headless runs only: with them off the server refuses `to`, and there is no button
			composer?.update(composerUnit(u, { name, mk, state, online: online() && can(hit?.base, "input"), away: !can(hit?.base, "input"), role: scene.info?.role, head: isHead }));
			asker?.update(u?.pending, canAnswer(mk, Boolean(u?.control), online() && can(hit?.base, "input")), can(hit?.base, "input") ? undefined : m.box_answer_blocked()); // its dialog above the composer, answerable or not; an away box's says why, as Zen's and the dock's do
		},
	};
}
