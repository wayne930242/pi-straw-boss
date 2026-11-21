import { MAIN_KINDS, reportPeek, type MainCard, type UnitCard } from "./linkmodel.ts";
import { requested, stopMain } from "./mainstop.ts";
import { m } from "./sentences.ts";
import { iconRef, unitIcon } from "./icons.ts";
import { ago, html, roleWord, sync, text } from "./render.ts";

// What an unattended device says about its units, as the card of its ally base draws it (docs/how-it-works.md, Unattended devices; the holder's `unit-status`): per unit a state word with how long ago the box said it, its monitors on one
// line, the last report folded to its first line (a tap opens it as Markdown), and, when a notice told of a crash lately, "crashed" with the notice behind a fold. Every word of a unit is a teammate's, so it only becomes text (the report goes
// through the page's Markdown, which parses no HTML). The report's Markdown is made when the fold first opens, in a chunk of its own, and again while it is open when the report changes.

type Row = UnitCard & { id: string; named: boolean };
/** The tower service's states that go with a run's coming and going (src/server/runs.ts `ServiceState`; `held` and `closing` are trouble and an end, not between runs): a unit in one of them is a tower, whose runs come and go while it stays. */
const TOWER_STATES = ["standing", "waking", "running"];
const make = () => html(`<li class="ally-unit"><div class="au-head"><i class="au-dot"></i><b class="au-word"></b><span class="au-name"></span><span class="au-time" hidden><span class="au-pre"></span><span class="age"></span><span class="au-ago"></span></span><em class="au-stale" hidden></em></div><p class="au-mons" hidden><b></b><span></span></p><details class="au-mains" hidden><summary><b class="au-mains-label"></b></summary><ul class="au-main-list"></ul></details><details class="au-crash" hidden><summary><b></b><span class="au-time"><span class="age"></span><span class="au-ago"></span></span></summary><pre></pre><p class="au-hint" hidden></p></details><details class="au-report" hidden><summary><b class="au-label"></b><span class="au-peek"></span></summary><div class="md au-md"></div></details></li>`);

type Markdown = typeof import("./markdown.ts");
let markdown: Markdown | undefined;
const reports = new WeakMap<HTMLElement, string>();
/** Makes the folded report's Markdown when the fold is open and what it shows is not the report. */
function paint(fold: HTMLDetailsElement) {
	const body = fold.querySelector<HTMLElement>(".au-md")!, report = reports.get(fold) ?? "";
	if (!fold.open || body.dataset.report === report) return;
	void (markdown ? Promise.resolve(markdown) : import("./markdown.ts").then((x) => (markdown = x))).then(({ mount, parse }) => {
		if (!fold.open || reports.get(fold) !== report) return;
		body.dataset.report = report;
		body.replaceChildren(mount(parse(report)));
	});
}
/** A time as "40s ago" (the page's clock keeps it current, `mountPage`), with the words before and after it when the line says what the time is of ("updated 40s ago", "40 秒前更新"). */
function clock(box: HTMLElement, since: number, pre = "", post = m.link_unit_ago()) {
	const age = box.querySelector<HTMLElement>(".age")!;
	age.dataset.since = String(since);
	age.textContent = ago(since);
	box.querySelector<HTMLElement>(".au-pre")?.replaceChildren(pre);
	box.querySelector<HTMLElement>(".au-ago")!.textContent = post;
}

