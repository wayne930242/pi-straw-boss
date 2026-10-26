import type { Mark } from "../src/dashboard.ts";
import type { Chat, Data, Who } from "./chat.ts";
import { mountAsk } from "./ask.ts";
import { drawMonitors, drawQueued, drawTodos } from "./bars.ts";
import { mountComposer, postTo } from "./composer.ts";
import { docFor, docTile } from "./doc.ts";
import type { Tile } from "./layer.ts";
import { m } from "./paraglide/messages.js";
import { aimSession } from "./quit.ts";
import { aim, aimOpening, doing, html, LABEL, mark, urgent, text } from "./render.ts";
import { closed, locate, type Scene, type Subject, towerBase, wsOf } from "./scene.ts";
import { linkTo } from "./tokens.ts";

// The session route's comms: the header, the log (chat.ts, its own chunk), the bars above the composer, the composer, the question panel, and the
// session's terminal as the other mode. A phone's Info button, in the header, opens the dossier full-screen through `fullScreen`.

const COMMS = () => `<div class="comms-in"><header class="comms-head"><a class="head-back" data-back aria-label="${m.back()}">‹</a><span class="logo"><svg><use href="#i-comms"/></svg></span><div class="head-id"><h2><small>${m.comms()}</small> <span></span></h2><p></p></div><div class="modes" role="group"><button type="button" data-mode="chat" aria-pressed="true">${m.comms()}</button><button type="button" data-mode="term" aria-pressed="false">${m.terminal()}</button></div><span class="chan link" data-state="live"><i></i><b>${m.channel_open()}</b></span><button type="button" class="pair-btn head-main" hidden></button><button type="button" class="pair-btn head-info">${m.info()}</button><button type="button" class="quit-btn head-quit" data-close="unit" hidden></button></header><div class="chat-root"></div><div class="queue-list" hidden></div><details class="todos" hidden><summary><b></b><span></span></summary><ol></ol></details><details class="monitors" hidden><summary><b></b><span></span></summary><ul></ul></details><div class="ask-root"></div><div class="composer-root"></div><div class="term-root" hidden></div></div>`;

export interface SessionDeps {
	view: HTMLElement; data(key: string): Data; openTile(tile: Tile, focus?: boolean): void; embedTerminal(key: string, name: string, host: HTMLElement): Promise<() => void>; online(): boolean;
	/** Shows or hides the dossier over the comms (a phone's Info). */
	fullScreen(on: boolean): void;
	/** The comms are mounted: the history that waited goes into the log and the views draw. */
	opened(): void;
}

