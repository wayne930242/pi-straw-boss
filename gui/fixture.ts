import type { Mark } from "../src/dashboard.ts";
import type { Net, Unit } from "../src/net.ts";
import type { Data, Page } from "./chat.ts";
import { DEMO_DOC, demoHistory, demoScreen, WHOLE } from "./demo-chat.ts";
import type { Tile } from "./layer.ts";
import type { Source } from "./stream.ts";

// The demo net for `npm run gui:dev`: invented names, state changes on a timer, and a stream that can be dropped to see the
// disconnected page. It stands in for the server's EventSource, so the real reconnect logic runs against it.

const unit = (id: string, name: string, role: Unit["role"], mark: Mark, note?: string, subs: Unit[] = []): Unit => ({ id, key: id, control: true, name, role, mark, note, subs });
// What the nth wait is on: a secret (odd), two questions as ask_user_question asks them (n % 4 == 2), or robot_hand's selector; the last two answer.
const two = [{ header: "Window", question: "When should the ops deploy go out?", options: [{ title: "Tonight 22:00", description: "Low traffic; on-call is awake." }, { title: "Tomorrow 08:00" }], multiple: false, freeform: true }, { header: "Notify", question: "Who should be told?", options: [{ title: "ops" }, { title: "billing" }, { title: "support" }], multiple: true, freeform: true }];
const hand = { title: "Robot Hand — Deploy needs your sudo password\n\n  ! npm run deploy", copy: "npm run deploy", choices: [{ label: "Type it into a new Herdr pane (I press Enter)", note: "Opens a pane with the command typed; press Enter there" }, { label: "Put it in my prompt", note: "Lands in the terminal's prompt; press Enter there" }, { label: "Copy it to my clipboard", note: "Copies on this computer", localOnly: true as const }, { label: "No, thanks" }] };
const ask = (n: number): Unit["pending"] => (n % 2 ? { callId: `demo-${n}`, tool: "secret_drop", why: "It waits for a secret." } : { callId: `demo-${n}`, ...(n % 4 ? { tool: "ask_user_question", asks: two, answer: { dialog: `d${n}`, digest: "0".repeat(64), questions: two } } : { tool: "robot_hand", answer: { dialog: `d${n}`, digest: "0".repeat(64), select: hand } }) });
const demo = (): Net => ({
	bases: [
		{ id: "w1", label: "Harbor API", mark: "working", head: true, tower: { name: "tower · Harbor API", mark: "working", key: "t1", control: true }, outposts: [{ id: "w1-fix", label: "harbor-api-hotfix", mark: "working" }], outside: [unit("o1", "scratch-notes", "outside", "idle")], tabs: [
			{ id: "w1:t1", label: "billing", units: [unit("a1", "billing-main", "main", "working", "tool:edit", [unit("a1/lint", "lint-sweep", "subagent", "working", "tool:bash"), unit("a1/docs", "docs-writer", "subagent", "done", "finished")]), unit("a2", "billing-tests", "member", "idle")] },
			{ id: "w1:t2", label: "ops", units: [{ ...unit("a3", "ops-main", "main", "waiting", "waiting on a question"), pending: ask(0) }] },
		] },
		{ id: "w2", label: "Lighthouse Web", mark: "working", head: false, tower: { name: "tower · Lighthouse Web", mark: "idle", key: "t2", control: true }, outposts: [], outside: [], tabs: [
			{ id: "w2:t1", label: "checkout", units: [unit("b1", "checkout-main", "main", "working", "thinking", [unit("b1/e2e", "e2e-runner", "subagent", "working", "thinking")]), unit("b2", "checkout-style", "member", "working", "tool:read")] },
		] },
		{ id: "w3", label: "Orchard Data", mark: "idle", head: false, tower: { name: "tower · Orchard Data", mark: "done", key: "t3", control: true }, outposts: [], outside: [], tabs: [
			{ id: "w3:t1", label: "etl", units: [unit("c1", "etl-main", "main", "idle")] },
		] },
		{ id: "w4", label: "Quarry Tools", mark: "idle", head: false, tower: null, outposts: [], outside: [], tabs: [] },
	],
});

