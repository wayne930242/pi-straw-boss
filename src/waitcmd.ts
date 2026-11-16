import { asBoss } from "./autoscope.ts";
import type { Here } from "./heremark.ts";
import { terminalOnlyOpts } from "./intercept.ts";
import { type Lang, matchWorkspaces, memoryWords, type ViewEntry, type ViewFrom } from "./memorycmd.ts";
import { type Act, actsOf, cardTitle, type Listed, type Nav, pending, rowsOf, rowText, type Tower, towerWord, WORDS } from "./waitview.ts";

// `/boss wait` (docs/specs/2026-11-10-wait-cards-tui.md, §2): the boss picks an open wait card from a list in the terminal, then an act, and nobody types or remembers a `W<n>`. It is the picker of the same presses
// `/boss memory done|choose|decline|restate W<n>` makes (one `tower-memory { op: "press" }` each, the server's own checks and refusals), over the cards `boss-waits` lists (waitlist.ts). The same code runs in an ordinary pi (boss.ts)
// and in the pi of a tower run that stands in a pane (runmode.ts), each with the requests it may make; the run's token is never attached.
// Only the boss's typed command reaches it. Every dialog is drawn terminal-only (`terminalOnlyOpts`: the GUI never gets a relayed select for a menu opened at a keyboard), under the boss's mark (`asBoss`), and the whole
// flow runs inside the here mark (heremark.ts), so a paired device's key pad cannot drive the picker. A pane that cannot be marked refuses the command, and a session with no screen is refused.
// The cards come one after another (docs/specs/2026-11-16-wait-cards-flow.md, B): a press, a skip, or a reply goes on to the next card that still waits, in the list's order and around its end, with no list between.
// `card` is the one dialog of a card: `boss_wait_ask` (waitask.ts) draws the same one for an agent, and reads what the boss did from what it returns.

/** The dialogs of a pi session (`ctx.ui`): this command draws every one terminal-only. */
export interface WaitUi {
	select(title: string, options: string[], opts?: { signal?: AbortSignal }): Promise<string | undefined>;
	input(title: string, placeholder?: string, opts?: { signal?: AbortSignal }): Promise<string | undefined>;
	confirm(title: string, message: string, opts?: { signal?: AbortSignal }): Promise<boolean>;
}
type Reply = { ok: boolean; error?: string; [key: string]: unknown };
export interface WaitCmdDeps {
	lang: Lang;
	/** True when the pi session has a screen (`ctx.hasUI`). */
	interactive: boolean;
	/** This session's workspace id, so its own tower's cards are listed first. */
	own: string | undefined;
	tell(text: string, level?: "info" | "warning" | "error"): void;
	/** One request to the control socket (`boss-waits`, `tower-event`, `head-event`); the caller adds the sender of an event. Never with a run token. */
	ask(request: Record<string, unknown>): Promise<Reply>;
	/** One request to a workspace's `tower-memory`: its reply, whose `status` and `body` are the memory route's. */
	memory(workspace: string, json: Record<string, unknown>): Promise<Reply & { status?: number; body?: Record<string, unknown> }>;
	workspaces(): Promise<{ workspace_id: string; label: string; tokens?: Record<string, string> }[]>;
	/** The tabs of a Herdr workspace, for the switch to a raiser's tab (the card names the raiser's workspace and tab by their labels). */
	tabs(workspace: string): Promise<{ tab_id: string; label?: string }[]>;
	ui: WaitUi;
	here: Here;
	/** Brings a Herdr tab forward. */
	focus(tab: string): Promise<void>;
	now(): number;
}
/** The words after `/boss wait`: an optional `-w <workspace id | label | head>`. `usage` when they are anything else. */
export function parseWaitArgs(input: string): { workspace?: string } | { usage: true } {
	const rest = input.trim();
	if (rest === "") return {};
	const m = /^-w\s+(\S+)$/.exec(rest);
	return m ? { workspace: m[1]! } : { usage: true };
}

/** `/boss wait <args>`. */
export async function runWaitCommand(args: string, d: WaitCmdDeps): Promise<void> {
	const w = WORDS[d.lang], parsed = parseWaitArgs(args);
	if ("usage" in parsed) return d.tell(w.usage, "warning");
	if (!d.interactive) return d.tell(w.noUi, "error");
	// The boss's mark outside, the here mark inside it: every dialog below opens under both (and is terminal-only).
	await asBoss(async () => {
		try {
			const only = parsed.workspace === undefined ? undefined : await resolveOnly(d, parsed.workspace);
			await d.here(() => picker(d, only));
		} catch (error) {
			d.tell((error as Error).message, "error");
		}
	});
}

