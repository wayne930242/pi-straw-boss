import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { asBoss } from "./autoscope.ts";
import { type AgentKind, cancelledText, refusedText } from "./autotext.ts";
import type { Here } from "./heremark.ts";
import { terminalOnlyOpts } from "./intercept.ts";
import type { Ask } from "./host.ts";
import { every } from "./lanface.ts";
import { type Lang, memoryLang } from "./memorycmd.ts";
import type { Kit } from "./state.ts";
import { card, type CardEnd, keyOf, read, type WaitUi } from "./waitcmd.ts";
import { type Listed, pending, pressedWord } from "./waitview.ts";

// `boss_wait_ask` (docs/specs/2026-11-16-wait-cards-flow.md, C): an agent has sb put open wait cards in front of the boss again, in the terminal, one after another. The agent names cards and nothing else: each dialog is the
// card as the tower recorded it, drawn by `card` of waitcmd.ts (the dialog of `/boss wait`) terminal-only, under the boss's mark and the here mark, so only the keys of this computer choose. The press is a session's request
// (`tower-memory` with `via: "ask"`, the hello secret), never a run's token. This amends decision 2 of docs/specs/2026-11-10-wait-cards-tui.md ("a run's model gets no press"): a model now decides when a card is shown, and still
// neither words it nor presses it. The first answer wins everywhere: while a dialog is open the list is read again every 2 s, and a card pressed or resolved elsewhere, or auto mode starting, aborts the dialog through its signal.

export const WAIT_ASK = "boss_wait_ask";
export const WAIT_ASK_DESCRIPTION = "Have sb show the boss open wait cards (the cards a tower recorded for him) in this terminal, one after another, and return what he did with each. You only name cards: ids (W<n>, 1 to 4), or none for every open card in your scope. sb draws each card as it is recorded, with its own buttons; you cannot word it, add an option, or choose, and only the boss's keys press. Scope: a main asks only the cards it raised, a tower run its tower's, the head tower any. His answer resolves the card everywhere (the GUI, other panes, the tower), and the first answer wins: a card answered elsewhere meanwhile says so. Refused while auto mode is on, on an unattended device, in a session without a screen, and in a tower run unless the boss's last words came from this pane. A card he left unanswered is not shown again for 10 minutes. Use it, never ask_user_question, to ask again a decision that is a wait card.";
export const waitAskParameters = () => Type.Object({
	ids: Type.Optional(Type.Array(Type.String({ pattern: "^W[0-9]+$", description: "A wait card's id: W and its number, as the card, your wait, or the return list names it." }), { minItems: 1, maxItems: 4, description: "The cards to show, 1 to 4. Omit to show every open card in your scope." })),
});

/** Whose cards a session may have shown: the ones it raised (a main, by its session id), one tower's (a local run, by its workspace), or every tower's (the head's run). */
export type Scope = { kind: "raised"; by: string } | { kind: "tower"; workspace: string } | { kind: "all" };
type Reply = { ok: boolean; error?: string; [key: string]: unknown };
export interface WaitAskDeps {
	lang: Lang;
	scope(): Scope;
	/** Why this session may not ask now (not a main, the boss not at this pane), or undefined: checked before anything is read or drawn. */
	refusal(): string | undefined;
	auto: { on(): boolean; since?(): string | undefined; kind?(): AgentKind };
	/** One request of a session to the sb server (the hello secret); never with a run token. */
	ask(request: Record<string, unknown>): Promise<Reply>;
	here: Here;
	now(): number;
	/** Runs `fn` every `ms` until the returned function is called (the look at the list while a dialog is open). */
	every(fn: () => void, ms: number): () => void;
	tell(text: string, level?: "info" | "warning" | "error"): void;
}
type Row = Listed["rows"][number];
const LOOK_MS = 2000, LEFT_MS = 10 * 60_000;
const STAYS = "it stays open for the GUI and /boss wait; do not ask it again this session.";
const NOT_OPEN: Record<Scope["kind"], string> = { raised: "not an open wait card you raised.", tower: "not an open wait card of your tower.", all: "not an open wait card of any tower." };
const none = async () => [];

