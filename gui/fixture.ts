import { trackActivity } from "../src/activity.ts"; import { CHOICES } from "../src/views.ts";
import type { Mark } from "../src/netdata.ts";
import type { Net, TowerService, Unit } from "../src/net.ts";
import type { Data, Page } from "./chat.ts";
import { demoCard, isCard, stepOf } from "./democard.ts";
import { allyDemo } from "./demo-ally.ts";
import { boxDemo } from "./demo-box.ts";
import { isLinkState, linkDemo } from "./demo-link.ts";
import { demoOpen } from "./demo-open.ts";
import { DEMO_BLOCKS_DOC, demoImage } from "./demo-blocks.ts";
import { DEMO_DOC, DEMO_PAGE, demoHistory, demoScreen, WHOLE } from "./demo-chat.ts";
import { boardFromUrl, demoTodos } from "./demo-board.ts";
import { headDemo, headDraft, headHistory, headInput, headReport, type HeadState, isHeadState } from "./demo-head.ts";
import { answeredHooks } from "./answered.ts";
import { cardsReply, cardWaits, headCardWait } from "./demo-waits.ts";
import { docHooks } from "./doc.ts";
import type { Answer } from "./post.ts";
import { type Source, WATCHDOG_MS } from "./stream.ts";
import { openThen } from "./terminalthen.ts";
import { kindsFromUrl } from "./demo-kinds.ts";
import { trainsFromUrl } from "./demo-trains.ts";
import { installAutoDemo } from "./demo-auto.ts";
import { RUN_STATES, runsFromUrl, runsHeadless } from "./demo-runs.ts";

// The demo net for `npm run gui:dev`: invented names, state changes on a timer, and a stream that can be dropped to see the
// disconnected page. It stands in for the server's EventSource, so the real reconnect logic runs against it.

