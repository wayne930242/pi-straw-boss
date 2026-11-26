import { type Answer, type BlockSegment, encodeAnswer, INTERACTIVE_KINDS, type InlineToken, type InvalidSegment, inline, inlinePlain, parse, reviewItemName, type TreeNode } from "pi-better-show";
import { configure, type PbsElement, TAGS } from "pi-better-show/elements";
import type { Delivery } from "./blockanswer.ts";
import { type Cell, lockFor } from "./blocklock.ts";
import { h } from "./dom.ts";
import { keepFocus } from "./focusback.ts";
import { mount, parse as markdown } from "./markdown.ts";
import { m } from "./sentences.ts";

// The lazy block host (docs/specs/2026-11-07-better-show-host.md): prose uses the page's Markdown, valid blocks their elements, invalid blocks their source.
// The host resolves review images, previews outgoing text that wasn't visible, and locks every drawing of a block while sending. On acceptance the lock keeps the fields; refusal reopens the block.

export interface BlockHost {
	density: "compact" | "comfortable";
	/** The document the blocks are in, as an answer's `ref` names it. */
	doc?: string;
	/** What the page's lock for these blocks is keyed by (blocklock.ts): a chat message's session and entry, a document's capability and the hash of its text. Without it nothing is kept across drawings. */
	scope?: string[];
	/** The URL the page may load for a review item's `image`, or none: only the host's own route (a document's capability), never what the author wrote. */
	image?(ref: string): string | undefined;
	/** Resolves once the server's record of answered blocks has been put into the page's locks (false: it could not be read). A host without one has nothing to read. */
	ready?(): Promise<boolean>;
	/** Delivers an answer: `text` is what the agent reads (`encodeAnswer`). */
	send(answer: Answer, text: string): Promise<Delivery>;
	/** Whether the unit these blocks are the words of can take an answer now: a unit of a remote base whose box is unreachable or ended cannot. `why` is the reason, or undefined when it can; `watch` registers a drawing to be told (`refresh`) when that changes, held weakly. A host without one (a document's) is never away. */
	away?: Away;
}
export interface Away { why(): string | undefined; watch(view: { refresh(): void }): void }

// The URLs the host resolved are the only ones an element may load: the package's default admits any http(s) or data image.
const resolved = new Set<string>();
configure({ imageUrl: (ref) => (resolved.has(ref) ? ref : undefined) });