export function mountSession(scene: Readonly<Scene>, { view, data, openTile, embedTerminal, online, fullScreen, opened }: SessionDeps) {
	let chat: Chat | undefined, composer: ReturnType<typeof mountComposer> | undefined, asker: ReturnType<typeof mountAsk> | undefined, entering = 0;
	let unembed: (() => void) | undefined, pendingMode: "term" | undefined, modeTurn = 0;
	/** Focus that fell to the page (the dialog that opened this route closed, its link gone) lands in the comms: the box, or the log on a touch screen. */
	const claim = () => setTimeout(() => scene.route.view === "session" && (document.activeElement ?? document.body) === document.body && (matchMedia("(pointer: fine)").matches && composer?.ready() ? composer.box : chat?.log)?.focus({ preventScroll: true }));

	async function enter(key: string) {
		const turn = ++entering, { mountChat } = await import("./chat.ts");
		if (turn !== entering || scene.route.view !== "session") return;
		view.replaceChildren(html(COMMS()));
		const who = (): Who => locate(scene.net, key)?.u ?? { key, name: scene.info?.name ?? key, role: scene.info?.role ?? "member", mark: "unknown" as Mark };
		const link = (name: string) => {
			const hit = locate(scene.net, key), sub = hit?.u.subs.find((s) => s.name === name) ?? scene.net?.bases.flatMap((b) => [...b.tabs.flatMap((t) => t.units), ...b.outside]).find((x) => x.name === name);
			return sub && linkTo({ view: "session", ws: locate(scene.net, sub.key)?.base.id ?? wsOf(scene), key: sub.key }, name);
		};
		const opener = (path: string, card = docFor(locate(scene.net, key)?.u.docs, scene.info?.header?.cwd, path)) => card && (() => openTile(docTile(who().name, card)));
		chat = mountChat(view.querySelector(".chat-root")!, data(key), { who, link, docFor: opener });
		const send = data(key).post ?? postTo(key);
		[composer, asker] = [mountComposer(view.querySelector(".composer-root")!, key, send), mountAsk(view.querySelector(".ask-root")!, send, undefined, () => setMode("term"))];
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
		root.querySelectorAll<HTMLButtonElement>(".modes button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === mode)));
		for (const sel of [".chat-root", ".ask-root", ".composer-root"]) root.querySelector<HTMLElement>(sel)!.hidden = mode === "term";
		const host = root.querySelector<HTMLElement>(".term-root")!;
		host.hidden = mode !== "term";
		root.classList.toggle("in-term", mode === "term");
		unembed?.();
		unembed = undefined;
		if (mode !== "term") return claim();
		const turn = ++modeTurn, name = locate(scene.net, key)?.u.name ?? scene.info?.name ?? key;
		// Switching to the terminal gives it the keyboard once, on a desktop (only a desktop's mirror has the text box that takes it).
		void embedTerminal(key, name, host).then((off) => (turn === modeTurn && scene.route.view === "session" && scene.route.key === key ? ((unembed = off), host.querySelector<HTMLElement>(".term-sink")?.focus({ preventScroll: true })) : off()));
	}
	return {
		get chat() { return chat; },
		/** A session other than the one shown: the comms start over for `key`. */
		open(key: string) {
			[chat, composer, asker] = [undefined, undefined, undefined];
			view.replaceChildren(html(`<p class="lost">${m.opening_channel()}</p>`));
			void enter(key);
		},
		/** A route that is not a session: its comms go, since entries that wait hidden with content-visibility keep a page with moving parts producing frames. */
		close() {
			entering++;
			(chat = composer = asker = undefined), view.replaceChildren();
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
			view.querySelector<HTMLElement>(".modes")?.toggleAttribute("hidden", !u?.control);
			chat?.docs();
			const head = view.querySelector<HTMLElement>(".comms-head");
			if (head) {
				mark(head, mk); // the head glows while the unit is commanding
				text(head, "h2 span", u?.name ?? scene.info?.name ?? "");
				text(head, "p", [hit?.base.label, hit?.squad && m.squad_label({ label: hit.squad })].filter(Boolean).join(" · "));
				const chan = head.querySelector<HTMLElement>(".chan")!, open = !closed(u, state);
				chan.dataset.state = open ? "live" : "closed";
				text(chan, "b", open ? m.channel_open() : state === "recent" || u?.ended ? m.channel_closed() : m.no_channel());
				chan.title = chan.querySelector("b")!.textContent ?? ""; // a phone shows the dot alone
				// A tower's comms open a main in its base (main.ts opens the same tile the map's "+ Main" does); no other unit has the button.
				const add = head.querySelector<HTMLButtonElement>(".head-main")!, base = towerBase(hit);
				add.hidden = !base;
				if (base) (aimOpening(add, base), (add.title = m.open_main_title({ base: base.label })));
				aimSession(head.querySelector(".head-quit")!, hit); // the map's Quit for this unit: the same confirmation, request, and refusals (quit.ts)
				aim(head.querySelector(".head-back")!, { view: "workspace", ws: wsOf(scene) }); // a phone's full-screen comms go back with it: to the page before, or up when the page opened here
			}
			drawTodos(view, scene.info?.todos);
			drawMonitors(view, u?.monitors);
			drawQueued(view, u?.queued);
			chat?.setLive(mk === "working" || mk === "commanding" ? `${doing(u!.note, mk)}` : urgent(mk) ? LABEL[mk]() : "", mk);
			composer?.update({ name, control: Boolean(u?.control), agent: u?.agent, live: !closed(u, state), mark: mk, online: online(), answerable: Boolean(u?.pending?.answer) });
			asker?.update(u?.pending, mk === "waiting" && Boolean(u?.control) && online()); // its dialog above the composer, answerable or not
		},
	};
}