const unit = (id: string, name: string, role: Unit["role"], mark: Mark, note?: string, subs: Unit[] = []): Unit => ({ id, key: id, control: true, name, role, mark, note, subs });
// What the nth wait is on: a secret_drop that only waits in the terminal (odd n), two questions as ask_user_question asks them (n % 4 == 2; rpiv takes a cancel, so the card has Cancel), or robot_hand's selector (no cancel path).
/** `?zen=long`: one multi-select question as long as an agent's real one, four described choices, and the own-answer box, the shape that once squeezed the box shut. */
const LONG = [{ header: "Companion", question: "When nothing waits, Zen keeps a session beside you. This time it showed the tower's old log, and the page said neither why it was that one nor what comes next. Which of these changes do you want?", options: [{ title: "Add one line that explains it", description: "Under the strip, a faint line: nothing waits for you, the session beside you is the tower ([ ] to change)" }, { title: "Default to a main, not a tower", description: "With no companion chosen, prefer the main agent you used last; a tower's log is mostly relayed messages" }, { title: "Fold the tool calls", description: "On the companion, the JSON of a tower's replies and every tool call fold to one line, and only the talk stays" }, { title: "Only the breathing circle by default", description: "With nothing waiting, only the circle and the strip; a session shows after [ ] or ⌘K picks one" }], multiple: true, freeform: true }];
const two = [{ header: "Window", question: "When should the ops deploy go out?", options: [{ title: "Tonight 22:00", description: "Low traffic; on-call is awake." }, { title: "Tomorrow 08:00" }], multiple: false, freeform: true }, { header: "Notify", question: "Who should be told?", options: [{ title: "ops" }, { title: "billing" }, { title: "support" }], multiple: true, freeform: true }];
const hand = { title: "Robot Hand — Deploy needs your sudo password\n\n  ! npm run deploy", copy: "npm run deploy", choices: [{ label: "Type it into a new Herdr pane (I press Enter)", note: "Opens a pane with the command typed; press Enter there", next: "pane" as const }, { label: "Run it in a new Herdr pane", note: "Opens a pane that runs the command", next: "pane" as const }, { label: "Put it in my prompt", note: "Lands in the terminal's prompt; press Enter there", next: "terminal" as const }, { label: "Copy it to my clipboard", note: "Copies on this computer", localOnly: true as const }, { label: "No, thanks" }] };
const ask = (n: number): Unit["pending"] => (n % 2 ? { callId: `demo-${n}`, tool: "secret_drop", why: "It waits for a secret." } : { callId: `demo-${n}`, ...(n % 4 ? { tool: "ask_user_question", asks: two, answer: { dialog: `d${n}`, digest: "0".repeat(64), cancel: true as const, questions: two } } : { tool: "robot_hand", answer: { dialog: `d${n}`, digest: "0".repeat(64), select: hand } }) });
const doc = (cap: string, display: string, reason: string, revision = 1) => ({ cap, display, kind: display.endsWith(".html") ? ("html" as const) : display.endsWith(".md") ? ("blocks" as const) : ("text" as const), reason, revision, onScreen: true });
const demo = (): Net => ({
	bases: [
		{ id: "w1", label: "Harbor API", mark: "working", tower: { name: "tower · Harbor API", mark: "working", key: "t1", control: true, subs: [{ ...unit("t1/triage", "triage-scout", "subagent", "working", "tool:read"), duty: "scout" }] }, outposts: [{ id: "w1-fix", label: "harbor-api-hotfix", mark: "working" }], outside: [unit("o1", "scratch-notes", "outside", "idle")], tabs: [
			{ id: "w1:t1", label: "billing", units: [{ todo: { done: 2, total: 5, now: "Fixing the ledger rounding order" }, duty: "coordinator", ...unit("a1", "billing-main", "main", "commanding", "watching a monitor", [{ ...unit("a1/lint", "lint-sweep", "subagent", "working", "tool:bash"), duty: "worker" }, { ...unit("a1/docs", "docs-writer", "subagent", "done", "finished"), duty: "planner", ended: true }]), docs: [doc("plan", "docs/rollout-plan.md", "Rollout plan ready"), doc("review", "docs/ledger-review.html", "Review the ledger fix and pick a window"), doc("blocks", "docs/release-blocks.md", "Every kind of block")], queued: [{ text: "Also check the refund path while you are in there.", as: "steer" }, { text: "While you are at it, please also look at how the rounding behaves for credit notes issued across a month end, for refunds split over several payments, and for invoices in a currency with no minor unit, then tell me which of those need their own regression test before we ship the ledger fix.", as: "steer" }, { text: "When done, write a short summary for the changelog.", as: "followUp" }], monitors: [{ id: "3", what: "billing dev server on 5173", status: "running", lines: 48, at: 3, last: "12:04:51 [vite] hmr update /src/ledger.ts" }, { id: "2", what: "ledger integration tests", status: "error", exit: 1, lines: 212, at: 2, ended: 4, last: "✖ rounds half-cent refunds down (expected 10.01, got 10.00)" }] }, unit("a2", "billing-tests", "member", "idle"), { ...unit("a4", "billing-old", "member", "done", "finished"), control: false, ended: true }] },
			{ id: "w1:t2", label: "ops", units: [{ todo: { done: 1, total: 3, now: "Checking the migration runs before traffic" }, duty: "standing", ...unit("a3", "ops-main", "main", "waiting", "waiting on a question"), pending: ask(0) }] },
		] },
		{ id: "w2", label: "Lighthouse Web", mark: "working", tower: { name: "tower · Lighthouse Web", mark: "idle", key: "t2", control: true, subs: [] }, outposts: [], outside: [], tabs: [
			{ id: "w2:t1", label: "checkout", units: [{ todo: { done: 3, total: 4, now: "Writing the checkout e2e test" }, duty: "integrator", ...unit("b1", "checkout-main", "main", "working", "thinking", [{ ...unit("b1/e2e", "e2e-runner", "subagent", "working", "thinking"), duty: "reviewer" }]) }, unit("b2", "checkout-member", "member", "working", "tool:read")] },
		] },
		{ id: "w3", label: "Orchard Data", mark: "idle", tower: { name: "tower · Orchard Data", mark: "done", key: "t3", control: true, subs: [] }, outposts: [], outside: [], tabs: [
			{ id: "w3:t1", label: "etl", units: [{ ...unit("c1", "etl-main", "main", "idle", undefined, [{ ...unit("c1/watch", "queue-scout", "subagent", "idle"), duty: "scout" }]), duty: "coordinator" }] },
		] },
		{ id: "w4", label: "Quarry Tools", mark: "idle", tower: null, outposts: [], outside: [], tabs: [{ id: "w4:t1", label: "quarry", units: [unit("d1", "quarry-scout", "member", "idle")] }] },
	],
	// An unattended device of a team: its ally base with the unit-status it sent, and a notice it raised (src/link/unitstatus.ts).
	link: {
		allies: [{ id: "t/d1/Harbor API", team: "t", teamName: "moldplan", device: "d1", short: "9f3a1c", label: "ci-box", online: true, unattended: true, workspace: "Harbor API", tower: "working", tabs: [{ label: "tower", state: "working" }, { label: "billing", state: "idle" }] }],
		alerts: [{ id: "notice/1", kind: "notice", level: "warning", team: "t", teamName: "moldplan", data: { device: "d1", label: "ci-box", short: "9f3a1c", what: "run-crashed", unit: "Harbor API", text: "An ally run crashed: pi exited without tower_done" } },
			{ id: "dialog/d1/D1", kind: "dialog", level: "info", team: "t", teamName: "moldplan", data: { device: "d1", dialogId: "D1", digest: "0".repeat(64), owner: "rpiv", dialog: JSON.stringify({ select: { title: "Deploy to staging?", choices: [{ label: "Yes" }, { label: "No" }] } }), label: "ci-box", short: "9f3a1c", answered: 1, closed: "remote" } }],
		confirms: [],
		units: [{ team: "t", device: "d1", at: 0, units: [{ unit: "Harbor API", state: "running", monitors: ["tail -f deploy.log", "npm run watch"], report: "Deployed v1.2 to staging.\nMigration 0042 applied; smoke tests green.\nNext: waiting for the review of the ledger fix." }] }],
	},
	stashed: [{ name: "Juniper Lab", label: "Juniper Lab", at: "2026-10-22T09:00:00.000Z" }, { name: "night run", label: "Harbor API", at: "2026-10-22T08:00:00.000Z" }],
});

// Where each state can go next: work mostly continues, sometimes asks a question or finishes; an error is rare.
const NEXT: Record<Mark, Mark[]> = { working: ["working", "waiting", "idle", "done", "commanding"], commanding: ["working", "commanding", "idle"], waiting: ["working"], idle: ["working"], done: ["working"], error: ["working"], unknown: ["working"] };
const units = (net: Net) => net.bases.filter((b) => !b.box).flatMap((b) => [...(b.tower?.subs ?? []), ...b.tabs.flatMap((t) => t.units.flatMap((u) => [u, ...u.subs]))]); // the local bases' (the demo's clock and the Zen states move these); a remote base (`?operate=`, demo-box.ts) stands still
const everyUnit = (net: Net) => net.bases.flatMap((b) => [...(b.tower?.subs ?? []), ...b.tabs.flatMap((t) => t.units.flatMap((u) => [u, ...u.subs]))]);

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