export function createWaitAsk(d: WaitAskDeps) {
	/** The cards the boss left unanswered here, and when: not drawn again for `LEFT_MS`. */
	const left = new Map<string, number>();
	const kind = () => d.auto.kind?.() ?? "run";

	return async (params: { ids?: unknown }, signal: AbortSignal | undefined, ctx: { hasUI: boolean; ui: WaitUi }): Promise<{ text: string; details: unknown }> => {
		const no = d.refusal();
		if (no) throw new Error(no);
		if (d.auto.on()) throw new Error(refusedText(d.auto.since?.(), WAIT_ASK, kind()));
		if (!ctx.hasUI) throw new Error("This session has no screen (nobody is at a keyboard here), so no card can be shown; the cards stay open for the GUI and /boss wait.");
		const ids = params.ids === undefined ? undefined : Array.isArray(params.ids) && params.ids.length >= 1 && params.ids.length <= 4 && params.ids.every((id) => typeof id === "string" && /^W[0-9]+$/.test(id)) ? [...new Set(params.ids as string[])] : null;
		if (ids === null) throw new Error("ids names 1 to 4 wait cards (W and its number), or is left out for every open card in your scope");
		const scope = d.scope(), only = scope.kind === "tower" ? scope.workspace : undefined, asker = scope.kind === "raised" ? scope.by : undefined;
		// `ask: true`: a device with no boss at it refuses the read, before anything is drawn (waitpress.ts `askRefused`).
		const list = () => read({ ask: d.ask, own: undefined }, only, { ask: true });
		const listed = await list(), mine = listed.rows.filter((r) => scope.kind !== "raised" || r.wait.card?.from?.id === scope.by);
		const name = (r: Row) => (scope.kind === "all" ? `${r.wait.id} (${r.tower.label})` : r.wait.id);
		const lines: string[] = [], queue: Row[] = [];
		let pressed = false;
		/** A card of the scope: drawn, or said why not (pressed already, or left unanswered a moment ago). */
		const sort = (r: Row) => {
			const ago = d.now() - (left.get(keyOf(r)) ?? Number.NEGATIVE_INFINITY);
			if (!pending(r.wait)) lines.push(`${name(r)}: answered already (${pressedWord("en", r.wait)}); nothing to ask.`);
			else if (ago < LEFT_MS) lines.push(`${name(r)}: the boss left it unanswered ${Math.floor(ago / 60_000)} min ago; ${STAYS}`);
			else queue.push(r);
		};
		// An id names the card of every tower in the scope that has it (the head's scope holds several memories, each with a W1).
		if (!ids) mine.filter((r) => pending(r.wait)).forEach(sort);
		else for (const id of ids) {
			const found = mine.filter((r) => r.wait.id === id);
			if (!found.length) lines.push(`${id}: ${NOT_OPEN[scope.kind]}`);
			found.forEach(sort);
		}
		if (!queue.length) return { text: lines.join("\n") || "No open wait card in your scope.", details: { asked: 0 } };

		const memory = async (workspace: string, json: Record<string, unknown>) => {
			const r = await d.ask({ cmd: "tower-memory", workspace, json: { ...json, ...(asker ? { asker } : {}) }, via: "ask" });
			return { ok: r.ok, ...(typeof r.error === "string" ? { error: r.error } : {}), ...(typeof r.status === "number" ? { status: r.status } : {}), ...(typeof r.body === "object" && r.body !== null ? { body: Object.fromEntries(Object.entries(r.body)) } : {}) };
		};
		/** One card's dialog, with the look at the list beside it: how it ended as the result's line, and why the round ends there, if it does. */
		const show = async (row: Row, more: boolean): Promise<{ line: string; stop?: string }> => {
			const ac = new AbortController(), id = name(row), key = keyOf(row);
			let cut: { line: string; stop?: string } | undefined, looking = false;
			const end = (why: { line: string; stop?: string }) => void (cut ??= why, ac.abort());
			const stopped = () => end({ line: `${id}: not answered (the turn was stopped).`, stop: "the turn was stopped" });
			const look = async () => {
				if (d.auto.on()) return end({ line: `${id}: ${cancelledText(d.auto.since?.(), WAIT_ASK, kind())}`, stop: "auto mode started" });
				// A server that does not answer changes nothing: the dialog stays, and a press that lost the race is refused by the server.
				const now = (await list().catch(() => undefined))?.rows.find((r) => keyOf(r) === key);
				if (now && pending(now.wait)) return;
				end({ line: `${id}: answered elsewhere first: ${now ? pressedWord("en", now.wait) : "it is no longer open"}.` });
			};
			if (signal?.aborted) stopped();
			signal?.addEventListener("abort", stopped, { once: true });
			const unwatch = d.every(() => void (!looking && !cut && ((looking = true), look().catch(() => {}).finally(() => (looking = false)))), LOOK_MS);
			try {
				for (;;) {
					const done: CardEnd = await card({ lang: d.lang, tell: d.tell, ask: d.ask, memory, ui: ctx.ui, workspaces: none, tabs: none, focus: async () => {} }, listed.auto, row.tower, row.wait, { ask: true, ...(more ? { next: true } : {}) }, { ...terminalOnlyOpts(), signal: ac.signal });
					if (done.kind === "pressed") return (pressed = true), { line: `${id}: ${pressedLine(row, done.json, asker !== undefined)}` };
					if (done.kind === "replied") return { line: `${id}: the boss replied to the tower: "${done.text}"${done.marked ? "" : " (the wait was not marked answered: the memory no longer has it as a wait for him)"}` };
					if (done.kind === "refused") return { line: `${id}: ${/already|no longer|not a wait/.test(done.why) ? "answered elsewhere first" : "the press was refused"}: ${done.why}` };
					if (cut) return cut;
					if (done.kind === "kept") continue; // a skip or a reply he did not go through with: the same card again
					left.set(key, d.now());
					return done.kind === "next" ? { line: `${id}: no answer (the boss moved to the next card); ${STAYS}` } : { line: `${id}: no answer (Esc); ${STAYS}`, stop: "the boss left the dialog" };
				}
			} finally {
				unwatch();
				signal?.removeEventListener("abort", stopped);
			}
		};
		// The boss's mark outside, the here mark inside it, as `/boss wait`: a pane that cannot be marked draws nothing.
		await asBoss(() => d.here(async () => {
			for (const [i, row] of queue.entries()) {
				const out = await show(row, i < queue.length - 1);
				lines.push(out.line);
				if (!out.stop) continue;
				const auto = out.stop === "auto mode started";
				for (const r of queue.slice(i + 1)) (auto || left.set(keyOf(r), d.now()), lines.push(`${name(r)}: not shown (${out.stop}); ${auto ? "it stays parked for the boss." : STAYS}`));
				break;
			}
		}));
		// The raiser that asked is told by this result alone: the server sends it no `wait_card` for its own ask.
		return { text: [...lines, ...(asker && pressed ? ["This is the boss's answer: no wait_card message follows."] : [])].join("\n"), details: { asked: queue.length } };
	};
}

