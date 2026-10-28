import { trackActivity } from "../src/activity.ts";
import type { Mark } from "../src/netdata.ts";
import type { Net, TowerService, Unit } from "../src/net.ts";
import type { Data, Page } from "./chat.ts";
import { demoOpen } from "./demo-open.ts";
import { DEMO_DOC, DEMO_PAGE, demoHistory, demoScreen, WHOLE } from "./demo-chat.ts";
import { docHooks } from "./doc.ts";
import type { Source } from "./stream.ts";

// The demo net for `npm run gui:dev`: invented names, state changes on a timer, and a stream that can be dropped to see the
// disconnected page. It stands in for the server's EventSource, so the real reconnect logic runs against it.

const unit = (id: string, name: string, role: Unit["role"], mark: Mark, note?: string, subs: Unit[] = []): Unit => ({ id, key: id, control: true, name, role, mark, note, subs });
// What the nth wait is on: a secret_drop that only waits in the terminal (odd n), two questions as ask_user_question asks them (n % 4 == 2), or robot_hand's selector.
const two = [{ header: "Window", question: "When should the ops deploy go out?", options: [{ title: "Tonight 22:00", description: "Low traffic; on-call is awake." }, { title: "Tomorrow 08:00" }], multiple: false, freeform: true }, { header: "Notify", question: "Who should be told?", options: [{ title: "ops" }, { title: "billing" }, { title: "support" }], multiple: true, freeform: true }];
const hand = { title: "Robot Hand — Deploy needs your sudo password\n\n  ! npm run deploy", copy: "npm run deploy", choices: [{ label: "Type it into a new Herdr pane (I press Enter)", note: "Opens a pane with the command typed; press Enter there" }, { label: "Put it in my prompt", note: "Lands in the terminal's prompt; press Enter there" }, { label: "Copy it to my clipboard", note: "Copies on this computer", localOnly: true as const }, { label: "No, thanks" }] };
const ask = (n: number): Unit["pending"] => (n % 2 ? { callId: `demo-${n}`, tool: "secret_drop", why: "It waits for a secret." } : { callId: `demo-${n}`, ...(n % 4 ? { tool: "ask_user_question", asks: two, answer: { dialog: `d${n}`, digest: "0".repeat(64), questions: two } } : { tool: "robot_hand", answer: { dialog: `d${n}`, digest: "0".repeat(64), select: hand } }) });
const doc = (cap: string, display: string, reason: string, revision = 1) => ({ cap, display, kind: display.endsWith(".html") ? ("html" as const) : ("text" as const), reason, revision, onScreen: true });
const demo = (): Net => ({
	bases: [
		{ id: "w1", label: "Harbor API", mark: "working", head: true, tower: { name: "tower · Harbor API", mark: "working", key: "t1", control: true, subs: [unit("t1/triage", "triage-scout", "subagent", "working", "tool:read")] }, outposts: [{ id: "w1-fix", label: "harbor-api-hotfix", mark: "working" }], outside: [unit("o1", "scratch-notes", "outside", "idle")], tabs: [
			{ id: "w1:t1", label: "billing", units: [{ todo: { done: 2, total: 5, now: "Fixing the ledger rounding order" }, ...unit("a1", "billing-main", "main", "commanding", "watching a monitor", [unit("a1/lint", "lint-sweep", "subagent", "working", "tool:bash"), { ...unit("a1/docs", "docs-writer", "subagent", "done", "finished"), ended: true }]), docs: [doc("plan", "docs/rollout-plan.md", "Rollout plan ready"), doc("review", "docs/ledger-review.html", "Review the ledger fix and pick a window")], queued: [{ text: "Also check the refund path while you are in there.", as: "steer" }, { text: "While you are at it, please also look at how the rounding behaves for credit notes issued across a month end, for refunds split over several payments, and for invoices in a currency with no minor unit, then tell me which of those need their own regression test before we ship the ledger fix.", as: "steer" }, { text: "When done, write a short summary for the changelog.", as: "followUp" }], monitors: [{ id: "3", what: "billing dev server on 5173", status: "running", lines: 48, at: 3, last: "12:04:51 [vite] hmr update /src/ledger.ts" }, { id: "2", what: "ledger integration tests", status: "error", exit: 1, lines: 212, at: 2, ended: 4, last: "✖ rounds half-cent refunds down (expected 10.01, got 10.00)" }] }, unit("a2", "billing-tests", "member", "idle"), { ...unit("a4", "billing-old", "member", "working", "tool:edit"), control: false, ended: true }] },
			{ id: "w1:t2", label: "ops", units: [{ todo: { done: 1, total: 3, now: "Checking the migration runs before traffic" }, ...unit("a3", "ops-main", "main", "waiting", "waiting on a question"), pending: ask(0) }] },
		] },
		{ id: "w2", label: "Lighthouse Web", mark: "working", head: false, tower: { name: "tower · Lighthouse Web", mark: "idle", key: "t2", control: true, subs: [] }, outposts: [], outside: [], tabs: [
			{ id: "w2:t1", label: "checkout", units: [{ todo: { done: 3, total: 4, now: "Writing the checkout e2e test" }, ...unit("b1", "checkout-main", "main", "working", "thinking", [unit("b1/e2e", "e2e-runner", "subagent", "working", "thinking")]) }, { ...unit("b2", "claude-checkout", "member", "working", "tool:read"), control: false, agent: "claude" as const }] },
		] },
		{ id: "w3", label: "Orchard Data", mark: "idle", head: false, tower: { name: "tower · Orchard Data", mark: "done", key: "t3", control: true, subs: [] }, outposts: [], outside: [], tabs: [
			{ id: "w3:t1", label: "etl", units: [unit("c1", "etl-main", "main", "idle")] },
		] },
		{ id: "w4", label: "Quarry Tools", mark: "idle", head: false, tower: null, outposts: [], outside: [], tabs: [{ id: "w4:t1", label: "quarry", units: [unit("d1", "quarry-scout", "member", "idle")] }] },
	],
	stashed: [{ name: "Juniper Lab", label: "Juniper Lab", at: "2026-10-22T09:00:00.000Z" }, { name: "night run", label: "Harbor API", at: "2026-10-22T08:00:00.000Z" }],
});