const HEAL_MS = 8000, SERVER_VIEWS: readonly string[] = CHOICES;
export interface Control { drop(): void; silence(): void; restore(): void; doc(): void; hand(): void; tower(state?: string): void; /** The server's default view changes, as `/boss gui view` does: the stream's `view` event (no value: the next of src/views.ts CHOICES: Auto, Standard, Geek, Raven Keep; Zen is a mode, never the server's). */ serverView(view?: string): void }

/** What the demo's key pad hears: Enter and Esc need a confirm (the server's English words, which the page replaces by token), Tab is refused. */
const PAD_REPLIES: Record<string, { ok: boolean; status: number; body: Record<string, unknown> }> = {
	enter: { ok: false, status: 409, body: { error: "confirm", confirm: "reload", reason: "Enter would run /reload (or the command picked in pi's menu, if it is open), which ends or replaces this session. Enter goes to whatever has focus in the terminal; confirm to send it." } },
	esc: { ok: false, status: 409, body: { error: "confirm", confirm: "double-esc", reason: "A second Escape on an idle session runs pi's double-Escape action (tree or fork); confirm to run it." } },
	tab: { ok: false, status: 409, body: { error: "blocked", reason: "While it waits on a secret or a question only Escape is sent from here; answer the question in its panel or the terminal." } },
};
// `?zen=<state>` starts the page in Zen mode (main.ts: `sb.zen` = 1 in the demo's own store) with the net in one state: `item` (ops-main's robot_hand select, the default net), `questions` (its two-question form), `secret` (a secret_drop, read-only), `words` (it waits with no dialog), `trust` (a project trust question, then ops-main), `long` (one long multi-select question with four described choices and the own-answer box), `idle` (nothing waits: the companion billing-main, the first visit's start), `alone` (nothing waits, a plain visit: the breathing circle and its line), `link-confirm`, `link-dialog`, `pair` and `proposal` (the link cards, demo-link.ts; `&refuse` makes the server refuse the answer; the pair number is 4821), `blocking` (a tower's wait is the card; a box's question arrives `&box=<ms>` later, 6000 by default: Z-D18), `chain` (three units ask the Robot Hand select: ops-main, billing-main and checkout-main; Enter takes the first card two seconds in, and each answer is followed by the next with no pause: Z-D22; `&queued` leaves all three waiting). `?card=<state>` (democard.ts) opens the terminal card a moment after the page starts, in either view. The idle states make no new waits for a minute and a half. Three more states press a key a moment after the page starts, for pictures: `history` is `item` with the card's 前情 (H) open, `palette` is `idle` with the command palette (⌘K, Ctrl+K off a Mac) open, `pause` is `item` answered at once, so the 3 s breathing pause shows. `settled` is `item` whose question is answered elsewhere `&settle=<ms>` on (6000): the card stays and says so (Z-D20); with `&left` the unit leaves the net instead and the card says that. On `idle` (the companion billing-main), `&end=<ms>` ends its session that long after the page starts and `&lost=<ms>` takes its control: the screen stays with a quiet note and its composer off (Z-D20). `&box=<ms>` (any state) sends a box's question that long after the page starts: it queues, nothing takes the screen for it. `&upgrade=<ms>` (any state) announces a new build that long after the page starts, once for the browser session: a Zen page waits for the breath with a quiet line (core.upgrade). `?music=<n>` gives the demo a music folder of n invented tracks (1 to 6; none by default, so the ♪ stays hidden); the demo has no audio file, so a track that is switched on says "tap to play" (`localStorage` `sb.zen.music` = 1 switches it on).
const zenState = (net: Net, extra: string | null) => {
	const state = extra === "palette" ? "idle" : extra?.startsWith("head") || extra === "addressed" || (RUN_STATES as readonly string[]).includes(extra ?? "") ? "alone" : extra === "history" || extra === "pause" || extra === "settled" ? "item" : extra; // head, head-open, head-history: nothing waits (the strip is under the circle)
	const main = units(net).find((u) => u.key === "a3")!;
	if (state === "trust") net.trust = [{ id: "tr1", digest: "t".repeat(64), folder: "/work/harbor-api", found: [{ kind: "skills", path: ".pi/skills", items: ["deploy", "release", "triage"], more: 0 }, { kind: "extensions", path: ".pi/extensions", items: ["harbor-hooks.ts"], more: 0 }], agents: [{ pane: "1", base: "Harbor API", role: "member", at: Date.now() - 50 * 60_000 }] }];
	// Only ops-main waits at first (the idle states: nothing does), so the first item is the one the state names.
	for (const u of units(net)) if (u.key !== "a3" || state === "idle" || state === "alone" || state === "blocking" || isLinkState(state ?? null)) if (u.mark === "waiting" || u.pending) [u.mark, u.note, u.pending] = ["working", "thinking", undefined];
	if (state === "questions" || state === "secret") main.pending = ask(state === "secret" ? 1 : 2);
	if (state === "words") main.pending = undefined;
	if (state === "chain") for (const [key, n] of [["a3", 0], ["a1", 4], ["b1", 8]] as const) Object.assign(units(net).find((u) => u.key === key)!, { mark: "waiting", note: "waiting on a question", pending: ask(n) }); // ops-main, billing-main and checkout-main each ask the Robot Hand select (Z-D22)
	if (state === "long") main.pending = { callId: "demo-long", tool: "ask_user_question", asks: LONG, answer: { dialog: "dlong", digest: "0".repeat(64), cancel: true as const, questions: LONG } };
	return net;
};