// Where each state can go next: work mostly continues, sometimes asks a question or finishes; an error is rare.
const NEXT: Record<Mark, Mark[]> = { working: ["working", "waiting", "idle", "done"], waiting: ["working"], idle: ["working"], done: ["working"], error: ["working"], unknown: ["working"] };
const units = (net: Net) => net.bases.flatMap((b) => b.tabs.flatMap((t) => t.units.flatMap((u) => [u, ...u.subs])));

export interface Control { drop(): void; silence(): void; restore(): void; doc(): void }

export function createFixture({ resume, tile, tick = 2500 }: { resume(): void; tile(tile: Tile): void; tick?: number }): { open(watch: string | null): Source; data(key: string): Data; control: Control } {
	let net = demo(), step = 0, waits = 0, dropped = false, silent = false, current: FixtureSource | undefined, live = 0;
	const history = demoHistory();
	/** The page of the chat that ends before `before` (the end of the history when absent), the way the server pages. */
	const page = (before?: string): Page => {
		const end = before ? history.findIndex((i) => i.id === before) : history.length, start = Math.max(0, end - 150);
		return { items: history.slice(start, end), before: start > 0 ? history[start]!.id : undefined };
	};
	class FixtureSource implements Source {
		fail: () => void = () => {};
		private listeners = new Map<string, ((data: string) => void)[]>();
		private timers: ReturnType<typeof setInterval>[] = [];
		constructor(watch: string | null) {
			current = this;
			// A dropped server answers a connection with an error, as a stopped one would.
			if (dropped) this.timers.push(setTimeout(() => this.fail(), 300));
			else this.timers.push(setTimeout(() => this.send("hello", { stream: "demo" }), 100), setTimeout(() => this.send("message", net), 150), setInterval(() => this.send("ping", ""), 15_000));
			if (dropped) return;
			if (watch?.startsWith("w:")) this.timers.push(setTimeout(() => this.send("cards", { a1: "I merged the billing branch and the tests pass.", a3: "Waiting for your answer about the deploy window." }), 250));
			else if (watch) {
				this.timers.push(setTimeout(() => this.send("history", { key: watch, state: "live", reset: true, ...page(), header: { id: watch, cwd: "/work/harbor-api" }, unreadable: 0 }), 250));
				// A new reply every few seconds, so the page shows a live chat.
				this.timers.push(setInterval(() => {
					const n = ++live, call = `live-c${n}`;
					this.send("history", { key: watch, reset: false, items: [{ id: `live-a${n}`, kind: "assistant", model: "harbor-1", at: new Date().toISOString(), text: `Live message ${n}`, tools: [{ id: call, name: "bash", summary: "date", args: "{}" }] }, { id: `live-r${n}`, kind: "result", callId: call, name: "bash", text: new Date().toString(), isError: false, bytes: 30 }] });
				}, 5000));
			}
		}
		onError(handler: () => void) {
			this.fail = handler;
		}
		listen(type: string, handler: (data: string) => void) {
			this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]);
		}
		send(type: string, payload: unknown) {
			if (silent) return;
			for (const l of this.listeners.get(type) ?? []) l(JSON.stringify(payload));
		}
		close() {
			this.timers.forEach((t) => (clearTimeout(t), clearInterval(t)));
			if (current === this) current = undefined;
		}
	}
	// Every tick one agent changes state, so the page always has something moving.
	setInterval(() => {
		const all = units(net);
		const pick = all[step % all.length]!;
		if (pick.pending?.answer) return void step++; // a dialog the page can answer stays until it is answered
		const options = NEXT[pick.mark];
		pick.mark = step % 17 === 16 ? "error" : options[step % options.length]!;
		pick.note = pick.mark === "working" ? "tool:edit" : pick.mark === "waiting" ? "waiting on a question" : undefined;
		pick.pending = pick.mark === "waiting" ? ask(++waits) : undefined;
		net = structuredClone(net);
		step++;
		current?.send("message", net);
	}, tick);
	const control: Control = {
		drop: () => ((dropped = true), current?.fail()),
		silence: () => (silent = true),
		restore: () => ((dropped = false), (silent = false), resume()),
		// A document arrives on its own (as a show_doc call will in phase 3): it opens as a tile and takes no focus.
		doc: () => tile({ id: "doc:docs/review-notes.md", title: "review-notes.md", body: () => {
			const body = document.createElement("div");
			body.className = "md";
			void import("./markdown.ts").then(({ mount, parse }) => body.append(mount(parse(DEMO_DOC.replace("Rollout plan", "Review notes")))));
			return body;
		} }),
	};
	mountToolbar(control);
	const data = (key: string): Data => ({
		older: async (before) => page(before),
		latest: async () => page(),
		// Input is accepted, and shows in the log a moment later as pi would write it.
		post: async (action, body) => (action === "answer" ? answered(key) : action === "mirror" ? mirror(key, body.on === true) : action === "keys" && body.key === "enter" && !body.confirmed ? { ok: false, status: 409, body: { error: "confirm", confirm: "reload", reason: "Enter would run /reload (or the command picked in pi's menu, if it is open), which ends or replaces this session. Enter goes to whatever has focus in the terminal; confirm to send it." } } : (action === "input" && setTimeout(() => current?.send("history", { key, reset: false, items: [{ id: `you-${++live}`, kind: "user", at: new Date().toISOString(), text: String(body.text) }] }), 700), { ok: true, status: 200, body: {} })),
		doc: async (path) => (path.endsWith("rollout-plan.md") ? DEMO_DOC : undefined),
		entry: async (id) => {
			const item = history.find((i) => i.id === id);
			return item && { ...item, thoughtText: item.kind === "assistant" ? "Thinking out loud about the rounding rules.\n\nCredit notes may need a separate sum." : undefined, tools: item.tools?.map((t) => (t.cut ? { ...t, args: WHOLE, cut: undefined } : t)), text: item.more ? Array.from({ length: 120 }, (_, i) => `line ${i + 1} of the full tool result`).join("\n") : item.text };
		},
	});
	/** A demo terminal: its screen once a second while a tile shows it, every row first, then the two rows that change. */
	const panes = new Map<string, ReturnType<typeof setInterval>>();
	const mirror = (key: string, on: boolean, n = 0, name = units(net).find((u) => u.key === key)?.name ?? key) => {
		clearInterval(panes.get(key));
		const beat = (rows = demoScreen(name, n++)) => current?.send("mirror", { key, seq: n, rows: rows.length, cols: 60, ...(n === 1 && { whole: true }), set: n === 1 ? rows.map((r, i) => [i, r]) : [5, 8].map((i) => [i, rows[i]]) });
		if (on) (beat(), panes.set(key, setInterval(beat, 1000)));
		return { ok: true, status: 200, body: { attached: on } };
	};
	/** An answer lands at once, and the unit goes back to work a moment later. */
	const answered = (key: string) => {
		// The unit is found when the answer lands: the tick clones the net meanwhile.
		setTimeout((u = units(net).find((x) => x.key === key)) => u && ((u.mark = "working"), (u.note = "thinking"), (u.pending = undefined), (net = structuredClone(net)), current?.send("message", net)), 1500);
		return { ok: true, status: 200, body: { outcome: "accepted" } };
	};
	return { open: (watch) => new FixtureSource(watch), data, control };
}

