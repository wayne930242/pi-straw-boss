import "./style.css";
import type { Net } from "../src/net.ts";
import { changes } from "./log.ts";
import { mountPage } from "./render.ts";
import { createStream, type Source, type Status } from "./stream.ts";

const page = mountPage();
const el = (id: string) => document.getElementById(id)!;
const time = (at?: number) => (at ? new Date(at).toLocaleTimeString([], { hour12: false }) : "never");

let shown: Net | undefined, pending: Net | undefined, status: Status = { state: "connecting", attempt: 0 };

// A hidden page keeps only the newest snapshot and draws it when it comes back, so a background tab does no DOM work.
function show(net: Net) {
	pending = net;
	if (document.hidden) return;
	page.log(changes(shown, net));
	page.show(net);
	shown = net;
	pending = undefined;
}

function report(next: Status) {
	status = next;
	const stale = next.state === "reconnecting" || next.state === "offline";
	document.body.dataset.stale = el("stage").dataset.stale = String(stale);
	el("link").dataset.state = next.state;
	el("link-text").textContent = { connecting: "connecting", live: "live", reconnecting: "reconnecting", offline: "offline" }[next.state];
	const banner = el("banner");
	banner.hidden = !stale && !next.problem;
	const lead = next.state === "offline"
		? `Disconnected. Gave up after ${next.attempt - 1} tries; it reconnects when you return to this tab.`
		: next.state === "reconnecting"
			? `Disconnected from the straw net. Reconnecting${next.attempt ? ` (try ${next.attempt})` : ""}… The map shows the last known state.`
			: `The server is up but cannot read the net: ${next.problem}`;
	const last = document.createElement("b");
	last.textContent = time(next.lastContact);
	banner.replaceChildren(`${lead} Last update `, last, ".");
}

/** The real stream: the server's events, relative to the page's own URL so the token path carries over. */
function live(): Source {
	const es = new EventSource("events");
	return {
		onError: (handler) => (es.onerror = handler),
		listen: (type, handler) => es.addEventListener(type, (event) => handler((event as MessageEvent<string>).data)),
		close: () => es.close(),
	};
}

const open = __LIVE__ ? live : (await import("./fixture.ts")).createFixture({ resume: () => stream.resume() }).open;
const stream = createStream({
	open,
	now: Date.now,
	setTimeout: (run, ms) => window.setTimeout(run, ms),
	clearTimeout: (id) => window.clearTimeout(id),
	random: Math.random,
	hidden: () => document.hidden,
	onNet: show,
	onStatus: report,
});
const resume = () => stream.resume();
document.addEventListener("visibilitychange", () => {
	page.pause(document.hidden);
	if (document.hidden) return stream.hide();
	if (pending) show(pending);
	resume();
});
for (const event of ["focus", "pageshow", "online"]) window.addEventListener(event, () => !document.hidden && resume());
report(status);
stream.start();
