import type { Tile } from "./layer.ts";
import { docList, docTile } from "./doc.ts";
import { m } from "./paraglide/messages.js";
import { fillPlate, html, LABEL, mark, PLATE, roleName, say, sync, text } from "./render.ts";
import { locate, type Scene, type Subject, wsOf } from "./scene.ts";
import { fillToken, linkTo, tokenEl } from "./tokens.ts";
import { statusLine } from "./towermodel.ts";

// The dossier in a session route's side column (a phone's Info opens it full-screen): the unit's plate and state, its specs, its documents, the
// subagents it dispatched, and, for a tower, each squad of its base.

const DOSSIER = () => `<div class="dossier-in"><span class="tag">${m.unit_dossier()}</span><button class="x d-x" type="button" aria-label="${m.close()}">×</button><div class="portrait">${PLATE}</div><h3></h3><p class="d-line"><em class="role"></em> <span class="state"></span></p><p class="d-note" hidden></p><dl class="specs"></dl><div class="d-docs" hidden><h4>${m.documents()}</h4><div class="d-doc-list"></div><p class="d-docs-cut" hidden>${m.docs_cut()}</p></div><div class="d-drones" hidden><h4>${m.dispatched()}</h4><div class="formation"></div></div><div class="d-squads" hidden><h4>${m.under_tower()}</h4><div class="d-squad-list"></div></div></div>`;
const droneOf = (el: HTMLElement) => el.classList.add("drone");

export interface DossierDeps { openTile(tile: Tile, focus?: boolean): void; fullScreen(on: boolean): void }

export function mountDossier(host: HTMLElement, scene: Readonly<Scene>, { openTile, fullScreen }: DossierDeps) {
	return function draw({ key, hit, u, mk, state, name }: Subject) {
		if (!host.firstElementChild) (host.append(html(DOSSIER())), (host.querySelector<HTMLElement>(".d-x")!.onclick = () => fullScreen(false)));
		const root = host.firstElementChild as HTMLElement, { net, info, model, ctx } = scene, ws = wsOf(scene);
		mark(root, mk);
		fillPlate(root.querySelector(".plate")!, u?.role ?? info?.role ?? "member", mk);
		const ally = !u && info?.role === "ally"; // an ally run's comms: a unit only its tower's chip lists (src/net.ts)
		text(root, "h3", ally ? m.ally_run({ device: name }) : name);
		text(root, ".role", roleName(u?.role ?? info?.role ?? "session"));
		say(root, ".state", u?.note, mk, u ? (u.service && !u.service.run ? statusLine(u.service, mk, (k) => LABEL[k]()) : undefined) : ally ? m.ally_state() : m.not_in_net()); // a tower the server runs says "standing by", as the map does
		const note = root.querySelector<HTMLElement>(".d-note")!;
		note.hidden = state !== "recent" && state !== "unknown";
		note.replaceChildren(state === "unknown" ? m.note_unknown() : m.note_recent());
		if (info?.successor) note.append(` ${m.successor()} `, linkTo({ view: "session", ws, key: info.successor }, locate(net, info.successor)?.u.name ?? m.new_session()));
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
		docList(root.querySelector(".d-docs")!, u?.docs, u?.docsCut, (card) => (fullScreen(false), openTile(docTile(name, card)))); // a phone's full-screen dossier steps aside for the document
		const drones = root.querySelector<HTMLElement>(".d-drones")!;
		drones.hidden = !u?.subs.length;
		sync(drones.querySelector(".formation")!, (u?.subs ?? []).map((s) => ({ ...s, id: s.key })), tokenEl, (el, s) => (droneOf(el), fillToken(el, s, ws)));
		const squads = root.querySelector<HTMLElement>(".d-squads")!, under = u?.role === "tower" ? hit?.base : undefined; // a tower's base: each squad and its units, as the map shows them
		squads.hidden = !under?.tabs.length;
		sync(squads.querySelector(".d-squad-list")!, under?.tabs ?? [], () => html(`<div class="d-squad"><small></small><div class="formation"></div></div>`), (el, t) => (text(el, "small", m.squad_label({ label: t.label })), sync(el.querySelector(".formation")!, t.units.flatMap((x) => [x, ...x.subs]).map((x) => ({ ...x, id: x.key })), tokenEl, (e, x) => (droneOf(e), fillToken(e, x, under!.id)))));
	};
}