function mountToolbar(control: Control) {
	const bar = document.createElement("div");
	bar.style.cssText = "position:fixed;left:12px;bottom:12px;z-index:9;display:flex;gap:8px;align-items:center;padding:8px 10px;border-radius:12px;background:#0e1628;border:1px solid #2a3a60;font:12px system-ui;color:#8b99ba";
	// On a phone it folds to a "demo" tab in the right margin, which no panel reaches; a tap shows the rest.
	const phone = innerWidth < 640;
	if (phone) bar.style.cssText += ";left:auto;bottom:auto;right:0;top:40%;writing-mode:vertical-rl;flex-direction:column;padding:6px 1px;gap:4px";
	const buttons = [["demo", () => buttons.slice(1).forEach((b) => (b.style.display = b.style.display ? "" : "none"))], ["drop stream", control.drop], ["go silent", control.silence], ["restore", control.restore], ["doc arrives", control.doc]].map(([label, run]) => {
		const button = document.createElement("button");
		[button.textContent, button.onclick] = [label as string, run as () => void];
		button.style.cssText = `all:unset;cursor:pointer;padding:3px 9px;border-radius:8px;background:#1a2748;color:#dbe6ff;${phone ? "padding:8px 1px;" : ""}${label !== "demo" && phone ? "display:none" : ""}`;
		return button;
	});
	bar.append(...buttons);
	document.body.append(bar);
}