// Where each state can go next: work mostly continues, sometimes asks a question or finishes; an error is rare.
const NEXT: Record<Mark, Mark[]> = { working: ["working", "waiting", "idle", "done", "commanding"], commanding: ["working", "commanding", "idle"], waiting: ["working"], idle: ["working"], done: ["working"], error: ["working"], unknown: ["working"] };
const units = (net: Net) => net.bases.flatMap((b) => [...(b.tower?.subs ?? []), ...b.tabs.flatMap((t) => t.units.flatMap((u) => [u, ...u.subs]))]);

// The harbor tower as the sb server's service shows it in each state of the boss conversation (src/server/runs.ts): `?tower=<state>` starts the demo in one, and the toolbar's "tower" button steps through them.
// The runs' times match the demo history of the tower's comms (demo-chat.ts), so the dividers fall between its rounds.
const stamp = (n: number) => new Date(Date.UTC(2026, 9, 17, 8, 0, 0) + n * 47_000).toISOString();
const TOWER_STATES = ["working", "waiting", "new", "closing", "inrun", "standing", "off"] as const;
type TowerState = (typeof TOWER_STATES)[number];
/** The boss spoke to an event run that is still live: no conversation, the run's own chip is the comms, and its heading names it. */
const inRun = (): TowerService => ({
	state: "running", queued: 0, notices: [], parked: [], allyRuns: [], run: { id: "e3", kind: "local", startedAt: stamp(420) }, bossIn: { id: "e3", since: stamp(424) },
	localRuns: [
		{ id: "c2", kind: "conversation", resumed: true, startedAt: stamp(204), endedAt: stamp(380), outcome: "quit", note: "(ended idle)" },
		{ id: "e3", kind: "event", startedAt: stamp(420), key: "run-e3" },
	],
});
function towerService(state: TowerState): { service?: TowerService; mark: Mark } {
	if (state === "off") return { mark: "working" };
	if (state === "inrun") return { mark: "working", service: inRun() };
	const live = state !== "standing", idle = state === "waiting", began = stamp(420);
	const localRuns: NonNullable<TowerService["localRuns"]> = [
		{ id: "c1", kind: "conversation", resumed: false, why: "no earlier boss session", startedAt: stamp(5), endedAt: stamp(150), outcome: "done", note: "(boss quit)" },
		{ id: "e1", kind: "event", startedAt: stamp(160), endedAt: stamp(171), outcome: "done", note: "routed the green build to docs", key: "run-e1" },
		{ id: "e2", kind: "event", startedAt: stamp(180), endedAt: stamp(190), outcome: "crashed", note: "(crashed: pi exited without tower_done)" },
		{ id: "c2", kind: "conversation", resumed: true, startedAt: stamp(204), endedAt: stamp(380), outcome: "quit", note: "(ended idle)" },
		{ id: "c3", kind: "conversation", resumed: state !== "new", ...(state === "new" ? { why: "the boss asked for a new one (/new)" } : {}), startedAt: began, ...(live ? {} : { endedAt: stamp(436), outcome: "done", note: "(boss quit)" }) },
	];
	const service: TowerService = {
		state: live ? (state === "closing" ? "closing" : "running") : "standing", queued: state === "standing" ? 0 : 1, notices: [], parked: [], allyRuns: [], localRuns,
		...(live ? { run: { id: "c3", kind: "local" as const, startedAt: began }, conversation: { since: began, resumed: state !== "new", ...(state === "new" ? { why: "the boss asked for a new one (/new)" } : {}), turns: state === "new" ? 0 : 14, idle, ...(idle ? { idleAt: Date.now() + 7 * 60_000 } : {}), idleMs: 600_000, capAt: Date.now() + 3.4 * 3_600_000, ...(state === "closing" ? { closing: true as const } : {}) } } : { lastRun: { endedAt: stamp(436), outcome: "done" } }),
	};
	return { service, mark: !live ? "idle" : idle ? "idle" : "working" };
}