/** Markdown's punctuation made literal, so that a chip shows a text as it is. */
const literal = (text: string) => text.replace(/[!-/:-@[-`{-~]/g, "\\$&");

const linked = (tokens: InlineToken[]): boolean => tokens.some((t) => t.type === "link" || ("children" in t && linked(t.children)));
/** Inline Markdown made again from its tokens with every link as its label and all text escaped (a bare address too), so what the element draws has the same words and no anchor. */
const unlink = (tokens: InlineToken[]): string => tokens.map((t) => {
	if (t.type === "text") return literal(t.text);
	if (t.type === "br") return "\n";
	if (t.type === "code") { const run = "`".repeat(Math.max(0, ...(t.text.match(/`+/g) ?? []).map((r) => r.length)) + 1); return `${run}${/^`|`$/.test(t.text) ? ` ${t.text} ` : t.text}${run}`; }
	const inner = unlink(t.children);
	return t.type === "strong" ? `**${inner}**` : t.type === "em" ? `*${inner}*` : inner;
}).join("");
/** A tree with no link in any note; a note without one is left as it is. */
const unlinked = (node: TreeNode): TreeNode => {
	const tokens = node.note === undefined ? [] : inline(node.note);
	return { ...node, ...(linked(tokens) ? { note: unlink(tokens) } : {}), children: node.children.map(unlinked) };
};

/** The block's data as the element gets it: a review item's `image` goes through the host, or goes; a chip shows the text it sends, since what goes out under the boss's name must be what the boss saw (a label that reads as the text keeps its formatting); a tree's notes carry no link. */
function dataOf(seg: BlockSegment, host: BlockHost): unknown {
	if (seg.kind === "tree") return { root: unlinked(seg.data.root) };
	if (seg.kind === "suggest") return { ...seg.data, items: seg.data.items.map((item) => (inlinePlain(item.label) === item.text ? item : { ...item, label: literal(item.text) })) };
	if (seg.kind !== "review") return seg.data;
	return { ...seg.data, items: seg.data.items.map(({ image, ...item }) => {
		const url = image === undefined ? undefined : host.image?.(image);
		if (url !== undefined) resolved.add(url);
		return url === undefined ? item : { ...item, image: url };
	}) };
}

/** A question's `name` that is a plain identifier (`store`) is the agent's own handle for its answer, not something the boss asserts; any other key lands in the message as text. */
const HANDLE = /^[A-Za-z0-9_.-]{1,40}$/;
/** Whether the answer would carry text the boss was not shown as it goes: a picked choice whose value is not its label, an item of a checklist whose name is not its label, a question key that is not a plain identifier and is not its label as drawn. (A choice not picked, or a value that is a part of what was typed, may ask once more than it needs: that costs one tap.) */
function hidden(seg: BlockSegment, fields: Answer["fields"]): boolean {
	const differs = (name: string, label = name) => inlinePlain(label) !== name;
	// The group legend is literal text. Item headings render inline Markdown, but the picks, comments and list of silent items carry the source names.
	if (seg.kind === "review") return seg.data.items.some((item) => differs(reviewItemName(item)));
	if (seg.kind === "checklist") return seg.data.items.some((item) => differs(item.name, item.label));
	if (seg.kind !== "form") return false;
	return seg.data.questions.some((q) => (differs(q.name, q.label) && !HANDLE.test(q.name)) || q.choices.some((c) => differs(c.value, c.label) && fields.some(([name, value]) => name === q.name && value.includes(c.value))));
}

/** The kinds whose element sends a `pbs-answer`: the package's own list of the kinds a reader answers, so a display kind (a tree, a table, a diagram) never takes one. */
const ANSWERS = new Set<string>(INTERACTIVE_KINDS);

function block(seg: BlockSegment, host: BlockHost, known: boolean): HTMLElement {
	const el = document.createElement(TAGS[seg.kind]) as PbsElement, lock = lockFor(...(host.scope ?? [])), index = seg.index;
	const note = h("p", { class: "pbs-note", role: "status", "aria-live": "polite" }), wrap = h("div", { class: "pbs-block", "data-kind": seg.kind }, el, note);
	el.setAttribute("density", host.density);
	el.ref = host.doc === undefined ? { block: index } : { doc: host.doc, block: index };
	el.data = dataOf(seg, host);
	let sending = false, confirming: HTMLElement | undefined;
	const closeConfirm = () => (confirming?.remove(), (confirming = undefined));
	/** The note a state brings, unless the delivery that ended it has put its own words there. */
	const say = (text: string, tone?: string) => ((note.textContent = text), tone ? (note.dataset.tone = tone) : delete note.dataset.tone);
	/** Why the block takes no answer now: its unit's box is away. Only an open block that can be answered is off for it (a table, a diagram or a card has nothing to submit); an answered one stays as it is, and one on its way stays on its way. */
	const off = () => (ANSWERS.has(seg.kind) && lock.get(index).state === "open" ? host.away?.why() : undefined);
	const unsure = () => (known || !ANSWERS.has(seg.kind) ? "" : m.block_unsure_state()); // a display block has no answer whose record could be missing
	let reason: string | undefined;
	const view = {
		show(cell: Cell) {
			wrap.toggleAttribute("inert", cell.state === "pending");
			if (cell.state !== "open") closeConfirm(); // answered, or on its way, from somewhere else meanwhile
			if (cell.state === "done") el.answered = cell.fields;
			if (cell.state === "pending") say(m.block_sending());
			else if (!sending && (cell.state === "done" || note.textContent === m.block_sending())) say(cell.state === "open" && !known ? m.block_unsure_state() : "");
			view.refresh();
		},
		/** The box came or went: the block's controls are off with the reason under it while it is away, and on again, with the note it had, when it is back. */
		gate: off,
		refresh() {
			const now = off();
			keepFocus(wrap, () => el.toggleAttribute("inert", now !== undefined));
			wrap.toggleAttribute("data-away", now !== undefined);
			if (now !== undefined) {
				closeConfirm();
				say(now);
			} else if (reason !== undefined && lock.get(index).state === "open") say(unsure());
			reason = now;
		},
	};
	lock.watch(index, view);
	host.away?.watch(view);
	say(unsure());
	view.show(lock.get(index));
	const deliver = (answer: Answer, text: string) => {
		sending = true;
		lock.pend(index);
		void host.send(answer, text).catch((): Delivery => ({ ok: false, reason: m.unsure() })).then((r) => {
			sending = false;
			if (r.ok) return lock.done(index, answer.fields);
			if (r.answered) lock.done(index, r.answered);
			else lock.cancel(index);
			say(r.reason, r.answered ? undefined : "error");
		});
	};
	/** The confirm step: the exact text that will go, and Send (which sends that very text) or Back. A later answer replaces it. */
	const confirm = (answer: Answer, text: string) => {
		closeConfirm();
		say("");
		const go = h("button", { type: "button", class: "pbs-confirm-send" }, m.block_confirm_send()), back = h("button", { type: "button", class: "pbs-confirm-back" }, m.block_confirm_back());
		const panel = (confirming = h("div", { class: "pbs-confirm", role: "group", "aria-label": m.block_confirm_title() }, h("p", { class: "pbs-confirm-title" }, m.block_confirm_title()), h("pre", { class: "pbs-confirm-text" }, text), h("div", { class: "pbs-confirm-row" }, go, back)));
		go.addEventListener("click", () => {
			if (confirming !== panel) return; // the step goes by itself when the block is locked, sending or away, so a stale Send finds none
			closeConfirm();
			deliver(answer, text);
		});
		back.addEventListener("click", () => confirming === panel && closeConfirm());
		panel.addEventListener("keydown", (event) => (event as KeyboardEvent).key === "Escape" && confirming === panel && closeConfirm());
		wrap.insertBefore(panel, note);
		go.focus();
	};
	el.addEventListener("pbs-answer", (event) => {
		if (!ANSWERS.has(seg.kind)) return; // a display block has nothing to answer: whatever its element says, the host takes none
		const sent = (event as CustomEvent<Answer>).detail, answer: Answer = { ...sent, ref: { ...sent.ref, block: index } }; // the block's address is the block's own, whatever the element says
		event.preventDefault(); // the host takes the answer: the element stays open until the owner has it
		if (sending || lock.get(index).state !== "open" || view.gate()) return; // a unit whose box is away takes nothing, whatever the element let through
		const text = encodeAnswer(answer);
		if (hidden(seg, answer.fields)) confirm(answer, text);
		else deliver(answer, text);
	});
	return wrap;
}

const invalid = (seg: InvalidSegment) => h("pre", { class: "pbs-invalid", title: `${seg.kind}: ${seg.error}` }, h("code", { "data-lang": seg.kind }, seg.source));

/** Replaces the children of `into` with `text` drawn: prose, blocks, and the source of what is not a block. `known` is false when the server's record of answered blocks could not be read: the blocks are open, with a note that says so. */
export function drawBlocks(into: HTMLElement, text: string, host: BlockHost, known = true) {
	into.replaceChildren(...parse(text).map((seg) => (seg.type === "markdown" ? mount(markdown(seg.text)) : seg.type === "invalid" ? invalid(seg) : block(seg, host, known))));
}
