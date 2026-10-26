import type { Progress, StepId, StepState } from "../src/deploy.ts";
import { ownOpenings } from "./alerts.ts";
import { h } from "./dom.ts";
import { m } from "./paraglide/messages.js";
import type { Answer } from "./post.ts";
import { reasonOf } from "./refusal.ts";
import { trustPanel, type TrustPost } from "./trust.ts";

// The deploy panel: what a tile shows, in place of its form, while a new unit opens (spawn.ts). The steps and how far they have got come from
// the server (POST open/progress, polled twice a second); a step of its own the page cannot know of is never made up. Only the elapsed time of the
// running step ticks here. The `trust` step is the server's (src/deploy.ts) and appears only when the new pi waits on a project trust question: the question is inline then, and the page's
// give-up does not count that time. Motion is CSS alone: the bar's fill transitions, the running step pulses, the finish flashes (style.css .deploy).

interface Row { id: StepId; state: StepState; ms: number; since: number }
interface Clock { now(): number; every(run: () => void, ms: number): () => void; after(run: () => void, ms: number): () => void }
export interface DeployOpts {
	kind: "base" | "main" | "member";
	/** A member split into a squad's tab, not in a tab of its own. */
	split: boolean;
	hasPrompt: boolean;
	name: string;
	/** The open request itself, carrying the id the progress is asked under. */
	open(deploy: string): Promise<Answer>;
	progress(deploy: string): Promise<Answer>;
	/** The finish has shown; the opened unit's answer. */
	ready(body: Answer["body"]): void;
	/** The failure is dismissed. */
	back(): void;
	/** Plays the unit-ready sound, when the page's Sound is on. */
	chime?(): void;
	/** Answers the trust question the opening waits on (POST trust/answer), shown inline in its `trust` step. */
	trust?: TrustPost;
	clock?: Clock;
}

const POLL_MS = 500, TIMEOUT_MS = 120_000;
const REAL: Clock = {
	now: () => Date.now(),
	every: (run, ms) => (((id) => () => clearInterval(id))(setInterval(run, ms))),
	after: (run, ms) => (((id) => () => clearTimeout(id))(setTimeout(run, ms))),
};
const clock = (ms: number) => `${String(Math.floor(ms / 60_000)).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
const svg = (id: string) => {
	const el = document.createElementNS("http://www.w3.org/2000/svg", "svg"), use = document.createElementNS("http://www.w3.org/2000/svg", "use");
	use.setAttribute("href", `#i-${id}`);
	el.append(use);
	return el;
};

/** The steps an open has, as the server plans them: create, start, join, and deliver only when there is a first message. */
const planOf = (hasPrompt: boolean): StepId[] => ["create", "start", "join", ...(hasPrompt ? ["deliver" as const] : [])];

