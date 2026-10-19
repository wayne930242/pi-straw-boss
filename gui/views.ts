import type { Net } from "../src/net.ts";
import type { Data, HistoryEvent } from "./chat.ts";
import { docTile, shelve } from "./doc.ts";
import { mountDossier } from "./dossier.ts";
import type { Tile } from "./layer.ts";
import { crumbs, entrance } from "./nav.ts";
import { html } from "./render.ts";
import type { Route } from "./router.ts";
import { locate, type Scene, subject } from "./scene.ts";
import { mountSession } from "./session.ts";
import { m } from "./paraglide/messages.js";
import { drawWorkspace } from "./workspace.ts";

// The focus views, a separate chunk loaded on the first route that is not the map. The workspace route is its base zoomed in (workspace.ts); the session
// route is the unit's comms log over the composer (session.ts, chat.ts in its own chunk) with its dossier in the side column (dossier.ts). Both are drawn in
// place with the map's keyed `sync` and unit plates, so state changes animate the same way on every route. This file is their coordinator: it owns the
// Scene they draw from (route, net, cards, the open session's header, model, and context), applies what the page tells it, and calls them to draw.

export interface FocusDeps { data(key: string): Data; restart(): void; openTile(tile: Tile, focus?: boolean): void; embedTerminal(key: string, name: string, host: HTMLElement): Promise<() => void>; online(): boolean }
const MAX_QUEUE = 200;

export function mountFocus({ data, restart, openTile, embedTerminal, online }: FocusDeps) {
	const $ = (id: string) => document.getElementById(id)!;
	const [wsView, sessionView, dossierView] = ["ws-view", "session-view", "dossier"].map($) as HTMLElement[];
	const scene: Scene = { route: { view: "map" }, cards: {} };
	let queue: HistoryEvent[] = [], stale = false;
	const seen = new Map<string, Set<string>>(); // each unit's documents at the last snapshot: what is new arrives
	/** A phone's Info opens the dossier over the full-screen comms, and its × closes it. */
	const fullScreen = (on: boolean) => dossierView.classList.toggle("full", on);
	const dossier = mountDossier(dossierView, scene, { openTile, fullScreen });
	const session = mountSession(scene, {
		view: sessionView, data, openTile, embedTerminal, online, fullScreen,
		opened: () => (queue.splice(0).forEach(apply), drawSession()),
	});
	function apply(e: HistoryEvent) {
		session.chat?.apply(e);
		for (const it of e.items ?? []) if (it.kind === "assistant") [scene.model, scene.ctx] = [it.model ?? scene.model, it.ctx ?? scene.ctx];
	}
	function drawSession() {
		const s = subject(scene);
		if (!s) return;
		dossier(s);
		session.draw(s);
	}
	const draw = () => (crumbs(scene), scene.route.view === "workspace" ? drawWorkspace(wsView, scene) : drawSession());
	return {
		terminal: session.terminal,
		locate: (key: string) => locate(scene.net, key),
		show(next: Route, before: Route, from?: DOMRect) {
			const [key, at] = scene.route.view === "session" ? [scene.route.key, scene.route.at] : [];
			if (next.view !== "workspace" || scene.route.view !== "workspace" || next.ws !== scene.route.ws) scene.cards = {};
			scene.route = next;
			wsView.hidden = next.view !== "workspace";
			sessionView.hidden = dossierView.hidden = next.view !== "session";
			fullScreen(false);
			if (next.view !== "session" || next.key !== key) session.leaveMode();
			if (next.view === "session" && next.key !== key) {
				[scene.info, scene.model, scene.ctx, queue, stale] = [undefined, undefined, undefined, [], false];
				session.open(next.key);
			} else if (next.view === "session" && next.at !== at) session.reveal(next.at);
			else if (next.view !== "session") session.close();
			draw();
			if (next !== before) entrance(next, before, from);
		},
		net(next: Net) {
			scene.net = next;
			shelve(next, seen, scene.route.view === "session" ? scene.route.key : undefined, (unit, card) => openTile(docTile(unit, card), false));
			if (scene.route.view !== "map") draw();
		},
		cards(next: Record<string, string>) {
			scene.cards = { ...scene.cards, ...next };
			if (scene.route.view === "workspace") drawWorkspace(wsView, scene);
		},
		history(e: HistoryEvent) {
			if (scene.route.view !== "session" || e.key !== scene.route.key) return;
			scene.info = { ...scene.info, ...e, items: undefined };
			if (e.reset) [scene.model, scene.ctx] = [undefined, undefined];
			if (document.hidden) return queue.length < MAX_QUEUE ? void queue.push(e) : void (stale = true);
			if (session.chat) apply(e);
			else queue.push(e);
			drawSession();
		},
		/** The page is visible again: replay what waited, or ask for a fresh history when too much did. */
		wake() {
			if (stale) return (stale = false), (queue = []), restart();
			queue.splice(0).forEach((e) => session.chat && apply(e));
			draw();
		},
	};
}