/** The workspace a `-w` names, as `boss-waits` takes it: `head` for the head tower (also when its own Herdr workspace is named), else an id. */
async function resolveOnly(d: WaitCmdDeps, q: string): Promise<string> {
	const w = WORDS[d.lang];
	if (q === "head") return q;
	const all = await d.workspaces(), found = matchWorkspaces(all, q);
	if (found.length > 1) throw new Error(w.many(q));
	if (found.length < 1) throw new Error(`${w.noMatch(q)} ${all.map((x) => `${x.workspace_id} (${x.label})`).join(", ")}`);
	return found[0]!.tokens?.sb_head ? "head" : found[0]!.workspace_id;
}

type Row = Listed["rows"][number];
export const keyOf = (r: Row) => `${r.tower.workspace}/${r.wait.id}`;
/** The list read and cleaned again: what `boss-waits` says, as rows in the order the server gave (the pane's own tower first, then the head, then the towers). `more` rides on the request (`ask: true` of waitask.ts). */
export async function read(d: Pick<WaitCmdDeps, "ask" | "own">, only: string | undefined, more: Record<string, unknown> = {}): Promise<Listed> {
	const got = await d.ask({ cmd: "boss-waits", ...(only ? { workspace: only } : {}), ...(d.own ? { own: d.own } : {}), ...more });
	if (!got.ok) throw new Error(String(got.error ?? "the sb server did not answer"));
	const towers = (got.towers as Tower[] | undefined) ?? [];
	const rows = rowsOf(towers);
	return { auto: (got.auto as { on?: boolean } | undefined)?.on === true, rows };
}

/**
 * The picker: the list, then the card and its acts, until the boss leaves it or nothing is left. Every dialog is terminal-only. A card the boss answered (a press, a skip, a reply) or moved on from leads to the next one that still waits
 * and was not answered here; the list comes back for the way back, a refused press, and a skip or a reply not gone through with. A single card has no list: what ends its dialog ends the picker.
 */
async function picker(d: WaitCmdDeps, only: string | undefined): Promise<void> {
	const w = WORDS[d.lang], opts = terminalOnlyOpts(), answered = new Set<string>();
	let from: { key: string; at: number } | undefined;
	for (;;) {
		const { auto, rows } = await read(d, only);
		if (!rows.length) return from ? undefined : d.tell(w.none);
		const waits = (r: Row) => pending(r.wait) && !answered.has(keyOf(r));
		let at = 0;
		if (from) {
			at = nextOf(rows, from, waits);
			if (at < 0) return;
		} else if (rows.length > 1) {
			const labels = rows.map((r, i) => rowText(d.lang, d.now(), i + 1, r.tower, r.wait)), pick = await d.ui.select(w.title(rows.length), labels, opts);
			at = pick === undefined ? -1 : labels.indexOf(pick);
			if (at < 0) return;
		}
		const row = rows[at]!, single = rows.length === 1;
		const end = await card(d, auto, row.tower, row.wait, { ...(single ? {} : { all: true }), ...(rows.some((r, i) => i !== at && waits(r)) ? { next: true } : {}) }, opts);
		from = undefined;
		if (end.kind === "switched" || (single && end.kind !== "kept" && end.kind !== "refused")) return;
		if (end.kind === "pressed" || end.kind === "replied") answered.add(keyOf(row));
		if (end.kind === "pressed" || end.kind === "replied" || end.kind === "next") from = { key: keyOf(row), at };
	}
}
/** The next row that waits after the card the boss left, around the end of the list; the place of a card that is gone (a skip resolves it) is where the rows after it moved up to. -1 when none waits. */
export function nextOf(rows: Row[], from: { key: string; at: number }, waits: (r: Row) => boolean): number {
	const i = rows.findIndex((r) => keyOf(r) === from.key), start = i < 0 ? from.at : i + 1;
	for (let n = 0; n < rows.length; n++) {
		const j = (start + n) % rows.length;
		if (j !== i && waits(rows[j]!)) return j;
	}
	return -1;
}

/** How a card's dialog ended: a press that went through (`json` is the request), one the server refused, a reply the tower took, a skip or a reply not gone through with (`kept`), Escape or the way back (`left`), the next card, or a switch to the raiser's tab. */
export type CardEnd =
	| { kind: "pressed"; json: Record<string, unknown>; body?: Record<string, unknown> } | { kind: "refused"; why: string } | { kind: "replied"; text: string; marked: boolean }
	| { kind: "kept" } | { kind: "left" } | { kind: "next" } | { kind: "switched" };