export function deployPanel(o: DeployOpts): HTMLElement & { close(): void } {
	const time = o.clock ?? REAL, id = `deploy-${crypto.randomUUID()}`;
	const label = (step: StepId) => ({ create: o.kind === "base" ? m.deploy_create_base() : o.split ? m.deploy_create_pane() : m.deploy_create_tab(), start: m.deploy_start(), trust: m.deploy_trust(), join: m.deploy_join(), deliver: m.deploy_deliver() })[step];
	let rows: Row[] = planOf(o.hasPrompt).map((step) => ({ id: step, state: "pending", ms: 0, since: 0 })), over: "running" | "ready" | "failed" = "running", polling = false, closed = false, timedOut = false, last = "", stopGo = () => {};
	const bar = h("span", { class: "deploy-fill" }), count = h("span", { class: "deploy-count" }), list = h("ol", { class: "deploy-steps" }), note = h("p", { class: "deploy-note", "aria-live": "polite" }), back = h("button", { type: "button", class: "later" }, m.deploy_back());
	const title = h("h3", { class: "deploy-title" }, svg(o.kind === "main" ? "main" : "member"), m.deploy_title({ kind: o.kind === "base" ? m.deploy_kind_base() : o.kind === "main" ? m.role_main() : m.role_member(), name: o.name }));
	const holder = h("div", { class: "deploy-trust" }), root = h("div", { class: "deploy", role: "status", "aria-label": m.deploy_aria() }, title, h("div", { class: "deploy-bar" }, bar), count, list, holder, note, back);
	let question: ReturnType<typeof trustPanel> | undefined;
	ownOpenings.add(id); // this page shows the opening's trust question here, so its alert queue does not
	const ask = (q: Progress["trust"]) => {
		if (!q) return void (question && (holder.replaceChildren(), (question = undefined)));
		const fresh = !question;
		if (!question) holder.replaceChildren((question = trustPanel((body) => o.trust?.(body) ?? Promise.reject(new Error("no route")))));
		question.update(q);
		if (fresh) holder.scrollIntoView?.({ block: "end", behavior: "smooth" }); // on a phone the choices are below the fold: bring them up
	};
	back.onclick = () => o.back();
	const items = new Map<StepId, { li: HTMLElement; at: HTMLElement }>();
	const draw = () => {
		const done = rows.filter((r) => r.state === "done").length;
		root.dataset.state = over;
		bar.style.setProperty("--done", String(done));
		bar.style.setProperty("--of", String(rows.length));
		count.textContent = `${done}/${rows.length}`;
		if (rows.map((r) => r.id).join() !== [...items.keys()].join()) {
			items.clear();
			list.replaceChildren(...rows.map((r) => {
				const at = h("time", { class: "deploy-time" }), li = h("li", { "data-step": r.id }, h("i", { class: "deploy-mark" }), h("span", null, label(r.id)), at);
				items.set(r.id, { li, at });
				return li;
			}));
		}
		for (const r of rows) {
			const item = items.get(r.id)!, ms = r.state === "active" ? time.now() - r.since : r.ms;
			item.li.dataset.state = r.state;
			item.at.textContent = r.state === "pending" || (r.state === "done" && ms < 1000) ? "" : clock(ms);
		}
	};
	const timeoutNote = m.deploy_timeout({ seconds: TIMEOUT_MS / 1000 });
	// A trust question holds the opening for as long as nobody answers it (the server fails it after ten minutes): the give-up does not count that time.
	const giveUp = () => (rows.some((r) => r.id === "trust" && r.state === "active") ? (stopWait(), (stopWait = time.after(giveUp, TIMEOUT_MS))) : fail(undefined, timeoutNote));
	const stop = () => (ownOpenings.delete(id), stopTick(), stopWait());
	const fail = (step: StepId | undefined, why: string) => {
		if (over !== "running") return;
		over = "failed";
		stop();
		timedOut = step === undefined && why === timeoutNote;
		const at = rows.find((r) => r.id === step) ?? rows.find((r) => r.state === "active") ?? rows[0]!;
		rows = rows.map((r) => (r === at ? { ...r, state: "failed", ms: r.state === "active" ? time.now() - r.since : r.ms } : r.state === "active" ? { ...r, state: "pending" } : r));
		note.setAttribute("role", "alert");
		note.textContent = `${m.deploy_failed({ step: label(at.id) })} ${why}`;
		draw();
		back.focus?.();
	};
	const apply = (p: Progress) => {
		if (over !== "running") return;
		rows = p.steps.map((s) => ({ id: s.id, state: s.state, ms: s.ms, since: time.now() - s.ms }));
		ask(p.trust);
		if (p.failed) return fail(p.failed.step, reasonOf(p.failed.reason, p.failed.settings)!);
		draw();
	};
	const tick = () => {
		draw();
		if (polling) return;
		polling = true;
		void o.progress(id).then((a) => {
			if (!a.ok || over !== "running") return;
			const seen = JSON.stringify(a.body);
			if (seen !== last) (last = seen, stopWait(), (stopWait = time.after(giveUp, TIMEOUT_MS))); // the timeout measures silence: each answer that shows change starts it again
			apply(a.body as unknown as Progress);
		}, () => {}).finally(() => (polling = false));
	};
	const stopTick = time.every(tick, POLL_MS);
	let stopWait = time.after(giveUp, TIMEOUT_MS);
	void o.open(id).then((a) => {
		if (closed || (over !== "running" && !(over === "failed" && timedOut && a.ok))) return; // an open that answers ok after the timeout is a unit all the same
		if (!a.ok) return fail(a.body.step as StepId | undefined, reasonOf(a.body.reason, a.body.settings) ?? m.refused({ status: a.status }));
		over = "ready";
		stop();
		note.setAttribute("role", "status");
		note.textContent = m.deploy_ready();
		rows = rows.map((r) => ({ ...r, state: "done", ms: r.state === "active" ? time.now() - r.since : r.ms }));
		draw();
		o.chime?.();
		stopGo = time.after(() => o.ready(a.body), matchMedia("(prefers-reduced-motion: reduce)").matches ? 600 : 1500);
	}, () => fail(undefined, m.no_answer()));
	draw();
	/** The tile is closed: polling, the chime, and the way on to the unit stop (the unit still appears in the net). */
	return Object.assign(root, { close: () => ((closed = true), stop(), stopGo()) });
}