/** What a press that went through says to the agent that asked; `raiser`: the asker raised the card, so this line is its notice. */
function pressedLine(row: Row, json: Record<string, unknown>, raiser: boolean): string {
	const c = row.wait.card, told = "the tower was told.";
	switch (json.act) {
		case "choose": { const o = c?.options?.[Number(json.option)]; return `the boss chose "${o?.label ?? "?"}" (then: ${o?.then ?? "?"}); ${told}`; }
		case "decline": return `skipped by the boss${typeof json.reason === "string" && json.reason ? `: "${json.reason}"` : ""}; ${told} Do not ask again unless something changed.`;
		case "secret": return `the boss is at this computer to enter ${c?.secret?.name ?? "the secret"}: ${raiser ? "call secret_drop now for it, in this session, and tell the tower with call_tower when it is stored." : `${c?.from?.name ?? "the raiser"} was told to call secret_drop now.`}`;
		case "restate": return "the boss asked the tower to record it again as a card.";
		default: return `the boss did it (${c?.do ?? row.wait.text}); ${told}`;
	}
}

/** `boss_wait_ask` of a joined session (tools.ts): only a tab's main agent asks, only the cards it raised, and its own result is the answer (no `wait_card` follows). */
export function mainWaitAsk({ pi, cfg, s, me, role, tell }: Kit, o: { ask?: Ask; here: Here; auto: WaitAskDeps["auto"] }): void {
	registerWaitAsk(pi, {
		lang: memoryLang(cfg.env), scope: () => ({ kind: "raised", by: me() }), auto: o.auto, here: o.here, now: cfg.now, every: cfg.face?.every ?? every, tell,
		refusal: () => (role() !== "main" ? "Only a tab's main agent has sb ask the boss its wait cards again (the ones it raised); a member's go through its main, and a train's stay with the tower." : s.remoteOrigin ? "A teammate's turn does not ask the boss of this computer." : undefined),
		ask: async (request) => (o.ask ? o.ask(request, { start: "never" }) : { ok: false, error: "The sb server is not available in this session." }),
	});
}

/** Registers the tool on a session's pi. */
export function registerWaitAsk(pi: Pick<ExtensionAPI, "registerTool">, d: WaitAskDeps): void {
	const run = createWaitAsk(d);
	pi.registerTool({
		name: WAIT_ASK, label: WAIT_ASK, description: WAIT_ASK_DESCRIPTION, parameters: waitAskParameters(),
		execute: async (_id, params, signal, _update, ctx) => {
			const { text, details } = await run(params, signal, ctx);
			return { content: [{ type: "text", text }], details };
		},
	});
}
