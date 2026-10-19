import type { Queued } from "../src/net.ts";
import type { Monitor } from "../src/monitors.ts";
import type { Todo } from "../src/items.ts";
import { m } from "./paraglide/messages.js";
import { text } from "./render.ts";

// The bars between a session's log and its composer, each drawn from what the net says about the unit: the queue, the todo list, the monitors.

/** What the session's queue holds, under the chat as the bubbles it will become, until a turn takes them. */
export function drawQueued(view: HTMLElement, list: Queued[] | undefined) {
	const box = view.querySelector<HTMLElement>(".queue-list");
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
export function drawTodos(view: HTMLElement, list: Todo[] | null | undefined) {
	const box = view.querySelector<HTMLDetailsElement>(".todos");
	if (!box) return;
	box.hidden = !list?.length;
	if (!list?.length) return;
	const done = list.filter((t) => t.status === "completed").length, now = list.find((t) => t.status === "in_progress");
	text(box, "summary b", m.todos_count({ done, total: list.length }));
	text(box, "summary span", now ? (now.activeForm ?? now.subject) : done === list.length ? m.todos_done() : "");
	box.querySelector("ol")!.replaceChildren(...list.map((t) => Object.assign(document.createElement("li"), { textContent: t.subject, className: t.status })));
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