export interface Control { drop(): void; silence(): void; restore(): void; doc(): void; tower(state?: string): void }

export function createFixture({ resume, tick = 2500 }: { resume(): void; tick?: number }): { open(watch: string | null): Source; data(key: string): Data; control: Control } {
	demoOpen(); // the opening tiles' folder picker and deploy, with no server
	let towerNow: TowerState = "off";
	let net = demo(), step = 0, waits = 0, dropped = false, silent = false, current: FixtureSource | undefined, live = 0, notes = 0;
	// The demo documents stand in for the server's: the HTML one as a data: page, the text ones from here.
	[docHooks.src, docHooks.load] = [() => `data:text/html;charset=utf-8,${encodeURIComponent(DEMO_PAGE)}`, async (cap) => ({ text: cap === "plan" ? DEMO_DOC : `# Notes ${cap.slice(5)}\n\nA demo document that arrived on its own.` })];
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
				this.timers.push(setTimeout(() => this.send("history", { key: watch, state: "live", reset: true, ...page(), ...(watch.startsWith("run-") ? { role: "run", name: watch.slice(4, 12) } : {}), header: { id: watch, cwd: "/work/harbor-api" }, unreadable: 0, todos: [{ id: 1, subject: "Find where the rounding happens", status: "completed" }, { id: 2, subject: "Fix the ledger rounding before tax", status: "in_progress", activeForm: "fixing the ledger rounding" }, { id: 3, subject: "Add a regression test for credit notes", status: "pending" }] }), 250));
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
	// Every tick one agent changes state, so the page always has something moving; the server's activity tracker runs over each snapshot.
	let clock = Date.now();
	const track = trackActivity(() => clock), TOOLS = ["tool:edit", "tool:bash", "tool:read", "thinking"];
	const advance = () => {
		const all = units(net);
		const pick = all[step % all.length]!;
		if (pick.pending?.answer) return void step++; // a dialog the page can answer stays until it is answered
		const options = NEXT[pick.mark];
		pick.mark = step % 17 === 16 ? "error" : options[step % options.length]!;
		pick.note = pick.mark === "working" ? TOOLS[step % TOOLS.length] : pick.mark === "waiting" ? "waiting on a question" : undefined;
		pick.pending = pick.mark === "waiting" ? ask(++waits) : undefined;
		net = track(structuredClone(net));
		step++;
		return true;
	};
	// The demo starts with most of half an hour behind it, so the timeline and the cards' clocks have something to show.
	for (let i = 41; i > 0; i--) ((clock = Date.now() - i * 40_000), i === 41 ? (net = track(net)) : advance());
	setInterval(() => ((clock = Date.now()), advance() && current?.send("message", net)), tick);
	const control: Control = {
		drop: () => ((dropped = true), current?.fail()),
		silence: () => (silent = true),
		restore: () => ((dropped = false), (silent = false), resume()),
		// billing-main shows a new document: on its comms it opens as a tile without focus; elsewhere its token gets the scroll badge.
		tower: (state) => {
			towerNow = TOWER_STATES.includes(state as TowerState) ? (state as TowerState) : TOWER_STATES[(TOWER_STATES.indexOf(towerNow) + 1) % TOWER_STATES.length]!;
			const harbor = net.bases[0]!.tower!, shown = towerService(towerNow);
			(harbor.mark = shown.mark), (harbor.service = shown.service);
			net = structuredClone(net);
			current?.send("message", net);
		},
		doc: () => ((units(net).find((u) => u.key === "a1")!.docs = [...(units(net).find((u) => u.key === "a1")!.docs ?? []), doc(`note-${++notes}`, `docs/notes-${notes}.md`, "Notes for review")]), (net = structuredClone(net)), current?.send("message", net)),
	};
	const start = new URLSearchParams(location.search).get("tower");
	if (start) control.tower(start);
	mountToolbar(control);
	const data = (key: string): Data => ({
		older: async (before) => page(before),
		latest: async () => page(),
		// Input is accepted, and shows in the log a moment later as pi would write it.
		post: async (action, body) => (action === "commands" ? { ok: true, status: 200, body: { commands: [{ name: "review", source: "prompt", description: "Review the current diff" }, { name: "boss", source: "extension", description: "Straw Boss: gui, status, join" }, { name: "skill:release", source: "skill", description: "Cut a release" }].filter((c) => c.name.includes(String(body.prefix))) } } : action === "dequeue" ? { ok: true, status: 200, body: { text: "Also check the refund path while you are in there.\n\nWhen done, write a short summary for the changelog." } } : action === "answer" ? answered(key) : action === "mirror" ? mirror(key, body.on === true) : action === "keys" && body.key === "enter" && !body.confirmed ? { ok: false, status: 409, body: { error: "confirm", confirm: "reload", reason: "Enter would run /reload (or the command picked in pi's menu, if it is open), which ends or replaces this session. Enter goes to whatever has focus in the terminal; confirm to send it." } } : (action === "input" && setTimeout(() => current?.send("history", { key, reset: false, items: [{ id: `you-${++live}`, kind: "user", at: new Date().toISOString(), text: String(body.text) }] }), 700), { ok: true, status: 200, body: {} })),
		// Demo images, drawn as SVG: the user's two on the last round, the read result's one, and a broken third index.
		pic: (id, n) => (n > 1 ? "data:," : `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${n ? 900 : 640}" height="${n ? 1400 : 360}"><rect width="100%" height="100%" fill="${id.startsWith("r") ? "#1f3a5f" : n ? "#3d2a5c" : "#14532d"}"/><text x="50%" y="50%" fill="#fff" font-size="48" text-anchor="middle" font-family="sans-serif">${id} · ${n + 1}</text></svg>`)}`),
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
	bar.style.cssText = "position:fixed;right:12px;bottom:12px;max-width:300px;flex-wrap:wrap;z-index:9;display:flex;gap:8px;align-items:center;padding:8px 10px;border-radius:12px;background:#0e1628;border:1px solid #2a3a60;font:12px system-ui;color:#8b99ba";
	// On a phone it folds to a "demo" tab in the right margin, which no panel reaches; a tap shows the rest.
	const phone = innerWidth < 640;
	if (phone) bar.style.cssText += ";max-width:none;bottom:auto;right:0;top:40%;writing-mode:vertical-rl;flex-direction:column;padding:6px 1px;gap:4px";
	const buttons = [["demo", () => buttons.slice(1).forEach((b) => (b.style.display = b.style.display ? "" : "none"))], ["drop stream", control.drop], ["go silent", control.silence], ["restore", control.restore], ["doc arrives", control.doc], ["tower", () => control.tower()], ["drawer", () => document.dispatchEvent(new Event("sb-drawer"))]].map(([label, run]) => {
		const button = document.createElement("button");
		[button.textContent, button.onclick] = [label as string, run as () => void];
		button.style.cssText = `all:unset;cursor:pointer;padding:3px 9px;border-radius:8px;background:#1a2748;color:#dbe6ff;${phone ? "padding:8px 1px;" : ""}${label !== "demo" && phone ? "display:none" : ""}`;
		return button;
	});
	bar.append(...buttons);
	document.body.append(bar);
}