export function createFixture({ resume, tick = 2500 }: { resume(): void; tick?: number }): { open(watch: string | null): Source; data(key: string): Data; control: Control; trust(body: { id: string }): Promise<Answer>; api(path: string): Promise<unknown>; start(): { key: string; ws: string } | undefined } {
	demoOpen(); // the opening tiles' folder picker and deploy, with no server
	let towerNow: TowerState = "off", serverNow: string = "auto";
	const zen = new URLSearchParams(location.search).get("zen"), cardParam = new URLSearchParams(location.search).get("card");
	/** The terminal card's script (democard.ts): `?card=<state>` starts one; an answer that leaves a terminal step starts the default one (a pane types its command, "Run it" runs it). */
	let card = isCard(cardParam) ? demoCard(cardParam, (type, payload) => current?.send(type, payload)) : undefined;
	let net: Net = { ...demo(), autoable: true }, step = 0, waits = 0, dropped = false, silent = false, current: FixtureSource | undefined, live = 0, notes = 0;
	const boxes = boxDemo(net, new URLSearchParams(location.search).get("operate")); // `?operate=live,unreachable,revoked,refused|more|all`: remote bases of an unattended box (demo-box.ts)
	// `?waits=cards` (demo-waits.ts: the fonstar case, then one card of each kind and state; its presses are answered there). `?wait=fresh|stale|both`: the tower records a wait on the boss (20 minutes old: an alert; three days old: only the card's line, marked as out of date); the memory route's drop is this stand-in's.
	const waitDemo = new URLSearchParams(location.search).get("wait") ?? (new URLSearchParams(location.search).get("waits") === "cards" || new URLSearchParams(location.search).has("auto") ? "cards" : zen === "blocking" ? "fresh" : null);
	const waitRefuse = new URLSearchParams(location.search).has("waitrefuse");
	/** The server's `answers` on a message to the tower: the wait is marked answered, and the next snapshot says so (the alert goes). */
	const answerWait = (id: unknown) => { const w = net.bases[0]!.tower?.service?.memory?.bossWaits.find((x) => x.id === id); return w ? ((w.answered = new Date().toISOString()), (net = structuredClone(net)), current?.send("message", net), w.id) : false; }; // `&waitrefuse`: the tower refuses what the boss sends it (the wait panel's refusal)
	if (waitDemo) {
		const old = { id: "W1", text: "Boss token needed to add the Tailscale ACL cloud-pub to gx10:443", at: new Date(Date.now() - 3 * 86_400_000).toISOString() }, fresh = { id: "W2", text: "api-fix asks: deploy ws01?", at: new Date(Date.now() - 20 * 60_000).toISOString() };
		const bossWaits = waitDemo === "cards" ? cardWaits(Date.now()) : waitDemo === "stale" ? [old] : waitDemo === "fresh" ? [fresh] : [old, fresh];
		net.bases[0]!.tower!.service = { ...towerService("standing").service!, memory: { rev: 3, standing: 0, decisions: 0, waits: bossWaits.length, bossWaits, proposals: [] } };
		const real = globalThis.fetch;
		globalThis.fetch = async (input, init) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			// The map card's wait row sends the boss's words through the page's own route (no fixture seam there): the tower's session input.
			if (/api\/sessions\/[^/]+\/input$/.test(url) && decodeURIComponent(url.split("/").at(-2)!) === net.bases[0]!.tower!.key) return new Response(JSON.stringify(waitRefuse ? { error: "refused", reason: "The sb server stands in for no tower of workspace w1" } : { accepted: true, woke: true, answered: answerWait((JSON.parse(String(init?.body)) as { answers?: string }).answers) }), { status: waitRefuse ? 409 : 200, headers: { "content-type": "application/json" } });
			if (!/api\/(tower\/\w+|head)\/memory$/.test(url)) return real(input, init);
			const memory = (/api\/head\/memory$/.test(url) ? net.head?.service?.memory : net.bases[0]!.tower!.service!.memory)!, id = (JSON.parse(String(init?.body)) as { id: string }).id;
			if (waitDemo === "cards") { const r = cardsReply(memory.bossWaits, init?.body, Date.now()); return ((net = structuredClone(net)), current?.send("message", net), r); }
			memory.bossWaits = memory.bossWaits.filter((w) => w.id !== id);
			(net = structuredClone(net)), current?.send("message", net);
			return new Response(JSON.stringify({ rev: memory.rev, proposals: [], entries: [] }), { status: 200, headers: { "content-type": "application/json" } }); // the memory route answers the memory it now holds
		};
	}
	installAutoDemo(new URLSearchParams(location.search).get("auto"), Date.now(), { net: () => net, change: () => ((net = structuredClone(net)), current?.send("message", net)) }); // `?auto=on|back` (demo-auto.ts)
	// The demo documents stand in for the server's: the HTML one as a data: page, the text ones from here.
	[docHooks.src, docHooks.load] = [() => `data:text/html;charset=utf-8,${encodeURIComponent(DEMO_PAGE)}`, async (cap) => ({ text: cap === "plan" ? DEMO_DOC : cap === "blocks" ? DEMO_BLOCKS_DOC : `# Notes ${cap.slice(5)}\n\nA demo document that arrived on its own.` })];
	answeredHooks.get = async () => ({ done: [], pending: [] }); // the demo has no server to ask: nothing is answered yet
	[docHooks.post, docHooks.image] = [async () => ({ ok: true, status: 200, body: { accepted: true } }), (_, ref) => demoImage(ref)]; // a Markdown document's blocks: every answer is accepted, and the review block's two pictures are drawn here
	const demoHistory0 = demoHistory(), history = demoHistory0;
	// `?head=<state>`: the head tower on the net (demo-head.ts); without it the demo has none.
	const headParam = new URLSearchParams(location.search).get("head"), headNow: HeadState | undefined = isHeadState(headParam) ? headParam : zen?.startsWith("head") || runsHeadless(zen, new URLSearchParams(location.search)) ? "answers" : new URLSearchParams(location.search).has("board") ? "talk" : undefined;
	if (headNow) net.head = headDemo(headNow);
	if (headNow && waitDemo === "cards" && net.head?.service) Object.assign(net.head.service, { memory: { rev: 1, standing: 0, decisions: 0, waits: 1, bossWaits: [headCardWait(Date.now())], proposals: [] } }); // `?waits=cards&head=<state>`: the head tower's own card, in the head's words (Q3)
	boardFromUrl(net, Date.now(), (change) => ((net = structuredClone(net)), change(net), current?.send("message", net))); // `?board` (demo-board.ts)
	trainsFromUrl(net, Date.now()); // `?trains=<state>` (demo-trains.ts)
	kindsFromUrl(net); // `?kinds`: one unit of every kind (demo-kinds.ts)
	const allyParam = new URLSearchParams(location.search).get("ally"), allyScenes = (allyParam ?? "").split(","); allyDemo(net.link!, allyParam, Date.now(), (ms, change) => void setTimeout(() => ((net = structuredClone(net)), change(net.link!), (net.link!.units[0]!.at = Date.now() - 5_000), current?.send("message", net)), ms)); // `?ally=idle|crashed|trust|held|closing|rerun|stale|long|gone|mate|units|teams`, a comma list (`ask,teams`): the states of the ci-box ally base's unit card (demo-ally.ts)
	// `?ally=ask`: the ci-box ally base hosts a question that waits (two questions with Send answer and Cancel), for the panel on its card in Standard (gui/allyasks.ts).
	if (allyScenes.includes("ask")) Object.assign(net.link!.alerts.find((x) => x.id === "dialog/d1/D1")!.data, { answered: undefined, closed: undefined, dialog: JSON.stringify({ cancel: true, questions: [{ question: "Deploy to staging?", header: "Deploy", multiple: false, options: [{ title: "Yes" }, { title: "No" }] }, { question: "Which region?", header: "Region", multiple: false, options: [{ title: "eu-west" }, { title: "us-east" }] }] }) });
	/** The page of the chat that ends before `before` (the end of the history when absent), the way the server pages; the head's key has its own conversation. */
	const page = (before?: string, key?: string): Page => {
		const history = (key === "sb-head" || key === "@head") && headNow ? headHistory(headNow) : demoHistory0;
		const end = before ? history.findIndex((i) => i.id === before) : history.length, start = Math.max(0, end - 150);
		return { items: history.slice(start, end), before: start > 0 ? history[start]!.id : undefined };
	};
	/** The head is working on a message the boss sent (the strip says so), or is done. */
	const headWorking = (on: boolean) => net.head && ((net = structuredClone({ ...net, head: { ...net.head, mark: on ? "working" : "idle" } })), current?.send("message", net));
	class FixtureSource implements Source {
		fail: () => void = () => {};
		private listeners = new Map<string, ((data: string) => void)[]>();
		private timers: ReturnType<typeof setInterval>[] = [];
		constructor(watch: string | null) {
			current = this;
			// A dropped server answers a connection with an error, as a stopped one would.
			if (dropped) this.timers.push(setTimeout(() => this.fail(), 300));
			else this.timers.push(setTimeout(() => this.send("hello", { stream: "demo", build: "demo" }), 100), setTimeout(() => this.send("message", net), 150), setInterval(() => this.send("ping", ""), 15_000));
			if (dropped) return;
			if (watch?.startsWith("w:")) this.timers.push(setTimeout(() => this.send("cards", { a1: "I merged the billing branch and the tests pass.", a3: "Waiting for your answer about the deploy window." }), 250));
			else if (watch) {
				this.timers.push(setTimeout(() => this.send("history", { key: watch, state: "live", reset: true, ...page(undefined, watch), ...(watch.startsWith("run-") ? { role: "run", name: watch.slice(4, 12) } : {}), ...boxes.info(watch), header: { id: watch, ...(watch === "sb-head" ? {} : { cwd: "/work/harbor-api" }) }, unreadable: 0, todos: watch === "sb-head" ? undefined : demoTodos() ?? [{ id: 1, subject: "Find where the rounding happens", status: "completed" }, { id: 2, subject: "Fix the ledger rounding before tax", status: "in_progress", activeForm: "fixing the ledger rounding", points: 2, anchor: "Credit notes round before tax", evidence: { command: "npm test -- rounding", result: "pass", sha: "a13b21c", at: "2026-11-24T09:40:00Z" } }, { id: 3, subject: "Add a regression test for credit notes", status: "pending" }] }), 250));
				// A new reply every few seconds, so the page shows a live chat.
				if (watch !== "sb-head") this.timers.push(setInterval(() => {
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
	let clock = Date.now(), quietUntil = 0;
	const track = trackActivity(() => clock), TOOLS = ["tool:edit", "tool:bash", "tool:read", "thinking"];
	const advance = () => {
		const all = units(net);
		const pick = all[step % all.length]!;
		if (pick.role === "train" || pick.pending?.answer || pick.ended || (pick.key === "a3" && zen === "words")) return void step++; // a dialog the page can answer stays until it is answered; a unit whose run is over stays done (src/netdata.ts)
		const options = NEXT[pick.mark];
		pick.mark = step % 17 === 16 ? "error" : options[step % options.length]!;
		if (pick.mark === "waiting" && Date.now() < quietUntil) pick.mark = "working"; // ?zen=idle|alone
		pick.note = pick.mark === "working" ? TOOLS[step % TOOLS.length] : pick.mark === "waiting" ? "waiting on a question" : undefined;
		pick.pending = pick.mark === "waiting" ? ask(++waits) : undefined;
		net = track(structuredClone(net));
		step++;
		return true;
	};
	// The demo starts with most of half an hour behind it, so the timeline and the cards' clocks have something to show.
	for (let i = 41; i > 0; i--) ((clock = Date.now() - i * 40_000), i === 41 ? (net = track(net)) : advance());
	net = track(zenState(net, zen));
	const linkIo = { net: () => net, change: (mut: (n: Net) => void) => (mut(net), (net = structuredClone(net)), current?.send("message", net)), service: () => towerService("standing").service! };
	if (isLinkState(zen)) linkDemo(zen, linkIo, new URLSearchParams(location.search).has("refuse")); // the link cards (demo-link.ts); `&refuse`: the server refuses every answer
	runsFromUrl(zen, { ...linkIo, send: (type, payload) => current?.send(type, payload) }); // headless runs: run cards, the target picker, an addressed tower (demo-runs.ts)
	if (allyScenes.includes("report")) setTimeout(() => linkIo.change((n) => (n.link!.units[0]!.units.push({ unit: "billing", state: "waiting", monitors: [], report: "Needs a decision on the invoice export." } as never), n.link!.alerts.push({ id: "notice/2", kind: "notice", level: "warning", team: "t", teamName: "moldplan", data: { device: "d1", label: "ci-box", short: "9f3a1c", what: "run-crashed", unit: "billing", text: "An ally run crashed: out of memory" } } as never))), 4000); // `?ally=report`: an ally base's report and a notice arrive four seconds on: Zen takes no notice of them (#93)
	// A box's question arrives `&box=<ms>` on, in any state (6000 for `blocking`, where a tower's wait is the card): a card never takes the screen by itself, so it queues behind whatever is shown (Z-D18, Z-D20).
	const boxAt = new URLSearchParams(location.search).get("box") ?? (zen === "blocking" ? "6000" : null);
	if (boxAt !== null) setTimeout(() => linkDemo("link-dialog", linkIo, false), Number(boxAt));
	// `&upgrade=<ms>` (any state): a new build is announced that long after the page starts, once for the browser session (a reload does not hear it again): a Zen page waits for the breath with a quiet line, Standard and Geek reload at once (main.ts `upgrade`).
	const upgradeAt = new URLSearchParams(location.search).get("upgrade");
	if (upgradeAt !== null && !sessionStorage.getItem("sb.demo.upgraded")) setTimeout(() => (sessionStorage.setItem("sb.demo.upgraded", "1"), current?.send("hello", { stream: "demo", build: "demo-next" })), Number(upgradeAt));
	// `?zen=settled`: the card's question is answered elsewhere `&settle=<ms>` on (6000 by default): the card stays, says so, and waits for the boss to close it (Z-D20).
	if (zen === "settled") (quietUntil = Date.now() + 900_000, setTimeout(() => linkIo.change((n) => { if (new URLSearchParams(location.search).has("left")) return void n.bases.forEach((b) => b.tabs.forEach((t) => (t.units = t.units.filter((x) => x.key !== "a3")))); const u = units(n).find((x) => x.key === "a3")!; [u.mark, u.note, u.pending] = ["working", "thinking", undefined]; }), Number(new URLSearchParams(location.search).get("settle") ?? 6000)));
	// `?zen=idle&end=<ms>` ends the companion's session that long on, `&lost=<ms>` takes its control: Zen keeps the screen (Z-D20).
	for (const [name, change] of [["end", (u: Unit) => ((u.ended = true), (u.control = false), (u.mark = "done"))], ["lost", (u: Unit) => (u.control = false)]] as const) { const at = new URLSearchParams(location.search).get(name); if (at !== null) setTimeout(() => linkIo.change((n) => change(units(n).find((x) => x.key === "a1")!)), Number(at)); }
	if (zen === "idle" || zen === "alone" || zen === "blocking" || zen === "chain" || zen?.startsWith("head") || isLinkState(zen) || runsHeadless(zen, new URLSearchParams(location.search))) quietUntil = Date.now() + ((zen ?? "").startsWith("head") || runsHeadless(zen, new URLSearchParams(location.search)) || zen === "blocking" || zen === "chain" || isLinkState(zen) ? 900_000 : 90_000); // the strip fades over minutes: nothing waits for a quarter of an hour
	// A visit starts at the breathing circle (Z-D16): `idle` and `palette` start their first visit as if the boss had stepped to billing-main with `]`; a later visit starts at the circle, as the page does.
	let first = zen === "idle" || zen === "palette";
	const zenStart = () => (first ? ((first = false), { key: "a1", ws: "w1" }) : undefined);
	setInterval(() => ((clock = Date.now()), advance() && current?.send("message", net)), tick);
	const control: Control = {
		// The overlay a drop or silence brings up is modal over this toolbar too, so the demo restores itself: a drop a few seconds on, a silence a few seconds after the watchdog has noticed it.
		drop: () => ((dropped = true), current?.fail(), setTimeout(control.restore, HEAL_MS)),
		silence: () => ((silent = true), setTimeout(control.restore, WATCHDOG_MS + HEAL_MS)),
		restore: () => ((dropped = false), (silent = false), resume()),
		// billing-main shows a new document: on its comms it opens as a tile without focus; elsewhere its token gets the scroll badge.
		tower: (state) => {
			towerNow = TOWER_STATES.includes(state as TowerState) ? (state as TowerState) : TOWER_STATES[(TOWER_STATES.indexOf(towerNow) + 1) % TOWER_STATES.length]!;
			const harbor = net.bases[0]!.tower!, shown = towerService(towerNow);
			(harbor.mark = shown.mark), (harbor.service = shown.service);
			net = structuredClone(net);
			current?.send("message", net);
		},
		// A robot_hand selector on billing-main (the demo of an answer that needs the terminal): "Type it into a new Herdr pane" opens a pane tile, "Put it in my prompt" the session's terminal.
		hand: () => {
			const u = units(net).find((x) => x.key === "a1")!;
			[u.mark, u.note, u.pending] = ["waiting", "waiting on a question", { callId: `demo-hand-${++waits}`, tool: "robot_hand", answer: { dialog: `dh${waits}`, digest: "0".repeat(64), select: hand } }];
			net = structuredClone(net);
			current?.send("message", net);
		},
		doc: () => ((units(net).find((u) => u.key === "a1")!.docs = [...(units(net).find((u) => u.key === "a1")!.docs ?? []), doc(`note-${++notes}`, `docs/notes-${notes}.md`, "Notes for review")]), (net = structuredClone(net)), current?.send("message", net)),
		serverView: (next) => {
			serverNow = next ?? SERVER_VIEWS[(SERVER_VIEWS.indexOf(serverNow) + 1) % SERVER_VIEWS.length]!;
			current?.send("view", serverNow);
		},
	};
	const start = new URLSearchParams(location.search).get("tower");
	if (start) control.tower(start);
	if (isCard(cardParam)) {
		if (cardParam === "held") control.tower("standing"); // a tower standing by has no terminal
		const step = stepOf(cardParam);
		setTimeout(() => openThen(step.kind === "pane" ? { pane: "demo-pane" } : { terminal: true }, { key: step.asker, command: step.command }), 1800);
	}
	// The states that press a key (the Zen layer takes it once it has drawn): H opens the card's context, ⌘K / Ctrl+K the palette, and an answer to the item starts the pause.
	const press = (init: KeyboardEventInit) => setTimeout(() => window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init })), 2200);
	if (zen === "history" || zen === "head-history") (press({ key: "h" }), zen === "head-history" && press({ key: "h" })); // head-history: the first H calls the strip's lines up, the second opens the whole conversation
	if (zen === "head-open") (press({ key: "Enter" }), setTimeout(() => { const box = document.querySelector<HTMLTextAreaElement>(".zen-head-box"); if (box) (box.value = headDraft(), box.dispatchEvent(new Event("input", { bubbles: true }))); }, 2900));
	if (zen === "head-rest") (setTimeout(() => current?.send("history", { key: "sb-head", reset: false, items: headReport(++live) }), 6000)); // the strip is at rest from the start, then the head reports by itself: it stays at rest
	// A card waits for Enter on the breathing circle (Z-D19): the card states press it, so the demo opens on the card its name says; `&queued` leaves the cards waiting, the cue above the input counting them.
	if ((["item", "questions", "secret", "words", "trust", "long", "history", "pause", "blocking", "chain", "settled"].includes(zen ?? "") || isLinkState(zen)) && !new URLSearchParams(location.search).has("queued")) setTimeout(() => window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })), 2000);
	if (zen === "palette") press(/Mac|iPhone|iPad/.test(navigator.platform) ? { key: "k", metaKey: true } : { key: "k", ctrlKey: true });
	if (zen === "pause") setTimeout(() => document.querySelector<HTMLElement>("#zen .zen-skip")?.click(), 2200);
	mountToolbar(control);
	const data = (key: string): Data => ({
		older: async (before) => page(before, key),
		latest: async () => page(undefined, key),
		// Input is accepted, and shows in the log a moment later as pi would write it.
		post: async (action, body) => (waitRefuse && action === "input" && key === net.bases[0]!.tower!.key && { ok: false, status: 409, body: { error: "refused", reason: "The sb server stands in for no tower of workspace w1" } }) || (waitDemo && action === "input" && key === net.bases[0]!.tower!.key && typeof body.answers === "string" && { ok: true, status: 200, body: { accepted: true, woke: true, answered: answerWait(body.answers) } }) || (key === "sb-head" && action === "input" && typeof body.to === "string" && { ok: true, status: 200, body: { accepted: true, label: net.bases.find((b) => b.id === body.to || b.label === body.to)?.label ?? body.to } }) || (key === "sb-head" && action === "input" && headInput(headNow, String(body.text ?? ""), { send: (type, payload) => current?.send(type, payload), mark: headWorking }, ++live)) || (action === "keys" && card?.keys(key, body)) || (action === "mirror" && card?.mirror(key, body.on === true)) || (action === "commands" ? { ok: true, status: 200, body: { commands: [{ name: "review", source: "prompt", description: "Review the current diff" }, { name: "boss", source: "extension", description: "Straw Boss: gui, status, join" }, { name: "skill:release", source: "skill", description: "Cut a release" }].filter((c) => c.name.includes(String(body.prefix))) } } : action === "dequeue" ? { ok: true, status: 200, body: { text: "Also check the refund path while you are in there.\n\nWhen done, write a short summary for the changelog." } } : action === "answer" ? answered(key, body) : action === "mirror" ? mirror(key, body.on === true) : action === "keys" && typeof body.key === "string" && body.key in PAD_REPLIES && !body.confirmed ? PAD_REPLIES[body.key]! : (action === "input" && setTimeout(() => current?.send("history", { key, reset: false, items: [{ id: `you-${++live}`, kind: "user", at: new Date().toISOString(), text: String(body.text) }] }), 700), { ok: true, status: 200, body: action === "input" ? { accepted: true, woke: true } : {} })),
		// Demo images, drawn as SVG: the user's two on the last round, the read result's one, and a broken third index.
		pic: (id, n) => (n > 1 ? "data:," : `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${n ? 900 : 640}" height="${n ? 1400 : 360}"><rect width="100%" height="100%" fill="${id.startsWith("r") ? "#1f3a5f" : n ? "#3d2a5c" : "#14532d"}"/><text x="50%" y="50%" fill="#fff" font-size="48" text-anchor="middle" font-family="sans-serif">${id} · ${n + 1}</text></svg>`)}`),
		entry: async (id) => {
			const item = history.find((i) => i.id === id);
			return item && { ...item, thoughtText: item.kind === "assistant" ? "Thinking out loud about the rounding rules.\n\nCredit notes may need a separate sum." : undefined, tools: item.tools?.map((t) => (t.cut ? { ...t, args: WHOLE, cut: undefined } : t)), text: item.more ? Array.from({ length: 120 }, (_, i) => `line ${i + 1} of the full tool result`).join("\n") : item.text };
		},
	});
	/** A demo terminal: its screen once a second while a tile shows it, every row first, then the two rows that change. */
	const panes = new Map<string, ReturnType<typeof setInterval>>();
	const mirror = (key: string, on: boolean, n = 0, name = everyUnit(net).find((u) => u.key === key)?.name ?? key) => {
		clearInterval(panes.get(key));
		const beat = (rows = demoScreen(name, n++)) => current?.send("mirror", { key, seq: n, rows: rows.length, cols: 60, ...(n === 1 && { whole: true }), set: n === 1 ? rows.map((r, i) => [i, r]) : [5, 8].map((i) => [i, rows[i]]) });
		if (on) (beat(), panes.set(key, setInterval(beat, 1000)));
		return { ok: true, status: 200, body: { attached: on } };
	};
	/** An answer lands at once, and the unit goes back to work a moment later. */
	const answered = (key: string, body: Record<string, unknown> = {}) => {
		// The unit is found when the answer lands: the tick clones the net meanwhile.
		// What the choice leaves to do in a terminal is read from the dialog, as the server does (src/control.ts): a new pane (a grant), or the session's own prompt.
		const choice = (everyUnit(net).find((x) => x.key === key)?.pending?.answer?.select?.choices ?? [])[Number(body.choice)], next = choice?.next, then = next === "pane" ? { pane: "demo-pane" } : next === "terminal" ? { terminal: true as const } : undefined;
		if (then && !isCard(cardParam)) card = demoCard(next === "pane" ? (choice?.label.startsWith("Run") ? "run" : "type") : "prompt", (type, payload) => current?.send(type, payload));
		setTimeout((u = everyUnit(net).find((x) => x.key === key)) => u && ((u.mark = "working"), (u.note = "thinking"), (u.pending = undefined), (net = structuredClone(net)), current?.send("message", net)), 1500);
		return { ok: true, status: 200, body: { outcome: "accepted", ...(then ? { then } : {}) } };
	};
	/** A trust answer settles the question: it leaves the net a moment later. */
	const trust = async (body: { id: string }): Promise<Answer> => (setTimeout(() => ((net = structuredClone({ ...net, trust: (net.trust ?? []).filter((t) => t.id !== body.id) })), current?.send("message", net)), 900), { ok: true, status: 200, body: { outcome: "accepted" } });
	/** The page's `api/<path>` reads the demo answers itself: the music folder (`?music=<n>`). */
	const tracks = Array.from({ length: Math.min(6, Number(new URLSearchParams(location.search).get("music")) || 0) }, (_, i) => ({ file: ["Morning ink.mp3", "Rain on the roof.mp3", "Slow tea.mp3", "Temple bell.mp3", "Late harbour.mp3", "Paper lantern.mp3"][i]!, size: 3_400_000 + i * 410_000 }));
	const api = async (path: string) => (path === "music" ? { tracks } : (boxes.api(path) ?? Promise.reject(new Error("404"))));
	return { open: (watch) => new FixtureSource(watch), data, control, trust, api, start: zenStart };
}

function mountToolbar(control: Control) {
	const bar = document.createElement("div");
	bar.style.cssText = "position:fixed;right:12px;bottom:12px;max-width:300px;flex-wrap:wrap;z-index:9;display:flex;gap:8px;align-items:center;padding:8px 10px;border-radius:12px;background:#0e1628;border:1px solid #2a3a60;font:12px system-ui;color:#8b99ba";
	// On a phone it folds to a "demo" tab in the right margin, which no panel reaches; a tap shows the rest.
	const phone = innerWidth < 640;
	if (phone) bar.style.cssText += ";max-width:none;bottom:auto;right:0;top:40%;writing-mode:vertical-rl;flex-direction:column;padding:6px 1px;gap:4px";
	const buttons = [["demo", () => buttons.slice(1).forEach((b) => (b.style.display = b.style.display ? "" : "none"))], ["drop stream", control.drop], ["go silent", control.silence], ["restore", control.restore], ["doc arrives", control.doc], ["robot_hand", control.hand], ["tower", () => control.tower()], ["server view", () => control.serverView()], ["drawer", () => document.dispatchEvent(new Event("sb-drawer"))]].map(([label, run]) => {
		const button = document.createElement("button");
		[button.textContent, button.onclick] = [label as string, run as () => void];
		button.style.cssText = `all:unset;cursor:pointer;padding:3px 9px;border-radius:8px;background:#1a2748;color:#dbe6ff;${phone ? "padding:8px 1px;" : ""}${label !== "demo" && phone ? "display:none" : ""}`;
		return button;
	});
	bar.append(...buttons);
	document.body.append(bar);
}