type MainRow = MainCard & { id: string };
const makeMain = () => html(`<li class="au-main"><span class="au-mdot"></span><svg class="au-micon" viewBox="0 0 512 512" aria-hidden="true"><use data-icon="main"/></svg><b class="au-mname"></b><em class="role au-mkind" hidden></em><span class="au-mstate"></span><span class="au-mby" hidden></span><button type="button" class="au-stop" hidden></button></li>`);
/** The kind word of a main as the local page draws it (docs/specs/2026-11-09-agent-kinds.md §11, `roleWord`): the box's word for a coordinator, integrator or standing main, `train` for a train; none for a main whose box named no kind or one this page does not draw. */
const kindWord = (kind: string | undefined) => (kind === undefined || !MAIN_KINDS.includes(kind) ? "" : kind === "train" ? roleWord("train") : roleWord("main", kind));
/** The mains of a unit, in a fold of their own: name, kind word, state word, the dispatcher for a main another device dispatched, and Stop where the box takes one (a pending stop reads "stopping…" in its place). */
function fillMains(li: HTMLElement, u: UnitCard, box: string) {
	const fold = li.querySelector<HTMLDetailsElement>(".au-mains")!;
	fold.hidden = !u.mains.length;
	if (!u.mains.length) return;
	text(fold, ".au-mains-label", m.link_mains({ count: u.mains.length }));
	sync(fold.querySelector(".au-main-list")!, u.mains.map((c): MainRow => ({ ...c, id: c.handle })), makeMain, (row, c) => {
		const pending = c.stopping || requested(u, c), word = pending ? m.link_main_stopping() : c.word;
		row.dataset.tone = pending ? "other" : c.tone;
		text(row, ".au-mname", c.name);
		const kind = kindWord(c.kind), kindEl = row.querySelector<HTMLElement>(".au-mkind")!;
		kindEl.hidden = !kind;
		kindEl.textContent = kind;
		if (kind) row.dataset.kind = c.kind!;
		else delete row.dataset.kind;
		const use = row.querySelector("use")!, icon = kind && c.kind === "train" ? "train" : unitIcon("main", kind ? c.kind : undefined); // the kind's icon, as the local page draws it (D16); a main with none keeps the main's
		use.dataset.icon = icon;
		use.setAttribute("href", iconRef(icon));
		text(row, ".au-mstate", word);
		const by = row.querySelector<HTMLElement>(".au-mby")!;
		const said = [...(c.byLabel === undefined ? [] : [m.link_main_by({ who: c.byLabel })]), ...(c.waiting ? [m.link_main_waiting({ ids: c.waiting.join(", ") })] : [])];
		by.hidden = !said.length;
		by.textContent = said.join(" · ");
		const button = row.querySelector<HTMLButtonElement>(".au-stop")!;
		button.hidden = !c.canStop || pending;
		button.textContent = m.link_main_stop();
		button.setAttribute("aria-label", m.link_main_stop_aria({ name: c.name }));
		button.onclick = () => {
			button.disabled = true;
			void stopMain(u, c, box).then((went) => {
				button.disabled = false;
				if (!went) return;
				row.dataset.tone = "other";
				text(row, ".au-mstate", m.link_main_stopping());
				button.hidden = true;
			});
		};
	});
}

/** Draws the units of one ally base. `named`: the base is a whole device (no workspace of its own), so a unit says its name; otherwise the card's title is the unit. `box` is the device's label, for the Stop's question. */
export function fillAllyUnits(list: Element, cards: UnitCard[], named: boolean, box = "") {
	sync(list, cards.map((u) => ({ ...u, id: u.unit, named })) as Row[], make, (li, u) => {
		li.dataset.state = u.state;
		li.dataset.tone = u.tone;
		li.classList.toggle("stale", u.stale);
		text(li, ".au-word", u.word);
		const word = li.querySelector<HTMLElement>(".au-word")!;
		word.title = TOWER_STATES.includes(u.state) ? m.link_unit_run_hint() : ""; // a tower's runs are short: the word says why the unit stands by after one
		text(li, ".au-name", u.named ? u.unit : "");
		const time = li.querySelector<HTMLElement>(".au-head > .au-time")!;
		time.hidden = false;
		time.title = m.link_unit_heard();
		clock(time, u.at, m.link_unit_updated_pre(), m.link_unit_updated_post());
		const stale = li.querySelector<HTMLElement>(".au-stale")!;
		stale.hidden = !u.stale;
		stale.textContent = u.stale ? m.link_unit_stale() : "";
		stale.title = u.stale ? m.link_unit_stale_title() : "";
		const mons = li.querySelector<HTMLElement>(".au-mons")!;
		mons.hidden = !u.monitors.length;
		if (u.monitors.length) {
			text(mons, "b", m.link_unit_monitors({ count: u.monitors.length }));
			text(mons, "span", u.monitors.join(" · "));
			mons.title = u.monitors.join("\n");
		}
		fillMains(li, u, box);
		const crash = li.querySelector<HTMLDetailsElement>(".au-crash")!;
		crash.hidden = !u.crash;
		crash.toggleAttribute("data-trust", u.crash?.trust === true);
		if (u.crash) {
			text(crash, "summary > b", u.crash.trust ? m.link_unit_trust_why() : m.link_unit_crash());
			clock(crash.querySelector<HTMLElement>("summary > .au-time")!, u.crash.at);
			text(crash, "pre", u.crash.text);
			const hint = crash.querySelector<HTMLElement>(".au-hint")!;
			hint.hidden = !u.crash.trust;
			hint.textContent = u.crash.trust ? m.link_unit_trust_hint() : "";
		}
		const fold = li.querySelector<HTMLDetailsElement>(".au-report")!;
		fold.hidden = !u.report;
		if (!u.report) return;
		text(fold, ".au-label", m.link_unit_report());
		text(fold, ".au-peek", reportPeek(u.report));
		reports.set(fold, u.report);
		fold.ontoggle = () => paint(fold);
		paint(fold);
	});
}
