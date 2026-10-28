import type { Mark } from "../src/netdata.ts";
import type { Unit } from "../src/net.ts";
import { m } from "./paraglide/messages.js";
import { aim, aimOpening, html, LABEL, mark, PLATE, sync, text, urgent } from "./render.ts";
import { type Scene, wsOf } from "./scene.ts";
import { fillToken, tokenEl } from "./tokens.ts";
import { fillAllies } from "./towerallies.ts";
import { fillNotices } from "./towernotes.ts";
import { queueChip, statusLine } from "./towermodel.ts";

// The workspace route: its base zoomed in. The tower with its subagents, each tab as a squad of unit tokens, subagents tethered under their launcher, outposts, and the
// workspace's other pi panes as unaligned units.

const colEl = () => html(`<div class="col"><a class="token">${PLATE}<span class="name"></span><span class="line"><em class="role"></em><em class="agent"></em><span class="note"></span></span></a><div class="say"><p></p></div><div class="drones"></div></div>`);
const ZOOM = () => `<div class="zoom-in"><header class="base keep"><a class="tower big"><i class="sweep"></i><i class="pulse"></i><svg><use href="#i-tower"/></svg><b class="badge"></b></a><div class="title"><span class="crown"><svg><use href="#i-crown"/></svg>${m.head_tower()}</span><h2></h2><p><span class="tstate"></span><span class="tqueue"></span></p><div class="allies" hidden></div></div><dl class="tally"><div><dt>${m.squads()}</dt><dd></dd></div><div><dt>${m.units()}</dt><dd></dd></div><div data-mark="working"><dt>${m.stat_working()}</dt><dd></dd></div><div data-mark="waiting"><dt>${m.stat_waiting()}</dt><dd></dd></div></dl></header><div class="tower-notices"></div><div class="drones tower-drones"></div><div class="spawn-btns"><button type="button" class="pair-btn"></button></div><div class="squads"></div><div class="camps"><section class="tab squad camp" data-group="outposts"><h3><svg><use href="#i-outpost"/></svg><b>${m.outposts()}</b><small></small></h3><div class="formation"></div></section><section class="tab squad camp" data-group="outside"><h3><svg><use href="#i-outside"/></svg><b>${m.outside_net()}</b><small>${m.outside_note()}</small></h3><div class="formation"></div></section></div><p class="lost" hidden></p></div>`;

export function drawWorkspace(host: HTMLElement, scene: Readonly<Scene>) {
	if (!host.firstElementChild) host.append(html(ZOOM()));
	const { net, cards } = scene, root = host.firstElementChild as HTMLElement, base = net?.bases.find((b) => b.id === wsOf(scene));
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
	text(root, ".title .tstate", base.tower ? m.control_tower({ state: statusLine(base.tower.service, base.tower.mark, (mk) => LABEL[mk]()) }) : m.no_tower());
	text(root, ".title .tqueue", queueChip(base.tower?.service) ?? "");
	fillAllies(root.querySelector(".title .allies")!, base.id, base.tower?.service);
	fillNotices(root.querySelector(".tower-notices")!, base.id, base.tower?.service, base.tower?.key);
	sync(root.querySelector(".tower-drones")!, base.tower?.subs ?? [], tokenEl, (el, s) => (el.classList.add("drone"), fillToken(el, s, base.id)));
	const all = [...(base.tower?.subs ?? []), ...base.tabs.flatMap((t) => t.units.flatMap((u) => [u, ...u.subs]))];
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
		mark(el, (["waiting", "error", "working"] as const).find((m) => busy.some((u) => u.mark === m || (m === "working" && u.mark === "commanding"))) ?? "idle"); // commanding counts as working here
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
