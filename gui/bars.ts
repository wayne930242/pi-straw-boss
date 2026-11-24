import type { Queued } from "../src/net.ts";
import type { Monitor } from "../src/monitors.ts";
import type { Todo } from "../src/items.ts";
import { m } from "./sentences.ts";
import { text } from "./render.ts";

// The bars between a session's log and its composer, each drawn from what the net says about the unit: the queue, the todo list, the monitors.

/** Queued rows the user opened, by session and then by what they hold (the nth of identical rows counts apart): the sets outlive a re-render, so an open row stays open while its queue redraws, and opening one never opens another session's or an identical row's. */
const opened = new Map<string, Set<string>>();
/** What the session's queue holds, under the chat as the bubbles it will become, until a turn takes them. `server`: the tower's queue is the sb server's (events for its next run), not pi's: its rows say so, and there is no Edit, which the server always refuses. A row cut by the clamp opens to its full text on a click, Enter or Space, and closes again. */
export function drawQueued(view: HTMLElement, list: Queued[] | undefined, session = "", server = false) {
	const box = view.querySelector<HTMLElement>(".queue-list");
	if (!box) return;
	box.hidden = !list?.length;
	const act = view.querySelector<HTMLElement>(".queue-act");
	if (act) act.hidden = !list?.length || server;
	const tag = (q: Queued) => Object.assign(document.createElement("b"), { textContent: q.as === "start" ? m.queued_start() : q.why ? { off: m.queued_wait_off, refused: m.queued_wait_refused, full: m.queued_wait_full, offline: m.queued_wait_offline, unproven: m.queued_wait_unproven }[q.why]() : server ? m.queued_server() : q.as === "steer" ? m.queued_steer() : m.queued_follow() });
	const live = new Set<string>(), mine = opened.get(session) ?? new Set<string>(), seen = new Map<string, number>();
	opened.set(session, mine);
	box.replaceChildren(...(list ?? []).map((q) => {
		const p = Object.assign(document.createElement("p"), { title: q.text }), body = document.createElement("span"); // the padding sits on `p`: padding inside a clamped box shows a sliver of the fourth line
		const same = `${q.as}\n${q.text}`, nth = seen.get(same) ?? 0, key = `${same}\n${nth}`;
		seen.set(same, nth + 1);
		live.add(key);
		body.append(tag(q), q.text);
		p.append(body);
		const show = () => {
			const open = mine.has(key);
			if (open) p.setAttribute?.("data-open", ""); else p.removeAttribute?.("data-open");
			// Only a row the clamp cuts (or one already open, whose overflow is gone) gets the button semantics.
			const cut = open || body.scrollHeight > body.clientHeight + 1;
			if (!cut) return p.removeAttribute?.("role"), p.removeAttribute?.("tabindex"), p.removeAttribute?.("aria-expanded");
			p.setAttribute?.("role", "button"), p.setAttribute?.("tabindex", "0"), p.setAttribute?.("aria-expanded", String(open));
		};
		const toggle = () => (mine.has(key) ? mine.delete(key) : mine.add(key), show());
		p.addEventListener?.("click", () => p.getAttribute?.("role") && toggle());
		p.addEventListener?.("keydown", (e) => {
			const k = e as KeyboardEvent;
			if ((k.key === "Enter" || k.key === " ") && p.getAttribute?.("role")) k.preventDefault(), toggle();
		});
		if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => (show(), typeof ResizeObserver === "function" && new ResizeObserver(show).observe(p)));
		return p;
	}));
	for (const key of mine) if (!live.has(key)) mine.delete(key);
	if (!list?.length) opened.delete(session); // a session with no queue keeps nothing
}
/** A queue of more than one folds to one row on a phone ("3 queued", style.css): the row shows with two or more, and its button opens or shuts the list and Edit under it. A single message stays as the bubble it will become. */
export function foldQueue(view: HTMLElement, count: number) {
	const bar = view.querySelector<HTMLElement>(".queue-bar");
	if (!bar) return;
	bar.hidden = count < 2;
	if (count < 2) delete bar.dataset.open;
	else bar.querySelector("b")!.textContent = m.queue_fold({ count });
	bar.querySelector("button")?.setAttribute("aria-expanded", String(Boolean(bar.dataset.open)));
}
/** The fold row's button: it opens and shuts the queue under it. */
export function mountQueueFold(view: HTMLElement) {
	const bar = view.querySelector<HTMLElement>(".queue-bar"), button = bar?.querySelector("button");
	if (bar && button) button.onclick = () => ((bar.dataset.open ? delete bar.dataset.open : (bar.dataset.open = "1")), button.setAttribute("aria-expanded", String(Boolean(bar.dataset.open))));
}
/** The queue's Edit: pressing it runs `take` (the composer's take-back, composer.ts) once at a time; the button is disabled while it runs. The button lives in the session view's markup (`.queue-act`), shown with the queue. */
export function mountQueueEdit(view: HTMLElement, take: () => Promise<unknown>) {
	const button = view.querySelector<HTMLButtonElement>(".queue-act button");
	if (button) button.onclick = () => {
		button.disabled = true;
		void take().finally(() => (button.disabled = false));
	};
}
/** The session's todo list above the composer: folded to the count and the task in progress, unfolded to every task. */
export function drawTodos(view: HTMLElement, list: Todo[] | null | undefined) {
	const box = view.querySelector<HTMLDetailsElement>(".todos");
	if (!box) return;
	box.hidden = !list?.length;
	if (!list?.length) return;
	const done = list.filter((t) => t.status === "completed").length, now = list.find((t) => t.status === "in_progress");
	text(box, "summary b", m.todos_count({ done, total: list.length }));
	text(box, "summary span", now ? (now.activeForm ?? now.subject) : done === list.length ? m.todos_done() : "");
	box.querySelector("ol")!.replaceChildren(...list.map((t) => {
		const row = Object.assign(document.createElement("li"), { textContent: t.subject, className: t.status });
		if (t.points !== undefined) row.append(" ", Object.assign(document.createElement("small"), { textContent: m.todos_points({ points: t.points }) }));
		const e = t.evidence, detail = [t.anchor && m.todos_anchor({ anchor: t.anchor }), e && m.todos_recorded({ run: [e.command, e.result, e.sha, new Date(e.at).toLocaleString()].filter(Boolean).join(" · ") })].filter(Boolean).join("\n");
		if (detail) { row.title = detail; row.setAttribute("aria-description", detail); }
		return row;
	}));
}
/** The session's background monitors under its todos (read-only: pi-loop-monitor lets nothing else stop one): folded to how many run or failed and the newest running one's last line, unfolded to each with its state, exit code, line count, and last line. */
export function drawMonitors(view: HTMLElement, list: Monitor[] | undefined) {
	const box = view.querySelector<HTMLDetailsElement>(".monitors");
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
