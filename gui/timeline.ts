import type { NetEvent } from "../src/activity.ts";
import type { Net } from "../src/net.ts";
import { said } from "./log.ts";
import { m } from "./paraglide/messages.js";
import { aim } from "./render.ts";

// The net's activity over the last 30 minutes (activity.ts WINDOW_MS) as a strip under the stage, after zoetrope's timeline: a mark per event,
// in a row by what it asks of the user (waiting and errors on top, work in the middle, the rest below), placed by its time, named on hover, and a
// link to its unit. The newest event is spelled out in the header. The strip slides with the clock every 30 s, and folds away on a phone.

const WINDOW = 30 * 60_000, ROW: Record<string, number> = { waiting: 0, error: 0, working: 1, commanding: 1 };
const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour12: false });

export function mountTimeline(root: HTMLDetailsElement) {
	const [lanes, axis, at, last, span] = [".tl-lanes", ".tl-axis", ".tl-at", ".tl-last", ".tl-span"].map((s) => root.querySelector<HTMLElement>(s)!);
	let events: NetEvent[] = [], sig = "";
	if (matchMedia("(max-width: 640px)").matches) root.open = false;
	const draw = () => {
		const from = Date.now() - WINDOW, shown = events.filter((e) => e.at >= from), newest = shown.at(-1);
		lanes.replaceChildren(...shown.map((e) => {
			const a = document.createElement("a"), x = ((e.at - from) / WINDOW) * 100;
			a.className = `tl-mark ${e.kind}${x > 70 ? " end" : ""}`;
			a.dataset.mark = e.kind === "left" ? "unknown" : e.mark;
			a.style.cssText = `left:${x.toFixed(2)}%;top:${(ROW[e.mark] ?? 2) * 14 + 4}px`;
			a.setAttribute("aria-label", `${clock(e.at)} ${said(e)}`);
			aim(a, e.key && e.kind !== "left" ? { view: "session", ws: e.ws, key: e.key } : { view: "workspace", ws: e.ws });
			return a;
		}));
		axis.replaceChildren(...[0, 10, 20].map((min) => Object.assign(document.createElement("span"), { textContent: clock(from + min * 60_000).slice(0, 5) })), Object.assign(document.createElement("span"), { textContent: m.timeline_now() }));
		at.textContent = newest ? clock(newest.at) : "";
		last.textContent = newest ? said(newest) : m.timeline_empty();
		span.textContent = m.timeline_span({ count: String(shown.length) });
	};
	setInterval(draw, 30_000);
	draw();
	return {
		net(net: Net) {
			const next = net.events ?? [], now = next.map((e) => `${e.at}${e.kind}${e.key ?? e.name}${e.mark}`).join();
			if (now !== sig) ((sig = now), (events = next), draw());
		},
	};
}