export type CardDeps = Pick<WaitCmdDeps, "lang" | "tell" | "ask" | "memory" | "ui" | "workspaces" | "tabs" | "focus">;

/** One card: its acts, one chosen and carried out. The caller decides where its end leads. */
export async function card(d: CardDeps, auto: boolean, tower: Tower, e: ViewEntry, nav: Nav, opts: { signal?: AbortSignal }): Promise<CardEnd> {
	const w = WORDS[d.lang], acts = actsOf(d.lang, auto, tower, e, nav), labels = acts.map((a) => a.label);
	const pick = await d.ui.select(cardTitle(d.lang, auto, tower, e), labels, opts);
	const chosen = pick === undefined ? undefined : acts[labels.indexOf(pick)]?.act;
	if (!chosen || chosen.kind === "back") return { kind: "left" };
	switch (chosen.kind) {
		case "next": return { kind: "next" };
		case "switch": return await switchTo(d, chosen.from), { kind: "switched" };
		case "press": return press(d, tower, e, chosen);
		case "skip": {
			const reason = await d.ui.input(w.reason, undefined, opts);
			if (reason === undefined) return { kind: "kept" };
			if (!(await d.ui.confirm(w.skipTitle, w.skipBody(towerWord(d.lang, tower), e.card?.from?.name), opts))) return { kind: "kept" };
			return press(d, tower, e, { kind: "press", json: { op: "press", id: e.id, act: "decline", ...(reason.trim() ? { reason: reason.trim() } : {}) }, what: memoryWords(d.lang).didDecline });
		}
		case "reply": {
			const text = (await d.ui.input(w.replyTitle(towerWord(d.lang, tower)), undefined, opts))?.trim();
			if (!text) return { kind: "kept" };
			try {
				const r = await d.ask(tower.head ? { cmd: "head-event", text, answers: e.id } : { cmd: "tower-event", workspace: tower.workspace, text, present: true, answers: e.id });
				if (!r.ok) throw new Error(String(r.error ?? "no answer"));
				d.tell(w.replied2(towerWord(d.lang, tower), String(r.answered ?? ""), e.id));
				return { kind: "replied", text, marked: r.answered === e.id };
			} catch (error) {
				return d.tell(w.refused((error as Error).message), "error"), { kind: "kept" };
			}
		}
	}
}

/** The raiser's tab, found by the labels the card keeps (its workspace and tab), and brought forward; nothing is written. One that cannot be found, or is not one, is said. */
async function switchTo(d: CardDeps, from: ViewFrom): Promise<void> {
	const w = WORDS[d.lang];
	try {
		const found: string[] = [];
		for (const ws of (await d.workspaces()).filter((x) => from.workspace === undefined || x.label === from.workspace)) found.push(...(await d.tabs(ws.workspace_id)).filter((t) => t.label === from.tab).map((t) => t.tab_id));
		if (found.length !== 1) return d.tell(found.length ? w.tabMany(from.name) : w.tabNone(from.name), "warning");
		await d.focus(found[0]!);
	} catch (error) {
		d.tell((error as Error).message, "error");
	}
}

/** One press, as `/boss memory` makes it: the result line names who was told; a refusal shows the server's reason. */
async function press(d: CardDeps, tower: Tower, e: ViewEntry, act: Extract<Act, { kind: "press" }>): Promise<CardEnd> {
	const m = memoryWords(d.lang), w = WORDS[d.lang], name = e.card?.from?.name ?? "";
	try {
		const r = await d.memory(tower.workspace, act.json);
		if (!r.ok) throw new Error(String(r.error ?? "no answer"));
		if (r.status !== 200) throw new Error(String(r.body?.reason ?? r.body?.error ?? r.status));
		const status = (r.body?.press as { main?: { status: string } } | undefined)?.main?.status;
		// `asked`: the raiser asked the boss itself (boss_wait_ask), and what it called is its notice.
		const note = !name || !status ? "" : status === "delivered" || status === "queued" || status === "asked" ? m.told(name) : m.notReached(name, status);
		d.tell(m.pressed(e.id, act.what, note));
		return { kind: "pressed", json: act.json, ...(r.body ? { body: r.body } : {}) };
	} catch (error) {
		d.tell(w.refused((error as Error).message), "error");
		return { kind: "refused", why: (error as Error).message };
	}
}
